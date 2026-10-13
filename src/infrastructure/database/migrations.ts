// src/infrastructure/database/migrations.ts
//
// Lightweight migration framework. Each future schema change adds a
// new `db.version(N).stores(...).upgrade(tx => ...)` block here.
//
// Per dev guide § 4.2: "Dexie 迁移需包含从上一 schema 版本升级测试".
// We test the migrations in `tests/integration/migrations.test.ts`.
//
// Why a helper class: Dexie migrations are per-instance, not global. To
// test against an isolated in-memory DB we need a way to construct a
// fresh database for each scenario. `createTestDatabase(name)` does that.

import Dexie, { type Table } from 'dexie';
import type { BookmarkRecord, FolderRecord } from '../../domain/bookmarks/types';
import type { MetaRecord } from './db';

export interface SchemaV1Stores {
  bookmarks: string;
  folders: string;
  meta: string;
}

export const SCHEMA_V1: SchemaV1Stores = {
  bookmarks:
    'id, browserId, parentId, kind, title, url, [parentId+index], updatedAt, syncGeneration',
  folders: 'id, browserId, parentId, title, [parentId+index], updatedAt, syncGeneration',
  meta: 'key, updatedAt',
};

/**
 * Build a fresh Dexie database bound to a unique name. Used by tests so
 * each test scenario starts from a clean slate without touching the
 * real chrome-extension IndexedDB.
 */
export function createTestDatabase(name: string): Dexie & {
  bookmarks: Table<BookmarkRecord, string>;
  folders: Table<FolderRecord, string>;
  meta: Table<MetaRecord, string>;
} {
  const d = new Dexie(name) as Dexie & {
    bookmarks: Table<BookmarkRecord, string>;
    folders: Table<FolderRecord, string>;
    meta: Table<MetaRecord, string>;
  };
  d.version(1).stores({
    bookmarks: SCHEMA_V1.bookmarks,
    folders: SCHEMA_V1.folders,
    meta: SCHEMA_V1.meta,
  });
  return d;
}
