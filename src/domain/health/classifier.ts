// src/domain/health/classifier.ts
//
// HealthClassifier — turn a fetch outcome into a LinkStatus.
//
// Pure function. The dev guide § 3.4 lays out the state machine
// carefully:
//   - 200 ⇒ healthy
//   - 3xx (followed) ⇒ redirected
//   - 401/407 ⇒ auth_required (NOT dead)
//   - 403 ⇒ forbidden (NOT dead; some sites return 403 to all bots)
//   - 429 ⇒ rate_limited, surface Retry-After
//   - 404/410 first hit ⇒ suspected_dead; after retries / time window
//     ⇒ confirmed_dead
//   - 5xx and network errors ⇒ network_error (retryable)
//
// We do NOT make the "first hit → confirmed_dead" transition here.
// The classifier returns suspected_dead for a single 404/410. The
// scheduler supplies explicit prior 404/410 evidence for promotion;
// unrelated retries never count. The classifier is conservative.

import type { HealthInputs, HealthClassification, HealthCheckOutcome } from './types';

export function classify(inputs: HealthInputs): HealthClassification {
  const code = typeof inputs.httpCode === 'number' && inputs.httpCode > 0 ? inputs.httpCode : null;
  const priorDeadResponses = inputs.priorDeadResponses ?? 0;

  // 1. Network error path: no httpCode at all.
  if (code === null) {
    if (inputs.networkError && inputs.networkError !== 'unknown') {
      return { status: 'network_error', reason: `network error: ${inputs.networkError}` };
    }
    return { status: 'network_error', reason: 'no response received' };
  }

  // 2. 2xx
  if (code >= 200 && code < 300) {
    return { status: 'healthy', reason: `${code} OK` };
  }

  // 3. 3xx — we only call classify after the fetch client has
  //    followed redirects to the final destination, so a 3xx here
  //    means the final hop was a 3xx. Treat as redirected but mark
  //    as healthy(ish) — the bookmark is alive.
  if (code >= 300 && code < 400) {
    return { status: 'redirected', reason: `${code} ${redirectText(code)}` };
  }

  // 4. 401/407 — auth required, NOT dead
  if (code === 401 || code === 407) {
    return { status: 'auth_required', reason: `${code} ${statusText(code)}` };
  }

  // 5. 403 — forbidden
  if (code === 403) {
    return { status: 'forbidden', reason: `${code} forbidden` };
  }

  // 6. 429 — rate-limited, surface Retry-After
  if (code === 429) {
    return {
      status: 'rate_limited',
      reason: '429 too many requests',
      retryAfterSec: inputs.retryAfterSec ?? undefined,
    };
  }

  // 7. 404 / 410
  if (code === 404 || code === 410) {
    if (priorDeadResponses >= 1) {
      return { status: 'confirmed_dead', reason: `${code} ${statusText(code)} after retry` };
    }
    return { status: 'suspected_dead', reason: `${code} ${statusText(code)}` };
  }

  // 8. 5xx
  if (code >= 500 && code < 600) {
    return { status: 'network_error', reason: `${code} server error` };
  }

  // 9. Anything else is unexpected but retryable.
  return { status: 'network_error', reason: `unexpected status ${code}` };
}

function statusText(code: number): string {
  switch (code) {
    case 401: return 'unauthorized';
    case 403: return 'forbidden';
    case 404: return 'not found';
    case 407: return 'proxy auth required';
    case 410: return 'gone';
    case 429: return 'too many requests';
    case 500: return 'internal server error';
    case 502: return 'bad gateway';
    case 503: return 'service unavailable';
    case 504: return 'gateway timeout';
    default: return '';
  }
}

function redirectText(code: number): string {
  switch (code) {
    case 301: return 'moved permanently';
    case 302: return 'found';
    case 303: return 'see other';
    case 307: return 'temporary redirect';
    case 308: return 'permanent redirect';
    default: return 'redirect';
  }
}

/**
 * Re-export the exhaustive set of outcomes the classifier can
 * produce. UI can rely on this being a subset of LinkStatus.
 */
export const CLASSIFIER_OUTCOMES: readonly HealthCheckOutcome[] = [
  'healthy', 'redirected', 'auth_required', 'forbidden',
  'rate_limited', 'suspected_dead', 'confirmed_dead',
  'network_error', 'unsupported',
];
