import { request } from './client';
import { AppErrorImpl } from './shared/errors';
import { ASSISTANT_STREAM_PORT, type AssistantStreamEvent } from './infrastructure/messaging/assistant-stream-port';
import type { AssistantSessionView } from './workspace-client';

export interface StreamTurnOptions { automatic?: boolean; expectedRevision?: number; signal?: AbortSignal; onText?: (text: string) => void }
export function streamAssistantTurn(sessionId: string, text: string, requestId: string, options: StreamTurnOptions): Promise<AssistantSessionView> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new Error('请求已停止')); return; }
    let port: chrome.runtime.Port;
    try { port = chrome.runtime.connect({name: ASSISTANT_STREAM_PORT}); }
    catch { reject(new Error('无法连接后台，请刷新后重试')); return; }
    let settled = false; let reconciling = false; let reconciliationTimeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, result?: AssistantSessionView) => {
      if (settled) return;
      settled = true; clearInterval(heartbeat); clearTimeout(timeout); clearTimeout(reconciliationTimeout);
      options.signal?.removeEventListener('abort', cancel);
      port.onMessage.removeListener(receive); port.onDisconnect.removeListener(disconnect);
      try { port.disconnect(); } catch { /* Already closed. */ }
      if (error) reject(error); else resolve(result!);
    };
    const reconcile = async () => {
      if (settled || reconciling) return;
      reconciling = true;
      reconciliationTimeout = setTimeout(() => finish(new Error('无法确认本次回答是否已保存，请重新打开对话核对后再发送。')),15000);
      try {
        // The background waits for this session's active writer before reading.
        // A durable request marker distinguishes a committed turn from old history.
        const session = await request<AssistantSessionView>({type:'ASSISTANT_GET',sessionId,requestId:crypto.randomUUID()});
        if (session.lastTurnRequestId === requestId || session.messages.some(message => message.requestId === requestId)) finish(undefined,session);
        else finish(new Error(options.signal?.aborted ? '请求已停止' : '后台连接已中断，回答未完成。请重试。'));
      } catch {finish(new Error('无法确认本次回答是否已保存，请重新打开对话核对后再发送。'));}
    };
    const cancel = () => { try {port.postMessage({type:'cancel'});} catch {void reconcile();} };
    const disconnect = () => { void chrome.runtime.lastError; void reconcile(); };
    const receive = (event: AssistantStreamEvent) => {
      if (settled || event?.requestId !== requestId || event.sessionId !== sessionId) return;
      if (event.type === 'text' && !options.signal?.aborted && !reconciling && typeof event.text === 'string' && event.text.length <= 12000) {
        try { options.onText?.(event.text); } catch { try {port.disconnect();} catch {/* Reconcile below. */} void reconcile(); }
      } else if (event.type === 'result' && event.response?.requestId === requestId) {
        const response = event.response;
        if (response.ok) finish(undefined, response.data);
        else finish(new AppErrorImpl(response.error.code, response.error.message, response.error.retryable));
      }
    };
    // Sending messages (rather than merely opening the port) keeps MV3 alive
    // during slow first-token reasoning. Closing the page automatically aborts.
    const heartbeat = setInterval(() => { try { port.postMessage({type: 'ping'}); } catch { disconnect(); } }, 15000);
    const timeout = setTimeout(() => {try {port.disconnect();} catch {/* Reconcile below. */} void reconcile();}, 105000);
    port.onMessage.addListener(receive); port.onDisconnect.addListener(disconnect);
    options.signal?.addEventListener('abort', cancel, {once: true});
    try { port.postMessage({type: 'ASSISTANT_TURN', requestId, sessionId, text, automatic: options.automatic, expectedRevision:options.expectedRevision}); }
    catch { disconnect(); }
  });
}
