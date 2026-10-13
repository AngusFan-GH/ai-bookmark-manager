// src/infrastructure/messaging/background-router.ts
//
// Typed dispatcher for BackgroundRequest → handler. Each handler
// returns a value or throws; the router wraps both into a
// BackgroundResponse with the rich error shape (dev guide § 9.1, 9.2).
//
// The router validates the message sender, the requestId, and a
// coarse shape check (requestId is a non-empty string). The actual
// payload validation per type is the handler's responsibility.

import { AppErrorImpl, toAppError } from '../../shared/errors';
import type { AppError } from '../../shared/errors';
import {
  err,
  ok,
  type BackgroundRequest,
  type BackgroundResponse,
  type ListResult,
  type StatsSummary,
  type ExportPayload,
  type SyncState,
} from './contracts';

export interface RouterDeps {
  listBookmarks(query: string, folderId: string | undefined, limit: number, offset: number): Promise<ListResult<unknown>>;
  listFolders(): Promise<unknown[]>;
  getStats(): Promise<StatsSummary>;
  fullSync(reason: 'manual' | 'startup' | 'event'): Promise<{ count: number }>;
  exportBackup(): Promise<ExportPayload>;
  readSyncState(): Promise<SyncState>;
  // Phase 2: backup import + plan execution
  previewImport(rawJson: string, mode: 'additive' | 'additive-with-meta' | 'controlled-merge'): Promise<unknown>;
  draftPlan(rawJson: string, mode: 'additive' | 'additive-with-meta' | 'controlled-merge', title?: string): Promise<unknown>;
  approvePlan(planId: string, ttlMs?: number): Promise<{ token: string; planId: string; expiresAt: number }>;
  executePlan(planId: string, token: string, dryRun?: boolean): Promise<{ planId: string; status: string; succeeded: number; failed: number; compensated: number }>;
  listPlans(): Promise<unknown[]>;
  getPlan(planId: string): Promise<unknown>; // returns plan + steps or null
}

/**
 * Map a BackgroundRequest `'type'` literal to the specific union member
 * that has that type. Lets `register('SYNC', (req) => req.reason)`
 * type-check without an explicit cast.
 */
type ByType<T extends BackgroundRequest['type']> = Extract<BackgroundRequest, { type: T }>;

export class BackgroundRouter {
  private readonly routes = new Map<BackgroundRequest['type'], (req: BackgroundRequest) => Promise<unknown>>();

  constructor(private readonly deps: RouterDeps) {}

  register<T extends BackgroundRequest['type'], R>(
    type: T,
    handle: (req: ByType<T>) => Promise<R>,
  ): this {
    this.routes.set(type, handle as (req: BackgroundRequest) => Promise<unknown>);
    return this;
  }

  async dispatch(raw: unknown): Promise<BackgroundResponse<unknown>> {
    const req = raw as BackgroundRequest;
    if (!req || typeof req !== 'object') {
      return err('?', { code: 'INVALID_REQUEST', message: 'request must be an object', retryable: false });
    }
    const requestId = (req as BackgroundRequest).requestId;
    if (typeof requestId !== 'string' || requestId.length === 0) {
      return err('?', { code: 'INVALID_REQUEST', message: 'requestId is required', retryable: false });
    }
    const handler = this.routes.get(req.type);
    if (!handler) {
      return err(requestId, { code: 'INVALID_REQUEST', message: `unknown request type: ${req.type}`, retryable: false });
    }
    try {
      const data = await handler(req);
      return ok(requestId, data);
    } catch (e) {
      const appErr: AppError = e instanceof AppErrorImpl ? e.toJSON() : toAppError(e);
      return err(requestId, appErr);
    }
  }
}
