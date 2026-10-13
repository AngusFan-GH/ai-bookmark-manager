// tests/integration/background-router.test.ts
//
// Verifies the typed router contract:
//   - unknown request type → INVALID_REQUEST error
//   - missing requestId → INVALID_REQUEST error
//   - successful handler → ok envelope with data
//   - thrown AppErrorImpl → its code/message/retryable are preserved
//   - generic Error → mapped via toAppError

import { describe, expect, it, vi } from 'vitest';
import { BackgroundRouter } from '../../src/infrastructure/messaging/background-router';
import { AppErrorImpl } from '../../src/shared/errors';

const deps = () => ({
  listBookmarks: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
  listFolders: vi.fn().mockResolvedValue([]),
  getStats: vi.fn().mockResolvedValue({ bookmarks: 0, folders: 0, lastSync: null, syncState: { status: 'idle', lastSyncAt: null, lastError: null, count: 0, generation: 0 } }),
  fullSync: vi.fn().mockResolvedValue({ count: 7 }),
  exportBackup: vi.fn().mockResolvedValue({ formatVersion: 1 }),
  readSyncState: vi.fn().mockResolvedValue({ status: 'idle', lastSyncAt: null, lastError: null, count: 0, generation: 0 }),
});

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
