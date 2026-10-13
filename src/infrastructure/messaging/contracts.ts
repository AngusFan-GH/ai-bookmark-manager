// src/infrastructure/messaging/contracts.ts
//
// Typed message protocol between the background service worker and UI pages
// (popup / options). Mirrors dev guide § 9.1 with a requestId and rich
// error shape. Background is the only writer to Dexie; UI never touches
// chrome.bookmarks APIs directly.

import type { AppError } from '../../shared/errors';

export type SyncStatus = 'idle' | 'running' | 'succeeded' | 'failed';

export interface SyncState {
  status: SyncStatus;
  lastSyncAt: number | null;
  lastError: string | null;
  count: number;
  generation: number;
}

export interface StatsSummary {
  bookmarks: number;
  folders: number;
  lastSync: number | null;
  syncState: SyncState;
}

export interface ListResult<T> {
  rows: T[];
  total: number;
}

export interface ExportPayload {
  formatVersion: number;
  exportedAt: string;
  appVersion: string;
  browserTree: unknown;
  localIndex: unknown;
  // NOTE: dev guide § 3.3 + § 10 — never include API keys, auth, page text,
  // or chat history in the default export. They must be opt-in by user.
  includes: {
    browserTree: true;
    localIndex: true;
  };
}

// ---- Requests -------------------------------------------------------------

export type BookmarkListRequest = {
  type: 'BOOKMARKS_LIST';
  requestId: string;
  query?: string;
  folderId?: string;
  limit?: number;
  offset?: number;
};

export type BookmarkTreeRequest = { type: 'BOOKMARKS_TREE'; requestId: string };

export type StatsRequest = { type: 'STATS'; requestId: string };

export type SyncRequest = { type: 'SYNC'; requestId: string; reason?: 'manual' | 'startup' | 'event' };

export type ExportRequest = { type: 'EXPORT'; requestId: string };

export type SyncStateRequest = { type: 'SYNC_STATE'; requestId: string };

export type BackgroundRequest =
  | BookmarkListRequest
  | BookmarkTreeRequest
  | StatsRequest
  | SyncRequest
  | ExportRequest
  | SyncStateRequest;

// ---- Responses ------------------------------------------------------------

export type BackgroundResponse<T> =
  | { ok: true; requestId: string; data: T }
  | { ok: false; requestId: string; error: AppError };

// ---- Errors helpers -------------------------------------------------------

export function err<T = never>(requestId: string, error: AppError): BackgroundResponse<T> {
  return { ok: false, requestId, error };
}

export function ok<T>(requestId: string, data: T): BackgroundResponse<T> {
  return { ok: true, requestId, data };
}
