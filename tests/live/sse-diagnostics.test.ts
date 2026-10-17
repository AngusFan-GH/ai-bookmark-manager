import { describe, expect, it } from 'vitest';
import { newSseDiagnostics, tapSseDiagnostics } from './sse-diagnostics';

function source(chunks: Uint8Array[]) {
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    const chunk = chunks.shift();
    if (chunk) controller.enqueue(chunk); else controller.close();
  } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
}
describe('safe SSE diagnostic transport tap', () => {
  it('preserves each original byte chunk and reports only bounded frame shapes', async () => {
    const raw = 'data: {"choices":[{"index":0,"delta":{"content":"秘密 FAKE_SECRET","reasoning_content":"PRIVATE_REASON"},"finish_reason":null}],"arbitrary_secret":"NEVER_SAVE"}\r\n\r\n'
      + 'data: {"choices":[{"index":0,"message":{"content":"FAKE_SECRET"},"finish_reason":"stop"}],"usage":{}}\n\n'
      + 'data: [DONE]\n\n';
    const bytes = new TextEncoder().encode(raw);
    const chunks = Array.from({ length: Math.ceil(bytes.length / 7) }, (_, index) => bytes.slice(index * 7, index * 7 + 7));
    const metrics = newSseDiagnostics();
    const reader = tapSseDiagnostics(source([...chunks]), metrics).body!.getReader();
    for (const chunk of chunks) expect((await reader.read()).value).toEqual(chunk);
    expect((await reader.read()).done).toBe(true);
    expect(metrics).toMatchObject({ frames: 3, doneMarkers: 1, stopFrames: 1, eof: true, canceled: false });
    expect(metrics.lastFrames[1]).toMatchObject({ choices: 'one', index: 'zero', delta: 'missing', message: true, finish: 'stop', usage: true });
    for (const privateValue of ['秘密', 'FAKE_SECRET', 'PRIVATE_REASON', 'NEVER_SAVE', 'arbitrary_secret', 'reasoning_content']) expect(JSON.stringify(metrics)).not.toContain(privateValue);
  });
  it('reports cancellation without consuming unread terminal events', async () => {
    const encoder = new TextEncoder();
    const metrics = newSseDiagnostics();
    const reader = tapSseDiagnostics(source([encoder.encode('data: {"choices":[]}\n\n'), encoder.encode('data: [DONE]\n\n')]), metrics).body!.getReader();
    await reader.read(); await reader.cancel();
    expect(metrics).toMatchObject({ frames: 1, doneMarkers: 0, canceled: true, eof: false });
  });
  it('keeps only eight fixed-enum shapes and maps unknown values to other', async () => {
    const raw = Array.from({ length: 20 }, () => 'data: {"choices":[{"index":"SECRET","delta":"SECRET","finish_reason":"SECRET"}]}\n\n').join('');
    const metrics = newSseDiagnostics();
    expect(await tapSseDiagnostics(source([new TextEncoder().encode(raw)]), metrics).text()).toBe(raw);
    expect(metrics.frames).toBe(20);
    expect(metrics.lastFrames).toHaveLength(8);
    expect(metrics.lastFrames[0]).toMatchObject({ index: 'other', delta: 'other', finish: 'other' });
    expect(JSON.stringify(metrics)).not.toContain('SECRET');
  });
  it('disables oversized diagnostics without changing the provider bytes', async () => {
    const raw = `data: ${'x'.repeat(256_001)}\n\n`;
    const metrics = newSseDiagnostics();
    expect(await tapSseDiagnostics(source([new TextEncoder().encode(raw)]), metrics).text()).toBe(raw);
    expect(metrics.truncatedDiagnostics).toBe(true);
    expect(metrics.lastFrames).toEqual([]);
  });
  it('distinguishes empty usage, null delta, missing index and unknown finish safely', async () => {
    const raw = 'data: {"choices":[],"usage":{}}\n\ndata: {"choices":[{"delta":null,"finish_reason":"length"}]}\n\n';
    const metrics = newSseDiagnostics();
    await tapSseDiagnostics(source([new TextEncoder().encode(raw)]), metrics).text();
    expect(metrics.lastFrames[0]).toMatchObject({ choices: 'empty', usage: true });
    expect(metrics.lastFrames[1]).toMatchObject({ index: 'missing', delta: 'null', finish: 'length' });
  });
});
