import { guardUrl } from '../health/url-guard';
import { extractHtmlContent } from './extract';

export type BookmarkContentStatus = 'ready' | 'login_required' | 'unavailable' | 'unsupported';
export interface BookmarkContentResult {
  originalUrl: string;
  title?: string;
  text: string;
  fetchedAt: number;
  status: BookmarkContentStatus;
  reason: string;
}
export interface FetchBookmarkContentOptions {
  url: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Optional host-permission gate, evaluated before every network hop. */
  canFetch?: (url: string) => Promise<boolean>;
}
export const CONTENT_TIMEOUT_MS = 12_000;
export const MAX_CONTENT_BYTES = 1_048_576;
const MAX_REDIRECTS = 3;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function isAuthUrl(url: URL): boolean {
  return /(?:^|[./_-])(?:login|signin|sign-in|sso|oauth|authorize|authentication|saml)(?:[./_-]|$)/i.test(url.hostname + url.pathname)
    || /^(?:accounts|auth|identity)\./i.test(url.hostname);
}

/** Optional unauthenticated retrieval. The caller owns opt-in and host permission.
 * Static private-host checks do not verify DNS resolution or prevent rebinding.
 * Does not persist raw HTML, send provider requests, or follow browser login flows.
 */
export async function fetchBookmarkContent({ url, signal, fetchImpl = fetch, canFetch }: FetchBookmarkContentOptions): Promise<BookmarkContentResult> {
  const result = (status: BookmarkContentStatus, reason: string, extras: Partial<BookmarkContentResult> = {}): BookmarkContentResult => ({
    originalUrl: url, text: '', fetchedAt: Date.now(), status, reason, ...extras,
  });
  if (signal?.aborted) return result('unavailable', 'Request cancelled');
  const controller = new AbortController();
  let timedOut = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let rejectAbort: ((error: Error) => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => { controller.abort(); rejectAbort?.(new Error('aborted')); };
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; abort(); }, CONTENT_TIMEOUT_MS);
  const bounded = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, interrupted]);
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const verdict = guardUrl(current);
      if (!verdict.ok) return result('unsupported', `URL blocked: ${verdict.reason}`);
      if (isAuthUrl(verdict.parsed)) return result('login_required', 'Authentication URL excluded');
      if (canFetch && !await bounded(canFetch(verdict.parsed.href))) return result('unavailable', 'Host permission not granted');
      const response = await bounded(fetchImpl(verdict.parsed.href, {
        method: 'GET', credentials: 'omit', redirect: 'manual', referrerPolicy: 'no-referrer',
        cache: 'no-store', signal: controller.signal, headers: { Accept: 'text/html' },
      }));
      if (response.type === 'opaqueredirect' || response.type === 'opaque') {
        void response.body?.cancel().catch(() => {});
        return result('unavailable', 'Browser hid response or redirect; destination cannot be safely checked');
      }
      if (response.redirected) {
        void response.body?.cancel().catch(() => {});
        return result('unavailable', 'Unexpected automatically followed redirect');
      }
      if (REDIRECTS.has(response.status)) {
        void response.body?.cancel().catch(() => {});
        if (hop === MAX_REDIRECTS) return result('unavailable', 'Redirect limit reached');
        const location = response.headers.get('location');
        if (!location) return result('unavailable', 'Redirect destination unavailable');
        try { current = new URL(location, verdict.parsed).href; }
        catch { return result('unsupported', 'Invalid redirect destination'); }
        continue;
      }
      if ([401, 403, 407].includes(response.status)) {
        void response.body?.cancel().catch(() => {});
        return result('login_required', `Access restricted (HTTP ${response.status})`);
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return result('unavailable', `HTTP ${response.status}`);
      }
      const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (contentType !== 'text/html') {
        void response.body?.cancel().catch(() => {});
        return result('unsupported', 'Only HTML content is supported');
      }
      const length = Number(response.headers.get('content-length'));
      if (length > MAX_CONTENT_BYTES) {
        void response.body?.cancel().catch(() => {});
        return result('unsupported', 'Page exceeds 1 MiB response limit');
      }
      if (!response.body) return result('unavailable', 'Response has no readable body');
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parts: string[] = [];
      let bytes = 0;
      while (true) {
        const chunk = await bounded(reader.read());
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_CONTENT_BYTES) return result('unsupported', 'Page exceeds 1 MiB response limit');
        parts.push(decoder.decode(chunk.value, { stream: true }));
      }
      parts.push(decoder.decode());
      const extracted = extractHtmlContent(parts.join(''));
      if (extracted.loginRequired) return result('login_required', 'Authentication page excluded');
      if (!extracted.text) return result('unavailable', 'No readable static page text');
      return result('ready', 'Static page text retrieved; DNS destination not verified', { title: extracted.title, text: extracted.text });
    }
    return result('unavailable', 'Redirect limit reached');
  } catch {
    return result('unavailable', timedOut ? 'Request timed out' : signal?.aborted ? 'Request cancelled' : 'Content request failed');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    // Cancellation is deliberately not awaited: a misbehaving stream must not defeat timeout.
    void reader?.cancel().catch(() => {});
    controller.abort();
  }
}
