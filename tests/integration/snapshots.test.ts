// tests/integration/snapshots.test.ts
//
// SnapshotService + path remap tests.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { SnapshotService, buildPathMap, remapByPath } from '../../src/domain/operations/snapshots';
import type { TreeSnapshot } from '../../src/domain/operations/types';

let saved: TreeSnapshot[] = [];
let nextIdCounter = 0;
const nextId = (): string => `snap-${++nextIdCounter}`;

function makeDeps() {
  return {
    captureTree: vi.fn(async () => [{ id: 'live-root', title: '', children: [] }]),
    captureLocalIndex: vi.fn(async () => ({ bookmarks: [], folders: [] })),
    saveSnapshot: vi.fn(async (s: TreeSnapshot) => { saved.push(s); }),
    readSnapshot: vi.fn(async (id: string) => saved.find((s) => s.id === id)),
    listSnapshotsByPlan: vi.fn(async (planId: string) => saved.filter((s) => s.planId === planId)),
    newId: nextId,
    now: () => 1_000_000,
    currentGeneration: () => 5,
  };
}

beforeEach(() => { saved = []; nextIdCounter = 0; });

describe('SnapshotService', () => {
  it('captures a snapshot with the expected fields', async () => {
    const svc = new SnapshotService(makeDeps());
    const s = await svc.capture('p1', 'before plan p1');
    expect(s.id).toMatch(/^snap-/);
    expect(s.planId).toBe('p1');
    expect(s.reason).toBe('before plan p1');
    expect(s.syncGeneration).toBe(5);
    expect(s.createdAt).toBe(1_000_000);
    expect(saved).toHaveLength(1);
  });

  it('lists snapshots for a plan', async () => {
    const svc = new SnapshotService(makeDeps());
    await svc.capture('p1', 'a');
    await svc.capture('p1', 'b');
    await svc.capture('p2', 'c');
    const list = await svc.listForPlan('p1');
    expect(list).toHaveLength(2);
  });
});

describe('buildPathMap', () => {
  it('maps path → id for the whole tree', () => {
    const t = [
      { id: 'A', title: 'A', children: [
        { id: 'B', title: 'B', children: [
          { id: 'x', title: 'x', children: [] },
        ] },
      ] },
    ];
    const m = buildPathMap(t as any);
    expect(m.get('A')).toBe('A');
    expect(m.get('A / B')).toBe('B');
    expect(m.get('A / B / x')).toBe('x');
  });
});

describe('remapByPath', () => {
  it('returns a map of staleId → liveId for matched paths', () => {
    const live = [
      { id: 'liveA', title: 'A', children: [
        { id: 'liveB', title: 'B', children: [] },
      ] },
    ];
    const stalePaths = new Map<string, string>([
      ['staleA', 'A'],
      ['staleB', 'A / B'],
      ['staleC', 'A / missing'],
    ]);
    const m = remapByPath(stalePaths, live as any);
    expect(m.get('staleA')).toBe('liveA');
    expect(m.get('staleB')).toBe('liveB');
    expect(m.has('staleC')).toBe(false); // dropped
  });
});
