// entrypoints/background.ts
//
// MV3 service worker. Wires:
//   - BrowserBookmarksAdapter  → reads chrome.bookmarks.getTree
//   - SyncCoordinator          → owns the single Dexie writer (dev guide § 2.1)
//   - DebouncedSync            → coalesces event bursts
//   - BackgroundRouter         → typed dispatch for UI messages
//
// On startup we run one full sync; events trigger debounced reconcile.
// UI calls come in via chrome.runtime.onMessage and are answered with
// the typed BackgroundResponse shape from contracts.ts.

import { defineBackground } from 'wxt/utils/define-background';
import { createBrowserBookmarksAdapter } from '../src/infrastructure/browser/bookmark-adapter';
import { BackgroundRouter } from '../src/infrastructure/messaging/background-router';
import {
  nextGeneration,
  readSyncState,
  writeSyncState,
  db,
} from '../src/infrastructure/database/db';
import { SyncCoordinator, DebouncedSync } from '../src/domain/bookmarks/sync';
import { matchesSearch } from '../src/domain/bookmarks/normalize';
import {
  ok,
  type BackgroundRequest,
  type BackgroundResponse,
  type ExportPayload,
  type ListResult,
  type StatsSummary,
  type SyncState,
} from '../src/infrastructure/messaging/contracts';

export default defineBackground(() => {
  // ---- Browser adapter ---------------------------------------------------
  const adapter = createBrowserBookmarksAdapter({
    bookmarks: chrome.bookmarks as any,
  });

  // ---- Coordinator + debouncer ------------------------------------------
  const coordinator = new SyncCoordinator({
    db: db as any,
    readTree: () => adapter.getTree(),
    readState: () => readSyncState(),
    writeState: (s: SyncState) => writeSyncState(s),
    nextGeneration,
    now: () => Date.now(),
  });
  const debouncer = new DebouncedSync(coordinator, 350);

  // ---- Subscriptions ----------------------------------------------------
  // Re-run on relevant events. Debouncer coalesces bursts.
  const unsubscribe = adapter.onAnyChange((reason) => {
    debouncer.schedule('event');
    void reason;
  });

  // Initial sync on install/startup.
  chrome.runtime.onInstalled.addListener(() => {
    debouncer.schedule('startup');
  });
  chrome.runtime.onStartup.addListener(() => {
    debouncer.schedule('startup');
  });

  // ---- Router -----------------------------------------------------------
  // Build the deps object once; both the router constructor and the
  // .register() callbacks need to call them.
  const deps = {
    async listBookmarks(query: string, folderId: string | undefined, limit: number, offset: number) {
      const all = await db.bookmarks.toArray();
      let rows = all;
      if (folderId) rows = rows.filter((r) => r.parentId === folderId);
      if (query.trim()) {
        rows = rows.filter((r) => matchesSearch(r, query));
      }
      rows.sort((a, b) => (a.path ?? '').localeCompare(b.path ?? '') || a.title.localeCompare(b.title));
      const total = rows.length;
      const capped = Math.max(1, Math.min(limit | 0 || 200, 1000));
      return { rows: rows.slice(offset, offset + capped), total } satisfies ListResult<unknown>;
    },
    async listFolders() {
      const folders = await db.folders.toArray();
      return folders.sort((a, b) => (a.path ?? '').localeCompare(b.path ?? '') || a.title.localeCompare(b.title));
    },
    async getStats(): Promise<StatsSummary> {
      const [all, folders, syncState] = await Promise.all([
        db.bookmarks.toArray(),
        db.folders.toArray(),
        readSyncState(),
      ]);
      return {
        bookmarks: all.length,
        folders: folders.length,
        lastSync: syncState.lastSyncAt,
        syncState,
      };
    },
    async fullSync(reason: 'manual' | 'startup' | 'event') {
      const r = await coordinator.fullSync(reason);
      return { count: r.count };
    },
    async exportBackup(): Promise<ExportPayload> {
      // We persist the already-synced index; we re-read the tree at
      // export time for fidelity. The export never includes API keys,
      // auth, page text, or chat history (dev guide § 3.3 + § 10).
      const [bookmarks, folders, browserTree] = await Promise.all([
        db.bookmarks.toArray(),
        db.folders.toArray(),
        adapter.getTree(),
      ]);
      return {
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        appVersion: chrome.runtime.getManifest().version,
        browserTree,
        localIndex: { bookmarks, folders },
        includes: { browserTree: true, localIndex: true },
      };
    },
    async readSyncState() {
      return readSyncState();
    },
  };

  // Wire every BackgroundRequest type to its handler. Without these
  // registrations, dispatch() returns INVALID_REQUEST for every type
  // (regression history: Phase 1 refactor originally forgot this).
  const router = new BackgroundRouter(deps)
    .register('BOOKMARKS_LIST', (req) => deps.listBookmarks(
      req.query ?? '', req.folderId, req.limit ?? 200, req.offset ?? 0,
    ))
    .register('BOOKMARKS_TREE', () => deps.listFolders())
    .register('STATS', () => deps.getStats())
    .register('SYNC', (req) => deps.fullSync(req.reason ?? 'manual'))
    .register('EXPORT', () => deps.exportBackup())
    .register('SYNC_STATE', () => deps.readSyncState());

  // ---- Message handler --------------------------------------------------
  // Reject messages from other extensions.
  chrome.runtime.onMessage.addListener(
    (request: BackgroundRequest, sender, sendResponse: (r: BackgroundResponse<unknown>) => void) => {
      if (sender.id !== chrome.runtime.id) {
        sendResponse(ok('?', null)); // ignore, but still respond
        return false;
      }
      void router.dispatch(request).then(sendResponse);
      return true; // keep channel open for async sendResponse
    },
  );

  // Service-worker teardown: best-effort flush of any pending debounced sync.
  // MV3 may not run this in all shutdowns (dev guide § 2.1); the worst case
  // is a missed event, which the next onStartup full sync will catch up.
   
  (self as any).addEventListener('unload', () => {
    unsubscribe();
    void debouncer.flush();
  });
});
