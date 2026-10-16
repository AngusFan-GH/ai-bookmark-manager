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
  OperationAction,
} from './types';
import { AppErrorImpl } from '../../shared/errors';
import { validateImport, hasForbiddenKeys } from './import';
import { diffImport, type ImportMode, type DiffOp, type FlatNode } from './diff';
import { validatePlan } from './validator';
import { OperationExecutor, type ExecutorDeps, type BookmarkApiNode } from './executor';
import { hashApprovedPlan } from './plan-hash';
import { buildRecoverySteps } from './recovery';

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
  captureLocalIndex?(): Promise<TreeSnapshot['localIndex']>;
  currentSyncGeneration(): number;
  newId(): string;
  now(): number;
}

export interface OrganizationStepInput {
  action: OperationAction;
  targetBrowserId?: string;
  parentBrowserId?: string;
  /** Move into a folder created by an earlier step in this input. */
  parentStepIndex?: number;
  desiredAfter?: { title?: string; url?: string; index?: number };
  reason?: string;
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
      captureSnapshot: async plan => {
        const snap: TreeSnapshot = {
          id: deps.newId(), planId: plan.id, createdAt: deps.now(),
          syncGeneration: deps.currentSyncGeneration(), tree: await deps.bookmarksApi.getTree(),
          localIndex: await deps.captureLocalIndex?.() ?? { bookmarks: [], folders: [] },
          reason: `immediately before execution of ${plan.id}`,
        };
        await deps.snapshotsStore.put(snap);
        plan.metadata['plan-service.snapshot'] = snap.id;
        await deps.plansStore.put(plan);
      },
      savePlan: (p) => deps.plansStore.put(p),
      saveStep: (s) => deps.stepsStore.put(s),
      saveAudit: (e) => deps.auditStore.append(e),
      readPlan: (id) => deps.plansStore.get(id),
      readApproval: (t) => deps.approvalsStore.take(t), // take = read+invalidate
      consumeApproval: async () => undefined, // already consumed by `take`
      newId: () => deps.newId(),
      now: () => deps.now(),
      validate: async (p) => { validatePlan(p); },
      assertStillValid: async (step) => {
        if (step.action === 'create' || step.action === 'move') {
          if (!step.parentBrowserId) throw new AppErrorImpl('PLAN_STALE', 'destination folder is missing', false);
          const parent = await deps.bookmarksApi.get(step.parentBrowserId);
          if (parent.url !== undefined || parent.id === '0') throw new AppErrorImpl('PLAN_STALE', 'destination is not a writable folder', false);
          if (step.action === 'move') {
            let ancestor: BookmarkApiNode | undefined = parent;
            const visited = new Set<string>();
            while (ancestor) {
              if (ancestor.id === step.targetBrowserId || visited.has(ancestor.id)) throw new AppErrorImpl('PLAN_STALE', 'move would create a cycle', false);
              visited.add(ancestor.id);
              ancestor = ancestor.parentId ? await deps.bookmarksApi.get(ancestor.parentId) : undefined;
            }
          }
        }
        if (step.action === 'create') return;
        if (!step.targetBrowserId) throw new AppErrorImpl('PLAN_STALE', 'operation target is missing', false);
        const live = await deps.bookmarksApi.get(step.targetBrowserId);
        if (!live.parentId || live.parentId === '0' || live.id === '0') throw new AppErrorImpl('PLAN_STALE', 'protected browser folder', false);
        for (const [key, expected] of Object.entries(step.expectedBefore)) {
          if (((live as unknown as Record<string, unknown>)[key] ?? null) !== expected) {
            throw new AppErrorImpl('PLAN_STALE', `target changed: ${key}`, false);
          }
        }
      },
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
    if (hasForbiddenKeys(payload)) throw new AppErrorImpl('INVALID_REQUEST', 'import contains forbidden fields', false);
    const importTree = (payload.browserTree as unknown as FlatNode[]);
    const liveTree = await this.deps.bookmarksApi.getTree();
    const diff = diffImport(importTree as FlatNode[], liveTree as unknown as FlatNode[], mode);
    const basedOnGeneration = this.deps.currentSyncGeneration();

    const planId = this.deps.newId();
    // Preview backup supplements the mandatory fresh execution backup.
    const snap: TreeSnapshot = {
      id: this.deps.newId(),
      planId,
      createdAt: this.deps.now(),
      syncGeneration: basedOnGeneration,
      tree: liveTree,
      localIndex: this.deps.captureLocalIndex ? await this.deps.captureLocalIndex() : { bookmarks: [], folders: [] },
      reason: `before plan execution (mode=${mode})`,
    };
    await this.deps.snapshotsStore.put(snap);

    const liveById = new Map<string, BookmarkApiNode>();
    const visit = (nodes: BookmarkApiNode[]) => { for (const n of nodes) { liveById.set(n.id, n); visit(n.children ?? []); } };
    visit(liveTree);
    const ops = diff.ops.filter(o => o.kind !== 'noop');
    // Empty-only browser removal requires descendants before their folders.
    const orderedOps = [...ops.filter(o => o.kind !== 'delete'), ...ops.filter(o => o.kind === 'delete').reverse()];
    const steps = orderedOps.map((op, i) => {
      const step = this.opToStep(op, i, planId);
      if (op.kind !== 'add') {
        const node = liveById.get(op.id);
        if (!node) throw new AppErrorImpl('PLAN_STALE', 'target disappeared', false);
        if (!node.parentId || node.parentId === '0' || node.id === '0') throw new AppErrorImpl('INVALID_REQUEST', 'import would modify a protected browser folder', false);
        step.expectedBefore = expectedState(node);
        // A preceding update in this same plan intentionally changes title/url.
        if (op.kind === 'move') {
          const update = orderedOps.find(o => o.kind === 'update' && o.id === op.id);
          if (update?.kind === 'update') Object.assign(step.expectedBefore, { title: update.toTitle, url: update.toUrl ?? null });
        }
      }
      return step;
    });
    const creates = new Map(orderedOps.flatMap((op, i) => op.kind === 'add' ? [[op.id, steps[i]] as const] : []));
    for (const step of steps) {
      const parent = step.parentBrowserId ? creates.get(step.parentBrowserId) : undefined;
      if (parent) { step.parentStepId = parent.id; step.dependsOn.push(parent.id); }
    }

    const plan: OperationPlan = {
      id: planId,
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

  private opToStep(op: DiffOp, order: number, planId: string): OperationStep {
    const base = {
      id: this.deps.newId(),
      planId,
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
      // UI input is untrusted. Keep tokens short-lived even if a caller
      // attempts to request an unbounded or negative lifetime.
      ttlMs: Math.min(Math.max(ttlMs, 1_000), 5 * 60_000),
      planHash: await hashApprovedPlan(plan),
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

  async getPlanSnapshots(planId: string): Promise<TreeSnapshot[]> {
    return this.deps.snapshotsStore.listByPlan(planId);
  }

  async draftOrganization(input: { title?: string; steps: OrganizationStepInput[] }): Promise<OperationPlan> {
    if (!input || !Array.isArray(input.steps) || !input.steps.length || input.steps.length > 1000) {
      throw new AppErrorImpl('INVALID_REQUEST', 'provide between 1 and 1000 organization steps', false);
    }
    const planId = this.deps.newId();
    const steps: OperationStep[] = [];
    const priorTargets = new Map<string, OperationStep>();
    for (const [order, request] of input.steps.entries()) {
      if (!['create', 'update', 'rename', 'move', 'delete'].includes(request.action)) throw new AppErrorImpl('INVALID_REQUEST', 'invalid organization action', false);
      const desiredAfter: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(request.desiredAfter ?? {})) {
        if (!['title', 'url', 'index'].includes(key)) throw new AppErrorImpl('INVALID_REQUEST', 'unsupported desired field', false);
        if (key === 'index' ? typeof value !== 'number' || !Number.isInteger(value) || value < 0 : typeof value !== 'string') throw new AppErrorImpl('INVALID_REQUEST', 'invalid desired field', false);
        desiredAfter[key] = value;
      }
      const allowedFields = request.action === 'create' ? ['title', 'url', 'index'] : request.action === 'move' ? ['index'] : request.action === 'rename' ? ['title'] : request.action === 'update' ? ['title', 'url'] : [];
      if (Object.keys(desiredAfter).some(key => !allowedFields.includes(key))) throw new AppErrorImpl('INVALID_REQUEST', 'field does not apply to action', false);
      if (request.action === 'update' && !Object.keys(desiredAfter).length) throw new AppErrorImpl('INVALID_REQUEST', 'update requires changes', false);
      let parentStep: OperationStep | undefined;
      if (request.parentStepIndex !== undefined) {
        if (!['move', 'create'].includes(request.action) || request.parentBrowserId !== undefined || !Number.isInteger(request.parentStepIndex) || request.parentStepIndex < 0 || request.parentStepIndex >= order) {
          throw new AppErrorImpl('INVALID_REQUEST', 'parent step must reference an earlier folder creation', false);
        }
        parentStep = steps[request.parentStepIndex];
        if (!parentStep || parentStep.action !== 'create' || parentStep.desiredAfter.url !== undefined) {
          throw new AppErrorImpl('INVALID_REQUEST', 'parent step must create a folder', false);
        }
      }
      if (request.action === 'move' && !parentStep) desiredAfter.parentId = request.parentBrowserId;
      if (request.action === 'delete' && Object.keys(desiredAfter).length) throw new AppErrorImpl('INVALID_REQUEST', 'delete does not accept desired fields', false);
      if (request.action === 'rename' && typeof desiredAfter.title !== 'string') throw new AppErrorImpl('INVALID_REQUEST', 'rename requires title', false);
      let expectedBefore: Record<string, unknown> = {};
      const previousTargetStep = request.targetBrowserId ? priorTargets.get(request.targetBrowserId) : undefined;
      if (request.action !== 'create') {
        if (!request.targetBrowserId) throw new AppErrorImpl('INVALID_REQUEST', 'target is required', false);
        if (previousTargetStep?.action === 'delete' || previousTargetStep?.parentStepId) throw new AppErrorImpl('INVALID_REQUEST', 'cannot edit a deleted target or unresolved moved target in the same plan', false);
        const node = await this.deps.bookmarksApi.get(request.targetBrowserId);
        if (!node.parentId || node.parentId === '0' || node.id === '0') throw new AppErrorImpl('INVALID_REQUEST', 'protected browser folder', false);
        if (request.action === 'update' && desiredAfter.url !== undefined && node.url === undefined) throw new AppErrorImpl('INVALID_REQUEST', 'cannot convert a folder into a bookmark', false);
        if (request.action === 'delete' && node.url === undefined) {
          const subtree = await this.deps.bookmarksApi.getSubTree(node.id);
          const remaining = (subtree[0]?.children ?? []).filter(child => !steps.some(s => s.action === 'delete' && s.targetBrowserId === child.id));
          if (remaining.length) throw new AppErrorImpl('INVALID_REQUEST', 'folder must be empty; explicitly preview descendant deletions first', false);
        }
        expectedBefore = expectedState(node);
        if (previousTargetStep) {
          expectedBefore = { ...previousTargetStep.expectedBefore };
          for (const key of ['title', 'url', 'parentId']) {
            if (previousTargetStep.desiredAfter[key] !== undefined) expectedBefore[key] = previousTargetStep.desiredAfter[key];
          }
        }
      }
      if ((request.action === 'create' || request.action === 'move') && !parentStep) {
        const parent = request.parentBrowserId ? await this.deps.bookmarksApi.get(request.parentBrowserId) : undefined;
        if (!parent || parent.url !== undefined || parent.id === '0') throw new AppErrorImpl('INVALID_REQUEST', 'destination must be a writable folder', false);
        if (request.action === 'move') {
          let ancestor: BookmarkApiNode | undefined = parent;
          const visited = new Set<string>();
          while (ancestor) {
            if (ancestor.id === request.targetBrowserId || visited.has(ancestor.id)) throw new AppErrorImpl('INVALID_REQUEST', 'move would create a cycle', false);
            visited.add(ancestor.id);
            ancestor = ancestor.parentId ? await this.deps.bookmarksApi.get(ancestor.parentId) : undefined;
          }
        }
      }
      steps.push({ id: this.deps.newId(), planId, order, action: request.action, targetBrowserId: request.targetBrowserId ?? null,
        parentBrowserId: request.parentBrowserId ?? (parentStep ? 'resolved-at-execution' : null), ...(parentStep ? { parentStepId: parentStep.id } : {}), expectedBefore, desiredAfter, reason: request.reason || 'User-requested organization',
        riskLevel: request.action === 'delete' ? 'high' : 'medium', dependsOn: [...(parentStep ? [parentStep.id] : []), ...(previousTargetStep ? [previousTargetStep.id] : [])], status: 'pending', inverseOfId: null, errorMessage: null, evidence: ['live browser state at draft'] });
      if (request.action !== 'create' && request.targetBrowserId) priorTargets.set(request.targetBrowserId, steps[steps.length - 1]);
    }
    const plan: OperationPlan = { id: planId, title: input.title || 'Organize bookmarks', description: 'Review native bookmark changes before approving.',
      createdAt: this.deps.now(), approvedAt: null, basedOnGeneration: this.deps.currentSyncGeneration(), steps, status: 'draft', metadata: { 'plan-service.mode': 'organization' } };
    validatePlan(plan);
    const snapshot: TreeSnapshot = {
      id: this.deps.newId(), planId, createdAt: this.deps.now(), syncGeneration: this.deps.currentSyncGeneration(),
      tree: await this.deps.bookmarksApi.getTree(),
      localIndex: await this.deps.captureLocalIndex?.() ?? { bookmarks: [], folders: [] },
      reason: `organization preview for ${planId}`,
    };
    await this.deps.snapshotsStore.put(snapshot);
    plan.metadata['plan-service.snapshot'] = snapshot.id;
    await this.deps.plansStore.put(plan);
    for (const step of steps) await this.deps.stepsStore.put(step);
    return plan;
  }

  private recoveryDraftInFlight = new Map<string, Promise<OperationPlan>>();

  /** One recovery attempt per source. Never replay deletes as duplicate creates. */
  draftRecovery(planId: string): Promise<OperationPlan> {
    const existing = this.recoveryDraftInFlight.get(planId);
    if (existing) return existing;
    const pending = this.createRecoveryDraft(planId).finally(() => this.recoveryDraftInFlight.delete(planId));
    this.recoveryDraftInFlight.set(planId, pending);
    return pending;
  }

  private async createRecoveryDraft(planId: string): Promise<OperationPlan> {
    const source = await this.deps.plansStore.get(planId);
    if (!source) throw new AppErrorImpl('BOOKMARK_NOT_FOUND', 'original plan not found', false);
    if (source.metadata['plan-service.recovery-of']) throw new AppErrorImpl('INVALID_REQUEST', 'recovery plans cannot themselves be recovered automatically', false);
    const recoveryId = source.metadata['plan-service.recovery-plan'];
    if (recoveryId) {
      const existing = await this.deps.plansStore.get(recoveryId);
      if (existing && ['draft', 'validated', 'approved'].includes(existing.status)) return existing;
      throw new AppErrorImpl('PLAN_STALE', 'Recovery already attempted; inspect its audit and backup rather than repeat it', false);
    }
    if (!['completed', 'partially_completed', 'failed'].includes(source.status)) throw new AppErrorImpl('INVALID_REQUEST', 'only finished operations can be recovered', false);
    const snapshot = await this.deps.snapshotsStore.get(source.metadata['plan-service.snapshot']);
    if (!snapshot || snapshot.planId !== source.id || !snapshot.reason.startsWith('immediately before execution')) {
      throw new AppErrorImpl('PLAN_STALE', 'execution backup is unavailable', false);
    }
    const id = this.deps.newId();
    const liveTree = await this.deps.bookmarksApi.getTree();
    const steps = buildRecoverySteps(source, snapshot, liveTree, id, () => this.deps.newId());
    const plan: OperationPlan = {
      id, title: `Recover: ${source.title}`, description: 'Review inverse changes. Deleted nodes receive new browser IDs; original timestamps cannot be restored. Later unrelated bookmarks are preserved.',
      createdAt: this.deps.now(), approvedAt: null, basedOnGeneration: this.deps.currentSyncGeneration(),
      steps, status: 'draft', metadata: { 'plan-service.mode': 'recovery', 'plan-service.recovery-of': source.id },
    };
    validatePlan(plan);
    // Recovery participates in the same downloadable preview-backup contract
    // as every organization draft. Do not reserve a recovery if capture fails.
    const previewSnapshot: TreeSnapshot = {
      id: this.deps.newId(), planId: plan.id, createdAt: this.deps.now(),
      syncGeneration: plan.basedOnGeneration, tree: liveTree,
      localIndex: await this.deps.captureLocalIndex?.() ?? { bookmarks: [], folders: [] },
      reason: `recovery preview for ${plan.id}`,
    };
    await this.deps.snapshotsStore.put(previewSnapshot);
    plan.metadata['plan-service.snapshot'] = previewSnapshot.id;
    // Reserve before persisting: a storage interruption must block, never create
    // a second restoration. This marker intentionally survives failed attempts.
    source.metadata['plan-service.recovery-plan'] = plan.id;
    await this.deps.plansStore.put(source);
    await this.deps.plansStore.put(plan);
    for (const step of steps) await this.deps.stepsStore.put(step);
    return plan;
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

/** Null explicitly records absent fields across JSON persistence. Index is
 * excluded because preceding sibling operations legitimately renumber it. */
function expectedState(node: BookmarkApiNode): Record<string, unknown> {
  return { title: node.title ?? null, url: node.url ?? null, parentId: node.parentId ?? null, dateAdded: node.dateAdded ?? null };
}
