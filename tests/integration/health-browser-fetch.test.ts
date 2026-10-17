// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createHealthBrowserFetch, HEALTH_TEXT_LIMIT, parseHealthRetryAfter } from '../../src/infrastructure/browser/health-fetch';
import type { FetchLikeRequest } from '../../src/domain/health/fetch-client';

const request: FetchLikeRequest = {
  method: 'GET', url: 'https://health.example.test/page', timeoutMs: 1000,
  maxRedirects: 5, maxResponseBytes: 1024 * 1024, userAgent: 'test',
};
const transport = (response: Response) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
  return { fetcher, run: createHealthBrowserFetch(fetcher) };
};

describe('bounded browser health transport', () => {
  it('keeps credentials off, redirects manual and sends browser-like Accept', async () => {
    const { run, fetcher } = transport(new Response('<h1>hello</h1>', { headers: { 'content-type': 'text/html; charset=utf-8' } }));
    const result = await run(request);
    expect(result.body).toBe('<h1>hello</h1>');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'manual', cache: 'no-store' });
    expect((fetcher.mock.calls[0][1]?.headers as Record<string, string>).Accept).toContain('text/html');
  });
  it('retains bounded prefix even when the first chunk exceeds the budget', async () => {
    const { run } = transport(new Response('x'.repeat(HEALTH_TEXT_LIMIT * 2), { headers: { 'content-type': 'text/html' } }));
    expect((await run(request)).body).toHaveLength(HEALTH_TEXT_LIMIT);
  });
  it('honors a smaller caller byte budget', async () => {
    const { run } = transport(new Response('abcdef', { headers: { 'content-type': 'text/plain' } }));
    expect((await run({ ...request, maxResponseBytes: 3 })).body).toBe('abc');
  });
  it('does not interpret binary or unknown MIME as page content', async () => {
    for (const type of ['application/pdf', 'image/png', 'application/octet-stream']) {
      const { run } = transport(new Response('404 not found', { headers: { 'content-type': type } }));
      expect((await run(request)).body).toBeUndefined();
    }
  });
  it('does not read a HEAD body', async () => {
    const { run } = transport(new Response('not found', { headers: { 'content-type': 'text/html' } }));
    expect((await run({ ...request, method: 'HEAD' })).body).toBeUndefined();
  });
  it('keeps opaque redirect unverified and exposes no target', async () => {
    const response = new Response(null);
    Object.defineProperty(response, 'type', { value: 'opaqueredirect' });
    const { run } = transport(response);
    expect(await run(request)).toEqual({ status: 0, url: request.url, retryAfterSec: null, redirectBlocked: true });
  });
  it('decodes UTF-8 split between chunks', async () => {
    const bytes = new TextEncoder().encode('你好');
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.subarray(0, 2)); c.enqueue(bytes.subarray(2)); c.close(); } });
    const { run } = transport(new Response(body, { headers: { 'content-type': 'text/html' } }));
    expect((await run(request)).body).toBe('你好');
  });
  it('cancels the stream once enough evidence is read', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('abcdef')); }, cancel });
    const { run } = transport(new Response(body, { headers: { 'content-type': 'text/html' } }));
    expect((await run({ ...request, maxResponseBytes: 3 })).body).toBe('abc');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('does not fetch an already cancelled request', async () => {
    const controller = new AbortController(); controller.abort();
    const { run, fetcher } = transport(new Response(null));
    await expect(run({ ...request, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('parses numeric/date Retry-After and rejects invalid values', () => {
    expect(parseHealthRetryAfter('120')).toBe(120);
    expect(parseHealthRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('2015-10-21T07:27:00Z'))).toBe(60);
    expect(parseHealthRetryAfter('bad')).toBeNull();
    expect(parseHealthRetryAfter('')).toBeNull();
  });
});
