import { db } from './db';
import { flattenTree } from './normalize';
import type { BookmarkRow } from './types';

let syncPromise: Promise<number> | undefined;
export function fullSync(): Promise<number> {
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    const tree = await chrome.bookmarks.getTree();
    const rows = flattenTree(tree);
    // Single IndexedDB transaction prevents partial replacement of the local index.
    await db.transaction('rw', db.bookmarks, db.meta, async () => {
      await db.bookmarks.clear();
      await db.bookmarks.bulkPut(rows);
      await db.meta.put({ key: 'lastSync', value: Date.now() });
    });
    return rows.length;
  })().finally(() => { syncPromise = undefined; });
  return syncPromise;
}

export async function refreshNode(id: string): Promise<void> {
  // Rebuild paths and folder ancestry correctly after rename/move.
  // Debounced caller avoids repeated rebuilds during bursts of events.
  await fullSync();
}

export async function listBookmarks(query = '', folderId?: string, limit = 200, offset = 0): Promise<{ rows: BookmarkRow[]; total: number }> {
  let rows = await db.bookmarks.toArray();
  if (folderId) rows = rows.filter(r => r.parentId === folderId);
  if (query.trim()) {
    const q = query.trim().toLocaleLowerCase();
    rows = rows.filter(r => [r.title, r.url ?? '', r.path].some(v => v.toLocaleLowerCase().includes(q)));
  }
  rows.sort((a, b) => a.path.localeCompare(b.path) || a.title.localeCompare(b.title));
  return { rows: rows.slice(offset, offset + Math.min(Math.max(limit, 1), 1000)), total: rows.length };
}

export async function getStats() {
  const all = await db.bookmarks.toArray();
  return {
    bookmarks: all.filter(x => x.kind === 'bookmark').length,
    folders: all.filter(x => x.kind === 'folder').length,
    lastSync: (await db.meta.get('lastSync'))?.value ?? null,
  };
}

export async function exportBackup() {
  // Backups contain the browser tree and an application index snapshot.
  return { schemaVersion: 1, exportedAt: new Date().toISOString(),
    browserTree: await chrome.bookmarks.getTree(),
    index: await db.bookmarks.toArray() };
}
