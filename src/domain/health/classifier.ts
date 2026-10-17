// src/domain/health/classifier.ts
//
// HealthClassifier — turn a fetch outcome into a LinkStatus.
//
// Pure evidence classification: repeated 404/410 observations request review,
// never establish permanent death. Redirects that were not followed stay unknown.
// Authentication, rate limits, server and network failures are not deletion evidence.

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
    if (inputs.contentSignal === 'soft_404') return { status: 'suspected_soft_404', reason: '2xx response with error-page heading; manual review required' };
    if (inputs.contentSignal === 'login') return { status: 'suspected_login', reason: '2xx response with login-page signals; manual review required' };
    return { status: 'healthy', reason: `${code} OK` };
  }

  // A final 3xx is an unresolved destination, not a successful page check.
  if (code >= 300 && code < 400) {
    return { status: 'redirect_pending', reason: `${code} ${redirectText(code)}` };
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
      return { status: 'repeated_not_found', reason: `${code} observed on repeated GET probes; not proof of permanent removal` };
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
  'rate_limited', 'suspected_dead', 'repeated_not_found', 'suspected_soft_404', 'suspected_login', 'redirect_pending',
  'network_error', 'unsupported',
];
