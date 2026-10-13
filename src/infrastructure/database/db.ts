// src/infrastructure/database/db.ts
//
// Dexie schema v1. Mirrors dev guide § 4.1 for the stores we need in
// Phase 1: `bookmarks`, `folders`, `meta`. Other stores (linkChecks,
// contents, classifications, plans, ...) are introduced by later
// phases and added as new schema versions in `migrations.ts`.

import Dexie, { type Table } from 'dexie';
import type { BookmarkRecord, FolderRecord } from '../../domain/bookmarks/types';
import type { SyncState } from '../../domain/bookmarks/types';

export interface MetaRecord {
  key: string;
  value: unknown;
  updatedAt: number;
}

export class BookmarkDatabase extends Dexie {
  bookmarks!: Table<BookmarkRecord, string>;
  folders!: Table<FolderRecord, string>;
  meta!: Table<MetaRecord, string>;

  constructor(name = 'ai-bookmark-manager') {
    super(name);
    // Schema v1. Indexes match dev guide § 4.1 for the stores we use now.
    // String indexes are case-sensitive; we normalize search client-side.
    this.version(1).stores({
      bookmarks:
        'id, browserId, parentId, kind, title, url, [parentId+index], updatedAt, syncGeneration',
      folders: 'id, browserId, parentId, title, [parentId+index], updatedAt, syncGeneration',
      meta: 'key, updatedAt',
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
