import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBookmarkContent, CONTENT_TIMEOUT_MS, MAX_CONTENT_BYTES } from '../../src/domain/content';
import { extractHtmlContent, MAX_CONTENT_TEXT } from '../../src/domain/content/extract';

const page = (html = '<title>Useful article</title><main><h1>Example</h1><p>Some useful evidence.</p></main>') => new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const mockFetch = (...responses: Response[]) => vi.fn<typeof fetch>().mockImplementation(async () => responses.shift()!);
const url = 'https://example.com/article';
afterEach(() => vi.useRealTimers());

describe('inert HTML text extraction', () => {
  it('decodes text while excluding scripts, styles, forms, navigation and hidden text', () => {
    const extracted = extractHtmlContent('<head><title>Title &amp; more</title><script>fetch("evil")</script><style>secret</style></head><nav>menu</nav><main><h1>Heading</h1><p>Hello <b>world</b> &amp; friends.</p><form>personal</form><div hidden>hidden</div><p style="display: none">invisible</p></main><footer>boilerplate</footer>');
    expect(extracted).toEqual({ title: 'Title & more', text: 'Heading Hello world & friends.', loginRequired: false });
  });
  it('handles malformed markup and bounds text', () => {
    expect(extractHtmlContent('<main><p>First<p>Second').text).toBe('First Second');
    expect(extractHtmlContent(`<p>${'x'.repeat(20_000)}</p>`).text).toHaveLength(MAX_CONTENT_TEXT);
  });
  it('does not disclose password forms or auth-page text', () => {
    expect(extractHtmlContent('<p>Account secret</p><form><input type="password"></form>')).toMatchObject({ text: '', loginRequired: true });
    expect(extractHtmlContent('<title>Sign in - Example</title><p>Welcome</p>')).toMatchObject({ text: '', loginRequired: true });
  });
});

describe('optional content retrieval', () => {
  it('returns only bounded extracted evidence and uses anonymous/manual requests', async () => {
    const fetchImpl = mockFetch(page());
    const result = await fetchBookmarkContent({ url, fetchImpl });
    expect(result).toMatchObject({ originalUrl: url, status: 'ready', title: 'Useful article', text: 'Example Some useful evidence.' });
    expect(result.fetchedAt).toEqual(expect.any(Number));
    expect(fetchImpl).toHaveBeenCalledWith(url, expect.objectContaining({ credentials: 'omit', redirect: 'manual', referrerPolicy: 'no-referrer', cache: 'no-store' }));
    expect(result.reason).toContain('DNS destination not verified');
  });
  it.each(['file:///etc/passwd', 'http://localhost/test', 'http://127.0.0.1/', 'http://10.0.0.1/', 'https://user:pass@example.com/'])('blocks unsafe URL %s', async (blocked) => {
    const fetchImpl = mockFetch(page());
    expect(await fetchBookmarkContent({ url: blocked, fetchImpl })).toMatchObject({ status: 'unsupported', text: '' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('rechecks redirect safety before fetching target', async () => {
    const fetchImpl = mockFetch(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }));
    expect(await fetchBookmarkContent({ url, fetchImpl })).toMatchObject({ status: 'unsupported', text: '' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('checks host permission at every redirect', async () => {
    const fetchImpl = mockFetch(new Response(null, { status: 302, headers: { location: 'https://other.example.com/article' } }), page());
    const canFetch = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await fetchBookmarkContent({ url, fetchImpl, canFetch })).toMatchObject({ status: 'unavailable', reason: 'Host permission not granted' });
    expect(canFetch).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('follows relative redirects and preserves original URL', async () => {
    const fetchImpl = mockFetch(new Response(null, { status: 301, headers: { location: '/moved' } }), page());
    expect(await fetchBookmarkContent({ url, fetchImpl })).toMatchObject({ originalUrl: url, status: 'ready' });
    expect(fetchImpl.mock.calls[1][0]).toBe('https://example.com/moved');
  });
  it('caps redirect loops', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 302, headers: { location: url } }));
    expect(await fetchBookmarkContent({ url, fetchImpl })).toMatchObject({ status: 'unavailable', reason: 'Redirect limit reached' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
  it('excludes SSO redirects without fetching login endpoint', async () => {
    const fetchImpl = mockFetch(new Response(null, { status: 302, headers: { location: '/oauth/authorize' } }));
    expect(await fetchBookmarkContent({ url, fetchImpl })).toMatchObject({ status: 'login_required', text: '' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 407])('handles restricted status %s', async (status) => {
    expect(await fetchBookmarkContent({ url, fetchImpl: mockFetch(new Response(null, { status })) })).toMatchObject({ status: 'login_required', text: '' });
  });
  it('rejects PDF and unknown MIME responses', async () => {
    for (const contentType of ['application/pdf', 'application/json', '']) {
      expect(await fetchBookmarkContent({ url, fetchImpl: mockFetch(new Response('data', { headers: { 'Content-Type': contentType } })) })).toMatchObject({ status: 'unsupported', text: '' });
    }
  });
  it('rejects large declared or streamed bodies', async () => {
    const declared = new Response('', { headers: { 'Content-Type': 'text/html', 'Content-Length': String(MAX_CONTENT_BYTES + 1) } });
    const streamed = page('x'.repeat(MAX_CONTENT_BYTES + 1));
    for (const response of [declared, streamed]) {
      expect(await fetchBookmarkContent({ url, fetchImpl: mockFetch(response) })).toMatchObject({ status: 'unsupported', text: '', reason: 'Page exceeds 1 MiB response limit' });
    }
  });
  it('fails closed for opaque redirects', async () => {
    const response = new Response();
    Object.defineProperty(response, 'type', { value: 'opaqueredirect' });
    expect(await fetchBookmarkContent({ url, fetchImpl: mockFetch(response) })).toMatchObject({ status: 'unavailable', text: '' });
  });
  it('returns unavailable for empty pages and fetch failures', async () => {
    expect(await fetchBookmarkContent({ url, fetchImpl: mockFetch(page('<script>onlyJavascript()</script>')) })).toMatchObject({ status: 'unavailable', text: '' });
    expect(await fetchBookmarkContent({ url, fetchImpl: vi.fn().mockRejectedValue(new Error('network')) })).toMatchObject({ status: 'unavailable', text: '' });
  });
  it('enforces timeout even if fetch ignores AbortSignal', async () => {
    vi.useFakeTimers();
    const pending = fetchBookmarkContent({ url, fetchImpl: vi.fn().mockImplementation(() => new Promise(() => {})) });
    await vi.advanceTimersByTimeAsync(CONTENT_TIMEOUT_MS);
    expect(await pending).toMatchObject({ status: 'unavailable', reason: 'Request timed out' });
  });
  it('times out stalled streamed responses and cancels their reader', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { 'Content-Type': 'text/html' } });
    const pending = fetchBookmarkContent({ url, fetchImpl: mockFetch(response) });
    await vi.advanceTimersByTimeAsync(CONTENT_TIMEOUT_MS);
    expect(await pending).toMatchObject({ status: 'unavailable', reason: 'Request timed out', text: '' });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('does not fetch when permission checking is denied or stalls', async () => {
    const fetchImpl = mockFetch(page());
    expect(await fetchBookmarkContent({ url, fetchImpl, canFetch: async () => false })).toMatchObject({ status: 'unavailable', reason: 'Host permission not granted' });
    vi.useFakeTimers();
    const pending = fetchBookmarkContent({ url, fetchImpl, canFetch: () => new Promise(() => {}) });
    await vi.advanceTimersByTimeAsync(CONTENT_TIMEOUT_MS);
    expect(await pending).toMatchObject({ status: 'unavailable', reason: 'Request timed out' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('returns no page evidence when HTML is a password login', async () => {
    expect(await fetchBookmarkContent({ url, fetchImpl: mockFetch(page('<title>Account</title><p>Private account</p><input type="password">')) })).toMatchObject({ status: 'login_required', text: '' });
  });
  it('fails closed if a fetch implementation unexpectedly follows redirects', async () => {
    const response = page();
    Object.defineProperty(response, 'redirected', { value: true });
    expect(await fetchBookmarkContent({ url, fetchImpl: mockFetch(response) })).toMatchObject({ status: 'unavailable', text: '' });
  });
  it('cancels in-flight and pre-aborted requests', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockImplementation(() => new Promise(() => {}));
    const pending = fetchBookmarkContent({ url, fetchImpl, signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ status: 'unavailable', reason: 'Request cancelled' });
    fetchImpl.mockClear();
    expect(await fetchBookmarkContent({ url, fetchImpl, signal: controller.signal })).toMatchObject({ status: 'unavailable', reason: 'Request cancelled' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
