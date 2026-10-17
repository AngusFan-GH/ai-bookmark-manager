// src/domain/health/types.ts
//
// Link health domain types. Mirrors dev guide § 3.4.
//
// Design constraints:
//   - Distinct LinkStatus values, each a string literal — not a
//     number — so they round-trip cleanly through IndexedDB.
//   - `evidence` is a list of short strings for the UI ("HEAD 405",
//     "检查方式：GET", "Retry-After: 120"); we never store page bodies
//     or query-string secrets (dev guide § 10).
//   - `httpCode` is the final response code; `finalUrl` records the
//     original bookmark URL and (when available) the final response URL.

export type LinkStatus =
  | 'unchecked'         // never scanned
  | 'checking'          // in flight
  | 'outdated'          // bookmark URL changed after this result
  | 'healthy'           // 2xx
  | 'redirected'        // 3xx followed; the bookmark is alive
  | 'redirect_pending'  // 3xx seen but target was intentionally not followed
  | 'auth_required'     // 401 / 407
  | 'forbidden'         // 403
  | 'rate_limited'       // 429
  | 'suspected_dead'    // first hit 404/410; not yet retried
  | 'confirmed_dead'    // legacy only; migrated to review wording on read
  | 'repeated_not_found' // repeated GET 404/410 observations, not proof of permanent death
  | 'suspected_soft_404' // 2xx with a bounded error-page heuristic
  | 'suspected_login'    // 2xx with a bounded login-page heuristic
  | 'network_error'     // DNS / TCP / TLS / abort / unknown
  | 'unsupported'       // non-http(s) / unresolvable host
  | 'permission_required'; // extension lacks host permission

export type HealthCheckOutcome =
  | Exclude<LinkStatus, 'unchecked' | 'checking' | 'outdated' | 'permission_required'>;

export interface HealthObservation {
  checkedAt: number;
  method?: 'HEAD' | 'GET';
  httpCode?: number;
  status: LinkStatus;
  evidence: string[];
}

export interface LinkCheckRecord {
  /** Bounded, body-free evidence for each probe in this scan. */
  observations?: HealthObservation[];
  id: string;
  bookmarkId: string;
  status: LinkStatus;
  httpCode?: number;
  finalUrl?: string;
  /**
   * Phase 3.6: the **original** URL the user asked us to scan, as
   * captured from `chrome.bookmarks`. We previously only stored
   * `finalUrl` (post-redirect), which is wrong for the "unsupported"
   * case — those never reach the fetch client, so they never had a
   * finalUrl. The UI now shows the user the exact address they
   * bookmarked so they can:
   *   - see the literal 192.168.x.x that was rejected
   *   - click it to open the address in a new tab for manual
   *     verification (the only legal way to reach a private host
   *     when the toggle is off)
   */
  url?: string;
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
  contentSignal?: 'soft_404' | 'login';
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
   * The number of retries already attempted for this check. Diagnostic
   * only: retries are not evidence that a bookmark is dead.
   */
  attempts?: number;
  /** Previous independent probes that returned 404/410, excluding network failures. */
  priorDeadResponses?: number;
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
  /**
   * If true, the URL guard will NOT block RFC 1918 / loopback / local
   * hosts. **Off by default** because dev guide § 0.1 forbids SSRF
   * probing of internal infrastructure. The user can opt in if they
   * really want to monitor their home NAS, dev server, etc.
   */
  allowPrivateHosts: boolean;     // default false
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
  // dev guide § 0.1 red line: do not probe internal / private hosts
  // without explicit user opt-in. The Settings page exposes a toggle
  // that flips this to true; see HealthView's "settings" card.
  allowPrivateHosts: false,
};
