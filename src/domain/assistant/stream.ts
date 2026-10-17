import { AssistantError, type ProviderResult } from './types';
import { sanitizeModelText, stripLeadingThinking } from './validation';

const invalid = () => new AssistantError('provider', 'MiniMax 流式响应不完整或格式无效，请重试；未保存或执行任何建议。');
/** Decode only the leading top-level text string. Never parse partial references/actions.
 * Nonconforming field order simply waits for final validation instead of guessing JSON. */
export function previewSuggestionText(content: string): string {
  let source = stripLeadingThinking(content);
  if (source === null) return '';
  source = source.replace(/^```(?:json)?\s*/i, '');
  const start = /^\{\s*"text"\s*:\s*"/.exec(source);
  if (!start) return '';
  let decoded = ''; let closed = false;
  for (let i = start[0].length; i < source.length; i++) {
    const char = source[i];
    if (char === '"') { closed = true; break; }
    if (char === '\\') {
      const escape = source[++i];
      if (escape === undefined) break;
      if (escape === 'u') {
        const hex = source.slice(i + 1, i + 5);
        if (hex.length < 4) break;
        if (!/^[\da-f]{4}$/i.test(hex)) return '';
        decoded += String.fromCharCode(parseInt(hex, 16)); i += 4;
      } else {
        const escapes: Record<string, string> = {'"':'"', '\\':'\\', '/':'/', b:'\b', f:'\f', n:'\n', r:'\r', t:'\t'};
        if (!(escape in escapes)) return '';
        decoded += escapes[escape];
      }
    } else { if (char.charCodeAt(0) < 32) return ''; decoded += char; }
    if (decoded.length > 12000) return '';
  }
  // Hold incomplete markup and ASCII tokens so a later chunk cannot turn already
  // displayed characters into a hidden thought, HTML tag, or generated URL.
  const openTag = decoded.lastIndexOf('<');
  if (openTag > decoded.lastIndexOf('>')) decoded = decoded.slice(0, openTag);
  const openLink = decoded.lastIndexOf('[');
  if (openLink > decoded.lastIndexOf(')')) decoded = decoded.slice(0, openLink);
  if (!closed) decoded = decoded.replace(/[\x21-\x7e]+$/, '').replace(/[\uD800-\uDBFF]$/, '');
  return sanitizeModelText(decoded);
}

/** SSE records and UTF-8 may split at any byte. Require an explicit stop plus
 * [DONE] or clean transport EOF. MiniMax's verifier documents implementations
 * omitting [DONE]; EOF alone, a failed read, or partial JSON never proves success.
 * Confirmed for CN MiniMax-M2.5 by sanitized CI run 39000442154: one stop,
 * clean EOF, no DONE, and no trailing frame data. The service still validates
 * the complete JSON before persisting any turn. */
export async function readMiniMaxStream(response: Response, signal?: AbortSignal, onContent?: (content: string) => void): Promise<ProviderResult> {
  if (!response.body || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) throw invalid();
  const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = ''; let content = ''; let bytes = 0; let stopped = false; let doneMarker = false; let cleanEof = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  function record(raw: string) {
    const data = raw.split(/\r\n|\r|\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return;
    if (doneMarker) throw invalid();
    if (data.trim() === '[DONE]') { if (!stopped) throw invalid(); doneMarker = true; return; }
    let value;
    try { value = JSON.parse(data); } catch { throw invalid(); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.error || value.base_resp?.status_code || !Array.isArray(value.choices)) throw invalid();
    if (!value.choices.length) { if (!stopped || !value.usage) throw invalid(); return; }
    if (value.choices.length !== 1) throw invalid();
    const choice = value.choices[0];
    if (choice.index !== 0 || !choice.delta || typeof choice.delta !== 'object' || Array.isArray(choice.delta)) throw invalid();
    const delta = choice.delta;
    if ((delta.tool_calls != null && (!Array.isArray(delta.tool_calls) || delta.tool_calls.length)) || delta.function_call || (delta.role !== undefined && delta.role !== 'assistant')) throw invalid();
    if (stopped) throw invalid();
    if (delta.content !== undefined && delta.content !== null) {
      if (typeof delta.content !== 'string') throw invalid();
      content += delta.content;
      if (content.length > 100_000) throw invalid();
      if (!signal?.aborted) onContent?.(content);
    }
    // reasoning_content / reasoning_details are never sent to the UI.
    if (choice.finish_reason === 'length') throw new AssistantError('provider', '模型输出达到 token 上限，回答被截断。请提高输出 token 上限或缩小书签范围后重试；未保存或执行任何建议。');
    if (choice.finish_reason != null) { if (choice.finish_reason !== 'stop') throw invalid(); stopped = true; }
  }
  try {
    while (true) {
      if (signal?.aborted) throw new AssistantError('canceled', '请求已停止');
      const next = await reader.read();
      if (signal?.aborted) throw new AssistantError('canceled', '请求已停止');
      if (next.done) { pending += decoder.decode(); cleanEof = true; break; }
      bytes += next.value.byteLength; if (bytes > 2_000_000) throw invalid();
      pending += decoder.decode(next.value, { stream: true });
      let boundary;
      while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(pending))) {
        record(pending.slice(0, boundary.index)); pending = pending.slice(boundary.index + boundary[0].length);
      }
      if (pending.length > 256_000) throw invalid();
      // Do not wait for an HTTP socket to close after the explicit SSE terminator.
      if (doneMarker) { if (pending.trim()) throw invalid(); break; }
    }
    if (pending.trim() || !stopped || (!doneMarker && !cleanEof) || !content.trim()) throw invalid();
    return { message: {role: 'assistant', content}, finishReason: 'stop' };
  } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
