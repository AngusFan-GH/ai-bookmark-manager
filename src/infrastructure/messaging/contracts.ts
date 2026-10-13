// src/infrastructure/messaging/contracts.ts
//
// Typed message protocol between the background service worker and UI pages
// (popup / options). Mirrors dev guide § 9.1 with a requestId and rich
// error shape. Background is the only writer to Dexie; UI never touches
// chrome.bookmarks APIs directly.

import type { AppError } from '../../shared/errors';
import type { OperationPlan, OperationStep } from '../../domain/operations/types';

// Re-export for UI convenience: the store imports these from
// `infrastructure/messaging/contracts` to keep a single import surface.
export type { OperationPlan, OperationStep };

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

// ---- Phase 2: backup import / plan / execute -----------------------------

export interface ImportPreview {
  formatVersion: number;
  totalNodes: number;
  mode: 'additive' | 'additive-with-meta' | 'controlled-merge';
  summary: {
    adds: number;
    updates: number;
    moves: number;
    deletes: number;
    noops: number;
  };
  conflicts: string[];
  /** First 50 ops for preview rendering. */
  sample: unknown[];
  /** Sanity-check the payload passed all schema and size rules. */
  ok: true;
}

export type ImportPreviewRequest = {
  type: 'IMPORT_PREVIEW';
  requestId: string;
  rawJson: string;
  mode: 'additive' | 'additive-with-meta' | 'controlled-merge';
};

export type PlanDraftRequest = {
  type: 'PLAN_DRAFT';
  requestId: string;
  rawJson: string;
  mode: 'additive' | 'additive-with-meta' | 'controlled-merge';
  title?: string;
};

export interface PlanSummary {
  planId: string;
  status: string;
  title: string;
  stepCount: number;
  createdAt: number;
}

export type PlanListRequest = { type: 'PLAN_LIST'; requestId: string };
export type PlanGetRequest = { type: 'PLAN_GET'; requestId: string; planId: string };

export type ApprovalRequest = {
  type: 'APPROVE';
  requestId: string;
  planId: string;
  ttlMs?: number;
};

export interface ApprovalToken {
  token: string;
  planId: string;
  expiresAt: number;
}

export type ExecuteRequest = {
  type: 'EXECUTE';
  requestId: string;
  planId: string;
  approvalToken: string;
  dryRun?: boolean;
};

export interface ExecuteResultMsg {
  planId: string;
  status: string;
  succeeded: number;
  failed: number;
  compensated: number;
}

// ---- Phase 3: link health -----------------------------------------------

export interface HealthRunSummary {
  total: number;
  enqueued: number;
  skipped: number;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
}

export type HealthStartRequest = {
  type: 'HEALTH_START';
  requestId: string;
  bookmarkIds?: string[]; // omit = scan all bookmarks
};

export type HealthCancelRequest = { type: 'HEALTH_CANCEL'; requestId: string };
export type HealthStatusRequest = { type: 'HEALTH_STATUS'; requestId: string };
export type HealthListRequest = { type: 'HEALTH_LIST'; requestId: string };

export interface HealthStatusSummary {
  status: 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  queued: number;
  inflight: number;
  total: number;
  processed: number;
}

export type BackgroundRequest =
  | BookmarkListRequest
  | BookmarkTreeRequest
  | StatsRequest
  | SyncRequest
  | ExportRequest
  | SyncStateRequest
  | ImportPreviewRequest
  | PlanDraftRequest
  | PlanListRequest
  | PlanGetRequest
  | ApprovalRequest
  | ExecuteRequest
  | HealthStartRequest
  | HealthCancelRequest
  | HealthStatusRequest
  | HealthListRequest;

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
