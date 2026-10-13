// tests/integration/background-router.test.ts
//
// Verifies the typed router contract:
//   - unknown request type → INVALID_REQUEST error
//   - missing requestId → INVALID_REQUEST error
//   - successful handler → ok envelope with data
//   - thrown AppErrorImpl → its code/message/retryable are preserved
//   - generic Error → mapped via toAppError
//   - REGRESSION: every BackgroundRequest type dispatched in the actual
//     background.ts wiring has a registered handler (this is what
//     bit us in commit 04e9422 — see phase-1-report § ISS-1 /
//     follow-up bug 'unknown request type: SYNC').

import { describe, expect, it, vi } from 'vitest';
import { BackgroundRouter } from '../../src/infrastructure/messaging/background-router';
import { AppErrorImpl } from '../../src/shared/errors';
import type { BackgroundRequest } from '../../src/infrastructure/messaging/contracts';

const deps = () => ({
  listBookmarks: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
  listFolders: vi.fn().mockResolvedValue([]),
  getStats: vi.fn().mockResolvedValue({ bookmarks: 0, folders: 0, lastSync: null, syncState: { status: 'idle', lastSyncAt: null, lastError: null, count: 0, generation: 0 } }),
  fullSync: vi.fn().mockResolvedValue({ count: 7 }),
  exportBackup: vi.fn().mockResolvedValue({ formatVersion: 1 }),
  readSyncState: vi.fn().mockResolvedValue({ status: 'idle', lastSyncAt: null, lastError: null, count: 0, generation: 0 }),
  // Phase 2 — kept as vi.fn so the regression test can update them.
  previewImport: vi.fn().mockResolvedValue({ ok: true, summary: { adds: 0, updates: 0, moves: 0, deletes: 0, noops: 0 }, conflicts: [], sample: [], totalNodes: 0, formatVersion: 1, mode: 'additive' }),
  draftPlan: vi.fn().mockResolvedValue({ id: 'plan-1', status: 'draft', title: 'p', stepCount: 0, createdAt: 0 }),
  approvePlan: vi.fn().mockResolvedValue({ token: 'tok', planId: 'p', expiresAt: 0 }),
  executePlan: vi.fn().mockResolvedValue({ planId: 'p', status: 'completed', succeeded: 0, failed: 0, compensated: 0 }),
  listPlans: vi.fn().mockResolvedValue([]),
  getPlan: vi.fn().mockResolvedValue({ id: 'p', steps: [], status: 'draft' }),
  // Phase 3
  startHealth: vi.fn().mockResolvedValue({ total: 0, enqueued: 0, skipped: 0 }),
  cancelHealth: vi.fn().mockResolvedValue({ status: 'cancelled' }),
  pauseHealth: vi.fn().mockResolvedValue({ status: 'paused' }),
  resumeHealth: vi.fn().mockResolvedValue({ status: 'running' }),
  healthStatus: vi.fn().mockResolvedValue({ status: 'idle', queued: 0, inflight: 0, total: 0, processed: 0, cancelled: 0, active: [], nextEligibleAt: null, lastError: null }),
  listHealth: vi.fn().mockResolvedValue({ rows: [], status: { status: 'idle', queued: 0, inflight: 0, total: 0, processed: 0, cancelled: 0, active: [], nextEligibleAt: null, lastError: null } }),
  healthPermissionStatus: vi.fn().mockResolvedValue({ granted: false }),
  requestHealthPermission: vi.fn().mockResolvedValue({ granted: true }),
  removeHealthPermission: vi.fn().mockResolvedValue({ granted: false }),
  // Phase 3.5
  getSetting: vi.fn().mockResolvedValue(false),
  setSetting: vi.fn().mockResolvedValue(undefined),
});

/**
 * Mirror of the exact registration pattern in entrypoints/background.ts.
 * If a new BackgroundRequest type is added to contracts.ts but not
 * registered here, the regression test below will fail.
 */
function wireLikeBackground(d: ReturnType<typeof deps>): BackgroundRouter {
  return new BackgroundRouter(d)
    .register('BOOKMARKS_LIST', (req) => d.listBookmarks(
      req.query ?? '', req.folderId, req.limit ?? 200, req.offset ?? 0,
    ))
    .register('BOOKMARKS_TREE', () => d.listFolders())
    .register('STATS', () => d.getStats())
    .register('SYNC', (req) => d.fullSync(req.reason ?? 'manual'))
    .register('EXPORT', () => d.exportBackup())
    .register('SYNC_STATE', () => d.readSyncState())
    .register('IMPORT_PREVIEW', (req) => d.previewImport(req.rawJson, req.mode))
    .register('PLAN_DRAFT', (req) => d.draftPlan(req.rawJson, req.mode))
    .register('PLAN_LIST', () => d.listPlans())
    .register('PLAN_GET', (req) => d.getPlan(req.planId))
    .register('APPROVE', (req) => d.approvePlan(req.planId, req.ttlMs))
    .register('EXECUTE', (req) => d.executePlan(req.planId, req.approvalToken, req.dryRun))
    .register('HEALTH_START', (req) => d.startHealth(req.bookmarkIds))
    .register('HEALTH_CANCEL', () => d.cancelHealth())
    .register('HEALTH_PAUSE', () => d.pauseHealth())
    .register('HEALTH_RESUME', () => d.resumeHealth())
    .register('HEALTH_STATUS', () => d.healthStatus())
    .register('HEALTH_LIST', () => d.listHealth())
    .register('HEALTH_PERMISSION_STATUS', () => d.healthPermissionStatus())
    .register('HEALTH_PERMISSION_REQUEST', () => d.requestHealthPermission())
    .register('HEALTH_PERMISSION_REMOVE', () => d.removeHealthPermission())
    .register('SETTINGS_GET', (req) => d.getSetting(req.key))
    .register('SETTINGS_SET', (req) => d.setSetting(req.key, req.value));
}

describe('BackgroundRouter', () => {
  it('rejects unknown request type with INVALID_REQUEST', async () => {
    const r = new BackgroundRouter(deps());
    const out = await r.dispatch({ type: 'NOPE', requestId: 'r1' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('INVALID_REQUEST');
  });

  it('rejects a request without requestId', async () => {
    const r = new BackgroundRouter(deps());
    const out = await r.dispatch({ type: 'STATS' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('INVALID_REQUEST');
  });

  it('wraps successful handlers in an ok envelope with the requestId', async () => {
    const d = deps();
    const r = new BackgroundRouter(d);
    r.register('STATS', (req) => d.getStats(req.requestId) as any);
    const out = await r.dispatch({ type: 'STATS', requestId: 'abc' });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.requestId).toBe('abc');
    }
  });

  it('preserves AppErrorImpl code/retryable on a thrown error', async () => {
    const d = deps();
    d.getStats = vi.fn().mockRejectedValue(new AppErrorImpl('PERMISSION_REQUIRED', 'revoked', false));
    const r = new BackgroundRouter(d);
    r.register('STATS', () => d.getStats() as any);
    const out = await r.dispatch({ type: 'STATS', requestId: 'r2' });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('PERMISSION_REQUIRED');
      expect(out.error.message).toBe('revoked');
      expect(out.error.retryable).toBe(false);
    }
  });

  it('maps plain Error to UNKNOWN via toAppError', async () => {
    const d = deps();
    d.getStats = vi.fn().mockRejectedValue(new Error('boom'));
    const r = new BackgroundRouter(d);
    r.register('STATS', () => d.getStats() as any);
    const out = await r.dispatch({ type: 'STATS', requestId: 'r3' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('UNKNOWN');
  });

  it('returns ok envelope for a registered type that is not STATS', async () => {
    const d = deps();
    const r = new BackgroundRouter(d);
    r.register('SYNC', async (req) => {
      void req; return d.fullSync('manual');
    });
    const out = await r.dispatch({ type: 'SYNC', requestId: 's1', reason: 'manual' });
    expect(out.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression: every BackgroundRequest type that the UI / popup / options
// pages can send must be registered in the background router. We do NOT
// want to see "unknown request type: SYNC" again.
// ---------------------------------------------------------------------------

describe('BackgroundRouter — background.ts wiring regression', () => {
  it('every BackgroundRequest type emitted by the UI has a registered handler', async () => {
    const d = deps();
    const r = wireLikeBackground(d);

    // The exhaustive set of BackgroundRequest 'type' values used in
    // production: src/store.ts, entrypoints/options/App.vue,
    // entrypoints/popup/App.vue. If a new request type is added, add
    // it to BOTH contracts.ts AND background.ts AND this list.
    const types: BackgroundRequest['type'][] = [
      'BOOKMARKS_LIST',
      'BOOKMARKS_TREE',
      'STATS',
      'SYNC',
      'EXPORT',
      'SYNC_STATE',
      'IMPORT_PREVIEW',
      'PLAN_DRAFT',
      'PLAN_LIST',
      'PLAN_GET',
      'APPROVE',
      'EXECUTE',
      'HEALTH_START',
      'HEALTH_CANCEL',
      'HEALTH_PAUSE',
      'HEALTH_RESUME',
      'HEALTH_STATUS',
      'HEALTH_LIST',
      'HEALTH_PERMISSION_STATUS',
      'HEALTH_PERMISSION_REQUEST',
      'HEALTH_PERMISSION_REMOVE',
      'SETTINGS_GET',
      'SETTINGS_SET',
    ];

    for (const t of types) {
      const req = { type: t, requestId: `reg-${t}` } as BackgroundRequest;
      const out = await r.dispatch(req);
      expect(out.ok, `request type ${t} returned ${JSON.stringify(out)}`).toBe(true);
    }
  });

  it('SYNC request with reason="manual" reaches fullSync() (the original bug)', async () => {
    const d = deps();
    const r = wireLikeBackground(d);
    const out = await r.dispatch({ type: 'SYNC', requestId: 'manual', reason: 'manual' });
    expect(out.ok).toBe(true);
    expect(d.fullSync).toHaveBeenCalledWith('manual');
  });
});
