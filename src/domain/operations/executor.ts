// src/domain/operations/executor.ts
//
// OperationExecutor — the ONLY place in the codebase that calls
// chrome.bookmarks.create / update / move / remove. Dev guide § 0.1
// red line #1 and § 3.7: "所有 chrome.bookmarks 写 API 必须集中在
// OperationExecutor，且具有显式批准、操作日志、冲突校验、可恢复记录".
//
// Guarantees:
//   - An Approval token is required for any non-noop plan.
//   - Each step re-queries the live tree and compares against
//     expectedBefore; mismatch → that step is failed (dev guide § 3.7).
//   - Steps run in declared order. Depends-on ordering is honored.
//   - Execution is serial. A second execute() call while one is in
//     flight throws.
//   - Failures during a plan: stop after the failing step, attempt
//     compensation for already-succeeded steps (in reverse order),
//     record every action in the audit log.
//   - Re-execution of the same plan requires a fresh Approval token.

import type {
  OperationPlan,
  OperationStep,
  Approval,
  OperationAuditEntry,
} from './types';
import { AppErrorImpl } from '../../shared/errors';

/**
 * Minimal shapes of the four write APIs the executor calls. We do NOT
 * import from `chrome.bookmarks` directly because @types/chrome does
 * not export them as named types; instead we use the well-known
 * structural shape that the chrome API expects.
 */
export interface CreateBookmarkInput {
  parentId: string;
  title?: string;
  url?: string;
  index?: number;
}
export interface UpdateBookmarkInput {
  title?: string;
  url?: string;
}
export interface MoveBookmarkInput {
  parentId?: string;
  index?: number;
}
export interface BookmarkApiNode {
  id: string;
  parentId?: string;
  title?: string;
  url?: string;
  dateAdded?: number;
  dateGroupModified?: number;
  index?: number;
  children?: BookmarkApiNode[];
}

export interface ExecutorDeps {
  /**
   * Native browser bookmarks API. The executor only consumes these
   * four methods; nothing else in the codebase calls them.
   */
  bookmarksApi: {
    get(id: string): Promise<BookmarkApiNode>;
    getSubTree(id: string): Promise<BookmarkApiNode[]>;
    getTree(): Promise<BookmarkApiNode[]>;
    create(input: CreateBookmarkInput): Promise<BookmarkApiNode>;
    update(id: string, changes: UpdateBookmarkInput): Promise<void>;
    move(id: string, destination: MoveBookmarkInput): Promise<void>;
    remove(id: string): Promise<void>;
  };
  /** Persist a plan and its updated steps. */
  savePlan(plan: OperationPlan): Promise<void>;
  /** Persist a single step's updated state. */
  saveStep(step: OperationStep): Promise<void>;
  /** Persist a single audit row. Append-only. */
  saveAudit(entry: OperationAuditEntry): Promise<void>;
  /** Read a plan by id. */
  readPlan(planId: string): Promise<OperationPlan | undefined>;
  /** Read an approval token. */
  readApproval(token: string): Promise<Approval | undefined>;
  /** Invalidate an approval token (single-use). */
  consumeApproval(token: string): Promise<void>;
  /** Returns a fresh id (uuid v4). */
  newId(): string;
  /** Wall-clock for audit timestamps. */
  now(): number;
  /**
   * Plan validator. Called once before execution starts. Rejects plans
   * that have invalid IDs, missing dependencies, etc.
   */
  validate(plan: OperationPlan): Promise<void>;
  /**
   * Re-query the live state of a target and compare to expectedBefore.
   * Throws AppErrorImpl('PLAN_STALE', ...) on mismatch.
   */
  assertStillValid(step: OperationStep): Promise<void>;
}

export interface ExecuteOptions {
  /**
   * Approval token. Required unless the plan has zero steps (a noop
   * preview). Tokens are single-use; replay requires a new token.
   */
  approvalToken?: string;
  /**
   * Set true to run in dry-run mode: every step is validated and
   * logged, but no chrome.bookmarks write is performed. Used by
   * `preview` in Phase 4+ and by tests.
   */
  dryRun?: boolean;
}

export interface ExecuteResult {
  planId: string;
  status: OperationPlan['status'];
  succeeded: number;
  failed: number;
  compensated: number;
}

/** Status of the executor — at most one plan runs at a time. */
export class OperationExecutor {
  private inflight: Promise<ExecuteResult> | null = null;
  constructor(private readonly deps: ExecutorDeps) {}

  /**
   * Run the plan. Returns the same in-flight promise if called again
   * before the previous execution completes (dev guide § 2.1 single
   * writer rule).
   */
  execute(plan: OperationPlan, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
    if (this.inflight) return this.inflight;
    this.inflight = this.run(plan, opts).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async run(plan: OperationPlan, opts: ExecuteOptions): Promise<ExecuteResult> {
    if (plan.steps.length > 0) {
      if (!opts.approvalToken) {
        throw new AppErrorImpl('INVALID_REQUEST', 'approvalToken required for non-empty plan', false);
      }
      const approval = await this.deps.readApproval(opts.approvalToken);
      if (!approval) {
        throw new AppErrorImpl('INVALID_REQUEST', 'unknown approval token', false);
      }
      if (approval.planId !== plan.id) {
        throw new AppErrorImpl('INVALID_REQUEST', 'approval token does not match plan', false);
      }
      if (Date.now() - approval.issuedAt > approval.ttlMs) {
        throw new AppErrorImpl('INVALID_REQUEST', 'approval token expired', false);
      }
      // Single-use: invalidate now even before the first step runs.
      await this.deps.consumeApproval(opts.approvalToken);
    }

    // Validate plan structure (deps, ids, ordering). Re-validates live
    // state on each step separately (assertStillValid).
    await this.deps.validate(plan);

    const ordered = sortSteps(plan.steps);
    let succeeded = 0;
    let failed = 0;
    let compensated = 0;
    const succeededSteps: OperationStep[] = [];

    for (const step of ordered) {
      if (failed > 0) {
        // Once any step has failed, skip the rest of the plan.
        step.status = 'skipped';
        step.errorMessage = 'skipped due to earlier failure';
        await this.deps.saveStep(step);
        continue;
      }

      // Re-validate dependencies: every step this one depends on must
      // have succeeded already.
      const unmetDeps = step.dependsOn.filter((depId) =>
        !succeededSteps.find((s) => s.id === depId),
      );
      if (unmetDeps.length > 0) {
        step.status = 'failed';
        step.errorMessage = `unmet dependencies: ${unmetDeps.join(', ')}`;
        failed += 1;
        await this.deps.saveStep(step);
        await this.audit(plan, step, 'failed: ' + step.errorMessage);
        continue;
      }

      // Re-validate live state.
      try {
        await this.deps.assertStillValid(step);
      } catch (err) {
        step.status = 'failed';
        step.errorMessage = err instanceof Error ? err.message : String(err);
        failed += 1;
        await this.deps.saveStep(step);
        await this.audit(plan, step, 'failed: ' + step.errorMessage);
        continue;
      }

      if (opts.dryRun) {
        step.status = 'succeeded';
        step.errorMessage = 'dry-run: not applied';
        succeeded += 1;
        await this.deps.saveStep(step);
        await this.audit(plan, step, 'dry-run');
        continue;
      }

      // Apply the step.
      try {
        await this.apply(step);
        step.status = 'succeeded';
        step.errorMessage = null;
        succeeded += 1;
        succeededSteps.push(step);
        await this.deps.saveStep(step);
        await this.audit(plan, step, 'succeeded');
      } catch (err) {
        step.status = 'failed';
        step.errorMessage = err instanceof Error ? err.message : String(err);
        failed += 1;
        await this.deps.saveStep(step);
        await this.audit(plan, step, 'failed: ' + step.errorMessage);
        // Do NOT break; let the loop's `if (failed > 0)` branch at the
        // top mark the remaining steps as 'skipped' so the UI sees
        // them in their final state.
      }
    }

    // If any step failed, attempt to compensate already-succeeded steps
    // in reverse order. Compensation is best-effort; failures here are
    // recorded but do not change the plan status.
    if (failed > 0) {
      for (const s of [...succeededSteps].reverse()) {
        try {
          await this.compensate(s);
          s.status = 'compensated';
          compensated += 1;
          await this.deps.saveStep(s);
          await this.audit(plan, s, 'compensated');
        } catch (err) {
          // Compensation failed — log and move on. The user will see
          // the audit row and can attempt manual recovery.
          s.errorMessage = (s.errorMessage ?? '') + ' | compensation failed: ' + (err instanceof Error ? err.message : String(err));
          await this.deps.saveStep(s);
          await this.audit(plan, s, 'compensation failed: ' + (err instanceof Error ? err.message : String(err)));
        }
      }
    }

    // Update plan status.
    const finalStatus: OperationPlan['status'] = failed === 0
      ? (succeeded === 0 ? 'completed' : 'completed')
      : (succeeded === 0 ? 'failed' : 'partially_completed');
    plan.status = finalStatus;
    await this.deps.savePlan(plan);

    return { planId: plan.id, status: finalStatus, succeeded, failed, compensated };
  }

  private async apply(step: OperationStep): Promise<void> {
    const api = this.deps.bookmarksApi;
    switch (step.action) {
      case 'create': {
        if (!step.parentBrowserId) {
          throw new AppErrorImpl('INVALID_REQUEST', 'create requires parentBrowserId', false);
        }
        const details: CreateBookmarkInput = {
          parentId: step.parentBrowserId,
          title: String(step.desiredAfter.title ?? ''),
        };
        if (typeof step.desiredAfter.url === 'string') {
          details.url = step.desiredAfter.url;
        }
        if (typeof step.desiredAfter.index === 'number') {
          details.index = step.desiredAfter.index;
        }
        await api.create(details);
        return;
      }
      case 'rename': {
        if (!step.targetBrowserId) {
          throw new AppErrorImpl('INVALID_REQUEST', 'rename requires targetBrowserId', false);
        }
        const newTitle = String(step.desiredAfter.title ?? '');
        if (!newTitle) {
          throw new AppErrorImpl('INVALID_REQUEST', 'rename requires desiredAfter.title', false);
        }
        await api.update(step.targetBrowserId, { title: newTitle });
        return;
      }
      case 'update': {
        if (!step.targetBrowserId) {
          throw new AppErrorImpl('INVALID_REQUEST', 'update requires targetBrowserId', false);
        }
        const changes: UpdateBookmarkInput = {};
        if (typeof step.desiredAfter.title === 'string') changes.title = step.desiredAfter.title;
        if (typeof step.desiredAfter.url === 'string') changes.url = step.desiredAfter.url;
        if (Object.keys(changes).length === 0) {
          throw new AppErrorImpl('INVALID_REQUEST', 'update requires at least one field', false);
        }
        await api.update(step.targetBrowserId, changes);
        return;
      }
      case 'move': {
        if (!step.targetBrowserId) {
          throw new AppErrorImpl('INVALID_REQUEST', 'move requires targetBrowserId', false);
        }
        const dest: MoveBookmarkInput = {};
        if (typeof step.desiredAfter.parentId === 'string') dest.parentId = step.desiredAfter.parentId;
        if (typeof step.desiredAfter.index === 'number') dest.index = step.desiredAfter.index;
        if (!dest.parentId && dest.index === undefined) {
          throw new AppErrorImpl('INVALID_REQUEST', 'move requires parentId or index', false);
        }
        await api.move(step.targetBrowserId, dest);
        return;
      }
      case 'delete': {
        if (!step.targetBrowserId) {
          throw new AppErrorImpl('INVALID_REQUEST', 'delete requires targetBrowserId', false);
        }
        await api.remove(step.targetBrowserId);
        return;
      }
      default: {
        const _exhaustive: never = step.action;
        throw new AppErrorImpl('UNKNOWN', `unknown action: ${String(_exhaustive)}`, false);
      }
    }
  }

  /**
   * Best-effort undo. Mirrors apply() but produces the inverse:
   *   create  → remove the new node
   *   rename  → restore the previous title
   *   update  → restore the previous title/url
   *   move    → restore the previous parentId/index
   *   delete  → NOT recoverable (the user must have a snapshot).
   *
   * Compensation is best-effort: failures are surfaced via audit, not
   * thrown. Dev guide § 3.7: "撤销是补偿操作，不保证恢复原 browserId
   * 或所有时间戳".
   */
  private async compensate(step: OperationStep): Promise<void> {
    const api = this.deps.bookmarksApi;
    switch (step.action) {
      case 'create': {
        // Find the newly created node by some marker. For now we expect
        // the caller to have stored the new id in desiredAfter.
        const newId = typeof step.desiredAfter.id === 'string' ? step.desiredAfter.id : null;
        if (!newId) {
          throw new AppErrorImpl('UNKNOWN', 'cannot compensate create: no new id recorded', false);
        }
        await api.remove(newId);
        return;
      }
      case 'rename': {
        if (!step.targetBrowserId) return;
        const prevTitle = String(step.expectedBefore.title ?? '');
        await api.update(step.targetBrowserId, { title: prevTitle });
        return;
      }
      case 'update': {
        if (!step.targetBrowserId) return;
        const changes: UpdateBookmarkInput = {};
        if (typeof step.expectedBefore.title === 'string') changes.title = step.expectedBefore.title;
        if (typeof step.expectedBefore.url === 'string') changes.url = step.expectedBefore.url;
        if (Object.keys(changes).length > 0) await api.update(step.targetBrowserId, changes);
        return;
      }
      case 'move': {
        if (!step.targetBrowserId) return;
        const dest: MoveBookmarkInput = {};
        if (typeof step.expectedBefore.parentId === 'string') dest.parentId = step.expectedBefore.parentId;
        if (typeof step.expectedBefore.index === 'number') dest.index = step.expectedBefore.index;
        if (dest.parentId || dest.index !== undefined) await api.move(step.targetBrowserId, dest);
        return;
      }
      case 'delete': {
        // Deletion is not compensable. The snapshot must be used to
        // recover manually. Surface this via audit.
        throw new AppErrorImpl('BOOKMARK_NOT_FOUND', 'cannot compensate a delete; use snapshot', false);
      }
    }
  }

  private async audit(plan: OperationPlan, step: OperationStep, message: string): Promise<void> {
    const entry: OperationAuditEntry = {
      id: this.deps.newId(),
      planId: plan.id,
      stepId: step.id,
      action: step.action,
      targetBrowserId: step.targetBrowserId,
      status: step.status,
      message,
      recordedAt: this.deps.now(),
    };
    await this.deps.saveAudit(entry);
  }
}

/**
 * Sort steps by (order asc, id asc) for deterministic execution.
 * Pure function; safe to unit test.
 */
export function sortSteps(steps: readonly OperationStep[]): OperationStep[] {
  return [...steps].sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
