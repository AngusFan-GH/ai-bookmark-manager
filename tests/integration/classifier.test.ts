// tests/integration/classifier.test.ts
//
// HealthClassifier: HTTP code / network error → LinkStatus.

import { describe, expect, it } from 'vitest';
import { classify } from '../../src/domain/health/classifier';
import { shouldRetryAsGet } from '../../src/domain/health/fetch-client';

describe('classify — 2xx', () => {
  it('returns healthy for 200', () => {
    expect(classify({ httpCode: 200 })).toEqual({ status: 'healthy', reason: '200 OK' });
  });
  it('returns healthy for 204', () => {
    expect(classify({ httpCode: 204 }).status).toBe('healthy');
  });
});

describe('classify — 3xx', () => {
  it('returns redirected for 301/302/307', () => {
    expect(classify({ httpCode: 301 }).status).toBe('redirected');
    expect(classify({ httpCode: 302 }).status).toBe('redirected');
    expect(classify({ httpCode: 307 }).status).toBe('redirected');
  });
});

describe('classify — 4xx', () => {
  it('auth_required for 401', () => {
    expect(classify({ httpCode: 401 }).status).toBe('auth_required');
  });
  it('auth_required for 407 (proxy auth)', () => {
    expect(classify({ httpCode: 407 }).status).toBe('auth_required');
  });
  it('forbidden for 403', () => {
    expect(classify({ httpCode: 403 }).status).toBe('forbidden');
  });
  it('rate_limited for 429 with retryAfterSec', () => {
    const r = classify({ httpCode: 429, retryAfterSec: 60 });
    expect(r.status).toBe('rate_limited');
    expect(r.retryAfterSec).toBe(60);
  });
  it('suspected_dead for first 404', () => {
    expect(classify({ httpCode: 404, attempts: 0 }).status).toBe('suspected_dead');
  });
  it('confirmed_dead for 404 after retry', () => {
    expect(classify({ httpCode: 404, priorDeadResponses: 1 }).status).toBe('confirmed_dead');
  });
  it('suspected_dead for first 410', () => {
    expect(classify({ httpCode: 410, attempts: 0 }).status).toBe('suspected_dead');
  });
  it('confirmed_dead for 410 after retry', () => {
    expect(classify({ httpCode: 410, priorDeadResponses: 2 }).status).toBe('confirmed_dead');
  });
});

describe('classify — 5xx', () => {
  for (const code of [500, 502, 503, 504]) {
    it(`returns network_error for ${code}`, () => {
      expect(classify({ httpCode: code }).status).toBe('network_error');
    });
  }
});

describe('classify — network errors', () => {
  it('returns network_error for DNS failure', () => {
    expect(classify({ networkError: 'dns' }).status).toBe('network_error');
  });
  it('returns network_error for TCP failure', () => {
    expect(classify({ networkError: 'tcp' }).status).toBe('network_error');
  });
  it('returns network_error for TLS failure', () => {
    expect(classify({ networkError: 'tls' }).status).toBe('network_error');
  });
  it('returns network_error for abort', () => {
    expect(classify({ networkError: 'abort' }).status).toBe('network_error');
  });
  it('returns network_error for unknown with no httpCode', () => {
    expect(classify({ networkError: 'unknown' }).status).toBe('network_error');
  });
});

describe('classify — fallback', () => {
  it('returns network_error for an unexpected code', () => {
    expect(classify({ httpCode: 418 }).status).toBe('network_error');
  });
});

describe('shouldRetryAsGet', () => {
  it('requires GET confirmation for every non-2xx HEAD response', () => {
    expect(shouldRetryAsGet(405)).toBe(true);
    expect(shouldRetryAsGet(501)).toBe(true);
    expect(shouldRetryAsGet(200)).toBe(false);
    expect(shouldRetryAsGet(403)).toBe(true);
    expect(shouldRetryAsGet(404)).toBe(true);
    expect(shouldRetryAsGet(500)).toBe(true);
  });
});
