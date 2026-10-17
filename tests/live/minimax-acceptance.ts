import { SUGGESTION_VALIDATION_REASONS, SuggestionValidationError, type SuggestionValidationReason } from '../../src/domain/assistant/validation';
import { newSseDiagnostics, tapSseDiagnostics, type SseDiagnostics } from './sse-diagnostics';
import { createMiniMaxProvider, MINIMAX_ENDPOINTS, DEFAULT_MINIMAX_MODEL } from '../../src/domain/assistant/provider';
import { createAssistantService } from '../../src/domain/assistant/service';
import { AssistantError, type AssistantRepository, type AssistantSession } from '../../src/domain/assistant/types';

export const LIVE_COMMIT_MESSAGE = 'test: run bounded MiniMax streaming acceptance [live-20261017-v2]';
export const MAX_LIVE_CALLS = 5;
export const LIVE_TOKEN_LIMIT = 4096;
export function liveGate(env: Record<string, string | undefined>): boolean {
  return env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === 'AngusFan-GH/ai-bookmark-manager'
    && env.GITHUB_REF === 'refs/heads/chloe/bookmark-workspace' && env.GITHUB_RUN_ATTEMPT === '1'
    && (env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.LIVE_REQUESTED === 'true'
      || env.GITHUB_EVENT_NAME === 'push' && env.LIVE_COMMIT_MESSAGE === LIVE_COMMIT_MESSAGE);
}
type Phase = 'connection' | 'recommendation' | 'multi-turn' | 'organization' | 'bookmark-advice';
type Failure = 'assertion' | 'validation' | 'provider' | 'canceled' | 'timeout' | 'busy' | 'conflict' | 'not-found' | 'limit' | 'unexpected';
export interface CallMetric { call: number; httpStatus?: number; latencyMs: number; promptTokens?: number; completionTokens?: number; totalTokens?: number; streamRequested: boolean; sseContentType?: boolean; stopValidated?: boolean; previewCallbacks?: number; firstPreviewMs?: number; incrementalPreview?: boolean; sseDiagnostics?: SseDiagnostics }
export interface LiveReport { schema: 2; provider: 'MiniMax'; region: 'cn'; model: string; maxCalls: number; maxCompletionTokens: number; passed: boolean; checks: { phase: Phase; passed: boolean; failure?: Failure; validationReason?: SuggestionValidationReason }[]; calls: CallMetric[] }
// Never serialize exception messages, headers, prompts, response bodies, reasoning or keys.
export function safeFailure(error: unknown): Failure {
  if (error instanceof AssistantError && ['validation', 'provider', 'canceled', 'timeout', 'busy', 'conflict', 'not-found', 'limit'].includes(error.code)) return error.code;
  return error instanceof AcceptanceAssertion ? 'assertion' : 'unexpected';
}
export function safeValidationReason(error: unknown): SuggestionValidationReason | undefined {
  return error instanceof SuggestionValidationError && SUGGESTION_VALIDATION_REASONS.includes(error.validationReason) ? error.validationReason : undefined;
}
class AcceptanceAssertion extends Error {}
function check(value: unknown): asserts value { if (!value) throw new AcceptanceAssertion(); }
function tokenCount(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000 ? value : undefined; }

export async function runLiveAcceptance(apiKey: string, fetcher: typeof fetch = fetch): Promise<LiveReport> {
  const report: LiveReport = { schema: 2, provider: 'MiniMax', region: 'cn', model: DEFAULT_MINIMAX_MODEL, maxCalls: MAX_LIVE_CALLS, maxCompletionTokens: LIVE_TOKEN_LIMIT, passed: false, checks: [], calls: [] };
  const boundedFetch: typeof fetch = async (input, init) => {
    check(input === MINIMAX_ENDPOINTS.cn && init?.redirect === 'error' && report.calls.length < MAX_LIVE_CALLS);
    const body = JSON.parse(String(init?.body));
    check(body.max_completion_tokens === LIVE_TOKEN_LIMIT && body.model === DEFAULT_MINIMAX_MODEL && body.stream === [false, true, true, true, false][report.calls.length]);
    const metric: CallMetric = { call: report.calls.length + 1, latencyMs: 0, streamRequested: body.stream };
    report.calls.push(metric);
    const start = performance.now();
    try {
      const response = await fetcher(input, init);
      metric.httpStatus = response.status;
      if (body.stream) {
        metric.sseContentType = !!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream');
        // A bounded shape-only tap forwards original bytes without waiting for EOF.
        metric.sseDiagnostics = newSseDiagnostics();
        return tapSseDiagnostics(response, metric.sseDiagnostics);
      }
      // The cloned response is transient; only bounded numeric usage is retained.
      try {
        const text = await response.clone().text();
        if (text.length <= 2_000_000) {
          const usage = JSON.parse(text)?.usage;
          metric.promptTokens = tokenCount(usage?.prompt_tokens);
          metric.completionTokens = tokenCount(usage?.completion_tokens);
          metric.totalTokens = tokenCount(usage?.total_tokens);
        }
      } catch { /* Optional metrics must not mask actual provider validation. */ }
      return response;
    } finally { metric.latencyMs = Math.round(performance.now() - start); }
  };
  const base = { index: 0, updatedAt: 0, syncGeneration: 1 };
  const folders = [
    { ...base, id: 'synthetic-inbox', browserId: 'synthetic-inbox', parentId: null, title: 'Inbox', path: 'Inbox' },
    { ...base, id: 'synthetic-recipes', browserId: 'synthetic-recipes', parentId: null, title: 'Recipes', path: 'Recipes' },
  ];
  const bookmarks = [
    { ...base, id: 'synthetic-typescript', browserId: 'synthetic-typescript', kind: 'bookmark' as const, parentId: 'synthetic-inbox', title: 'TypeScript beginner handbook', url: 'https://example.com/typescript-handbook', path: 'Inbox' },
    { ...base, id: 'synthetic-cooking', browserId: 'synthetic-cooking', kind: 'bookmark' as const, parentId: 'synthetic-inbox', title: 'Vegetarian cooking recipes', url: 'https://example.com/recipes', path: 'Inbox' },
  ];
  const sessions = new Map<string, AssistantSession>();
  const repository: AssistantRepository = {
    async listBookmarks() { return structuredClone(bookmarks); },
    async listFolders() { return structuredClone(folders); },
    async getSession(id) { const session = sessions.get(id); return session && structuredClone(session); },
    async saveSession(session, revision) {
      if (revision === null ? sessions.has(session.id) : sessions.get(session.id)?.revision !== revision) return false;
      sessions.set(session.id, structuredClone(session)); return true;
    },
  };
  const actualProvider = createMiniMaxProvider(boundedFetch);
  const provider: typeof actualProvider = { async complete(request) {
    const start = performance.now();
    const index = report.calls.length;
    try {
      const result = await actualProvider.complete(request);
      check(result.finishReason === 'stop');
      if (report.calls[index]) report.calls[index].stopValidated = true;
      return result;
    } finally { if (report.calls[index]) report.calls[index].latencyMs = Math.round(performance.now() - start); }
  } };

  const service = createAssistantService({ repository, provider, timeoutMs: 90_000 });
  const settings = { region: 'cn' as const, model: DEFAULT_MINIMAX_MODEL, maxCompletionTokens: LIVE_TOKEN_LIMIT };
  async function streamedTurn(sessionId: string, text: string) {
    const previews: string[] = [];
    const callIndex = report.calls.length;
    const start = performance.now();
    let settled = false;
    try {
      const result = await service.turn({ sessionId, text, settings, apiKey, onText(preview) {
        check(!settled && typeof preview === 'string');
        // No raw schema, SSE protocol or thinking markup may enter presentation text.
        check(!/"(?:text|references|moves|folders|edits|deletions)"\s*:|<\/?think\b|reasoning_content|^data:|```/i.test(preview));
        if (!preview) return;
        const metric = report.calls[callIndex];
        check(metric);
        metric.previewCallbacks = (metric.previewCallbacks ?? 0) + 1;
        metric.firstPreviewMs ??= Math.round(performance.now() - start);
        previews.push(preview);
      } });
      settled = true;
      const finalText = result.messages.at(-1)?.text;
      check(finalText && previews.length > 0 && previews.every(preview => finalText.startsWith(preview)));
      const metric = report.calls[callIndex];
      metric.incrementalPreview = previews.some(preview => preview.length < finalText.length);
      check(metric.streamRequested && metric.sseContentType && metric.stopValidated && metric.incrementalPreview);
      return result;
    } finally { settled = true; }
  }
  let phase: Phase = 'connection';
  try {
    const connection = await provider.complete({ settings, apiKey, signal: AbortSignal.timeout(90_000), messages: [{ role: 'user', content: 'Reply with only OK. This is a synthetic connection check.' }] });
    check(connection.finishReason === 'stop' && connection.message.content.trim().length > 0);
    report.checks.push({ phase, passed: true });
    phase = 'recommendation';
    const session = await service.createSession({ mode: 'recommend' });
    const first = await streamedTurn(session.id, 'My synthetic preference code is MAPLE42. Remember it for the next turn. Recommend only the TypeScript beginner handbook, with exactly one reference. Use two short plain-text sentences in the text field and keep reasons brief.');
    const answer = first.messages.at(-1)!;
    check(answer.references?.length === 1 && answer.references[0].bookmarkId === 'synthetic-typescript');
    check(!answer.moves?.length && !answer.folders?.length && !answer.edits?.length && !answer.deletions?.length);
    report.checks.push({ phase, passed: true });
    phase = 'multi-turn';
    const second = await streamedTurn(session.id, 'What was my synthetic preference code in the previous turn? Include that exact code in text, and reference the same TypeScript bookmark again. Use two short plain-text sentences in the text field.');
    check(second.revision === 2 && second.providerHistory.length === 4 && second.messages.length === 4);
    check(second.messages.at(-1)?.text.includes('MAPLE42'));
    check(second.messages.at(-1)?.references?.some(ref => ref.bookmarkId === 'synthetic-typescript' && ref.citationId === answer.references![0].citationId));
    report.checks.push({ phase, passed: true });
    phase = 'organization';
    const organizing = await service.createSession({ mode: 'organize' });
    const organized = await streamedTurn(organizing.id, 'Propose exactly one move: move Vegetarian cooking recipes into the existing Recipes folder. Leave TypeScript unchanged. No new folders, title edits or deletions. Use two short plain-text sentences in the text field and keep reasons brief.');
    const proposal = organized.messages.at(-1)!;
    check(proposal.moves?.length === 1 && proposal.moves[0].bookmarkId === 'synthetic-cooking' && proposal.moves[0].targetFolderId === 'synthetic-recipes');
    check(!proposal.folders?.length && !proposal.edits?.length && !proposal.deletions?.length);
    check(bookmarks[1].parentId === 'synthetic-inbox');
    report.checks.push({ phase, passed: true });
    phase = 'bookmark-advice';
    const advice = await service.adviseBookmark({ title: 'Vegetarian cooking recipes for beginners', url: 'https://example.com/vegetarian-recipes', parentFolderId: 'synthetic-inbox', settings, apiKey });
    check(advice.title.trim() && advice.reason.trim() && advice.targetFolderId === 'synthetic-recipes');
    report.checks.push({ phase, passed: true });
    check(report.calls.length === MAX_LIVE_CALLS);
    report.passed = true;
  } catch (error) { report.checks.push({ phase, passed: false, failure: safeFailure(error), validationReason: safeValidationReason(error) }); }
  return report;
}
