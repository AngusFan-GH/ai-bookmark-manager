import type { Request, Result } from './types';
export async function request<T>(payload: Request): Promise<T> {
  const result = await chrome.runtime.sendMessage<Request, Result<T>>(payload);
  if (!result?.ok) throw new Error(result?.error ?? 'Background unavailable');
  return result.data;
}
