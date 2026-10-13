// src/domain/health/fetch-client.ts
//
// FetchClient — controlled HEAD/GET with timeout, redirect blocking, body
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
  /** Original URL; production does not automatically follow redirects. */
  url: string;
  /** Optional Retry-After (seconds) parsed from headers. */
  retryAfterSec: number | null;
  /** Optional body for a small GET (used for soft-404 detection). */
  body?: string;
  /** The browser refused to expose a manual redirect safely. */
  redirectBlocked?: boolean;
}

export interface FetchLikeRequest {
  method: 'HEAD' | 'GET';
  url: string;
  timeoutMs: number;
  maxRedirects: number;
  maxResponseBytes: number;
  userAgent: string;
  signal?: AbortSignal;
  /** Optional platform DNS resolver. Browser extensions normally lack one. */
  dns?: DnsResolver;
}

export type FetchLikeFn = (req: FetchLikeRequest) => Promise<FetchLikeResponse>;

export type FetchNetworkErrorStage = 'dns' | 'tcp' | 'tls' | 'abort' | 'unknown';

export interface FetchAttemptOutcome {
  /** HTTP status or 0 if no response received. */
  httpCode: number;
  /** URL used for this request (the original URL in production). */
  finalUrl: string;
  /** Number of redirects followed by the injected implementation. */
  redirectCount: number;
  /** Network-layer error stage, or null. */
  networkError: FetchNetworkErrorStage | null;
  /**
   * Raw error code / name from the underlying fetch. Useful for
   * debugging "network: unknown" — the UI surfaces it as the
   * `raw:` evidence token. Empty when no error.
   */
  rawError: string;
  /** The response body, if a GET was performed. */
  body?: string;
  /** Retry-After (seconds) from the final response. */
  retryAfterSec: number | null;
  /** True when a redirect target could not be inspected safely. */
  redirectBlocked?: boolean;
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
  const dns = opts.dns;

  // A browser extension has no portable Node-style DNS API. Only perform a
  // DNS check when a platform resolver is explicitly supplied; do not treat
  // an empty fallback result as proof that a host is public.
  if (dns) {
    const host = new URL(url).hostname;
    const dnsCheck = await guardResolvedHost(host, dns);
    if (!dnsCheck.ok) {
      return {
        httpCode: 0,
        finalUrl: url,
        redirectCount: 0,
        networkError: 'dns',
        rawError: dnsCheck.reason,
        retryAfterSec: null,
      };
    }
  }

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), timeoutMs);
  if (signal) {
    signal.addEventListener('abort', () => ac.abort(), { once: true });
  }
  try {
    const resp = await deps.fetch({
      method, url, timeoutMs, maxRedirects, maxResponseBytes, userAgent, signal: ac.signal, ...(dns ? { dns } : {}),
    });
    return {
      httpCode: resp.status,
      finalUrl: resp.url,
      redirectCount: 0, // production uses manual redirect handling
      networkError: null,
      rawError: '',
      body: resp.body,
      retryAfterSec: resp.retryAfterSec,
      ...(resp.redirectBlocked ? { redirectBlocked: true } : {}),
    };
  } catch (err) {
    const stage = mapErrorStage(err);
    return {
      httpCode: 0,
      finalUrl: url,
      redirectCount: 0,
      networkError: stage,
      rawError: extractRawError(err),
      retryAfterSec: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Pull the most useful diagnostic out of a thrown fetch error so
 * the UI evidence list can show something actionable. We prefer
 * `err.name` (e.g. 'TypeError') and fall back to the message.
 */
function extractRawError(err: unknown): string {
  if (!err) return '';
  if (err instanceof Error) {
    const name = err.name || 'Error';
    const msg = err.message || '';
    // Trim and clamp — the UI evidence list is space-constrained.
    const clean = msg.replace(/\s+/g, ' ').slice(0, 120);
    return clean ? `${name}: ${clean}` : name;
  }
  return String(err).slice(0, 120);
}

/**
 * Map a thrown fetch error to a coarse network stage. The goal is
 * the UI evidence string — accurate diagnosis helps the user
 * understand why their Chinese-domains returned network: unknown
 * (typical: macOS system proxy / VPN / DNS pollution).
 *
 * Order matters: abort > dns > tls > tcp > unknown.
 */
function mapErrorStage(err: unknown): FetchNetworkErrorStage {
  if (!err) return 'unknown';
  const name = (err as { name?: string } | null)?.name ?? '';
  if (name === 'AbortError') return 'abort';
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();

  // abort from our own timeout (we never see this from the global
  // fetch in MV3 service workers, but be defensive).
  if (msg.includes('aborted') || msg.includes('aborted due to')) return 'abort';

  // DNS resolution failures.
  if (msg.includes('getaddrinfo') || msg.includes('enotfound')
      || msg.includes('dns') || msg.includes('name not known')
      || msg.includes('no such host')) return 'dns';

  // TLS / certificate / SNI / protocol issues.
  if (msg.includes('tls') || msg.includes('ssl') || msg.includes('cert')
      || msg.includes('handshake') || msg.includes('unable to verify')
      || msg.includes('hostname mismatch') || msg.includes('protocol')) return 'tls';

  // TCP / connect-level failures.
  if (msg.includes('econnrefused') || msg.includes('econnreset')
      || msg.includes('etimedout') || msg.includes('enetunreach')
      || msg.includes('ehostunreach') || msg.includes('epipe')
      || msg.includes('connection refused') || msg.includes('connection reset')
      || msg.includes('connection timed out') || msg.includes('connect timeout')
      || msg.includes('network is unreachable') || msg.includes('network timeout')) return 'tcp';

  // macOS / Linux specific: the URL is for an IPv6 host that has no
  // IPv4 route, or the local stack refused to connect.
  if (msg.includes('no route to host') || msg.includes('network down')) return 'tcp';

  // CORS / mixed content — the fetch itself succeeded, but we
  // couldn't read the response. We surface these as 'tcp' because
  // from the extension's perspective the request is unreachable.
  if (msg.includes('cors') || msg.includes('failed to fetch')
      || msg.includes('cross-origin') || msg.includes('opaque')
      || msg.includes('networkerror') || msg.includes('load failed')
      || msg.includes('failed to load')) return 'tcp';

  // Truly unrecognised. We attach the raw error code / name to the
  // evidence array so the UI can show a hint about what to look for
  // (system proxy, VPN, DNS pollution, etc.).
  return 'unknown';
}

/**
 * The decision table for "HEAD then maybe GET" from dev guide § 3.4
 * step 3. We surface the policy as a pure function so tests can
 * exercise it without any network I/O.
 */
export function shouldRetryAsGet(httpCode: number): boolean {
  // HEAD is only a cheap positive signal. A non-2xx answer often reflects a
  // method-specific rule in a CDN/WAF rather than what a user sees on GET, so
  // it must be confirmed by one bounded GET before we classify the bookmark.
  return httpCode < 200 || httpCode >= 300;
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
  if (head.redirectBlocked || (head.httpCode > 0 && !shouldRetryAsGet(head.httpCode))) {
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
