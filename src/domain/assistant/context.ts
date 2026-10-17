import type { AssistantSession, AssistantTaskContext } from './types';
import { AssistantError } from './types';

/** Versioned, user-authored task state. No model summary may rewrite constraints. */
export function taskContext(session: AssistantSession): AssistantTaskContext {
  const requests = session.messages.filter(message => message.role === 'user').map(message => message.text);
  const last = session.messages.filter(message => message.role === 'assistant').at(-1);
  return {
    version: 1,
    objective: requests[0] ?? '',
    refinements: requests.slice(1),
    resultOrder: (last?.references ?? []).map((reference, index) => ({
      position: index + 1, bookmarkId: reference.bookmarkId, citationId: reference.citationId,
      title: reference.title, url: reference.url, path: reference.path,
    })),
  };
}
export function assertContextBound(context: AssistantTaskContext): void {
  if (JSON.stringify(context).length > 80_000) throw new AssistantError('limit', '任务条件已达到上下文上限。请开始新任务，并带上仍需保留的条件。');
}
export function isReferenceFollowup(text: string): boolean {
  return /(?:第\s*[一二三四五六七八九十\d]+\s*[个项条篇份]|上[面次述]|这[个些两]|那[个些两]|前[两三几]|\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th)|last|previous|above|these|those|it|them)\b)/i.test(text);
}
