/** Test-only transport tap. Never retain arbitrary field names or string values.
 * It forwards the original bytes; parsing here is diagnostic, never acceptance. */
interface FrameShape {
  kind: 'json' | 'done' | 'invalid-json';
  choices?: 'missing' | 'non-array' | 'empty' | 'one' | 'many';
  index?: 'zero' | 'missing' | 'other';
  delta?: 'object' | 'null' | 'missing' | 'other';
  message?: boolean;
  finish?: 'stop' | 'length' | 'null' | 'missing' | 'other';
  usage?: boolean;
  providerError?: boolean;
}
export interface SseDiagnostics {
  frames: number; doneMarkers: number; stopFrames: number; eof: boolean;
  canceled: boolean; readFailed: boolean; truncatedDiagnostics: boolean;
  trailingData: boolean; lastFrames: FrameShape[];
}
export function newSseDiagnostics(): SseDiagnostics {
  return { frames: 0, doneMarkers: 0, stopFrames: 0, eof: false, canceled: false, readFailed: false, truncatedDiagnostics: false, trailingData: false, lastFrames: [] };
}
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export function tapSseDiagnostics(response: Response, metrics: SseDiagnostics): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  function record(raw: string) {
    const data = raw.split(/\r\n|\r|\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return;
    if (metrics.frames >= 10_000) { metrics.truncatedDiagnostics = true; return; }
    metrics.frames++;
    let shape: FrameShape;
    if (data.trim() === '[DONE]') { metrics.doneMarkers++; shape = { kind: 'done' }; }
    else {
      try {
        const value = object(JSON.parse(data));
        const choices = value?.choices;
        shape = { kind: 'json', choices: choices === undefined ? 'missing' : !Array.isArray(choices) ? 'non-array' : choices.length === 0 ? 'empty' : choices.length === 1 ? 'one' : 'many', usage: value?.usage != null, providerError: !!(value?.error || object(value?.base_resp)?.status_code) };
        if (Array.isArray(choices) && choices.length) {
          const choice = object(choices[0]);
          shape.index = choice?.index === 0 ? 'zero' : choice?.index === undefined ? 'missing' : 'other';
          shape.delta = choice?.delta === undefined ? 'missing' : choice.delta === null ? 'null' : object(choice.delta) ? 'object' : 'other';
          shape.message = choice?.message != null;
          const finish = choice?.finish_reason;
          shape.finish = finish === undefined ? 'missing' : finish === null ? 'null' : finish === 'stop' || finish === 'length' ? finish : 'other';
          if (finish === 'stop') metrics.stopFrames++;
        }
      } catch { shape = { kind: 'invalid-json' }; }
    }
    metrics.lastFrames.push(shape);
    if (metrics.lastFrames.length > 8) metrics.lastFrames.shift();
  }
  function observe(bytes: Uint8Array) {
    if (metrics.truncatedDiagnostics) return;
    pending += decoder.decode(bytes, { stream: true });
    if (pending.length > 256_000) { pending = ''; metrics.truncatedDiagnostics = true; return; }
    let boundary;
    while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(pending))) {
      record(pending.slice(0, boundary.index)); pending = pending.slice(boundary.index + boundary[0].length);
    }
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { metrics.eof = true; metrics.trailingData = !!pending.trim(); pending = ''; controller.close(); return; }
        observe(next.value);
        controller.enqueue(next.value);
      } catch (error) { metrics.readFailed = true; pending = ''; controller.error(error); }
    },
    async cancel() { metrics.canceled = true; pending = ''; await reader.cancel(); },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
