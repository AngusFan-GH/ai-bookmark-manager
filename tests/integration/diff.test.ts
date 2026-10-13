// tests/integration/diff.test.ts
//
// Diff algorithm between an import tree and the live tree.

import { describe, expect, it } from 'vitest';
import { diffImport, indexByPath, type FlatNode } from '../../src/domain/operations/diff';

function tree(nodes: FlatNode[]): FlatNode[] { return nodes; }

describe('indexByPath', () => {
  it('builds a path → node map', () => {
    const t: FlatNode[] = tree([
      { id: 'A', title: 'A', parentId: null, children: [
        { id: 'a1', title: 'a1', parentId: 'A', children: [] },
      ] },
    ]);
    const { byId, pathById, parentById } = indexByPath(t);
    expect(byId.size).toBe(2);
    expect(byId.get('A')?.id).toBe('A');
    expect(pathById.get('a1')).toBe('A / a1');
    expect(parentById.get('a1')).toBe('A');
  });
});

describe('diffImport — additive mode', () => {
  it('produces adds for ids only in the import', () => {
    const imp = tree([
      { id: 'A', title: 'A', parentId: null, children: [
        { id: 'a1', title: 'a1', parentId: 'A', url: 'https://a.test', children: [] },
      ] },
    ]);
    const live = tree([]);
    const r = diffImport(imp, live, 'additive');
    expect(r.summary.adds).toBe(2); // A and a1
    expect(r.summary.noops).toBe(0);
  });

  it('marks identical trees as noop', () => {
    const t: FlatNode[] = tree([
      { id: 'A', title: 'A', parentId: null, children: [
        { id: 'a1', title: 'a1', parentId: 'A', url: 'https://a.test', children: [] },
      ] },
    ]);
    const r = diffImport(t, t, 'additive');
    expect(r.summary.noops).toBe(2);
    expect(r.summary.adds).toBe(0);
  });

  it('skips a same-id-different-url node under additive (does not overwrite)', () => {
    const imp: FlatNode[] = tree([
      { id: 'A', title: 'A', parentId: null, children: [
        { id: 'a1', title: 'a1', parentId: 'A', url: 'https://a.test', children: [] },
      ] },
    ]);
    const live: FlatNode[] = tree([
      { id: 'A', title: 'A', parentId: null, children: [
        { id: 'a1', title: 'a1', parentId: 'A', url: 'https://b.test', children: [] },
      ] },
    ]);
    const r = diffImport(imp, live, 'additive');
    expect(r.summary.noops).toBeGreaterThanOrEqual(1);
    expect(r.conflicts.length).toBe(1);
    expect(r.summary.adds).toBe(0);
  });
});

describe('diffImport — controlled-merge mode', () => {
  it('emits updates when same id has different title or url', () => {
    const imp: FlatNode[] = tree([
      { id: 'A', title: 'A-updated', parentId: null, children: [
        { id: 'a1', title: 'a1', parentId: 'A', url: 'https://a.test/new', children: [] },
      ] },
    ]);
    const live: FlatNode[] = tree([
      { id: 'A', title: 'A', parentId: null, children: [
        { id: 'a1', title: 'a1', parentId: 'A', url: 'https://a.test', children: [] },
      ] },
    ]);
    const r = diffImport(imp, live, 'controlled-merge');
    expect(r.summary.updates).toBe(2);
  });

  it('emits deletes for live ids missing from import', () => {
    const imp: FlatNode[] = tree([
      { id: 'A', title: 'A', parentId: null, children: [] },
    ]);
    const live: FlatNode[] = tree([
      { id: 'A', title: 'A', parentId: null, children: [
        { id: 'stale', title: 'stale', parentId: 'A', children: [] },
      ] },
    ]);
    const r = diffImport(imp, live, 'controlled-merge');
    expect(r.summary.deletes).toBe(1);
  });
});

describe('diffImport — additive-with-meta', () => {
  it('still skips same-id conflicts (same as additive)', () => {
    const imp: FlatNode[] = tree([{ id: 'A', title: 'A', parentId: null, children: [
      { id: 'a1', title: 'a1', parentId: 'A', url: 'https://x', children: [] },
    ] }]);
    const live: FlatNode[] = tree([{ id: 'A', title: 'A', parentId: null, children: [
      { id: 'a1', title: 'a1', parentId: 'A', url: 'https://y', children: [] },
    ] }]);
    const r = diffImport(imp, live, 'additive-with-meta');
    expect(r.conflicts.length).toBe(1);
  });
});
