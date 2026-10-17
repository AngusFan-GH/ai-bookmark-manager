import { describe, expect, it, vi } from 'vitest';
import { PlanService, type PlanServiceDeps } from '../../src/domain/operations/plan-service';
import type { BookmarkApiNode } from '../../src/domain/operations/executor';
import type { Approval, OperationPlan, TreeSnapshot } from '../../src/domain/operations/types';

function fixture() {
  const tree: BookmarkApiNode[] = [{ id: '0', title: '', children: [{ id: '1', parentId: '0', title: 'Bar', children: [{ id: 'b', parentId: '1', title: 'Old', url: 'https://example.test' }] }] }];
  const find = (id: string, nodes = tree): BookmarkApiNode | undefined => nodes.flatMap(n => [n, ...(n.children ?? [])]).find(n => n.id === id) ?? nodes.map(n => find(id, n.children ?? [])).find(Boolean);
  const plans = new Map<string, OperationPlan>(); const approvals = new Map<string, Approval>(); const snapshots: TreeSnapshot[] = []; let id = 0;
  const deps: PlanServiceDeps = {
    bookmarksApi: {
      get: vi.fn(async key => { const node = find(key); if (!node) throw new Error('missing'); return structuredClone(node); }),
      getTree: vi.fn(async () => structuredClone(tree)), getSubTree: vi.fn(async key => [structuredClone(find(key)!)]),
      create: vi.fn(async input => { const node = { ...input, id: `native-${++id}`, children: [] }; find(input.parentId)!.children!.push(node); return node; }),
      update: vi.fn(async (key, changes) => { Object.assign(find(key)!, changes); }), move: vi.fn(async () => {}), remove: vi.fn(async () => {}),
    },
    plansStore: { put: async p => { plans.set(p.id, structuredClone(p)); }, get: async key => structuredClone(plans.get(key)), list: async () => [...plans.values()] },
    stepsStore: { put: async () => {}, listByPlan: async key => plans.get(key)?.steps ?? [] }, auditStore: { append: async () => {} },
    snapshotsStore: { put: vi.fn(async s => { snapshots.push(structuredClone(s)); }), get: async key => snapshots.find(s => s.id === key), listByPlan: async key => snapshots.filter(s => s.planId === key) },
    approvalsStore: { put: async a => { approvals.set(a.token, a); }, take: async key => { const a = approvals.get(key); approvals.delete(key); return a; } },
    currentSyncGeneration: () => 1, now: () => Date.now(), newId: () => `id-${++id}`,
  };
  const raw = (nodes = tree) => JSON.stringify({ formatVersion: 1, browserTree: nodes });
  return { tree, find, deps, service: new PlanService(deps), snapshots, raw };
}

describe('PlanService safety regressions', () => {
  it('binds every persisted step to its plan', async () => {
    const f = fixture(); const imported = structuredClone(f.tree); imported[0].children![0].children = [];
    const p = await f.service.draftPlan(f.raw(imported), 'controlled-merge');
    expect(p.steps.every(s => s.planId === p.id)).toBe(true);
    expect(p.steps[0].expectedBefore).toMatchObject({ title: 'Old', url: 'https://example.test', parentId: '1' });
  });
  it('rejects a delete when the live title changed after preview', async () => {
    const f = fixture(); const imported = structuredClone(f.tree); imported[0].children![0].children = [];
    const p = await f.service.draftPlan(f.raw(imported), 'controlled-merge'); const a = await f.service.approve(p.id);
    f.find('b')!.title = 'Edited';
    expect((await f.service.execute(p.id, a.token)).failed).toBe(1);
    expect(f.deps.bookmarksApi.remove).not.toHaveBeenCalled();
  });
  it('maps nested imported parents to newly assigned native IDs', async () => {
    const f = fixture(); const imported = structuredClone(f.tree);
    imported[0].children![0].children!.push({ id: 'import-folder', parentId: '1', title: 'Folder', children: [{ id: 'import-bookmark', parentId: 'import-folder', title: 'Nested', url: 'https://nested.test' }] });
    const p = await f.service.draftPlan(f.raw(imported), 'additive'); const a = await f.service.approve(p.id);
    expect(p.steps[1].dependsOn).toEqual([p.steps[0].id]);
    expect((await f.service.execute(p.id, a.token)).status).toBe('completed');
    const calls = vi.mocked(f.deps.bookmarksApi.create).mock.calls;
    expect(calls[1][0].parentId).toMatch(/^native-/);
  });
  it('captures a fresh exportable snapshot immediately before execution', async () => {
    const f = fixture(); const imported = structuredClone(f.tree); imported[0].children![0].children![0].title = 'New';
    const p = await f.service.draftPlan(f.raw(imported), 'controlled-merge'); const a = await f.service.approve(p.id);
    f.tree[0].children![0].children!.push({ id: 'later', parentId: '1', title: 'Added later', url: 'https://later.test' });
    await f.service.execute(p.id, a.token);
    const snapshots = await f.service.getPlanSnapshots(p.id);
    expect(JSON.stringify(snapshots.at(-1)?.tree)).toContain('Added later');
    expect(JSON.stringify(snapshots.at(-1)?.tree)).toContain('Old');
  });
  it('does not perform any native writes when backup persistence fails', async () => {
    const f = fixture(); const imported = structuredClone(f.tree); imported[0].children![0].children![0].title = 'New';
    const p = await f.service.draftPlan(f.raw(imported), 'controlled-merge'); const a = await f.service.approve(p.id);
    vi.mocked(f.deps.snapshotsStore.put).mockRejectedValueOnce(new Error('disk full'));
    await expect(f.service.execute(p.id, a.token)).rejects.toThrow('disk full');
    expect(f.deps.bookmarksApi.update).not.toHaveBeenCalled();
  });
});

it('drafts organization with captured live state and never writes without approval', async () => {
  const f = fixture(); const p = await f.service.draftOrganization({ steps: [{ action: 'rename', targetBrowserId: 'b', desiredAfter: { title: 'Organized' } }] });
  expect(p.steps[0].expectedBefore).toMatchObject({ title: 'Old', url: 'https://example.test', parentId: '1' });
  await expect(f.service.execute(p.id, 'unknown')).rejects.toThrow();
  expect(f.deps.bookmarksApi.update).not.toHaveBeenCalled();
  const approval = await f.service.approve(p.id);
  expect((await f.service.execute(p.id, approval.token)).status).toBe('completed');
  expect(f.deps.bookmarksApi.update).toHaveBeenCalledWith('b', { title: 'Organized' });
});
it('rejects protected roots, non-folder parents, cycles, and inappropriate fields', async () => {
  const f = fixture();
  await expect(f.service.draftOrganization({ steps: [{ action: 'delete', targetBrowserId: '1' }] })).rejects.toThrow(/protected/);
  await expect(f.service.draftOrganization({ steps: [{ action: 'create', parentBrowserId: 'b', desiredAfter: { title: 'bad' } }] })).rejects.toThrow(/folder/);
  f.tree[0].children![0].children!.push({ id: 'folder', parentId: '1', title: 'F', children: [{ id: 'child', parentId: 'folder', title: 'C', children: [] }] });
  await expect(f.service.draftOrganization({ steps: [{ action: 'move', targetBrowserId: 'folder', parentBrowserId: 'child' }] })).rejects.toThrow(/cycle/);
  await expect(f.service.draftOrganization({ steps: [{ action: 'rename', targetBrowserId: 'b', desiredAfter: { title: 'OK', url: 'https://ignored.test' } }] })).rejects.toThrow(/field/);
});
it('orders deleted descendants before their folders', async () => {
  const f = fixture();
  f.tree[0].children![0].children!.push({ id: 'folder', parentId: '1', title: 'F', children: [{ id: 'child', parentId: 'folder', title: 'C', url: 'https://child.test' }] });
  const imported = structuredClone(f.tree); imported[0].children![0].children = [];
  const p = await f.service.draftPlan(f.raw(imported), 'controlled-merge');
  expect(p.steps.findIndex(s => s.targetBrowserId === 'child')).toBeLessThan(p.steps.findIndex(s => s.targetBrowserId === 'folder'));
});
it.each(['move', 'update'] as const)('rejects stale %s targets after drafting', async action => {
  const f = fixture();
  const p = await f.service.draftOrganization({ steps: [{ action, targetBrowserId: 'b', ...(action === 'move' ? { parentBrowserId: '1' } : { desiredAfter: { title: 'Changed' } }) }] });
  const a = await f.service.approve(p.id); f.find('b')!.url = 'https://externally-edited.test';
  expect((await f.service.execute(p.id, a.token)).failed).toBe(1);
  expect(f.deps.bookmarksApi[action]).not.toHaveBeenCalled();
});
it('detects parent-reference tampering after approval', async () => {
  const f = fixture(); const p = await f.service.draftOrganization({ steps: [{ action: 'create', parentBrowserId: '1', desiredAfter: { title: 'F' } }] });
  const a = await f.service.approve(p.id); const saved = await f.deps.plansStore.get(p.id); saved!.steps[0].parentStepId = 'injected'; await f.deps.plansStore.put(saved!);
  await expect(f.service.execute(p.id, a.token)).rejects.toThrow(/changed after approval/);
  expect(f.deps.bookmarksApi.create).not.toHaveBeenCalled();
});
it('rejects imports that would delete permanent browser folders before any execution', async () => {
  const f = fixture(); const imported = structuredClone(f.tree); imported[0].children = [];
  await expect(f.service.draftPlan(f.raw(imported), 'controlled-merge')).rejects.toThrow(/protected/);
  expect(f.deps.bookmarksApi.remove).not.toHaveBeenCalled();
});
it('provides organization backup before approval, including captured local metadata', async () => {
  const f = fixture(); f.deps.captureLocalIndex = async () => ({ bookmarks: [{ id: 'b', tags: ['kept'] }], folders: [] });
  const p = await f.service.draftOrganization({ steps: [{ action: 'rename', targetBrowserId: 'b', desiredAfter: { title: 'New' } }] });
  const snapshots = await f.service.getPlanSnapshots(p.id);
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0].tree).toEqual(f.tree);
  expect(snapshots[0].localIndex.bookmarks).toEqual([{ id: 'b', tags: ['kept'] }]);
  expect(p.metadata['plan-service.snapshot']).toBe(snapshots[0].id);
  expect(f.deps.bookmarksApi.update).not.toHaveBeenCalled();
});
it('does not persist an organization draft when its preview backup fails', async () => {
  const f = fixture(); vi.mocked(f.deps.snapshotsStore.put).mockRejectedValueOnce(new Error('backup unavailable'));
  await expect(f.service.draftOrganization({ steps: [{ action: 'delete', targetBrowserId: 'b' }] })).rejects.toThrow('backup unavailable');
  expect(await f.service.listPlans()).toEqual([]);
  expect(f.deps.bookmarksApi.remove).not.toHaveBeenCalled();
});
it('requires a fresh execution backup even when organization preview backup exists', async () => {
  const f = fixture(); const p = await f.service.draftOrganization({ steps: [{ action: 'delete', targetBrowserId: 'b' }] });
  const a = await f.service.approve(p.id);
  vi.mocked(f.deps.snapshotsStore.put).mockRejectedValueOnce(new Error('execution backup failed'));
  await expect(f.service.execute(p.id, a.token)).rejects.toThrow('execution backup failed');
  expect(f.deps.bookmarksApi.remove).not.toHaveBeenCalled();
  expect(await f.service.getPlanSnapshots(p.id)).toHaveLength(1);
});
it('maps organization moves into a newly created folder using parentStepIndex', async () => {
  const f = fixture();
  const p = await f.service.draftOrganization({ steps: [
    { action: 'create', parentBrowserId: '1', desiredAfter: { title: 'New group' } },
    { action: 'move', targetBrowserId: 'b', parentStepIndex: 0 },
  ] });
  expect(p.steps[1].parentStepId).toBe(p.steps[0].id);
  expect(p.steps[1].dependsOn).toEqual([p.steps[0].id]);
  const a = await f.service.approve(p.id);
  expect((await f.service.execute(p.id, a.token)).status).toBe('completed');
  const created = await vi.mocked(f.deps.bookmarksApi.create).mock.results[0].value;
  expect(f.deps.bookmarksApi.move).toHaveBeenCalledWith('b', { parentId: created.id });
});
it('rejects future, invalid, and bookmark parent step references', async () => {
  const f = fixture();
  for (const parentStepIndex of [-1, 0.5, 1, 999]) {
    await expect(f.service.draftOrganization({ steps: [
      { action: 'create', parentBrowserId: '1', desiredAfter: { title: 'New group' } },
      { action: 'move', targetBrowserId: 'b', parentStepIndex },
    ] })).rejects.toThrow(/parent step/i);
  }
  await expect(f.service.draftOrganization({ steps: [
    { action: 'create', parentBrowserId: '1', desiredAfter: { title: 'Bookmark', url: 'https://example.test' } },
    { action: 'move', targetBrowserId: 'b', parentStepIndex: 0 },
  ] })).rejects.toThrow(/parent step/i);
  expect(f.deps.bookmarksApi.create).not.toHaveBeenCalled();
});
it.each(['completed', 'failed', 'executing', 'partially_completed', 'cancelled'] as const)('does not approve a %s plan for replay', async status => {
  const f = fixture(); const p = await f.service.draftOrganization({ steps: [{ action: 'delete', targetBrowserId: 'b' }] });
  p.status = status; await f.deps.plansStore.put(p);
  await expect(f.service.approve(p.id)).rejects.toThrow(/cannot be approved/);
});

it('captures local metadata in the downloadable import preview backup', async () => {
 const f=fixture();const index={bookmarks:[{id:'b',title:'local'}],folders:[]};
 f.deps.captureLocalIndex=vi.fn(async()=>index as unknown as TreeSnapshot['localIndex']);
 await f.service.draftPlan(f.raw(),'additive');
 expect(f.snapshots[0].localIndex).toEqual(index);
});
it('does not save an import plan when preview metadata capture fails', async()=>{
 const f=fixture();f.deps.captureLocalIndex=vi.fn(async()=>{throw new Error('index backup failed');});
 await expect(f.service.draftPlan(f.raw(),'additive')).rejects.toThrow('index backup failed');
 expect(f.snapshots).toHaveLength(0);expect(await f.deps.plansStore.list()).toHaveLength(0);
 expect(f.deps.bookmarksApi.create).not.toHaveBeenCalled();
});

describe('suggestion and exact-duplicate evidence binding',()=>{
 const source={bookmarkId:'b',title:'Old',url:'https://example.test',path:'Bookmarks',parentId:'1'};
 it.each(['title','url','parentId'] as const)('rejects a stale AI %s before preview is persisted',async key=>{
  const f=fixture();f.find('b')![key]='changed';
  await expect(f.service.draftOrganization({evidence:{bookmarks:[source]},steps:[{action:'delete',targetBrowserId:'b'}]})).rejects.toMatchObject({code:'PLAN_STALE'});
  expect(f.snapshots).toHaveLength(0);expect(f.deps.bookmarksApi.remove).not.toHaveBeenCalled();
 });
 it('rejects missing evidence for any proposed target',async()=>{
  const f=fixture();await expect(f.service.draftOrganization({evidence:{bookmarks:[]},steps:[{action:'rename',targetBrowserId:'b',desiredAfter:{title:'AI'}}]})).rejects.toMatchObject({code:'PLAN_STALE'});
 });
 function duplicates(){
  const f=fixture();f.tree[0].children![0].children!.push({id:'survivor',title:'Keep',parentId:'1',url:source.url});
  const evidence={bookmarks:[source,{...source,bookmarkId:'survivor',title:'Keep'}],exactDuplicateGroups:[{url:source.url,bookmarkIds:['b','survivor']}]};
  return {...f,evidence};
 }
 it('rejects duplicates whose target became unique before preview',async()=>{
  const f=duplicates();f.find('b')!.url='https://unique.test';
  await expect(f.service.draftOrganization({evidence:f.evidence,steps:[{action:'delete',targetBrowserId:'b'}]})).rejects.toMatchObject({code:'PLAN_STALE'});
 });
 it('rejects stale survivor metadata before preview',async()=>{
  const f=duplicates();f.find('survivor')!.url='https://unique.test';
  await expect(f.service.draftOrganization({evidence:f.evidence,steps:[{action:'delete',targetBrowserId:'b'}]})).rejects.toMatchObject({code:'PLAN_STALE'});
 });
 it('refuses selecting every exact duplicate',async()=>{
  const f=duplicates();await expect(f.service.draftOrganization({evidence:f.evidence,steps:[{action:'delete',targetBrowserId:'b'},{action:'delete',targetBrowserId:'survivor'}]})).rejects.toMatchObject({code:'PLAN_STALE'});
 });
 it('persists evidence and rechecks survivor changes between preview and execution',async()=>{
  const f=duplicates();const plan=await f.service.draftOrganization({evidence:f.evidence,steps:[{action:'delete',targetBrowserId:'b'}]});
  expect(JSON.parse(plan.metadata['plan-service.evidence'])).toEqual(f.evidence);
  const approval=await f.service.approve(plan.id);f.find('survivor')!.url='https://unique.test';
  await expect(f.service.execute(plan.id,approval.token)).rejects.toMatchObject({code:'PLAN_STALE'});
  expect(f.deps.bookmarksApi.remove).not.toHaveBeenCalled();
 });
});


it.each(['remove','replace'] as const)('invalidates approval when duplicate evidence is %s',async mutation=>{
 const f=fixture();f.tree[0].children![0].children!.push({id:'survivor',title:'Keep',parentId:'1',url:'https://example.test'});
 const evidence={bookmarks:[{bookmarkId:'b',title:'Old',url:'https://example.test',path:'Bar',parentId:'1'},{bookmarkId:'survivor',title:'Keep',url:'https://example.test',path:'Bar',parentId:'1'}],exactDuplicateGroups:[{url:'https://example.test',bookmarkIds:['b','survivor']}]};
 const plan=await f.service.draftOrganization({evidence,steps:[{action:'delete',targetBrowserId:'b'}]});
 const approval=await f.service.approve(plan.id);
 const tampered=(await f.deps.plansStore.get(plan.id))!;
 if(mutation==='remove')delete tampered.metadata['plan-service.evidence'];
 else tampered.metadata['plan-service.evidence']=JSON.stringify({bookmarks:evidence.bookmarks.slice(0,1)});
 await f.deps.plansStore.put(tampered);
 f.find('survivor')!.url='https://now-unique.test';
 await expect(f.service.execute(plan.id,approval.token)).rejects.toMatchObject({code:'PLAN_STALE'});
 expect(f.deps.bookmarksApi.remove).not.toHaveBeenCalled();
});
