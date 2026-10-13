// src/client.ts
//
// UI-side wrapper around chrome.runtime.sendMessage. Uses the typed
// BackgroundRequest / BackgroundResponse contract (dev guide § 9.1).
// Throws an AppErrorImpl on failure so callers can branch on `code`
// and `retryable` instead of a raw string.

import { AppErrorImpl } from './shared/errors';
import type { BackgroundRequest, BackgroundResponse } from './infrastructure/messaging/contracts';

export async function request<T>(payload: BackgroundRequest): Promise<T> {
  let result: BackgroundResponse<T> | undefined;
  try {
    result = await chrome.runtime.sendMessage<BackgroundRequest, BackgroundResponse<T>>(payload);
  } catch (err) {
    throw new AppErrorImpl('BACKGROUND_UNAVAILABLE', err instanceof Error ? err.message : String(err), true);
  }
  if (!result) {
    throw new AppErrorImpl('BACKGROUND_UNAVAILABLE', 'no response from background', true);
  }
  if (result.ok) return result.data;
  // Surface the rich error shape.
  throw new AppErrorImpl(result.error.code, result.error.message, result.error.retryable);
}
