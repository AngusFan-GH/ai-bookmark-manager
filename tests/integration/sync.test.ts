// tests/integration/sync.test.ts
//
// Phase 1 acceptance tests for SyncCoordinator (dev guide § 6 "阶段 1"):
//   - 10,000 条模拟书签无丢失
//   - 事件乱序/重复：full sync always replaces the index; a partial
//     late snapshot from an older generation must not win
//   - 目录重命名/移动：path updates for descendants after rebuild
//   - 重复 ID：last write wins (consistent with current Dexie semantics)
//
// We exercise SyncCoordinator against `createTestDatabase` (a fresh
// per-test in-memory Dexie) so tests are isolated and run under
// happy-dom/Node without an extension context.

import { describe, expect, it, beforeEach } from 'vitest';
import { SyncCoordinator, DebouncedSync } from '../../src/domain/bookmarks/sync';
import { createTestDatabase } from '../../src/infrastructure/database/migrations';
import { AppErrorImpl } from '../../src/shared/errors';
import { makeFlatTree, makeTreeWithCollisions } from '../fixtures/bookmark-fixtures';
import type { SyncState } from '../../src/domain/bookmarks/types';

let currentGen = 0;
let storedState: SyncState = SyncCoordinator.defaultState();

function buildCoordinator() {
  const db = createTestDatabase(`test-${Math.random().toString(36).slice(2)}`);
  return {
    db,
    coordinator: new SyncCoordinator({
       
      db: db as any,
      readTree: () => Promise.resolve(tree),
      readState: () => Promise.resolve(storedState),
      writeState: (s: SyncState) => { storedState = s; return Promise.resolve(); },
      nextGeneration: (previousGeneration) => (currentGen = Math.max(currentGen, previousGeneration) + 1),
      now: () => Date.now(),
    }),
  };
}

let tree = makeEmpty();

function makeEmpty(): import('../../src/domain/bookmarks/types').RawBookmarkNode[] {
  return [{ id: 'root', title: '', children: [] }];
}

beforeEach(() => {
  currentGen = 0;
  storedState = SyncCoordinator.defaultState();
  tree = makeEmpty();
});

describe('SyncCoordinator — 10,000 bookmarks (Phase 1 acceptance)', () => {
  it('persists all 10,000 bookmarks without loss', async () => {
    tree = makeFlatTree(10_000);
    const { coordinator, db } = buildCoordinator();
    const t0 = performance.now();
    const r = await coordinator.fullSync('startup');
    const t1 = performance.now();
    // totalCount = 1 root folder + 10,000 bookmarks
    expect(r.count).toBe(10_001);
    const rows = await db.bookmarks.toArray();
    expect(rows).toHaveLength(10_000);
    // Sanity: titles are unique and cover the full range
    expect(new Set(rows.map((r) => r.title)).size).toBe(10_000);
    // Performance: must not take more than 2s on a normal dev machine.
    expect(t1 - t0).toBeLessThan(2000);
  });

  it('a second sync replaces the index (no duplicate records)', async () => {
    tree = makeFlatTree(100);
    const { coordinator, db } = buildCoordinator();
    await coordinator.fullSync('startup');
    expect(await db.bookmarks.count()).toBe(100);
    // Same tree (simulate: tree unchanged but a fresh full sync runs)
    await coordinator.fullSync('event');
    expect(await db.bookmarks.count()).toBe(100);
    expect(new Set((await db.bookmarks.toArray()).map((r) => r.id)).size).toBe(100);
  });
});

describe('SyncCoordinator — folder rename / move', () => {
  it('updates paths for all descendants after a folder rename', async () => {
    tree = makeTreeWithCollisions();
    const { coordinator, db } = buildCoordinator();
    await coordinator.fullSync('startup');
    // Before rename: b1 path is "Work"
    let b1 = (await db.bookmarks.get('b1'))!;
    expect(b1.path).toBe('Work');

    // Simulate a rename: re-emit tree with the folder renamed
    tree = [{
      id: 'root', title: '', children: [
        { id: 'f1', parentId: 'root', title: 'Work-Renamed', index: 0, children: [
          { id: 'b1', parentId: 'f1', title: 'Doc', index: 0, url: 'https://docs.example.com/a' },
          { id: 'b2', parentId: 'f1', title: 'Doc', index: 1, url: 'https://docs.example.com/b' },
        ] },
        { id: 'f2', parentId: 'root', title: 'Personal', index: 1, children: [
          { id: 'b3', parentId: 'f2', title: 'Doc', index: 0, url: 'https://docs.example.com/a' },
        ] },
      ],
    }];
    await coordinator.fullSync('event');
    b1 = (await db.bookmarks.get('b1'))!;
    expect(b1.path).toBe('Work-Renamed');
    const f1 = (await db.folders.get('f1'))!;
    expect(f1.path).toBe('Work-Renamed');
  });

  it('updates paths when a bookmark moves across folders', async () => {
    tree = [{
      id: 'root', title: '', children: [
        { id: 'A', parentId: 'root', title: 'A', index: 0, children: [
          { id: 'b1', parentId: 'A', title: 'shared', index: 0, url: 'https://x' },
        ] },
        { id: 'B', parentId: 'root', title: 'B', index: 1, children: [] },
      ],
    }];
    const { coordinator, db } = buildCoordinator();
    await coordinator.fullSync('startup');
    let b1 = (await db.bookmarks.get('b1'))!;
    expect(b1.path).toBe('A');

    // Move b1 to B
    tree = [{
      id: 'root', title: '', children: [
        { id: 'A', parentId: 'root', title: 'A', index: 0, children: [] },
        { id: 'B', parentId: 'root', title: 'B', index: 1, children: [
          { id: 'b1', parentId: 'B', title: 'shared', index: 0, url: 'https://x' },
        ] },
      ],
    }];
    await coordinator.fullSync('event');
    b1 = (await db.bookmarks.get('b1'))!;
    expect(b1.path).toBe('B');
    expect(b1.parentId).toBe('B');
  });
});

describe('SyncCoordinator — error reporting and failed state', () => {
  it('records a failed state when readTree throws, and surfaces a typed error', async () => {
    const { coordinator: _coordinator } = buildCoordinator();
    void _coordinator;
    tree = makeEmpty();
    // Force an error by making readTree reject.
    const c2 = new SyncCoordinator({
       
      db: createTestDatabase(`err-${Math.random().toString(36).slice(2)}`) as any,
      readTree: () => Promise.reject(new Error('permission denied for chrome.bookmarks')),
      readState: () => Promise.resolve(storedState),
      writeState: (s: SyncState) => { storedState = s; return Promise.resolve(); },
      nextGeneration: () => ++currentGen,
      now: () => Date.now(),
    });
    await expect(c2.fullSync('startup')).rejects.toBeInstanceOf(AppErrorImpl);
    expect(storedState.status).toBe('failed');
    expect(storedState.lastError).toMatch(/permission/);
  });

  it('writes a succeeded state on success and bumps the generation', async () => {
    tree = makeFlatTree(3);
    const { coordinator } = buildCoordinator();
    const r = await coordinator.fullSync('startup');
    expect(r.state.status).toBe('succeeded');
    expect(r.state.lastSyncAt).toBeGreaterThan(0);
    // totalCount = 1 root folder + 3 bookmarks
    expect(r.state.count).toBe(4);
    expect(r.state.generation).toBe(1);
  });
});

describe('SyncCoordinator — persisted generation', () => {
  it('never regresses generation after a service-worker restart', async () => {
    tree = makeFlatTree(1);
    storedState = {
      status: 'succeeded', lastSyncAt: 1, lastError: null, count: 1, generation: 9,
    };
    // A fresh worker starts with no in-memory generation knowledge.
    currentGen = 0;
    const { coordinator } = buildCoordinator();
    const r = await coordinator.fullSync('startup');
    expect(r.generation).toBe(10);
  });
});

describe('DebouncedSync — event coalescing', () => {
  it('collapses a burst of 100 events into a single fullSync', async () => {
    tree = makeFlatTree(5);
    const { coordinator: _unused, db } = buildCoordinator();
    void _unused;
    let fullSyncCalls = 0;
    const wrapped = new SyncCoordinator({
       
      db: db as any,
      readTree: () => { fullSyncCalls++; return Promise.resolve(tree); },
      readState: () => Promise.resolve(storedState),
      writeState: (s: SyncState) => { storedState = s; return Promise.resolve(); },
      nextGeneration: () => ++currentGen,
      now: () => Date.now(),
    });
    const debouncer = new DebouncedSync(wrapped, 30);

    for (let i = 0; i < 100; i++) debouncer.schedule('event');
    // Wait > waitMs so the timer fires.
    await new Promise((r) => setTimeout(r, 80));
    expect(fullSyncCalls).toBe(1);
  });

  it('flush() runs any pending sync immediately', async () => {
    tree = makeFlatTree(2);
    const { coordinator: _unused, db } = buildCoordinator();
    void _unused;
    const wrapped = new SyncCoordinator({
       
      db: db as any,
      readTree: () => Promise.resolve(tree),
      readState: () => Promise.resolve(storedState),
      writeState: (s: SyncState) => { storedState = s; return Promise.resolve(); },
      nextGeneration: () => ++currentGen,
      now: () => Date.now(),
    });
    const debouncer = new DebouncedSync(wrapped, 10_000); // long wait
    debouncer.schedule('event');
    await debouncer.flush();
    const rows = await db.bookmarks.toArray();
    expect(rows).toHaveLength(2);
  });
});

it('reconciles dirty events received while a previous snapshot is in flight', async () => {
  const db = createTestDatabase(`dirty-${Math.random()}`);
  let release!: () => void; let started!: () => void; let reads = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { started = resolve; });
  const coordinator = new SyncCoordinator({
    db: db as any,
    readTree: async () => { reads++; if (reads === 1) { started(); await gate; return makeFlatTree(1); } return makeFlatTree(2); },
    readState: async () => storedState, writeState: async s => { storedState = s; }, nextGeneration: n => n + 1, now: Date.now,
  });
  const first = coordinator.fullSync('startup'); await reading;
  const second = coordinator.fullSync('event'); release();
  await Promise.all([first, second]);
  expect(reads).toBe(2); expect(await db.bookmarks.count()).toBe(2);
});
