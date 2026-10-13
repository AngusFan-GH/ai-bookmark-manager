// tests/integration/migrations.test.ts
//
// Per dev guide § 4.2: "Dexie 迁移需包含从上一 schema 版本升级测试".
// v1 was added in Phase 1; v2 (operation plans/steps/snapshots/audit)
// in Phase 2; v3 (linkChecks) in Phase 3. This file tests all
// schemas and simulated v1→v2 and v2→v3 upgrades.

import { describe, expect, it, beforeEach } from 'vitest';
import { createTestDatabase, SCHEMA_V1, SCHEMA_V2, SCHEMA_V3 } from '../../src/infrastructure/database/migrations';
import { SyncCoordinator } from '../../src/domain/bookmarks/sync';
import { makeFlatTree } from '../fixtures/bookmark-fixtures';
import type { SyncState } from '../../src/domain/bookmarks/types';
import type { OperationPlan } from '../../src/domain/operations/types';
import type { LinkCheckRecord } from '../../src/domain/health/types';

let storedState: SyncState = SyncCoordinator.defaultState();
let currentGen = 0;

beforeEach(() => {
  storedState = SyncCoordinator.defaultState();
  currentGen = 0;
});

describe('Schema v1 — stores and indexes (Phase 1)', () => {
  it('declares the expected stores', () => {
    const db = createTestDatabase(`t-${Math.random().toString(36).slice(2)}`, 1);
    expect(Object.keys(SCHEMA_V1).sort()).toEqual(['bookmarks', 'folders', 'meta']);
    expect(db.tables.map((t) => t.name).sort()).toEqual(['bookmarks', 'folders', 'meta']);
  });

  it('round-trips bookmark rows with all expected fields', async () => {
    const db = createTestDatabase(`t-${Math.random().toString(36).slice(2)}`, 1);
    const tree = makeFlatTree(50);
    const coord = new SyncCoordinator({
      db: db as any,
      readTree: () => Promise.resolve(tree),
      readState: () => Promise.resolve(storedState),
      writeState: (s: SyncState) => { storedState = s; return Promise.resolve(); },
      nextGeneration: () => ++currentGen,
      now: () => Date.now(),
    });
    await coord.fullSync('startup');
    const rows = await db.bookmarks.toArray();
    expect(rows).toHaveLength(50);
    expect(rows[0]).toHaveProperty('syncGeneration');
    expect(rows[0]).toHaveProperty('parentId');
    expect(rows[0]).toHaveProperty('url');
  });
});

describe('Schema v2 — adds plans/operationSteps/snapshots/audit (Phase 2)', () => {
  it('declares the four new stores alongside the v1 ones', () => {
    const db = createTestDatabase(`t-${Math.random().toString(36).slice(2)}`, 2);
    expect(Object.keys(SCHEMA_V2).sort()).toEqual([
      'audit', 'bookmarks', 'folders', 'meta', 'operationSteps', 'plans', 'snapshots',
    ]);
    expect(db.tables.map((t) => t.name).sort()).toEqual([
      'audit', 'bookmarks', 'folders', 'meta', 'operationSteps', 'plans', 'snapshots',
    ]);
  });

  it('round-trips a plan and its audit row through v2', async () => {
    const db = createTestDatabase(`t-${Math.random().toString(36).slice(2)}`, 2);
    const plan: OperationPlan = {
      id: 'p1',
      title: 'test plan',
      description: 'integration test',
      createdAt: 1000,
      approvedAt: null,
      basedOnGeneration: 1,
      steps: [],
      status: 'draft',
      metadata: {},
    };
    await db.plans!.put(plan);
    const back = await db.plans!.get('p1');
    expect(back).toMatchObject({ id: 'p1', status: 'draft' });
  });

  it('a DB created at v1 can be opened at v2 (upgrade path)', async () => {
    // Simulate: open a v1 DB, write some data, close, reopen as v2.
    const name = `upgrade-${Math.random().toString(36).slice(2)}`;
    const v1 = createTestDatabase(name, 1);
    await v1.bookmarks.put({
      id: 'b1', browserId: 'b1', kind: 'bookmark', parentId: null, index: 0,
      title: 'hello', url: 'https://x.test', updatedAt: 1, syncGeneration: 1, path: '',
    });
    v1.close();

    // Re-open at v2: Dexie should auto-upgrade. The v1 row must persist.
    const v2 = createTestDatabase(name, 2);
    const rows = await v2.bookmarks.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('hello');
    expect(v2.tables.map((t) => t.name).sort()).toContain('plans');
    v2.close();
  });
});

describe('Schema v3 — adds linkChecks (Phase 3)', () => {
  it('declares the linkChecks store', () => {
    const db = createTestDatabase(`t-${Math.random().toString(36).slice(2)}`, 3);
    expect(Object.keys(SCHEMA_V3).sort()).toContain('linkChecks');
    expect(db.tables.map((t) => t.name).sort()).toContain('linkChecks');
  });

  it('round-trips a LinkCheckRecord through v3', async () => {
    const db = createTestDatabase(`t-${Math.random().toString(36).slice(2)}`, 3);
    const rec: LinkCheckRecord = {
      id: 'lc-1',
      bookmarkId: 'b-1',
      status: 'healthy',
      httpCode: 200,
      checkedAt: 1_000_000,
      evidence: ['200 OK'],
      syncGeneration: 5,
    };
    await db.linkChecks!.put(rec);
    const back = await db.linkChecks!.get('lc-1');
    expect(back).toMatchObject({ id: 'lc-1', status: 'healthy', httpCode: 200 });
  });

  it('a DB created at v2 can be opened at v3 (upgrade path)', async () => {
    const name = `upgradeto3-${Math.random().toString(36).slice(2)}`;
    const v2 = createTestDatabase(name, 2);
    await v2.bookmarks.put({
      id: 'b1', browserId: 'b1', kind: 'bookmark', parentId: null, index: 0,
      title: 'phase-2-data', url: 'https://x.test', updatedAt: 1, syncGeneration: 1, path: '',
    });
    v2.close();

    const v3 = createTestDatabase(name, 3);
    const rows = await v3.bookmarks.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('phase-2-data');
    expect(v3.tables.map((t) => t.name).sort()).toContain('linkChecks');
    v3.close();
  });
});
