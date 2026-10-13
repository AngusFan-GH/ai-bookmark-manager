// tests/integration/migrations.test.ts
//
// Per dev guide § 4.2: "Dexie 迁移需包含从上一 schema 版本升级测试".
// This file is the test for the v1 schema. Future migrations will
// also add a test here that simulates a v1 DB and upgrades to v2.

import { describe, expect, it, beforeEach } from 'vitest';
import { createTestDatabase, SCHEMA_V1 } from '../../src/infrastructure/database/migrations';
import { SyncCoordinator } from '../../src/domain/bookmarks/sync';
import { makeFlatTree } from '../fixtures/bookmark-fixtures';
import type { SyncState } from '../../src/domain/bookmarks/types';

let storedState: SyncState = SyncCoordinator.defaultState();
let currentGen = 0;

beforeEach(() => {
  storedState = SyncCoordinator.defaultState();
  currentGen = 0;
});

describe('Schema v1 — stores and indexes', () => {
  it('declares the expected stores', () => {
    const db = createTestDatabase(`t-${Math.random().toString(36).slice(2)}`);
    expect(Object.keys(SCHEMA_V1).sort()).toEqual(['bookmarks', 'folders', 'meta']);
    expect(db.tables.map((t) => t.name).sort()).toEqual(['bookmarks', 'folders', 'meta']);
  });

  it('round-trips bookmark rows with all expected fields', async () => {
    const db = createTestDatabase(`t-${Math.random().toString(36).slice(2)}`);
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
