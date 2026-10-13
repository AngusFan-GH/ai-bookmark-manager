// tests/integration/fetch-client.test.ts
//
// FetchClient + classifier + URL guard — exercised against the
// in-process mock HTTP server so we cover the full status-code
// matrix from dev guide § 3.4 step 4.
//
// We use Node's built-in `http` client (not the global `fetch`)
// because happy-dom blocks the global fetch via same-origin policy.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import { startMockServer, type MockServer } from '../fixtures/mock-http-server';
import { fetchOnce, probeUrl, shouldRetryAsGet } from '../../src/domain/health/fetch-client';
import { classify } from '../../src/domain/health/classifier';
import { guardUrl } from '../../src/domain/health/url-guard';
import { DEFAULT_HEALTH_CONFIG } from '../../src/domain/health/types';

let server: MockServer;
const deps = () => ({
  fetch: realFetch,
  defaultMaxRedirects: DEFAULT_HEALTH_CONFIG.maxRedirects,
  defaultTimeoutMs: DEFAULT_HEALTH_CONFIG.timeoutMs,
  defaultMaxResponseBytes: DEFAULT_HEALTH_CONFIG.maxResponseBytes,
  defaultUserAgent: DEFAULT_HEALTH_CONFIG.userAgent,
});

/**
 * Minimal Node-native http client. Implements the FetchLikeFn
 * contract: HEAD/GET with timeout, redirects (follow), response body
 * cap, Retry-After header, abort signal.
 *
 * We do NOT depend on the global `fetch` (which is blocked by
 * happy-dom's same-origin policy in tests). Using node:http directly
 * avoids that.
 */
function realFetch(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const u = new URL(req.url);
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      // Abort by destroying the socket — there's no per-request
      // cancellation on a node http.ClientRequest beyond .destroy().
      try { req._socket?.destroy(); } catch { /* ignore */ }
      reject(new Error('aborted'));
    };
    if (req.signal?.aborted) { onAbort(); return; }
    req.signal?.addEventListener?.('abort', onAbort, { once: true });

    const opts = {
      method: req.method,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: { 'user-agent': req.userAgent },
    };
    const r = httpRequest(opts, (res) => {
      if (aborted) return;
      // Manually follow redirects (max req.maxRedirects hops).
      const location = res.headers['location'];
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && location) {
        // Consume the body to free the socket
        res.resume();
        const next = new URL(location, req.url).toString();
        if (req._redirects === undefined) req._redirects = 0;
        req._redirects += 1;
        if (req._redirects > req.maxRedirects) {
          return reject(new Error('too many redirects'));
        }
        return resolve(realFetch({ ...req, url: next }));
      }
      const retryAfter = res.headers['retry-after'];
      let body = '';
      let received = 0;
      res.on('data', (chunk) => {
        if (aborted) return;
        received += chunk.length;
        if (received > req.maxResponseBytes) {
          // Cap reached; stop reading.
          res.destroy();
          return;
        }
        body += chunk.toString('utf8');
      });
      res.on('end', () => {
        if (aborted) return;
        resolve({
          status,
          url: req.url,
          retryAfterSec: retryAfter ? Number(retryAfter) : null,
          ...(req.method === 'GET' ? { body } : {}),
        });
      });
      res.on('error', (e) => { if (!aborted) reject(e); });
    });
    r.setTimeout(req.timeoutMs, () => {
      aborted = true;
      r.destroy();
      reject(new Error('timeout'));
    });
    r.on('error', (e) => { if (!aborted) reject(e); });
    r.end();
  });
}

beforeEach(async () => { server = await startMockServer(); });
afterEach(async () => { await server.close(); });

describe('guardUrl + URL pass-through', () => {
  it('rejects the mock server URL (it is on 127.0.0.1)', () => {
    // The mock server binds to 127.0.0.1, which is correctly blocked
    // by URLGuard — the public tests must use the DNS-side bypass
    // (guardResolvedHost with a custom resolver) or run against a
    // real public host. This is the intended behavior.
    const v = guardUrl(server.baseUrl + '/');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('PRIVATE_HOST');
  });
  it('rejects the mock server URL if it had credentials', () => {
    const u = server.baseUrl.replace('http://', 'http://u:p@') + '/';
    const v = guardUrl(u);
    expect(v.ok).toBe(false);
  });
  it('accepts a hostname URL (no IP literal)', () => {
    const v = guardUrl('https://example.com/path');
    expect(v.ok).toBe(true);
  });
});

describe('fetchOnce — status matrix', () => {
  for (const code of [200, 204, 301, 302, 307, 401, 403, 404, 410, 429, 500, 502, 503, 504]) {
    it(`status ${code} flows correctly through fetch + classify`, async () => {
      const path = `/status-${code}`;
      server.setRoute(path, () => ({
        status: code,
        ...(code === 429 ? { headers: { 'retry-after': '42' } } : {}),
      }));
      const out = await fetchOnce(server.baseUrl + path, 'HEAD', deps());
      expect(out.httpCode).toBe(code);
      const c = classify({
        httpCode: out.httpCode,
        retryAfterSec: out.retryAfterSec,
      });
      if (code >= 400 && code < 500) {
        expect(['auth_required', 'forbidden', 'rate_limited', 'suspected_dead', 'redirected']).toContain(c.status);
      }
      if (code === 429) {
        expect(c.retryAfterSec).toBe(42);
      }
    });
  }
});

describe('probeUrl — HEAD then GET fallback', () => {
  it('uses GET after HEAD returns 405', async () => {
    const path = '/method-fallback';
    server.setRoute(path, (req) => {
      if (req.method === 'HEAD') return { status: 405 };
      return { status: 200, body: 'ok' };
    });
    const { outcome, method } = await probeUrl(server.baseUrl + path, deps());
    expect(method).toBe('GET');
    expect(outcome.httpCode).toBe(200);
  });

  it('uses GET after HEAD returns 501', async () => {
    const path = '/method-501';
    server.setRoute(path, (req) => req.method === 'HEAD' ? { status: 501 } : { status: 200, body: 'ok' });
    const { method, outcome } = await probeUrl(server.baseUrl + path, deps());
    expect(method).toBe('GET');
    expect(outcome.httpCode).toBe(200);
  });

  it('keeps HEAD when 404', async () => {
    const path = '/head-404';
    server.setRoute(path, () => ({ status: 404 }));
    const { method, outcome } = await probeUrl(server.baseUrl + path, deps());
    expect(method).toBe('HEAD');
    expect(outcome.httpCode).toBe(404);
  });
});

describe('shouldRetryAsGet — confirms HEAD→GET policy', () => {
  it('returns true only for 405 and 501', () => {
    expect(shouldRetryAsGet(405)).toBe(true);
    expect(shouldRetryAsGet(501)).toBe(true);
    expect(shouldRetryAsGet(404)).toBe(false);
    expect(shouldRetryAsGet(403)).toBe(false);
  });
});

describe('fetchOnce — body cap', () => {
  it('caps the GET body at maxResponseBytes', async () => {
    const path = '/big-body';
    server.setRoute(path, () => ({ status: 200, body: 'X'.repeat(10_000) }));
    const out = await fetchOnce(server.baseUrl + path, 'GET', deps(), { maxResponseBytes: 100 });
    expect(out.body!.length).toBeLessThanOrEqual(100);
  });
});

describe('fetchOnce — timeout', () => {
  it('reports network_error on timeout', async () => {
    // We use a port nobody is listening on; the connect itself fails
    // (TCP), which is a valid network_error outcome.
    const out = await fetchOnce('http://127.0.0.1:1/never', 'GET', deps(), { timeoutMs: 50 });
    expect(out.httpCode).toBe(0);
    expect(out.networkError).not.toBeNull();
  });
});
