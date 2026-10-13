// src/domain/operations/plan-service.ts
//
// PlanService — the application-layer façade that the background
// router calls. Wires together:
//   - validateImport (JSON schema + size + forbidden keys)
//   - diffImport (preview between import and live tree)
//   - PlanValidator (structural checks)
//   - OperationExecutor (the only writer of chrome.bookmarks.*)
//   - SnapshotService (capture/restore)
//   - Approval tokens (single-use, expiring)
//
// Why a service and not just wiring in background.ts: the wiring
// touches the live bookmarks API, the Dexie plan/snapshot/audit
// stores, the sync generation, and the import buffer. Keeping it in
// one place makes Phase 3+ (link health) and Phase 4 (dedupe) easier
// to add additional plan kinds without bloating background.ts.

import type {
  Approval,
  OperationPlan,
  OperationStep,
  TreeSnapshot,
  OperationAuditEntry,
} from './types';
import { AppErrorImpl } from '../../shared/errors';
import { validateImport, hasForbiddenKeys } from './import';
import { diffImport, type ImportMode, type DiffOp, type FlatNode } from './diff';
import { validatePlan } from './validator';
import { OperationExecutor, type ExecutorDeps } from './executor';

export interface PlanServiceDeps {
  bookmarksApi: ExecutorDeps['bookmarksApi'];
  plansStore: {
    put(plan: OperationPlan): Promise<void>;
    get(id: string): Promise<OperationPlan | undefined>;
    list(): Promise<OperationPlan[]>;
  };
  stepsStore: {
    put(step: OperationStep): Promise<void>;
    listByPlan(planId: string): Promise<OperationStep[]>;
  };
  auditStore: { append(e: OperationAuditEntry): Promise<void> };
  snapshotsStore: {
    put(s: TreeSnapshot): Promise<void>;
    get(id: string): Promise<TreeSnapshot | undefined>;
    listByPlan(planId: string): Promise<TreeSnapshot[]>;
  };
  approvalsStore: {
    put(a: Approval): Promise<void>;
    take(token: string): Promise<Approval | undefined>;
  };
  currentSyncGeneration(): number;
  newId(): string;
  now(): number;
}

export interface ImportPreviewSummary {
  formatVersion: number;
  totalNodes: number;
  mode: ImportMode;
  summary: { adds: number; updates: number; moves: number; deletes: number; noops: number };
  conflicts: string[];
  sample: DiffOp[];
  ok: true;
}

export class PlanService {
  private readonly executor: OperationExecutor;

  constructor(private readonly deps: PlanServiceDeps) {
    this.executor = new OperationExecutor({
      bookmarksApi: deps.bookmarksApi,
      savePlan: (p) => deps.plansStore.put(p),
      saveStep: (s) => deps.stepsStore.put(s),
      saveAudit: (e) => deps.auditStore.append(e),
      readPlan: (id) => deps.plansStore.get(id),
      readApproval: (t) => deps.approvalsStore.take(t), // take = read+invalidate
      consumeApproval: async () => undefined, // already consumed by `take`
      newId: () => deps.newId(),
      now: () => deps.now(),
      validate: async (p) => { validatePlan(p); },
      assertStillValid: async () => undefined, // background-only check; placeholder
    });
  }

  /**
   * Validate a raw JSON string and produce a preview of the operations
   * that would be applied to the live tree under the given mode.
   * Does NOT persist any plan; this is read-only.
   */
  async previewImport(rawJson: string, mode: ImportMode): Promise<ImportPreviewSummary> {
    const payload = validateImport(rawJson);
    const forbidden = hasForbiddenKeys(payload);
    if (forbidden) {
      throw new AppErrorImpl('INVALID_REQUEST', `import contains forbidden field: ${forbidden}`, false);
    }
    const importTree = (payload.browserTree as unknown as FlatNode[]);
    const liveTree = await this.deps.bookmarksApi.getTree();
    const diff = diffImport(importTree as FlatNode[], liveTree as unknown as FlatNode[], mode);
    return {
      formatVersion: payload.formatVersion,
      totalNodes: diff.summary.totalInImport,
      mode,
      summary: {
        adds: diff.summary.adds,
        updates: diff.summary.updates,
        moves: diff.summary.moves,
        deletes: diff.summary.deletes,
        noops: diff.summary.noops,
      },
      conflicts: diff.conflicts,
      sample: diff.ops.slice(0, 50),
      ok: true,
    };
  }

  /**
   * Build and persist a draft plan. The plan is NOT approved; the
   * UI must request an approval token before execution.
   */
  async draftPlan(rawJson: string, mode: ImportMode, title = 'Import from backup'): Promise<OperationPlan> {
    const payload = validateImport(rawJson);
    const importTree = (payload.browserTree as unknown as FlatNode[]);
    const liveTree = await this.deps.bookmarksApi.getTree();
    const diff = diffImport(importTree as FlatNode[], liveTree as unknown as FlatNode[], mode);
    const basedOnGeneration = this.deps.currentSyncGeneration();

    // Capture a snapshot for undo before any writes.
    const snap: TreeSnapshot = {
      id: this.deps.newId(),
      planId: null,
      createdAt: this.deps.now(),
      syncGeneration: basedOnGeneration,
      tree: liveTree,
      localIndex: { bookmarks: [], folders: [] },
      reason: `before plan execution (mode=${mode})`,
    };
    await this.deps.snapshotsStore.put(snap);

    const steps: OperationStep[] = diff.ops
      .filter((o) => o.kind === 'add' || o.kind === 'update' || o.kind === 'move' || o.kind === 'delete')
      .map((o, i) => this.opToStep(o, i, this.deps.newId()));

    const plan: OperationPlan = {
      id: this.deps.newId(),
      title,
      description: `Mode: ${mode}. Conflicts: ${diff.conflicts.length}.`,
      createdAt: this.deps.now(),
      approvedAt: null,
      basedOnGeneration,
      steps,
      status: 'draft',
      metadata: {
        'plan-service.mode': mode,
        'plan-service.snapshot': snap.id,
        'plan-service.imported-format': String(payload.formatVersion),
      },
    };
    validatePlan(plan);
    await this.deps.plansStore.put(plan);
    for (const s of steps) await this.deps.stepsStore.put(s);
    return plan;
  }

  private opToStep(op: DiffOp, order: number, _planIdHint: string): OperationStep {
    const base = {
      id: this.deps.newId(),
      planId: 'PENDING', // filled in by caller before persist
      order,
      reason: 'import diff',
      riskLevel: op.kind === 'delete' ? 'high' as const : 'low' as const,
      dependsOn: [],
      status: 'pending' as const,
      inverseOfId: null,
      errorMessage: null,
      evidence: [],
    };
    switch (op.kind) {
      case 'add':
        return {
          ...base,
          action: 'create',
          targetBrowserId: null,
          parentBrowserId: op.parentId,
          expectedBefore: {},
          desiredAfter: { title: op.title, url: op.url },
        };
      case 'update':
        return {
          ...base,
          action: 'update',
          targetBrowserId: op.id,
          parentBrowserId: null,
          expectedBefore: { title: op.fromTitle, url: op.fromUrl },
          desiredAfter: { title: op.toTitle, url: op.toUrl },
        };
      case 'move':
        return {
          ...base,
          action: 'move',
          targetBrowserId: op.id,
          parentBrowserId: op.toParentId,
          expectedBefore: { parentId: op.fromParentId },
          desiredAfter: { parentId: op.toParentId },
        };
      case 'delete':
        return {
          ...base,
          action: 'delete',
          targetBrowserId: op.id,
          parentBrowserId: null,
          expectedBefore: {},
          desiredAfter: {},
        };
      case 'noop':
        // noop should never be turned into a step; the filter above
        // excludes it. Defensive default.
        return {
          ...base,
          action: 'update',
          targetBrowserId: op.id,
          parentBrowserId: null,
          expectedBefore: {},
          desiredAfter: {},
        };
    }
  }

  /**
   * Issue a single-use approval token for a plan. Default TTL is
   * 5 minutes; callers may override.
   */
  async approve(planId: string, ttlMs = 5 * 60_000): Promise<Approval> {
    const plan = await this.deps.plansStore.get(planId);
    if (!plan) throw new AppErrorImpl('BOOKMARK_NOT_FOUND', `plan ${planId} not found`, false);
    if (plan.status !== 'draft' && plan.status !== 'validated') {
      throw new AppErrorImpl('INVALID_REQUEST', `plan status ${plan.status} cannot be approved`, false);
    }
    const approval: Approval = {
      token: this.deps.newId(),
      planId,
      issuedAt: this.deps.now(),
      ttlMs,
      confirmationHash: null,
      issuedBy: 'options-ui',
    };
    await this.deps.approvalsStore.put(approval);
    plan.status = 'approved';
    plan.approvedAt = this.deps.now();
    await this.deps.plansStore.put(plan);
    return approval;
  }

  /**
   * Run a plan. Requires a valid approval token. The executor handles
   * all the per-step live-state checks, compensation, and audit.
   */
  async execute(planId: string, approvalToken: string, dryRun = false): Promise<{
    planId: string;
    status: string;
    succeeded: number;
    failed: number;
    compensated: number;
  }> {
    const plan = await this.deps.plansStore.get(planId);
    if (!plan) throw new AppErrorImpl('BOOKMARK_NOT_FOUND', `plan ${planId} not found`, false);
    return this.executor.execute(plan, { approvalToken, dryRun });
  }

  async listPlans(): Promise<OperationPlan[]> {
    return this.deps.plansStore.list();
  }

  async getPlan(id: string): Promise<OperationPlan | undefined> {
    return this.deps.plansStore.get(id);
  }

  async getPlanSteps(planId: string): Promise<OperationStep[]> {
    return this.deps.stepsStore.listByPlan(planId);
  }
}
