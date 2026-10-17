import { readMiniMaxStream } from './stream';
import { AssistantError, type AssistantProvider, type ProviderMessage } from './types';

// Official compatibility reference: https://platform.minimax.io/docs/api-reference/text-openai-api
export const MINIMAX_ENDPOINTS = Object.freeze({ global: 'https://api.minimax.io/v1/chat/completions', cn: 'https://api.minimax.cn/v1/chat/completions' });
export const DEFAULT_MINIMAX_MODEL = 'MiniMax-M2.5';
/** No storage, retries, arbitrary endpoint, tools, or key logging. fetch is injectable for tests. */
export function createMiniMaxProvider(fetcher: typeof fetch = fetch): AssistantProvider {
  return { async complete({ messages, settings, apiKey, signal, onContent }) {
    if (settings.region !== 'global' && settings.region !== 'cn') throw new AssistantError('validation', 'Choose a supported MiniMax region.');
    if (!apiKey.trim()) throw new AssistantError('validation', '请先在 AI 设置中填写 MiniMax API Key。');
    if (/[\r\n]/.test(apiKey)) throw new AssistantError('validation', 'API Key 含换行符，请重新粘贴完整的 MiniMax API Key。');
    const model = settings.model?.trim() || DEFAULT_MINIMAX_MODEL;
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(model)) throw new AssistantError('validation', 'Invalid model name.');
    const limit = settings.maxCompletionTokens ?? 4096;
    if (!Number.isInteger(limit) || limit < 256 || limit > 32768) throw new AssistantError('validation', 'Completion limit must be 256–32768 tokens.');
    try {
      const response = await fetcher(MINIMAX_ENDPOINTS[settings.region], {
        method: 'POST', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, max_completion_tokens: limit, reasoning_split: true, stream: !!onContent }),
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new AssistantError('provider', 'MiniMax 身份验证或访问权限失败。请检查 API Key、所选地区及模型权限。');
        if (response.status === 429) throw new AssistantError('provider', 'MiniMax 请求受限，请稍后重试，并检查账户额度及速率限制。');
        throw new AssistantError('provider', `MiniMax 请求失败（HTTP ${response.status}）。请检查模型设置或稍后重试。`);
      }
      if (onContent) return await readMiniMaxStream(response, signal, onContent);
      const body = await response.text();
      if (body.length > 2_000_000) throw new AssistantError('provider', 'MiniMax response exceeded the size limit.');
      let data;
      try { data = JSON.parse(body); } catch { throw new AssistantError('provider', 'MiniMax 返回了无法读取的响应格式。请稍后重试；未保存或执行任何建议。'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AssistantError('provider', 'MiniMax 返回了无法识别的响应结构。请稍后重试。');
      if (data.base_resp?.status_code || data.error) throw new AssistantError('provider', 'MiniMax 拒绝了请求。请检查 API Key、账户额度、地区及模型设置。');
      const choice = data.choices?.[0];
      if (choice?.finish_reason === 'length') throw new AssistantError('provider', '模型输出达到 token 上限，回答被截断。请提高输出 token 上限或缩小书签范围后重试；未保存或执行任何建议。');
      if (!choice || choice.message?.role !== 'assistant' || typeof choice.message.content !== 'string' || !choice.message.content.trim()) throw new AssistantError('provider', 'MiniMax 返回了空回答或无法识别的响应。请稍后重试；未保存或执行任何建议。');
      if (choice.message.tool_calls?.length) throw new AssistantError('provider', 'Unexpected tool call from MiniMax.');
      if (choice.finish_reason !== 'stop') throw new AssistantError('provider', 'MiniMax 未正常完成回答。请缩小范围后重试；未保存或执行任何建议。');
      return { message: choice.message as ProviderMessage, finishReason: choice.finish_reason };
    } catch (error) {
      if (signal?.aborted) throw new AssistantError('canceled', 'Request canceled.');
      if (error instanceof AssistantError) throw error;
      throw new AssistantError('provider', '无法连接 MiniMax 或读取响应。请检查网络、地区设置后重试。');
    }
  } };
}
