import type { FetchLikeFn } from '../../domain/health/fetch-client';

export const HEALTH_TEXT_LIMIT = 64 * 1024;

export function parseHealthRetryAfter(header: string | null, now = Date.now()): number | null {
  if (!header?.trim()) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

/** Browser transport only. Guard and host permission checks belong to HealthService.
 * Page text is transient classification evidence, never persisted by this adapter.
 */
export function createHealthBrowserFetch(fetchImpl: typeof fetch = fetch): FetchLikeFn {
  return async (req) => {
    if (req.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);
    const onAbort = () => controller.abort();
    req.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetchImpl(req.url, {
        method: req.method, credentials: 'omit', cache: 'no-store',
        redirect: 'manual', signal: controller.signal,
        headers: { Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
      });
      if (response.type === 'opaqueredirect') {
        return { status: 0, url: req.url, retryAfterSec: null, redirectBlocked: true };
      }
      const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      const textual = ['text/html', 'application/xhtml+xml', 'text/plain'].includes(contentType);
      let body: string | undefined;
      if (req.method === 'GET' && response.body) {
        if (!textual) {
          await response.body.cancel().catch(() => undefined);
        } else {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          const limit = Math.max(0, Math.min(HEALTH_TEXT_LIMIT, req.maxResponseBytes));
          let received = 0;
          body = '';
          try {
            while (received < limit) {
              if (controller.signal.aborted) throw new DOMException('Request aborted', 'AbortError');
              const { value, done } = await reader.read();
              if (done) break;
              if (!value) continue;
              const prefix = value.subarray(0, limit - received);
              received += prefix.byteLength;
              body += decoder.decode(prefix, { stream: true });
            }
            body += decoder.decode();
          } finally {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
          }
        }
      }
      if (controller.signal.aborted) throw new DOMException('Request aborted', 'AbortError');
      return {
        status: response.status, url: response.url || req.url,
        retryAfterSec: parseHealthRetryAfter(response.headers.get('retry-after')),
        contentType, ...(body === undefined ? {} : { body }),
      };
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }
  };
}
