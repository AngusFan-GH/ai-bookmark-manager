// src/infrastructure/browser/bookmark-adapter.ts
//
// Thin wrapper over the chrome.bookmarks API. The domain layer never
// imports `chrome` directly; tests can pass a fake adapter. This is the
// only place in the codebase that should call `chrome.bookmarks.*` for
// read operations. (Phase 2 will introduce a separate OperationExecutor
// for write operations — per dev guide red line #1 and BM-002.)
//
// The adapter is intentionally narrow: it does not handle events, it
// does not talk to Dexie, and it does not decide when to sync. The
// SyncCoordinator owns those concerns.

import type { RawBookmarkNode } from '../../domain/bookmarks/types';
import { AppErrorImpl } from '../../shared/errors';

export interface BookmarksApiShape {
  getTree(): Promise<RawBookmarkNode[]>;
}

export interface BookmarkEventsApiShape {
  onCreated: { addListener(cb: (id: string, node: RawBookmarkNode) => void): void };
  onRemoved: { addListener(cb: (id: string, removeInfo: { parentId: string; index: number; node?: RawBookmarkNode }) => void): void };
  onChanged: { addListener(cb: (id: string, changeInfo: { title: string; url?: string }) => void): void };
  onMoved: { addListener(cb: (id: string, moveInfo: { parentId: string; index: number; oldParentId: string; oldIndex: number }) => void): void };
  onChildrenReordered: { addListener(cb: (id: string, reorderInfo: { childIds: string[] }) => void): void };
  onImportEnded: { addListener(cb: () => void): void };
  onImportBegan?: { addListener(cb: () => void): void };
}

export interface ChromeBookmarksApi {
  bookmarks: BookmarksApiShape & BookmarkEventsApiShape;
}

export interface BrowserBookmarksAdapter {
  /** Permission-gated read of the full native bookmark tree. */
  getTree(): Promise<RawBookmarkNode[]>;
  /** Subscribe to the union of bookmark-change events. */
  onAnyChange(cb: (reason: string) => void): () => void;
  /** Check that the bookmarks permission is granted; throws if not. */
  ensurePermission(): Promise<void>;
}

export function createBrowserBookmarksAdapter(api: ChromeBookmarksApi): BrowserBookmarksAdapter {
  return {
    async getTree() {
      try {
        return await api.bookmarks.getTree();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/permission/i.test(msg)) {
          throw new AppErrorImpl('PERMISSION_REQUIRED', msg, false);
        }
        throw new AppErrorImpl('UNKNOWN', msg, true);
      }
    },
    onAnyChange(cb) {
      const handlers: Array<() => void> = [];
      const add = (key: keyof BookmarkEventsApiShape): void => {
        const fn = (...args: any[]) => { void args; cb(String(key)); };
        const ev = api.bookmarks[key];
        if (!ev) return;
        ev.addListener(fn as any);
        handlers.push(() => {
          const ev2 = api.bookmarks[key];
          if (ev2 && typeof (ev2 as any).removeListener === 'function') (ev2 as any).removeListener(fn);
        });
      };
      add('onCreated');
      add('onRemoved');
      add('onChanged');
      add('onMoved');
      add('onChildrenReordered');
      add('onImportEnded');
      if (api.bookmarks.onImportBegan) add('onImportBegan');
      return () => { for (const h of handlers) h(); };
    },
    async ensurePermission() {
      // The bookmarks permission is statically declared in the manifest;
      // if the user revoked it, chrome.bookmarks APIs will reject on call.
      // We just verify the API is callable to surface a clear error early.
      if (typeof api.bookmarks.getTree !== 'function') {
        throw new AppErrorImpl('PERMISSION_REQUIRED', 'bookmarks API unavailable', false);
      }
    },
  };
}
