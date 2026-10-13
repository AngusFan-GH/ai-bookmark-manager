// src/domain/health/fetch-client.ts
//
// FetchClient — controlled HEAD/GET with timeout, redirects, body
// cap, abort signal. Dev guide § 3.4 step 3:
//
//   - "先尝试 HEAD；405/501 或结果不可信时受控 GET；设超时、最大响应
//     体、请求取消、重定向上限."
//
// We split the implementation from the Chrome fetch adapter (which
// uses the real browser network stack) so tests can pass a stub
// that resolves with arbitrary status codes / redirects / errors.
// In production the adapter wraps `fetch()` with an AbortController.

import { guardResolvedHost, isPrivateLiteralAddress, type DnsResolver } from './url-guard';

export interface FetchLikeResponse {
  status: number;
  /** Final URL after all redirects have been followed. */
  url: string;
  /** Optional Retry-After (seconds) parsed from headers. */
  retryAfterSec: number | null;
  /** Optional body for a small GET (used for soft-404 detection). */
  body?: string;
}

export interface FetchLikeRequest {
  method: 'HEAD' | 'GET';
  url: string;
  timeoutMs: number;
  maxRedirects: number;
  maxResponseBytes: number;
  userAgent: string;
  signal?: AbortSignal;
  /** Resolver used to defend against DNS-based SSRF. */
  dns: DnsResolver;
}

export type FetchLikeFn = (req: FetchLikeRequest) => Promise<FetchLikeResponse>;

export type FetchNetworkErrorStage = 'dns' | 'tcp' | 'tls' | 'abort' | 'unknown';

export interface FetchAttemptOutcome {
  /** HTTP status (after redirects) or 0 if no response received. */
  httpCode: number;
  /** Final URL after redirects (or the original URL if no redirect). */
  finalUrl: string;
  /** Number of redirects followed. */
  redirectCount: number;
  /** Network-layer error stage, or null. */
  networkError: FetchNetworkErrorStage | null;
  /** The response body, if a GET was performed. */
  body?: string;
  /** Retry-After (seconds) from the final response. */
  retryAfterSec: number | null;
}

export interface FetchClientDeps {
  fetch: FetchLikeFn;
  defaultMaxRedirects: number;
  defaultTimeoutMs: number;
  defaultMaxResponseBytes: number;
  defaultUserAgent: string;
}

/**
 * Try HEAD first. If the response is 405 / 501 (method not allowed /
 * not implemented) or another code that suggests HEAD is unreliable,
 * retry as a GET (capped at maxResponseBytes).
 */
export async function fetchOnce(
  url: string,
  method: 'HEAD' | 'GET',
  deps: FetchClientDeps,
  opts: Partial<FetchLikeRequest> = {},
): Promise<FetchAttemptOutcome> {
  const maxRedirects = opts.maxRedirects ?? deps.defaultMaxRedirects;
  const timeoutMs = opts.timeoutMs ?? deps.defaultTimeoutMs;
  const maxResponseBytes = opts.maxResponseBytes ?? deps.defaultMaxResponseBytes;
  const userAgent = opts.userAgent ?? deps.defaultUserAgent;
  const signal = opts.signal;
  // Provide a default no-op DNS resolver for tests/callers that
  // pass opts without one. Production callers wire a real `dns.lookup`.
  const dns: DnsResolver = opts.dns ?? { lookup: async () => [] };

  // Defensive DNS check (best-effort).
  const host = new URL(url).hostname;
  const dnsCheck = await guardResolvedHost(host, dns);
  if (!dnsCheck.ok) {
    return {
      httpCode: 0,
      finalUrl: url,
      redirectCount: 0,
      networkError: 'dns',
      retryAfterSec: null,
    };
  }

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), timeoutMs);
  if (signal) {
    signal.addEventListener('abort', () => ac.abort(), { once: true });
  }
  try {
    const resp = await deps.fetch({
      method, url, timeoutMs, maxRedirects, maxResponseBytes, userAgent, signal: ac.signal, dns,
    });
    return {
      httpCode: resp.status,
      finalUrl: resp.url,
      redirectCount: 0, // the real fetch impl is responsible for following redirects
      networkError: null,
      body: resp.body,
      retryAfterSec: resp.retryAfterSec,
    };
  } catch (err) {
    const stage = mapErrorStage(err);
    return {
      httpCode: 0,
      finalUrl: url,
      redirectCount: 0,
      networkError: stage,
      retryAfterSec: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function mapErrorStage(err: unknown): FetchNetworkErrorStage {
  if (!err) return 'unknown';
  const name = (err as { name?: string } | null)?.name ?? '';
  if (name === 'AbortError') return 'abort';
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (msg.includes('dns') || msg.includes('getaddrinfo') || msg.includes('enotfound')) return 'dns';
  if (msg.includes('tls') || msg.includes('ssl') || msg.includes('cert')) return 'tls';
  if (msg.includes('tcp') || msg.includes('econnrefused') || msg.includes('econnreset')) return 'tcp';
  return 'unknown';
}

/**
 * The decision table for "HEAD then maybe GET" from dev guide § 3.4
 * step 3. We surface the policy as a pure function so tests can
 * exercise it without any network I/O.
 */
export function shouldRetryAsGet(httpCode: number): boolean {
  // 405 (method not allowed) and 501 (not implemented) are the two
  // well-known "HEAD is not a thing on this server" responses. Some
  // servers also return 403 on HEAD (bot protection). We do NOT
  // re-attempt on 403 — that's a deliberate "go away" response.
  return httpCode === 405 || httpCode === 501;
}

/**
 * Convenience: run the full HEAD-then-GET-fallback flow with the
 * given FetchClient deps. Returns the final outcome and which method
 * produced it.
 */
export async function probeUrl(
  url: string,
  deps: FetchClientDeps,
  opts: Partial<FetchLikeRequest> = {},
): Promise<{ outcome: FetchAttemptOutcome; method: 'HEAD' | 'GET' }> {
  const head = await fetchOnce(url, 'HEAD', deps, opts);
  if (head.httpCode > 0 && !shouldRetryAsGet(head.httpCode)) {
    return { outcome: head, method: 'HEAD' };
  }
  // HEAD failed or was uninformative; try GET (still bounded).
  const get = await fetchOnce(url, 'GET', deps, opts);
  return { outcome: get, method: 'GET' };
}

/**
 * Expose the private literal check to other modules (HealthService)
 * for redirect re-validation.
 */
export { isPrivateLiteralAddress };
