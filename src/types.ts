// src/types.ts
//
// Thin re-export of the canonical contract from
// `src/infrastructure/messaging/contracts.ts`.
//
// We keep this path as a public alias so the UI (store, App.vue) does
// not have to be migrated in lockstep with the background. New code
// should import from the canonical path; this file will be deleted in
// Phase 2 once the UI uses the typed messages directly.

export type { BackgroundRequest, BackgroundResponse, SyncState, StatsSummary, ListResult, ExportPayload } from './infrastructure/messaging/contracts';
export type { BookmarkRecord, FolderRecord, SyncReason, RawBookmarkNode } from './domain/bookmarks/types';

// Back-compat: the old `Request`/`Result` shape used by the pre-Phase 1
// UI. Kept so legacy callers (existing App.vue) still type-check.
export type Request =
  | { type: 'LIST'; query?: string; folderId?: string; limit?: number; offset?: number }
  | { type: 'TREE' }
  | { type: 'STATS' }
  | { type: 'SYNC' }
  | { type: 'EXPORT' };

export type Result<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

// The pre-Phase 1 store still uses `BookmarkRow` (with a `path` field).
// Phase 1's canonical `BookmarkRecord` includes the same fields.
export type BookmarkRow = import('./domain/bookmarks/types').BookmarkRecord;
export type SyncMeta = { key: string; value: string | number };
