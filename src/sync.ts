// src/sync.ts
//
// Backward-compatible facade. The pre-Phase 1 implementation lives
// here as plain functions. New code should depend on
// `domain/bookmarks/sync.ts` (SyncCoordinator) and
// `infrastructure/database/db.ts` instead.

import { db } from './db';
import { flattenTree, matchesSearch } from './domain/bookmarks/normalize';
import { nextGeneration } from './infrastructure/database/db';
import type { BookmarkRow } from './types';

// `fullSync` for legacy callers. Uses the current generation counter
// and a single transaction so the local index is never observed empty
// by concurrent readers. Returns the number of bookmarks+folders.
export async function fullSync(): Promise<number> {
  const tree = await chrome.bookmarks.getTree();
  const generation = nextGeneration();
  const flat = flattenTree(tree as any, { now: Date.now(), generation });
  await db.transaction('rw', db.bookmarks, db.folders, db.meta, async () => {
    await db.bookmarks.clear();
    await db.folders.clear();
    if (flat.bookmarks.length) await db.bookmarks.bulkPut(flat.bookmarks as any);
    if (flat.folders.length) await db.folders.bulkPut(flat.folders as any);
  });
  return flat.totalCount;
}

export async function refreshNode(_id: string): Promise<void> {
  await fullSync();
}

export async function listBookmarks(
  query = '',
  folderId?: string,
  limit = 200,
  offset = 0,
): Promise<{ rows: BookmarkRow[]; total: number }> {
  let rows = await db.bookmarks.toArray();
  if (folderId) rows = rows.filter((r) => r.parentId === folderId);
  if (query.trim()) rows = rows.filter((r) => matchesSearch(r, query));
  rows.sort(
    (a, b) => (a.path ?? '').localeCompare(b.path ?? '') || a.title.localeCompare(b.title),
  );
  return {
    rows: rows.slice(offset, offset + Math.max(1, Math.min(limit | 0, 1000))) as BookmarkRow[],
    total: rows.length,
  };
}

export async function getStats() {
  const [all, folders] = await Promise.all([db.bookmarks.toArray(), db.folders.toArray()]);
  return {
    bookmarks: all.length,
    folders: folders.length,
    lastSync: ((await db.meta.get('lastSync'))?.value as number | undefined) ?? null,
  };
}

export async function exportBackup() {
  const [bookmarks, folders, browserTree] = await Promise.all([
    db.bookmarks.toArray(),
    db.folders.toArray(),
    chrome.bookmarks.getTree(),
  ]);
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    browserTree,
    index: { bookmarks, folders },
  };
}
