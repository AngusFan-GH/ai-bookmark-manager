import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundRouter } from '../../src/infrastructure/messaging/background-router';
import { registerWorkspaceHandlers } from '../../src/infrastructure/messaging/workspace-handlers';
import type { BookmarkDatabase } from '../../src/infrastructure/database/db';
import type { PlanService } from '../../src/domain/operations/plan-service';

const mocks = vi.hoisted(() => ({ turn: vi.fn() }));
vi.mock('../../src/domain/assistant', () => ({
  createAssistantService: () => ({ turn: mocks.turn }),
  createMiniMaxProvider: () => ({}),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(canFetch = vi.fn(async () => true)) {
  const values = new Map<string, unknown>([['assistant:settings', { region: 'global', model: 'MiniMax-M2.5', consent: true }]]);
  const db = { meta: {
    get: vi.fn(async (key: string) => ({ value: values.get(key) })),
    put: vi.fn(async ({ key, value }: { key: string; value: unknown }) => { values.set(key, value); }),
  } } as unknown as BookmarkDatabase;
  const router = new BackgroundRouter({} as ConstructorParameters<typeof BackgroundRouter>[0]);
  registerWorkspaceHandlers(router, { db, planService: {} as PlanService, canFetch });
  return { router, db };
}
const turn = { type: 'ASSISTANT_TURN', sessionId: 's1', text: 'Find references', requestId: 'turn-1' };

beforeEach(() => {
  mocks.turn.mockReset().mockResolvedValue({ id: 's1', providerHistory: [] });
  vi.stubGlobal('chrome', { storage: { session: {
    get: vi.fn(async () => ({ minimaxSessionKey: 'test-only-placeholder' })),
    remove: vi.fn(async () => {}), set: vi.fn(async () => {}),
  } } });
});
afterEach(() => vi.unstubAllGlobals());

describe('workspace turn preflight ownership', () => {
  it('rejects concurrent turns without losing the first cancellation controller', async () => {
    const permission = deferred<boolean>();
    const canFetch = vi.fn(() => permission.promise);
    const { router } = fixture(canFetch);
    const first = router.dispatch(turn);
    await vi.waitFor(() => expect(canFetch).toHaveBeenCalledOnce());
    const second = await router.dispatch({ ...turn, requestId: 'turn-2' });
    expect(second.ok).toBe(false);
    await router.dispatch({ type: 'ASSISTANT_CANCEL', sessionId: 's1', requestId: 'cancel' });
    permission.resolve(true);
    expect((await first).ok).toBe(false);
    expect(mocks.turn).not.toHaveBeenCalled();
    // Cancel completion releases ownership and allows a later explicit retry.
    expect((await router.dispatch({ ...turn, requestId: 'retry' })).ok).toBe(true);
    expect(mocks.turn).toHaveBeenCalledOnce();
  });

  it('clearing the key aborts a request waiting on permissions before any provider call', async () => {
    const permission = deferred<boolean>();
    const canFetch = vi.fn(() => permission.promise);
    const { router } = fixture(canFetch);
    const pending = router.dispatch(turn);
    await vi.waitFor(() => expect(canFetch).toHaveBeenCalledOnce());
    expect((await router.dispatch({ type: 'ASSISTANT_KEY_CLEAR', requestId: 'clear' })).ok).toBe(true);
    expect(chrome.storage.session.remove).toHaveBeenCalledWith('minimaxSessionKey');
    permission.resolve(true);
    expect((await pending).ok).toBe(false);
    expect(mocks.turn).not.toHaveBeenCalled();
  });

  it('blocks setting changes throughout preflight and releases the guard on a failed preflight', async () => {
    const permission = deferred<boolean>();
    const canFetch = vi.fn(() => permission.promise);
    const { router, db } = fixture(canFetch);
    const pending = router.dispatch(turn);
    await vi.waitFor(() => expect(canFetch).toHaveBeenCalledOnce());
    const save = { type: 'ASSISTANT_SETTINGS_SAVE', requestId: 'save', settings: { region: 'global', model: 'MiniMax-M2.5', consent: false } };
    expect((await router.dispatch(save)).ok).toBe(false);
    expect(db.meta.put).not.toHaveBeenCalled();
    permission.resolve(false);
    expect((await pending).ok).toBe(false);
    expect((await router.dispatch(save)).ok).toBe(true);
    expect(db.meta.put).toHaveBeenCalledOnce();
    expect(mocks.turn).not.toHaveBeenCalled();
  });
});


describe('workspace settings mutation ownership', () => {
  it('rejects a new turn while clearing the old key, then releases ownership', async () => {
    const removed = deferred<void>();
    vi.mocked(chrome.storage.session.remove).mockImplementationOnce(() => removed.promise);
    const { router } = fixture();
    const clearing = router.dispatch({ type: 'ASSISTANT_KEY_CLEAR', requestId: 'clear' });
    expect(chrome.storage.session.remove).toHaveBeenCalledOnce();
    expect((await router.dispatch(turn)).ok).toBe(false);
    expect(mocks.turn).not.toHaveBeenCalled();
    removed.resolve();
    expect((await clearing).ok).toBe(true);
    // A later request can proceed once the mutation has settled.
    expect((await router.dispatch({ ...turn, requestId: 'later' })).ok).toBe(true);
  });

  it('rejects turns and competing configuration mutations while settings are saving', async () => {
    const saved = deferred<void>();
    const { router, db } = fixture();
    vi.mocked(db.meta.put).mockImplementationOnce(() => saved.promise as never);
    const save = { type: 'ASSISTANT_SETTINGS_SAVE', requestId: 'save', settings: { region: 'global', model: 'MiniMax-M2.5', consent: true } };
    const saving = router.dispatch(save);
    await vi.waitFor(() => expect(db.meta.put).toHaveBeenCalledOnce());
    expect((await router.dispatch(turn)).ok).toBe(false);
    expect((await router.dispatch({ ...save, requestId: 'save-again' })).ok).toBe(false);
    expect((await router.dispatch({ type: 'ASSISTANT_KEY_CLEAR', requestId: 'clear' })).ok).toBe(false);
    expect(mocks.turn).not.toHaveBeenCalled();
    expect(chrome.storage.session.remove).not.toHaveBeenCalled();
    saved.resolve();
    expect((await saving).ok).toBe(true);
    expect((await router.dispatch(turn)).ok).toBe(true);
  });

  it('releases configuration ownership even if the storage write fails', async () => {
    const { router } = fixture();
    vi.mocked(chrome.storage.session.remove).mockRejectedValueOnce(new Error('Storage unavailable'));
    expect((await router.dispatch({ type: 'ASSISTANT_KEY_CLEAR', requestId: 'clear' })).ok).toBe(false);
    expect((await router.dispatch(turn)).ok).toBe(true);
  });
});
