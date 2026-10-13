// src/domain/health/types.ts
//
// Link health domain types. Mirrors dev guide § 3.4.
//
// Design constraints:
//   - 12 distinct LinkStatus values, each a string literal — not a
//     number — so they round-trip cleanly through IndexedDB.
//   - `evidence` is a list of short strings for the UI ("HEAD 405",
//     "Retry-After: 120", "5 redirects"); we never store page bodies
//     or query-string secrets (dev guide § 10).
//   - `httpCode` is the final response code; `finalUrl` records the
//     last hop of a redirect chain.

export type LinkStatus =
  | 'unchecked'         // never scanned
  | 'checking'          // in flight
  | 'healthy'           // 2xx
  | 'redirected'        // 3xx (followed; the bookmark is alive)
  | 'auth_required'     // 401 / 407
  | 'forbidden'         // 403
  | 'rate_limited'       // 429
  | 'suspected_dead'    // first hit 404/410; not yet retried
  | 'confirmed_dead'    // 404/410 across the retry window
  | 'network_error'     // DNS / TCP / TLS / abort / unknown
  | 'unsupported'       // non-http(s) / unresolvable host
  | 'permission_required'; // extension lacks host permission

export type HealthCheckOutcome =
  | Exclude<LinkStatus, 'unchecked' | 'checking' | 'permission_required'>;

export interface LinkCheckRecord {
  id: string;
  bookmarkId: string;
  status: LinkStatus;
  httpCode?: number;
  finalUrl?: string;
  errorCode?: string;
  checkedAt: number;
  retryAt?: number;
  evidence: string[];
  /**
   * The syncGeneration this check was based on. The UI uses this to
   * invalidate stale health badges if the URL was edited in between.
   */
  syncGeneration?: number;
}

/**
 * The classification inputs the classifier needs. We accept just
 * the data it cares about (not a full fetch Response) so unit tests
 * can pass plain objects.
 */
export interface HealthInputs {
  httpCode?: number;
  finalUrl?: string;
  /**
   * If the request errored at the network layer (DNS / TCP / TLS /
   * abort), this is the stage at which it failed.
   */
  networkError?: 'dns' | 'tcp' | 'tls' | 'abort' | 'unknown' | null;
  /**
   * Number of redirects followed before the final response. 0 means
   * no redirect.
   */
  redirectCount?: number;
  /**
   * The number of retries already attempted for this check.
   */
  attempts?: number;
  /**
   * If the server returned a Retry-After header (in seconds), the
   * classifier may surface it for the scheduler.
   */
  retryAfterSec?: number | null;
}

export interface HealthClassification {
  status: HealthCheckOutcome;
  reason: string;
  retryAfterSec?: number;
}

/**
 * Configuration for the health pipeline. Default values are
 * conservative; the user can override per-deployment in Phase 5+.
 */
export interface HealthConfig {
  timeoutMs: number;             // default 10_000
  maxRetries: number;            // default 2
  maxRedirects: number;          // default 5
  maxResponseBytes: number;      // default 1 MB
  userAgent: string;
  retryDelayBaseMs: number;      // default 1_000
  globalConcurrency: number;     // default 5
  perHostConcurrency: number;    // default 1
  normalRecheckDays: number;     // default 30
  fastRecheckDays: number;       // default 2
}

export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  timeoutMs: 10_000,
  maxRetries: 2,
  maxRedirects: 5,
  maxResponseBytes: 1024 * 1024,
  userAgent: 'ai-bookmark-manager/0.1 (link-health; +https://example.invalid)',
  retryDelayBaseMs: 1_000,
  globalConcurrency: 5,
  perHostConcurrency: 1,
  normalRecheckDays: 30,
  fastRecheckDays: 2,
};
