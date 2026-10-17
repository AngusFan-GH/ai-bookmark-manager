import type { BackgroundRouter } from './background-router';
import type { BackgroundResponse } from './contracts';
import type { AssistantSessionView } from '../../workspace-client';

export const ASSISTANT_STREAM_PORT = 'assistant-turn-stream-v1';
export type AssistantStreamEvent = {requestId: string; sessionId: string} & (
  | {type: 'text'; text: string}
  | {type: 'result'; response: BackgroundResponse<AssistantSessionView>}
);
/** One port owns one request. Disconnect cancels only its own controller, so an
 * old tab cannot cancel a newer turn belonging to another port. */
export function attachAssistantStreamPort(port: chrome.runtime.Port, router: BackgroundRouter, extensionId: string, extensionUrl: string): void {
  if (port.name !== ASSISTANT_STREAM_PORT) return;
  if (port.sender?.id !== extensionId || !port.sender.url?.startsWith(extensionUrl)) { port.disconnect(); return; }
  const controller = new AbortController(); let started = false; let closed = false;
  const disconnect = () => { closed = true; controller.abort(); };
  port.onDisconnect.addListener(disconnect);
  port.onMessage.addListener(message => {
    if (closed) return;
    if (message?.type === 'ping' && started) return;
    if (message?.type === 'cancel' && started) {controller.abort();return;}
    if (started || message?.type !== 'ASSISTANT_TURN' || typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 200 || typeof message.sessionId !== 'string' || !message.sessionId || message.sessionId.length > 200 || typeof message.text !== 'string' || message.text.length > 8000 || (message.automatic !== undefined && typeof message.automatic !== 'boolean') || (message.expectedRevision !== undefined && (!Number.isInteger(message.expectedRevision) || message.expectedRevision < 0))) {
      disconnect(); port.disconnect(); return;
    }
    started = true;
    const {requestId, sessionId, text, automatic, expectedRevision} = message;
    const post = (event: AssistantStreamEvent) => {
      if (closed || (event.type === 'text' && controller.signal.aborted)) return;
      try { port.postMessage(event); } catch { disconnect(); }
    };
    void router.dispatch({type: 'ASSISTANT_TURN', requestId, sessionId, text, automatic, expectedRevision}, {
      signal: controller.signal,
      onText: text => post({type: 'text', requestId, sessionId, text}),
    }).then(response => {
      post({type: 'result', requestId, sessionId, response: response as BackgroundResponse<AssistantSessionView>});
      closed = true;
      port.onDisconnect.removeListener(disconnect);
      // Client closes the port after receiving the terminal result.
    });
  });
}
