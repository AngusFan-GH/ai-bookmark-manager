// src/infrastructure/database/db.ts
//
// Dexie schema. v1 from Phase 1 (bookmarks / folders / meta). v2 from
// Phase 2 (plans / operationSteps / snapshots / audit).
//
// All other stores (linkChecks, contents, classifications, etc.) are
// added by later phases and bump the schema version in migrations.ts.

import Dexie, { type Table } from 'dexie';
import type { BookmarkRecord, FolderRecord, SyncState } from '../../domain/bookmarks/types';
import type {
  OperationPlan,
  OperationStep,
  TreeSnapshot,
  OperationAuditEntry,
} from '../../domain/operations/types';
import type { LinkCheckRecord } from '../../domain/health/types';

export interface MetaRecord {
  key: string;
  value: unknown;
  updatedAt: number;
}

export class BookmarkDatabase extends Dexie {
  bookmarks!: Table<BookmarkRecord, string>;
  folders!: Table<FolderRecord, string>;
  meta!: Table<MetaRecord, string>;
  // Phase 2 stores
  plans!: Table<OperationPlan, string>;
  operationSteps!: Table<OperationStep, string>;
  snapshots!: Table<TreeSnapshot, string>;
  audit!: Table<OperationAuditEntry, string>;
  // Phase 3 stores
  linkChecks!: Table<LinkCheckRecord, string>;

  constructor(name = 'ai-bookmark-manager') {
    super(name);
    // v1: bookmarks / folders / meta.
    this.version(1).stores({
      bookmarks:
        'id, browserId, parentId, kind, title, url, [parentId+index], updatedAt, syncGeneration',
      folders: 'id, browserId, parentId, title, [parentId+index], updatedAt, syncGeneration',
      meta: 'key, updatedAt',
    });
    // v2: + plans / operationSteps / snapshots / audit.
    this.version(2).stores({
      bookmarks:
        'id, browserId, parentId, kind, title, url, [parentId+index], updatedAt, syncGeneration',
      folders: 'id, browserId, parentId, title, [parentId+index], updatedAt, syncGeneration',
      meta: 'key, updatedAt',
      plans: 'id, status, createdAt, basedOnGeneration',
      operationSteps: 'id, planId, status, targetBrowserId, [planId+order]',
      snapshots: 'id, planId, createdAt, syncGeneration',
      audit: 'id, planId, stepId, recordedAt',
    });
    // v3: + linkChecks.
    this.version(3).stores({
      bookmarks:
        'id, browserId, parentId, kind, title, url, [parentId+index], updatedAt, syncGeneration',
      folders: 'id, browserId, parentId, title, [parentId+index], updatedAt, syncGeneration',
      meta: 'key, updatedAt',
      plans: 'id, status, createdAt, basedOnGeneration',
      operationSteps: 'id, planId, status, targetBrowserId, [planId+order]',
      snapshots: 'id, planId, createdAt, syncGeneration',
      audit: 'id, planId, stepId, recordedAt',
      linkChecks: 'id, bookmarkId, status, checkedAt, [bookmarkId+checkedAt], retryAt',
    });
  }
}

export const db = new BookmarkDatabase();

// ---- syncGeneration tracking ---------------------------------------------

let currentGeneration = 0;

/** Bump and return the new generation. Call before each full sync. */
export function nextGeneration(): number {
  currentGeneration += 1;
  return currentGeneration;
}

/** Current generation; 0 means "no successful sync yet". */
export function getCurrentGeneration(): number {
  return currentGeneration;
}

/** Reset generation to a known value (used after restoring from backup). */
export function setGeneration(g: number): void {
  currentGeneration = Math.max(0, g | 0);
}

// ---- meta helpers ---------------------------------------------------------

const SYNC_STATE_KEY = 'syncState';

export async function readSyncState(): Promise<SyncState> {
  const row = await db.meta.get(SYNC_STATE_KEY);
  if (!row) {
    return { status: 'idle', lastSyncAt: null, lastError: null, count: 0, generation: 0 };
  }
  return row.value as SyncState;
}

export async function writeSyncState(state: SyncState): Promise<void> {
  await db.meta.put({ key: SYNC_STATE_KEY, value: state, updatedAt: Date.now() });
}
