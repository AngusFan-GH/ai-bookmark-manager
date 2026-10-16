import { describe, expect, it, vi } from 'vitest';
import { PlanService, type PlanServiceDeps, type OrganizationStepInput } from '../../src/domain/operations/plan-service';
import type { BookmarkApiNode } from '../../src/domain/operations/executor';
import type { Approval, OperationPlan, OperationStep, TreeSnapshot } from '../../src/domain/operations/types';

function fixture() {
  let counter = 0;
  const nodes = new Map<string, BookmarkApiNode>([
    ['0', { id: '0', title: '' }], ['1', { id: '1', parentId: '0', title: 'Bar' }],
    ['f', { id: 'f', parentId: '1', title: 'Folder', index: 0 }],
    ['b', { id: 'b', parentId: 'f', title: 'Bookmark', url: 'https://example.test', index: 0 }],
    ['other', { id: 'other', parentId: '1', title: 'Other', index: 1 }],
  ]);
  const nativeTree = (id = '0'): BookmarkApiNode => {
    const node = nodes.get(id);
    if (!node) throw new Error('missing native ID');
    return { ...node, ...(node.url === undefined ? { children: [...nodes.values()].filter(n => n.parentId === id).map(n => nativeTree(n.id)) } : {}) };
  };
  const plans = new Map<string, OperationPlan>();
  const steps = new Map<string, OperationStep>();
  const snapshots = new Map<string, TreeSnapshot>();
  const approvals = new Map<string, Approval>();
  const deps: PlanServiceDeps = {
    bookmarksApi: {
      get: async id => structuredClone(nodes.get(id) ?? (() => { throw new Error('missing'); })()),
      getTree: async () => [nativeTree()], getSubTree: async id => [nativeTree(id)],
      create: vi.fn(async input => { const node = { ...input, id: `new-${++counter}` }; nodes.set(node.id, node); return node; }),
      update: vi.fn(async (id, fields) => { Object.assign(nodes.get(id)!, fields); }),
      move: vi.fn(async (id, fields) => { Object.assign(nodes.get(id)!, fields); }),
      remove: vi.fn(async id => {
        if ([...nodes.values()].some(n => n.parentId === id)) throw new Error('folder is not empty');
        if (!nodes.delete(id)) throw new Error('missing');
      }),
    },
    plansStore: { put: async p => { plans.set(p.id, structuredClone(p)); }, get: async id => structuredClone(plans.get(id)), list: async () => structuredClone([...plans.values()]) },
    stepsStore: { put: async s => { steps.set(s.id, structuredClone(s)); }, listByPlan: async id => [...steps.values()].filter(s => s.planId === id) },
    auditStore: { append: vi.fn(async () => {}) },
    snapshotsStore: { put: vi.fn(async s => { snapshots.set(s.id, structuredClone(s)); }), get: async id => structuredClone(snapshots.get(id)), listByPlan: async id => [...snapshots.values()].filter(s => s.planId === id) },
    approvalsStore: { put: async a => { approvals.set(a.token, a); }, take: async token => { const a = approvals.get(token); approvals.delete(token); return a; } },
    newId: () => `id-${++counter}`, now: () => Date.now(), currentSyncGeneration: () => 1,
  };
  const service = new PlanService(deps);
  const execute = async (plan: OperationPlan) => { const a = await service.approve(plan.id); return service.execute(plan.id, a.token); };
  const perform = async (input: OrganizationStepInput[]) => {
    const plan = await service.draftOrganization({ steps: input });
    expect((await execute(plan)).status).toBe('completed');
    return plan;
  };
  return { service, nodes, deps, plans, execute, perform };
}

describe('reviewable targeted recovery', () => {
  it('recovers update and move without touching later unrelated additions', async () => {
    const f = fixture();
    const update = await f.perform([{ action: 'update', targetBrowserId: 'b', desiredAfter: { title: 'New', url: 'https://new.test' } }]);
    f.nodes.set('later', { id: 'later', parentId: '1', title: 'Later', url: 'https://later.test' });
    const recovery = await f.service.draftRecovery(update.id);
    expect(recovery.status).toBe('draft');
    expect(f.nodes.get('b')?.title).toBe('New');
    await f.execute(recovery);
    expect(f.nodes.get('b')).toMatchObject({ title: 'Bookmark', url: 'https://example.test' });
    expect(f.nodes.has('later')).toBe(true);
    const moved = await f.perform([{ action: 'move', targetBrowserId: 'b', parentBrowserId: 'other', desiredAfter: { index: 2 } }]);
    await f.execute(await f.service.draftRecovery(moved.id));
    expect(f.nodes.get('b')).toMatchObject({ parentId: 'f', index: 0 });
  });
  it('restores nested deleted folders with new IDs and preserved contents', async () => {
    const f = fixture();
    f.nodes.set('nested', { id: 'nested', parentId: 'f', title: 'Nested folder', index: 0 });
    f.nodes.get('b')!.parentId = 'nested';
    const plan = await f.perform([{ action: 'delete', targetBrowserId: 'b' }, { action: 'delete', targetBrowserId: 'nested' }, { action: 'delete', targetBrowserId: 'f' }]);
    const recovery = await f.service.draftRecovery(plan.id);
    expect(recovery.steps.map(s => s.action)).toEqual(['create', 'create', 'create']);
    expect(recovery.steps[1].parentStepId).toBe(recovery.steps[0].id);
    expect(recovery.steps[2].parentStepId).toBe(recovery.steps[1].id);
    await f.execute(recovery);
    const folder = [...f.nodes.values()].find(n => n.title === 'Folder')!;
    const bookmark = [...f.nodes.values()].find(n => n.url === 'https://example.test')!;
    expect(folder.id).not.toBe('f'); expect(bookmark.id).not.toBe('b');
    const nested = [...f.nodes.values()].find(n => n.title === 'Nested folder')!;
    expect(nested.parentId).toBe(folder.id);
    expect(bookmark.parentId).toBe(nested.id);
    await expect(f.service.draftRecovery(plan.id)).rejects.toThrow(/already attempted/);
    expect([...f.nodes.values()].filter(n => n.url === bookmark.url)).toHaveLength(1);
  });
  it('returns the same pending recovery for concurrent requests', async () => {
    const f = fixture(); const plan = await f.perform([{ action: 'delete', targetBrowserId: 'b' }]);
    const [a, b] = await Promise.all([f.service.draftRecovery(plan.id), f.service.draftRecovery(plan.id)]);
    expect(a.id).toBe(b.id);
    expect((await f.service.draftRecovery(plan.id)).id).toBe(a.id);
  });
  it('refuses external content edits before drafting and after drafting', async () => {
    const f = fixture(); const plan = await f.perform([{ action: 'rename', targetBrowserId: 'b', desiredAfter: { title: 'New' } }]);
    f.nodes.get('b')!.title = 'External';
    await expect(f.service.draftRecovery(plan.id)).rejects.toThrow(/changed after/);
    f.nodes.get('b')!.title = 'New';
    const recovery = await f.service.draftRecovery(plan.id);
    f.nodes.get('b')!.url = 'https://external.test';
    expect((await f.execute(recovery)).failed).toBe(1);
    expect(f.nodes.get('b')).toMatchObject({ title: 'New', url: 'https://external.test' });
  });
  it('never removes externally added children when undoing a created folder', async () => {
    const f = fixture(); const plan = await f.perform([{ action: 'create', parentBrowserId: '1', desiredAfter: { title: 'Created' } }]);
    const folder = [...f.nodes.values()].find(n => n.title === 'Created')!;
    f.nodes.set('external', { id: 'external', parentId: folder.id, title: 'User addition', url: 'https://later.test' });
    await expect(f.service.draftRecovery(plan.id)).rejects.toThrow(/later or unrecovered children/);
    expect(f.nodes.has('external')).toBe(true);
  });
  it('removes only the exact node created by the original plan', async () => {
    const f = fixture(); const plan = await f.perform([{ action: 'create', parentBrowserId: '1', desiredAfter: { title: 'New bookmark', url: 'https://new.test' } }]);
    const created = [...f.nodes.values()].find(n => n.title === 'New bookmark')!;
    await f.execute(await f.service.draftRecovery(plan.id));
    expect(f.nodes.has(created.id)).toBe(false); expect(f.nodes.has('b')).toBe(true);
  });
  it('fails closed when post-write state or execution backup is unavailable', async () => {
    const f = fixture(); const plan = await f.perform([{ action: 'rename', targetBrowserId: 'b', desiredAfter: { title: 'New' } }]);
    const persisted = f.plans.get(plan.id)!; delete persisted.steps[0].recoveryAfter;
    await expect(f.service.draftRecovery(plan.id)).rejects.toThrow(/post-write evidence/);
    delete persisted.metadata['plan-service.snapshot'];
    await expect(f.service.draftRecovery(plan.id)).rejects.toThrow(/backup/);
  });
  it('performs no recovery writes if the fresh recovery backup fails', async () => {
    const f = fixture(); const plan = await f.perform([{ action: 'delete', targetBrowserId: 'b' }]);
    const recovery = await f.service.draftRecovery(plan.id);
    vi.mocked(f.deps.snapshotsStore.put).mockRejectedValueOnce(new Error('disk full'));
    await expect(f.execute(recovery)).rejects.toThrow('disk full');
    expect(f.deps.bookmarksApi.create).not.toHaveBeenCalled();
  });
  it('rejects nonempty folder deletion unless descendants are explicitly reviewed first', async () => {
    const f = fixture();
    await expect(f.service.draftOrganization({ steps: [{ action: 'delete', targetBrowserId: 'f' }] })).rejects.toThrow(/folder must be empty/);
    await expect(f.service.draftOrganization({ steps: [{ action: 'delete', targetBrowserId: 'f' }, { action: 'delete', targetBrowserId: 'b' }] })).rejects.toThrow(/folder must be empty/);
    expect(f.deps.bookmarksApi.remove).not.toHaveBeenCalled();
  });
  it('supports creating nested folders and bookmarks via earlier create steps', async () => {
    const f = fixture();
    await f.perform([
      { action: 'create', parentBrowserId: '1', desiredAfter: { title: 'Parent' } },
      { action: 'create', parentStepIndex: 0, desiredAfter: { title: 'Child' } },
      { action: 'create', parentStepIndex: 1, desiredAfter: { title: 'Leaf', url: 'https://leaf.test' } },
    ]);
    const child = [...f.nodes.values()].find(n => n.title === 'Child')!;
    expect([...f.nodes.values()].find(n => n.title === 'Leaf')?.parentId).toBe(child.id);
  });
  it('cannot turn a folder into a bookmark by updating its URL', async () => {
    const f = fixture();
    await expect(f.service.draftOrganization({ steps: [{ action: 'update', targetBrowserId: 'f', desiredAfter: { url: 'https://bad.test' } }] })).rejects.toThrow(/convert a folder/);
  });
});

it('rejects reorder changes after a move recovery preview', async () => {
  const f = fixture();
  const plan = await f.perform([{ action: 'move', targetBrowserId: 'b', parentBrowserId: 'other', desiredAfter: { index: 2 } }]);
  const recovery = await f.service.draftRecovery(plan.id);
  f.nodes.get('b')!.index = 3;
  expect((await f.execute(recovery)).failed).toBe(1);
  expect(f.nodes.get('b')).toMatchObject({ parentId: 'other', index: 3 });
});

it('refuses to recover an uncertain interrupted native write', async () => {
  const f = fixture();
  const plan = await f.perform([{ action: 'rename', targetBrowserId: 'b', desiredAfter: { title: 'New' } }]);
  const stored = f.plans.get(plan.id)!;
  stored.status = 'partially_completed';
  stored.steps[0].status = 'failed';
  await expect(f.service.draftRecovery(plan.id)).rejects.toThrow(/uncertain outcome/);
});

it('undoes nested created folders child-first and preserves outside nodes', async () => {
  const f = fixture();
  const plan = await f.perform([
    { action: 'create', parentBrowserId: '1', desiredAfter: { title: 'Parent' } },
    { action: 'create', parentStepIndex: 0, desiredAfter: { title: 'Child' } },
    { action: 'create', parentStepIndex: 1, desiredAfter: { title: 'Leaf', url: 'https://leaf.test' } },
  ]);
  const recovery = await f.service.draftRecovery(plan.id);
  expect(recovery.steps.map(s => s.expectedBefore.title)).toEqual(['Leaf', 'Child', 'Parent']);
  await f.execute(recovery);
  expect(f.nodes.size).toBe(5);
});

it('does not delete children added after a create-recovery preview', async () => {
  const f = fixture();
  const plan = await f.perform([{ action: 'create', parentBrowserId: '1', desiredAfter: { title: 'Created' } }]);
  const recovery = await f.service.draftRecovery(plan.id);
  const folder = [...f.nodes.values()].find(n => n.title === 'Created')!;
  f.nodes.set('external', { id: 'external', parentId: folder.id, title: 'External', url: 'https://external.test' });
  expect((await f.execute(recovery)).failed).toBe(1);
  expect(f.nodes.has(folder.id)).toBe(true);
  expect(f.nodes.has('external')).toBe(true);
});

it('blocks replay even if another valid approval token was persisted for the plan', async () => {
  const f = fixture();
  const plan = await f.service.draftOrganization({ steps: [{ action: 'create', parentBrowserId: '1', desiredAfter: { title: 'One only' } }] });
  const approval = await f.service.approve(plan.id);
  await f.service.execute(plan.id, approval.token);
  await expect(f.service.execute(plan.id, approval.token)).rejects.toThrow(/already attempted/);
  expect(f.deps.bookmarksApi.create).toHaveBeenCalledTimes(1);
});

it('reviews and executes update plus move on one target, then recovers both in reverse order', async () => {
  const f = fixture();
  const plan = await f.service.draftOrganization({ steps: [
    { action: 'update', targetBrowserId: 'b', desiredAfter: { title: 'Edited', url: 'https://edited.test' } },
    { action: 'move', targetBrowserId: 'b', parentBrowserId: 'other', desiredAfter: { index: 2 } },
  ] });
  expect(plan.steps[1].expectedBefore).toMatchObject({ title: 'Edited', url: 'https://edited.test', parentId: 'f' });
  expect(plan.steps[1].dependsOn).toContain(plan.steps[0].id);
  expect((await f.execute(plan)).status).toBe('completed');
  expect(f.nodes.get('b')).toMatchObject({ title: 'Edited', url: 'https://edited.test', parentId: 'other', index: 2 });
  const recovery = await f.service.draftRecovery(plan.id);
  expect(recovery.steps.map(s => s.action)).toEqual(['move', 'update']);
  expect((await f.execute(recovery)).status).toBe('completed');
  expect(f.nodes.get('b')).toMatchObject({ title: 'Bookmark', url: 'https://example.test', parentId: 'f', index: 0 });
});

it('does not overwrite external changes between sequential target writes', async () => {
  const f = fixture();
  const originalUpdate = f.deps.bookmarksApi.update;
  f.deps.bookmarksApi.update = vi.fn(async (id, fields) => {
    await originalUpdate(id, fields);
    if (fields.title === 'Edited') f.nodes.get(id)!.url = 'https://external.test';
  });
  const plan = await f.service.draftOrganization({ steps: [
    { action: 'update', targetBrowserId: 'b', desiredAfter: { title: 'Edited' } },
    { action: 'move', targetBrowserId: 'b', parentBrowserId: 'other' },
  ] });
  expect((await f.execute(plan)).failed).toBe(1);
  expect(f.deps.bookmarksApi.move).not.toHaveBeenCalled();
  expect(f.nodes.get('b')!.url).toBe('https://external.test');
});

it('provides a persisted downloadable recovery preview snapshot including local metadata', async () => {
  const f = fixture();
  const source = await f.perform([{ action: 'rename', targetBrowserId: 'b', desiredAfter: { title: 'Changed' } }]);
  f.deps.captureLocalIndex = async () => ({ bookmarks: [{ browserId: 'b', tags: ['local'] }], folders: [] });
  const recovery = await f.service.draftRecovery(source.id);
  expect(recovery.metadata['plan-service.snapshot']).toBeTruthy();
  const backup = await f.deps.snapshotsStore.get(recovery.metadata['plan-service.snapshot']);
  expect(backup?.planId).toBe(recovery.id);
  expect(backup?.localIndex.bookmarks).toEqual([{ browserId: 'b', tags: ['local'] }]);
  expect(JSON.stringify(backup?.tree)).toContain('Changed');
  expect(await f.service.getPlanSnapshots(recovery.id)).toHaveLength(1);
  expect((await f.service.getPlan(recovery.id))?.metadata['plan-service.snapshot']).toBe(backup?.id);
  const previewId = backup?.id;
  await f.execute(recovery);
  expect((await f.service.getPlan(recovery.id))?.metadata['plan-service.snapshot']).not.toBe(previewId);
  expect(await f.service.getPlanSnapshots(recovery.id)).toHaveLength(2);
});

it.each(['snapshot', 'local metadata'])('does not reserve or persist recovery when %s preview capture fails', async failure => {
  const f = fixture();
  const source = await f.perform([{ action: 'delete', targetBrowserId: 'b' }]);
  if (failure === 'snapshot') vi.mocked(f.deps.snapshotsStore.put).mockRejectedValueOnce(new Error('backup unavailable'));
  else f.deps.captureLocalIndex = async () => { throw new Error('backup unavailable'); };
  await expect(f.service.draftRecovery(source.id)).rejects.toThrow('backup unavailable');
  expect((await f.service.listPlans()).map(p => p.id)).toEqual([source.id]);
  expect((await f.service.getPlan(source.id))?.metadata['plan-service.recovery-plan']).toBeUndefined();
  expect(f.deps.bookmarksApi.create).not.toHaveBeenCalled();
  delete f.deps.captureLocalIndex;
  expect((await f.service.draftRecovery(source.id)).metadata['plan-service.snapshot']).toBeTruthy();
});
