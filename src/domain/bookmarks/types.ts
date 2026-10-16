// src/domain/bookmarks/types.ts
//
// Canonical bookmark domain types. Mirrors dev guide § 4.2 but with
// the practical shape we need in Iteration 1 (the guide's extra fields
// like normalizedUrl, syncGeneration are added where they make sense).
//
// Design constraints (dev guide § 4.2):
//   - 'url' preserves the original; do NOT overwrite it with normalizedUrl.
//   - 'path' is a presentation cache rebuilt from parentId; it is
//     invalidated on rename/move, not stored as the truth.
//   - 'syncGeneration' prevents stale snapshots from overwriting newer ones.
//   - 'browserId' is the original chrome.bookmarks id; it is only valid
//     inside this browser profile.

export type BookmarkKind = 'bookmark' | 'folder' | 'separator';

export interface BookmarkRecord {
  id: string; // app-scoped stable id == browserId for the local profile
  browserId: string;
  kind: BookmarkKind;
  parentId: string | null;
  index: number;
  title: string;
  /** Preserved exactly. Never overwritten by normalization. */
  url?: string;
  /** Only for comparison. See dev guide § 4.2 (added in Phase 4). */
  normalizedUrl?: string;
  dateAdded?: number;
  dateGroupModified?: number;
  /** Wall-clock updated time of the local row. */
  updatedAt: number;
  /**
   * Monotonic counter; bumped each time a full sync completes. Used to
   * reject late-arriving snapshots from a previous sync cycle.
   */
  syncGeneration: number;
  /**
   * Presentation cache: full folder path joined with " / ". Recomputed
   * on every full sync (dev guide BM-006). Kept on the row for fast UI
   * rendering; do not treat as the source of truth — `parentId` is.
   */
  path: string;
}

export interface FolderRecord {
  id: string;
  browserId: string;
  parentId: string | null;
  title: string;
  dateAdded?: number;
  dateGroupModified?: number;
  index: number;
  updatedAt: number;
  syncGeneration: number;
  /** Same presentation-cache semantics as BookmarkRecord.path. */
  path: string;
}

export type SyncStatus = 'idle' | 'running' | 'succeeded' | 'failed';

export interface SyncState {
  status: SyncStatus;
  lastSyncAt: number | null;
  lastError: string | null;
  count: number;
  generation: number;
}

export type SyncReason = 'manual' | 'startup' | 'event';

/**
 * chrome.bookmarks.BookmarkTreeNode as exposed to domain code.
 * Domain code never imports the global `chrome` type directly so it can
 * be unit-tested with plain objects.
 */
export interface RawBookmarkNode {
  id: string;
  /** Optional explicit node kind from compatible bookmark APIs/imports. */
  type?: BookmarkKind;
  parentId?: string;
  title?: string;
  url?: string;
  dateAdded?: number;
  dateGroupModified?: number;
  index?: number;
  children?: RawBookmarkNode[];
}
