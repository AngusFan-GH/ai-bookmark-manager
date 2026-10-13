// tests/integration/executor.test.ts
//
// OperationExecutor integration tests. Per dev guide § 3.7:
//   - An approval token is required for any non-empty plan.
//   - Single-use tokens: a second use of the same token must fail.
//   - Steps run in order; failed step halts the plan.
//   - Re-validates live state via assertStillValid before each step.
//   - Compensates already-succeeded steps in reverse on failure.
//   - Dry-run mode applies no writes.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { OperationExecutor, sortSteps } from '../../src/domain/operations/executor';
import type { OperationPlan, OperationStep, Approval, OperationAuditEntry } from '../../src/domain/operations/types';
import type { BookmarkApiNode } from '../../src/domain/operations/executor';
import { AppErrorImpl } from '../../src/shared/errors';
import { hashApprovedPlan } from '../../src/domain/operations/plan-hash';

let currentTree: BookmarkApiNode[] = [];
let currentApprovals = new Map<string, Approval>();
let currentPlans = new Map<string, OperationPlan>();
let currentSteps = new Map<string, OperationStep>();
let currentAudit: OperationAuditEntry[] = [];
let nextIdCounter = 0;
const nextId = (): string => `id-${++nextIdCounter}`;

function makeBookmarksApi() {
  return {
    get: vi.fn(async (id: string) => findById(currentTree, id) ?? Promise.reject(new Error('not found'))),
    getSubTree: vi.fn(async () => []),
    getTree: vi.fn(async () => currentTree),
    create: vi.fn(async (input: { parentId: string; title?: string; url?: string; index?: number }) => {
      const newNode: BookmarkApiNode = {
        id: `new-${++nextIdCounter}`,
        parentId: input.parentId,
        title: input.title,
        url: input.url,
        index: input.index ?? 0,
        children: [],
      };
      const parent = findById(currentTree, input.parentId);
      if (parent) (parent.children ??= []).push(newNode);
      return newNode;
    }),
    update: vi.fn(async (id: string, changes: { title?: string; url?: string }) => {
      const node = findById(currentTree, id);
      if (node) {
        if (typeof changes.title === 'string') node.title = changes.title;
        if (typeof changes.url === 'string') node.url = changes.url;
      }
    }),
    move: vi.fn(async (id: string, dest: { parentId?: string; index?: number }) => {
      const node = findById(currentTree, id);
      if (node) {
        if (dest.parentId) node.parentId = dest.parentId;
        if (typeof dest.index === 'number') node.index = dest.index;
      }
    }),
    remove: vi.fn(async (id: string) => {
      removeById(currentTree, id);
    }),
  };
}

function findById(roots: BookmarkApiNode[], id: string): BookmarkApiNode | undefined {
  for (const r of roots) {
    if (r.id === id) return r;
    if (r.children) {
      const f = findById(r.children, id);
      if (f) return f;
    }
  }
  return undefined;
}
function removeById(roots: BookmarkApiNode[], id: string): boolean {
  for (let i = 0; i < roots.length; i++) {
    if (roots[i].id === id) { roots.splice(i, 1); return true; }
    if (roots[i].children && removeById(roots[i].children!, id)) return true;
  }
  return false;
}

function makeDeps() {
  const api = makeBookmarksApi();
  return {
    api,
    deps: {
      bookmarksApi: api,
      savePlan: vi.fn(async (p: OperationPlan) => { currentPlans.set(p.id, JSON.parse(JSON.stringify(p))); }),
      saveStep: vi.fn(async (s: OperationStep) => { currentSteps.set(s.id, JSON.parse(JSON.stringify(s))); }),
      saveAudit: vi.fn(async (e: OperationAuditEntry) => { currentAudit.push(JSON.parse(JSON.stringify(e))); }),
      readPlan: vi.fn(async (id: string) => currentPlans.get(id)),
      readApproval: vi.fn(async (token: string) => currentApprovals.get(token)),
      consumeApproval: vi.fn(async (token: string) => { currentApprovals.delete(token); }),
      newId: nextId,
      now: () => Date.now(),
      validate: vi.fn(async () => undefined),
      assertStillValid: vi.fn(async () => undefined),
    },
  };
}

function makeStep(over: Partial<OperationStep> = {}): OperationStep {
  return {
    id: 's1', planId: 'p1', order: 0, action: 'rename', targetBrowserId: 'b1',
    parentBrowserId: null,
    expectedBefore: { title: 'old' },
    desiredAfter: { title: 'new' },
    reason: 'test', riskLevel: 'low', dependsOn: [], status: 'pending',
    inverseOfId: null, errorMessage: null, evidence: [], ...over,
  };
}

function makePlan(steps: OperationStep[]): OperationPlan {
  return {
    id: 'p1', title: 'plan', description: '', createdAt: 0, approvedAt: null,
    basedOnGeneration: 1, steps, status: 'draft', metadata: {},
  };
}

function makeApproval(planId: string, ttlMs = 60_000): Approval {
  return {
    token: `tok-${++nextIdCounter}`,
    planId,
    issuedAt: Date.now(),
    ttlMs,
    planHash: null,
    confirmationHash: null,
    issuedBy: 'test',
  };
}

beforeEach(() => {
  currentTree = [];
  currentApprovals.clear();
  currentPlans.clear();
  currentSteps.clear();
  currentAudit = [];
  nextIdCounter = 0;
});

describe('sortSteps', () => {
  it('orders by order asc, then id asc', () => {
    const a = makeStep({ id: 'a', order: 2 });
    const b = makeStep({ id: 'b', order: 1 });
    const c = makeStep({ id: 'c', order: 2 });
    const sorted = sortSteps([a, b, c]);
    expect(sorted.map((s) => s.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('OperationExecutor — approval', () => {
  it('rejects a non-empty plan without an approval token', async () => {
    const { deps } = makeDeps();
    const exec = new OperationExecutor(deps);
    await expect(exec.execute(makePlan([makeStep()]))).rejects.toThrow(/approvalToken required/);
  });

  it('rejects an unknown approval token', async () => {
    const { deps } = makeDeps();
    const exec = new OperationExecutor(deps);
    await expect(exec.execute(makePlan([makeStep()]), { approvalToken: 'nope' })).rejects.toThrow(/unknown approval token/);
  });

  it('rejects a token issued for a different plan', async () => {
    const { deps } = makeDeps();
    const approval = makeApproval('p2');
    currentApprovals.set(approval.token, approval);
    const exec = new OperationExecutor(deps);
    await expect(exec.execute(makePlan([makeStep()]), { approvalToken: approval.token })).rejects.toThrow(/does not match plan/);
  });

  it('rejects an expired token', async () => {
    const { deps } = makeDeps();
    const approval = makeApproval('p1', -1);
    currentApprovals.set(approval.token, approval);
    const exec = new OperationExecutor(deps);
    await expect(exec.execute(makePlan([makeStep()]), { approvalToken: approval.token })).rejects.toThrow(/expired/);
  });

  it('consumes the token even before any step runs (single-use)', async () => {
    const { deps } = makeDeps();
    const approval = makeApproval('p1');
    currentApprovals.set(approval.token, approval);
    const exec = new OperationExecutor(deps);
    await exec.execute(makePlan([makeStep()]), { approvalToken: approval.token });
    expect(currentApprovals.has(approval.token)).toBe(false);
  });

  it('rejects a plan whose approved content has changed', async () => {
    const { deps } = makeDeps();
    const plan = makePlan([makeStep()]);
    const approval = makeApproval('p1');
    approval.planHash = await hashApprovedPlan(plan);
    currentApprovals.set(approval.token, approval);
    plan.steps[0].desiredAfter.title = 'tampered';
    const exec = new OperationExecutor(deps);
    await expect(exec.execute(plan, { approvalToken: approval.token })).rejects.toThrow(/changed after approval/);
  });
});

describe('OperationExecutor — applies steps in order', () => {
  it('runs two renames in declared order, then a move', async () => {
    currentTree = [
      { id: 'A', title: 'A', children: [
        { id: 'b1', title: 'b1', parentId: 'A', children: [] },
        { id: 'b2', title: 'b2', parentId: 'A', children: [] },
        { id: 'B', title: 'B', children: [] },
      ] },
    ];
    const { deps, api } = makeDeps();
    const approval = makeApproval('p1');
    currentApprovals.set(approval.token, approval);
    const exec = new OperationExecutor(deps);
    const plan = makePlan([
      makeStep({ id: 's1', order: 0, targetBrowserId: 'b1', expectedBefore: { title: 'b1' }, desiredAfter: { title: 'b1-renamed' } }),
      makeStep({ id: 's2', order: 1, targetBrowserId: 'b2', expectedBefore: { title: 'b2' }, desiredAfter: { title: 'b2-renamed' } }),
      makeStep({ id: 's3', order: 2, action: 'move', targetBrowserId: 'b1', expectedBefore: { parentId: 'A' }, desiredAfter: { parentId: 'B' } }),
    ]);
    const result = await exec.execute(plan, { approvalToken: approval.token });
    expect(result.status).toBe('completed');
    expect(result.succeeded).toBe(3);
    expect(api.update).toHaveBeenCalledTimes(2);
    expect(api.move).toHaveBeenCalledTimes(1);
  });

  it('halts on the first failing step', async () => {
    currentTree = [
      { id: 'A', children: [
        { id: 'b1', title: 'b1', parentId: 'A', children: [] },
        { id: 'b2', title: 'b2', parentId: 'A', children: [] },
      ] },
    ];
    const { deps, api } = makeDeps();
    // Make the second step's api.update throw.
    api.update.mockImplementation(async (id: string, _changes: unknown) => {
      if (id === 'b2') throw new Error('boom');
      const node = findById(currentTree, id);
      if (node) node.title = '...';
    });
    const approval = makeApproval('p1');
    currentApprovals.set(approval.token, approval);
    const exec = new OperationExecutor(deps);
    const plan = makePlan([
      makeStep({ id: 's1', order: 0, targetBrowserId: 'b1', expectedBefore: { title: 'b1' }, desiredAfter: { title: 'b1-r' } }),
      makeStep({ id: 's2', order: 1, targetBrowserId: 'b2', expectedBefore: { title: 'b2' }, desiredAfter: { title: 'b2-r' } }),
      makeStep({ id: 's3', order: 2, targetBrowserId: 'b1', action: 'update', expectedBefore: { url: 'x' }, desiredAfter: { url: 'y' } }),
    ]);
    const result = await exec.execute(plan, { approvalToken: approval.token });
    expect(result.failed).toBeGreaterThan(0);
    // b1 was renamed (s1 succeeded); b2 failed; s3 must have been skipped.
    const s3 = currentSteps.get('s3');
    expect(s3?.status).toBe('skipped');
  });
});

describe('OperationExecutor — compensation', () => {
  it('records the created browser id and removes that node on a later failure', async () => {
    currentTree = [{ id: 'root', title: 'root', children: [] }];
    const { deps, api } = makeDeps();
    api.update.mockRejectedValue(new Error('forced failure'));
    const approval = makeApproval('p1');
    currentApprovals.set(approval.token, approval);
    const exec = new OperationExecutor(deps);
    const create = makeStep({
      id: 'create', action: 'create', targetBrowserId: null, parentBrowserId: 'root',
      expectedBefore: {}, desiredAfter: { title: 'temporary', url: 'https://example.com' },
    });
    const fail = makeStep({ id: 'fail', order: 1, action: 'update', targetBrowserId: 'missing' });
    await exec.execute(makePlan([create, fail]), { approvalToken: approval.token });
    expect(create.desiredAfter.createdBrowserId).toMatch(/^new-/);
    expect(findById(currentTree, String(create.desiredAfter.createdBrowserId))).toBeUndefined();
  });

  it('compensates a succeeded rename when a later step fails', async () => {
    currentTree = [
      { id: 'A', children: [
        { id: 'b1', title: 'orig1', parentId: 'A', children: [] },
        { id: 'b2', title: 'orig2', parentId: 'A', children: [] },
      ] },
    ];
    const { deps, api } = makeDeps();
    api.update.mockImplementation(async (id: string, changes: { title?: string }) => {
      const node = findById(currentTree, id);
      if (!node) throw new Error('not found');
      if (changes.title === 'never') throw new Error('forced failure');
      if (changes.title) node.title = changes.title;
    });
    const approval = makeApproval('p1');
    currentApprovals.set(approval.token, approval);
    const exec = new OperationExecutor(deps);
    const plan = makePlan([
      makeStep({ id: 's1', order: 0, targetBrowserId: 'b1', expectedBefore: { title: 'orig1' }, desiredAfter: { title: 's1' } }),
      makeStep({ id: 's2', order: 1, targetBrowserId: 'b2', expectedBefore: { title: 'orig2' }, desiredAfter: { title: 'never' } }),
    ]);
    await exec.execute(plan, { approvalToken: approval.token });
    // After compensation, b1 should be back to 'orig1'.
    expect(findById(currentTree, 'b1')?.title).toBe('orig1');
  });
});

describe('OperationExecutor — assertStillValid and dry-run', () => {
  it('fails a step when assertStillValid throws', async () => {
    const { deps } = makeDeps();
    let call = 0;
    deps.assertStillValid.mockImplementation(async () => {
      call += 1;
      if (call === 1) throw new AppErrorImpl('PLAN_STALE', 'stale', false);
    });
    const approval = makeApproval('p1');
    currentApprovals.set(approval.token, approval);
    const exec = new OperationExecutor(deps);
    const plan = makePlan([makeStep()]);
    const result = await exec.execute(plan, { approvalToken: approval.token });
    expect(result.failed).toBe(1);
  });

  it('dry-run does not call any write api', async () => {
    const { deps, api } = makeDeps();
    const approval = makeApproval('p1');
    currentApprovals.set(approval.token, approval);
    const exec = new OperationExecutor(deps);
    const plan = makePlan([makeStep({ action: 'rename' })]);
    await exec.execute(plan, { approvalToken: approval.token, dryRun: true });
    expect(api.create).not.toHaveBeenCalled();
    expect(api.update).not.toHaveBeenCalled();
    expect(api.move).not.toHaveBeenCalled();
    expect(api.remove).not.toHaveBeenCalled();
  });
});
