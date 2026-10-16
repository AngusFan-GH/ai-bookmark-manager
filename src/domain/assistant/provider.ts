import { AssistantError, type AssistantProvider, type ProviderMessage } from './types';

// Official compatibility reference: https://platform.minimax.io/docs/api-reference/text-openai-api
export const MINIMAX_ENDPOINTS = Object.freeze({ global: 'https://api.minimax.io/v1/chat/completions', cn: 'https://api.minimax.cn/v1/chat/completions' });
export const DEFAULT_MINIMAX_MODEL = 'MiniMax-M2.5';
/** No storage, retries, arbitrary endpoint, tools, or key logging. fetch is injectable for tests. */
export function createMiniMaxProvider(fetcher: typeof fetch = fetch): AssistantProvider {
  return { async complete({ messages, settings, apiKey, signal }) {
    if (settings.region !== 'global' && settings.region !== 'cn') throw new AssistantError('validation', 'Choose a supported MiniMax region.');
    if (!apiKey.trim() || /[\r\n]/.test(apiKey)) throw new AssistantError('validation', 'A valid MiniMax API key is required.');
    const model = settings.model?.trim() || DEFAULT_MINIMAX_MODEL;
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(model)) throw new AssistantError('validation', 'Invalid model name.');
    const limit = settings.maxCompletionTokens ?? 4096;
    if (!Number.isInteger(limit) || limit < 256 || limit > 32768) throw new AssistantError('validation', 'Completion limit must be 256–32768 tokens.');
    try {
      const response = await fetcher(MINIMAX_ENDPOINTS[settings.region], {
        method: 'POST', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, max_completion_tokens: limit, reasoning_split: true, stream: false }),
      });
      if (!response.ok) throw new AssistantError('provider', `MiniMax request failed (HTTP ${response.status}).`);
      const body = await response.text();
      if (body.length > 2_000_000) throw new AssistantError('provider', 'MiniMax response exceeded the size limit.');
      const data = JSON.parse(body);
      if (data.base_resp?.status_code) throw new AssistantError('provider', 'MiniMax rejected the request. Check your account and model settings.');
      const choice = data.choices?.[0];
      if (!choice || choice.message?.role !== 'assistant' || typeof choice.message.content !== 'string' || !choice.message.content.trim()) throw new AssistantError('provider', 'MiniMax returned an empty or malformed response.');
      if (choice.message.tool_calls?.length) throw new AssistantError('provider', 'Unexpected tool call from MiniMax.');
      if (choice.finish_reason !== 'stop') throw new AssistantError('provider', 'MiniMax did not complete the response. Try a higher token limit or a shorter request.');
      return { message: choice.message as ProviderMessage, finishReason: choice.finish_reason };
    } catch (error) {
      if (signal?.aborted) throw new AssistantError('canceled', 'Request canceled.');
      if (error instanceof AssistantError) throw error;
      throw new AssistantError('provider', 'Unable to reach MiniMax or read its response.');
    }
  } };
}
