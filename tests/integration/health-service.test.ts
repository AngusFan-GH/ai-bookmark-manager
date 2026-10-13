// tests/integration/health-service.test.ts
//
// HealthService integration: URL guard + DNS guard + HEAD→GET
// fallback + classifier + scheduler + persistence.

import { describe, expect, it, beforeEach } from 'vitest';
import { HealthService } from '../../src/domain/health/service';
import type { LinkCheckRecord } from '../../src/domain/health/types';
import type { BookmarkRecord } from '../../src/domain/bookmarks/types';

let saved: LinkCheckRecord[] = [];
let nextIdCounter = 0;
const newId = (): string => `hc-${++nextIdCounter}`;

function bookmarks(): BookmarkRecord[] {
  return [
    {
      id: 'b1', browserId: 'b1', kind: 'bookmark', parentId: null, index: 0,
      title: 'Public', url: 'https://example.com/a', updatedAt: 0, syncGeneration: 1, path: '',
    },
    {
      id: 'b2', browserId: 'b2', kind: 'bookmark', parentId: null, index: 0,
      title: 'Local', url: 'http://localhost/x', updatedAt: 0, syncGeneration: 1, path: '',
    },
    {
      id: 'b3', browserId: 'b3', kind: 'bookmark', parentId: null, index: 0,
      title: 'FTP', url: 'ftp://example.com/y', updatedAt: 0, syncGeneration: 1, path: '',
    },
  ];
}

type HealthDeps = ConstructorParameters<typeof HealthService>[0];

function makeDeps(overrides: Partial<HealthDeps> = {}): HealthDeps {
  return {
    listBookmarks: async () => bookmarks(),
    latestChecks: async () => saved,
    saveCheck: async (r: LinkCheckRecord) => { saved.push(r); },
    dns: { lookup: async () => ['8.8.8.8'] },
    fetch: async (req: { url: string; method: string; signal?: AbortSignal; timeoutMs: number; userAgent: string; maxResponseBytes: number; maxRedirects: number; dns?: unknown }) => {
      if (req.url.includes('200')) return { status: 200, url: req.url, retryAfterSec: null, body: 'ok' };
      if (req.url.includes('404')) return { status: 404, url: req.url, retryAfterSec: null };
      return { status: 200, url: req.url, retryAfterSec: null, body: 'ok' };
    },
    config: {
      defaultTimeoutMs: 1000, defaultMaxRedirects: 5, defaultMaxResponseBytes: 1000,
      defaultUserAgent: 'test', globalConcurrency: 2, perHostConcurrency: 1, maxRetries: 0,
      allowPrivateHosts: false,
    },
    now: () => Date.now(),
    newId,
    isPaused: () => false,
    readAllowPrivateHosts: async () => false,
    canFetch: async () => true,
    ...overrides,
  };
}

beforeEach(() => { saved = []; nextIdCounter = 0; });

describe('HealthService — start', () => {
  it('persists an unsupported record for local URLs without probing', async () => {
    const svc = new HealthService(makeDeps());
    const r = await svc.start();
    // b1 (public) is enqueued; b2 (localhost) and b3 (ftp) are
    // recorded as unsupported without making a network call.
    expect(r.skipped).toBe(2);
    const unsupported = saved.filter((s) => s.status === 'unsupported');
    expect(unsupported.length).toBe(2);
    expect(unsupported.map((s) => s.bookmarkId).sort()).toEqual(['b2', 'b3']);
  });

  it('returns enqueued count for the public host', async () => {
    const svc = new HealthService(makeDeps());
    const r = await svc.start();
    expect(r.enqueued).toBe(1);
    expect(r.total).toBe(3); // 1 enqueued + 2 skipped
  });

  it('records permission_required without sending a network request', async () => {
    let fetchCalls = 0;
    const svc = new HealthService(makeDeps({
      canFetch: async () => false,
      fetch: async () => {
        fetchCalls += 1;
        return { status: 200, url: 'https://example.com', retryAfterSec: null };
      },
    }));
    const r = await svc.start(['b1']);
    expect(r.skipped).toBe(1);
    expect(fetchCalls).toBe(0);
    expect(saved).toEqual(expect.arrayContaining([
      expect.objectContaining({ bookmarkId: 'b1', status: 'permission_required' }),
    ]));
  });

  it('completes a small scan and records a healthy result for the public URL', async () => {
    const svc = new HealthService(makeDeps());
    await svc.start();
    // Wait for the scheduler to finish
    while (svc.snapshotStatus().inflight > 0 || svc.snapshotStatus().queued > 0) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const healthy = saved.find((s) => s.bookmarkId === 'b1' && s.status === 'healthy');
    expect(healthy).toBeDefined();
    expect(svc.snapshotStatus().status).toBe('completed');
    expect(svc.snapshotStatus().processed).toBe(3);
  });

  it('confirms a 404 only after a second GET check', async () => {
    let getCalls = 0;
    const svc = new HealthService(makeDeps({
      listBookmarks: async () => [bookmarks()[0]],
      config: { ...makeDeps().config, maxRetries: 1 },
      fetch: async (req) => {
        if (req.method === 'GET') getCalls += 1;
        return { status: 404, url: req.url, retryAfterSec: null };
      },
    }));
    await svc.start();
    while (svc.snapshotStatus().inflight > 0 || svc.snapshotStatus().queued > 0) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(getCalls).toBe(2);
    expect(saved).toEqual(expect.arrayContaining([
      expect.objectContaining({ bookmarkId: 'b1', status: 'confirmed_dead' }),
    ]));
  });

  it('cancels queued probes instead of allowing them to resume', async () => {
    const slowBookmarks = (): BookmarkRecord[] => Array.from({ length: 3 }, (_, i) => ({
      id: `b${i}`, browserId: `b${i}`, kind: 'bookmark', parentId: null, index: i,
      title: `Bookmark ${i}`, url: `https://example.com/${i}`, updatedAt: 0, syncGeneration: 1, path: '',
    }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const svc = new HealthService(makeDeps({
      listBookmarks: async () => slowBookmarks(),
      config: { ...makeDeps().config, globalConcurrency: 1 },
      fetch: async (req) => {
        await gate;
        return { status: 200, url: req.url, retryAfterSec: null };
      },
    }));
    await svc.start();
    svc.cancel();
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(svc.snapshotStatus().status).toBe('cancelled');
    expect(svc.snapshotStatus().queued).toBe(0);
    expect(saved).toHaveLength(0);
  });
});

describe('HealthService — snapshot', () => {
  it('returns one row per bookmark with the most recent check', async () => {
    saved = [
      { id: 'x1', bookmarkId: 'b1', url: 'https://example.com/a', syncGeneration: 1, status: 'healthy', httpCode: 200, checkedAt: 100, evidence: [] },
      { id: 'x2', bookmarkId: 'b1', url: 'https://example.com/a', syncGeneration: 1, status: 'redirected', httpCode: 301, checkedAt: 200, evidence: [] },
    ];
    const svc = new HealthService(makeDeps());
    const snap = await svc.snapshot();
    expect(snap.rows).toHaveLength(3);
    expect(snap.rows.find((row) => row.bookmarkId === 'b1')?.status).toBe('redirected');
    expect(snap.rows.filter((row) => row.status === 'unchecked').map((row) => row.bookmarkId).sort()).toEqual(['b2', 'b3']);
  });

  it('marks a saved result outdated when the bookmark URL has changed', async () => {
    saved = [{ id: 'old', bookmarkId: 'b1', url: 'https://old.example', syncGeneration: 1, status: 'healthy', checkedAt: 100, evidence: [] }];
    const svc = new HealthService(makeDeps());
    const snap = await svc.snapshot();
    expect(snap.rows.find((row) => row.bookmarkId === 'b1')).toEqual(expect.objectContaining({
      status: 'outdated', url: 'https://example.com/a',
    }));
  });
});
