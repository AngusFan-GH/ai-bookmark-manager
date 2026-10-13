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
//
// Schema history
//   v1 — bookmarks / folders / meta (Phase 1)
//   v2 — + plans / operationSteps / snapshots / audit (Phase 2)

import Dexie, { type Table } from 'dexie';
import type { BookmarkRecord, FolderRecord } from '../../domain/bookmarks/types';
import type { MetaRecord } from './db';
import type {
  OperationPlan,
  OperationStep,
  TreeSnapshot,
  OperationAuditEntry,
} from '../../domain/operations/types';

export interface SchemaV1Stores {
  bookmarks: string;
  folders: string;
  meta: string;
}

export interface SchemaV2Stores extends SchemaV1Stores {
  plans: string;
  operationSteps: string;
  snapshots: string;
  audit: string;
}

export const SCHEMA_V1: SchemaV1Stores = {
  bookmarks:
    'id, browserId, parentId, kind, title, url, [parentId+index], updatedAt, syncGeneration',
  folders: 'id, browserId, parentId, title, [parentId+index], updatedAt, syncGeneration',
  meta: 'key, updatedAt',
};

/**
 * v2 adds the four Phase 2 stores. Indexes match dev guide § 4.1
 * ("plans: id, status, createdAt"; "operationSteps: id, planId, status, targetId";
 * "snapshots: id, planId, createdAt"; audit append-only).
 */
export const SCHEMA_V2: SchemaV2Stores = {
  ...SCHEMA_V1,
  plans: 'id, status, createdAt, basedOnGeneration',
  operationSteps: 'id, planId, status, targetBrowserId, [planId+order]',
  snapshots: 'id, planId, createdAt, syncGeneration',
  audit: 'id, planId, stepId, recordedAt',
};

/**
 * Build a fresh Dexie database bound to a unique name at a given
 * schema version. Used by tests so each test scenario starts from a
 * clean slate without touching the real chrome-extension IndexedDB.
 */
export function createTestDatabase(name: string, schemaVersion: 1 | 2 = 2): Dexie & {
  bookmarks: Table<BookmarkRecord, string>;
  folders: Table<FolderRecord, string>;
  meta: Table<MetaRecord, string>;
  plans?: Table<OperationPlan, string>;
  operationSteps?: Table<OperationStep, string>;
  snapshots?: Table<TreeSnapshot, string>;
  audit?: Table<OperationAuditEntry, string>;
} {
  const d = new Dexie(name) as Dexie & {
    bookmarks: Table<BookmarkRecord, string>;
    folders: Table<FolderRecord, string>;
    meta: Table<MetaRecord, string>;
    plans?: Table<OperationPlan, string>;
    operationSteps?: Table<OperationStep, string>;
    snapshots?: Table<TreeSnapshot, string>;
    audit?: Table<OperationAuditEntry, string>;
  };
  d.version(1).stores({
    bookmarks: SCHEMA_V1.bookmarks,
    folders: SCHEMA_V1.folders,
    meta: SCHEMA_V1.meta,
  });
  if (schemaVersion >= 2) {
    d.version(2).stores({
      bookmarks: SCHEMA_V2.bookmarks,
      folders: SCHEMA_V2.folders,
      meta: SCHEMA_V2.meta,
      plans: SCHEMA_V2.plans,
      operationSteps: SCHEMA_V2.operationSteps,
      snapshots: SCHEMA_V2.snapshots,
      audit: SCHEMA_V2.audit,
    });
  }
  return d;
}

/**
 * Current schema version. Bumped when a new migration lands. New
 * stores go in SCHEMA_V2 → SCHEMA_V3 etc. in the same file.
 */
export const CURRENT_SCHEMA_VERSION = 2;
