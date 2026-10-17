import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchOnce, probeUrl, type FetchClientDeps } from '../../src/domain/health/fetch-client';
import { guardUrl, guardResolvedHost, isPrivateLiteralAddress } from '../../src/domain/health/url-guard';
import { classify } from '../../src/domain/health/classifier';
import { HealthService, type HealthServiceDeps } from '../../src/domain/health/service';
import type { LinkCheckRecord } from '../../src/domain/health/types';

const url = 'https://example.com/bookmark';
const response = (status = 404) => ({ status, url, retryAfterSec: null });
const client = (fetch: FetchClientDeps['fetch']): FetchClientDeps => ({
  fetch, defaultTimeoutMs: 1000, defaultMaxRedirects: 0,
  defaultMaxResponseBytes: 1000, defaultUserAgent: 'test',
});
afterEach(() => vi.useRealTimers());

describe('health guard canonicalization', () => {
  it.each(['localhost.', 'LOCALHOST.', 'app.localhost.', 'printer.local.', 'db.internal.', 'nas.lan.', '127.1', '0x7f000001', '2130706433', '192.0.2.1'])('blocks %s without opt-in', (host) => {
    expect(guardUrl(`http://${host}/`).ok).toBe(false);
    expect(guardUrl(`http://${host}/`, { allowPrivateHosts: true }).ok).toBe(true);
  });
  it.each(['192.0.3.1', '192.2.1.1', 'example.com.'])('does not overblock public host %s', (host) => {
    expect(guardUrl(`https://${host}/`).ok).toBe(true);
  });
  it.each(['::ffff:7f00:1', '0:0:0:0:0:0:0:1', '0:0:0:0:0:ffff:a00:1', 'fe80::1', 'fc00::1', '2001:db8::1', 'garbage', '8.8.8.999'])('rejects private or invalid DNS address %s', (address) => {
    expect(isPrivateLiteralAddress(address)).toBe(true);
  });
  it.each(['::ffff:808:808', '2001:4860:4860::8888', '8.8.8.8'])('accepts public DNS address %s', (address) => {
    expect(isPrivateLiteralAddress(address)).toBe(false);
  });
  it('fails closed for empty and mixed resolver results', async () => {
    for (const addresses of [[], ['8.8.8.8', '::ffff:7f00:1'], ['not-an-address']]) {
      expect((await guardResolvedHost('example.com', { lookup: async () => addresses })).ok).toBe(false);
    }
  });
});

describe('health fetch cancellation', () => {
  it('does not resolve DNS or fetch when already cancelled', async () => {
    const ac = new AbortController(); ac.abort();
    const fetch = vi.fn(async () => response());
    const lookup = vi.fn(async () => ['8.8.8.8']);
    const result = await probeUrl(url, client(fetch), { signal: ac.signal, dns: { lookup } });
    expect(result.outcome.networkError).toBe('abort');
    expect(fetch).not.toHaveBeenCalled(); expect(lookup).not.toHaveBeenCalled();
  });
  it('honors explicit private-host opt-in for the DNS check', async () => {
    const fetch = vi.fn(async () => response(200));
    const result = await fetchOnce('http://localhost/', 'HEAD', client(fetch), {
      dns: { lookup: async () => ['127.0.0.1'] }, allowPrivateHosts: true,
    });
    expect(result.httpCode).toBe(200); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not fetch when cancelled during DNS', async () => {
    const ac = new AbortController();
    const fetch = vi.fn(async () => response());
    const result = await fetchOnce(url, 'HEAD', client(fetch), {
      signal: ac.signal, dns: { lookup: async () => { ac.abort(); return ['8.8.8.8']; } },
    });
    expect(result.networkError).toBe('abort'); expect(fetch).not.toHaveBeenCalled();
  });
  it('does not begin fallback GET after HEAD cancellation', async () => {
    const ac = new AbortController();
    const fetch = vi.fn(async () => { ac.abort(); return response(405); });
    const result = await probeUrl(url, client(fetch), { signal: ac.signal });
    expect(result.outcome.networkError).toBe('abort'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('removes its parent abort listener after success and failure', async () => {
    for (const fail of [false, true]) {
      const ac = new AbortController();
      const add = vi.spyOn(ac.signal, 'addEventListener');
      const remove = vi.spyOn(ac.signal, 'removeEventListener');
      await fetchOnce(url, 'HEAD', client(async () => { if (fail) throw new Error('network'); return response(200); }), { signal: ac.signal });
      expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]);
    }
  });
  it('does not fallback after a timeout abort', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (req: Parameters<FetchClientDeps['fetch']>[0]) => new Promise<never>((_, reject) => {
      req.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const pending = probeUrl(url, client(fetch));
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).outcome.networkError).toBe('abort');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

function service(fetch: HealthServiceDeps['fetch'], saved: LinkCheckRecord[], maxRetries = 1): HealthService {
  return new HealthService({
    listBookmarks: async () => [{ id: 'b1', browserId: 'b1', kind: 'bookmark', parentId: null, index: 0, title: 'Test', url, updatedAt: 0, syncGeneration: 1, path: '' }],
    latestChecks: async () => saved,
    saveCheck: async (record) => { saved.push(record); }, fetch,
    canFetch: async () => true, readAllowPrivateHosts: async () => false,
    config: { defaultTimeoutMs: 1000, defaultMaxRedirects: 0, defaultMaxResponseBytes: 1000, defaultUserAgent: 'test', globalConcurrency: 1, perHostConcurrency: 1, maxRetries, allowPrivateHosts: false },
    now: () => Date.now(), newId: () => 'check', isPaused: () => false,
  });
}

describe('health evidence counting', () => {
  it('does not classify retry count as repeated dead-link evidence', () => {
    expect(classify({ httpCode: 404, attempts: 10 }).status).toBe('suspected_dead');
    expect(classify({ httpCode: 410, priorDeadResponses: 1 }).status).toBe('repeated_not_found');
  });
  it.each([404, 410])('does not confirm a single %s after a network failure', async (code) => {
    vi.useFakeTimers();
    const saved: LinkCheckRecord[] = []; let calls = 0;
    const svc = service(async () => { calls++; if (calls <= 2) throw new Error('Failed to fetch'); return response(code); }, saved);
    await svc.start(); await vi.runAllTimersAsync();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ status: 'suspected_dead', httpCode: code, url });
  });
  it('requires two independent GET 404 responses for confirmation', async () => {
    vi.useFakeTimers();
    const saved: LinkCheckRecord[] = [];
    const fetch = vi.fn(async () => response(404));
    const svc = service(fetch, saved);
    await svc.start(); await vi.runAllTimersAsync();
    expect(saved[0].status).toBe('repeated_not_found'); expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('cancellation during HEAD prevents service GET and persistence', async () => {
    vi.useFakeTimers();
    const saved: LinkCheckRecord[] = [];
    let svc: HealthService;
    const fetch = vi.fn(async () => { svc.cancel(); return response(405); });
    svc = service(fetch, saved);
    await svc.start(); await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(1); expect(saved).toHaveLength(0);
    expect(svc.snapshotStatus().status).toBe('cancelled');
  });
});
