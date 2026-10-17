import { describe, expect, it, vi } from 'vitest';
import { LIVE_COMMIT_MESSAGE, liveGate, runLiveAcceptance, safeFailure } from './minimax-acceptance';
import { AssistantError } from '../../src/domain/assistant/types';

const approved = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'AngusFan-GH/ai-bookmark-manager', GITHUB_REF: 'refs/heads/chloe/bookmark-workspace', GITHUB_RUN_ATTEMPT: '1', GITHUB_EVENT_NAME: 'push', LIVE_COMMIT_MESSAGE };
const suggestion = (extra = {}) => ({ text: 'Synthetic MAPLE42 response', references: [], moves: [], folders: [], edits: [], deletions: [], ...extra });
const reference = { bookmarkId: 'synthetic-typescript', reason: 'Matches beginner programming.' };
function response(content: unknown, usage: unknown = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }) {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: 'stop' }], usage }), { status: 200 });
}
function streamedResponse(content: unknown, options: { finish?: string; done?: boolean; singleChunk?: boolean } = {}) {
  const json = JSON.stringify(content);
  const frame = (delta: object, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  const chunks = [frame({ role: 'assistant', reasoning_content: 'PRIVATE_REASONING_SENTINEL' })];
  if (options.singleChunk) chunks.push(frame({ content: json }));
  else for (let i = 0; i < json.length; i += 7) chunks.push(frame({ content: json.slice(i, i + 7) }));
  chunks.push(frame({}, options.finish ?? 'stop'));
  if (options.done !== false) chunks.push('data: [DONE]\n\n');
  return new Response(new ReadableStream({ async pull(controller) {
    await Promise.resolve();
    const chunk = chunks.shift();
    if (chunk === undefined) controller.close();
    else controller.enqueue(new TextEncoder().encode(chunk));
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
function successfulFetch() {
  return vi.fn<typeof fetch>()
    .mockResolvedValueOnce(response('OK'))
    .mockResolvedValueOnce(streamedResponse(suggestion({ references: [reference] })))
    .mockResolvedValueOnce(streamedResponse(suggestion({ references: [reference] })))
    .mockResolvedValueOnce(streamedResponse(suggestion({ moves: [{ bookmarkId: 'synthetic-cooking', targetFolderId: 'synthetic-recipes', reason: 'Recipe topic.' }] })))
    .mockResolvedValueOnce(response({ title: 'Vegetarian recipes', targetFolderId: 'synthetic-recipes', reason: 'Recipe topic.' }));
}
describe('live acceptance gates and reporting (offline)', () => {
  it('allows only the exact one-shot push or explicit branch dispatch', () => {
    expect(liveGate(approved)).toBe(true);
    expect(liveGate({ ...approved, GITHUB_EVENT_NAME: 'workflow_dispatch', LIVE_REQUESTED: 'true' })).toBe(true);
    for (const change of [
      { GITHUB_ACTIONS: 'false' }, { GITHUB_REPOSITORY: 'someone/fork' }, { GITHUB_REF: 'refs/heads/main' },
      { GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_EVENT_NAME: 'pull_request' }, { LIVE_COMMIT_MESSAGE: 'ordinary push' }, { LIVE_COMMIT_MESSAGE: 'test: run bounded MiniMax acceptance [live-20261017-v1]' },
      { LIVE_COMMIT_MESSAGE: `${LIVE_COMMIT_MESSAGE}\nextra` }, { GITHUB_EVENT_NAME: 'workflow_dispatch', LIVE_REQUESTED: 'false' },
    ]) expect(liveGate({ ...approved, ...change })).toBe(false);
    expect(liveGate({})).toBe(false);
  });
  it('runs actual provider/service parsers in five bounded calls and carries history', async () => {
    const fetcher = successfulFetch();
    const report = await runLiveAcceptance('synthetic-key-not-a-credential', fetcher);
    expect(report.passed).toBe(true);
    expect(report.checks).toHaveLength(5);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(report.calls.every(call => call.httpStatus === 200 && call.stopValidated)).toBe(true);
    expect(report.calls.filter(call => !call.streamRequested).every(call => call.totalTokens === 30)).toBe(true);
    expect(report.calls.filter(call => call.streamRequested)).toHaveLength(3);
    for (const call of report.calls.filter(call => call.streamRequested)) {
      expect(call).toMatchObject({ sseContentType: true, incrementalPreview: true });
      expect(call.previewCallbacks).toBeGreaterThan(1);
      expect(call.firstPreviewMs).toBeTypeOf('number');
      expect(call.totalTokens).toBeUndefined();
    }
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).toBe('https://api.minimax.cn/v1/chat/completions');
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeDefined();
      expect(JSON.parse(String(init?.body))).toMatchObject({ max_completion_tokens: 4096, model: 'MiniMax-M2.5' });
    }
    expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).stream)).toEqual([false, true, true, true, false]);
    expect(JSON.stringify(report)).not.toContain('PRIVATE_REASONING_SENTINEL');
    const followup = JSON.parse(String(fetcher.mock.calls[2][1]?.body));
    expect(followup.messages.map((message: { role: string }) => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(followup.messages[1].content).toContain('MAPLE42');
    expect(JSON.stringify(report)).not.toContain('synthetic-key-not-a-credential');
    expect(JSON.stringify(report)).not.toContain('MAPLE42');
  });
  it('stops on authentication failure, with no retry or raw response disclosure', async () => {
    const secret = 'fake-secret-must-never-be-reported';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(secret, { status: 401 }));
    const report = await runLiveAcceptance(secret, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(report.checks).toEqual([{ phase: 'connection', passed: false, failure: 'provider' }]);
    expect(report.calls[0].httpStatus).toBe(401);
    expect(JSON.stringify(report)).not.toContain(secret);
  });
  it('rejects invented bookmark IDs through the actual domain parser', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response('OK')).mockResolvedValueOnce(streamedResponse(suggestion({ references: [{ ...reference, bookmarkId: 'invented-id' }] })));
    const report = await runLiveAcceptance('synthetic-key', fetcher);
    expect(report.passed).toBe(false);
    expect(report.checks.at(-1)).toMatchObject({ phase: 'recommendation', passed: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects invented organization targets after otherwise valid streamed turns', async () => {
    const fetcher = successfulFetch();
    fetcher.mockReset()
      .mockResolvedValueOnce(response('OK'))
      .mockResolvedValueOnce(streamedResponse(suggestion({ references: [reference] })))
      .mockResolvedValueOnce(streamedResponse(suggestion({ references: [reference] })))
      .mockResolvedValueOnce(streamedResponse(suggestion({ moves: [{ bookmarkId: 'synthetic-cooking', targetFolderId: 'invented-folder', reason: 'Invalid target.' }] })));
    const report = await runLiveAcceptance('synthetic-key', fetcher);
    expect(report.passed).toBe(false);
    expect(report.checks.at(-1)).toMatchObject({ phase: 'organization', passed: false });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('does not clone or buffer the SSE body before forwarding callbacks', async () => {
    const streamed = streamedResponse(suggestion({ references: [reference] }));
    const clone = vi.spyOn(streamed, 'clone');
    const fetcher = successfulFetch();
    fetcher.mockReset().mockResolvedValueOnce(response('OK')).mockResolvedValueOnce(streamed).mockRejectedValue(new Error('stop after observed stream'));
    const report = await runLiveAcceptance('synthetic-key', fetcher);
    expect(clone).not.toHaveBeenCalled();
    expect(report.checks[1]).toEqual({ phase: 'recommendation', passed: true });
    expect(report.calls[1].incrementalPreview).toBe(true);
  });
  it.each([{ finish: 'length' }, { done: false }, { singleChunk: true }])('fails closed on truncated or nonincremental SSE: %j', async options => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response('OK')).mockResolvedValueOnce(streamedResponse(suggestion({ references: [reference] }), options));
    const report = await runLiveAcceptance('synthetic-key', fetcher);
    expect(report.passed).toBe(false);
    expect(report.checks.at(-1)).toMatchObject({ phase: 'recommendation', passed: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(report)).not.toContain('PRIVATE_REASONING_SENTINEL');
  });
  it('rejects JSON fallback instead of falsely claiming genuine streaming', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response('OK')).mockResolvedValueOnce(response(suggestion({ references: [reference] })));
    const report = await runLiveAcceptance('synthetic-key', fetcher);
    expect(report.passed).toBe(false);
    expect(report.calls[1].sseContentType).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('drops arbitrary error text and nonnumeric token usage', async () => {
    expect(safeFailure(new Error('fake-secret'))).toBe('unexpected');
    expect(safeFailure(new AssistantError('provider', 'fake-secret'))).toBe('provider');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response('OK', { prompt_tokens: 'fake-secret', completion_tokens: -1, total_tokens: Infinity })).mockRejectedValue(new Error('fake-secret'));
    const report = await runLiveAcceptance('synthetic-key', fetcher);
    expect(report.calls[0].promptTokens).toBeUndefined();
    expect(report.calls[0].completionTokens).toBeUndefined();
    expect(report.calls[0].totalTokens).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain('fake-secret');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
