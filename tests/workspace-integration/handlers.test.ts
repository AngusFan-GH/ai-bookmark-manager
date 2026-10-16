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
    await vi.waitFor(() => expect(chrome.storage.session.remove).toHaveBeenCalledOnce());
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
    expect((await router.dispatch(turn)).ok).toBe(false);
    expect((await router.dispatch({ type: 'ASSISTANT_KEY_CLEAR', requestId: 'retry-clear' })).ok).toBe(true);
    expect((await router.dispatch(turn)).ok).toBe(true);
  });
});

function installStorage() {
  const session: Record<string, unknown> = {};
  const local: Record<string, unknown> = {};
  const area = (values: Record<string, unknown>) => ({
    get: vi.fn(async (key: string) => ({ [key]: values[key] })),
    set: vi.fn(async (data: Record<string, unknown>) => { Object.assign(values, data); }),
    remove: vi.fn(async (key: string) => { delete values[key]; }),
    setAccessLevel: vi.fn(async () => {}),
  });
  vi.stubGlobal('chrome', { storage: { session: area(session), local: area(local) } });
  return { session, local };
}
const getSettings = { type: 'ASSISTANT_SETTINGS_GET', requestId: 'get-settings' };
const saveSettings = (settings: Record<string, unknown> = {}) => ({
  type: 'ASSISTANT_SETTINGS_SAVE', requestId: 'save-settings',
  settings: { region: 'global', model: 'MiniMax-M2.5', consent: true, ...settings },
});

describe('opt-in region-bound key persistence', () => {
  it('defaults missing persistence to session and does not expose secrets', async () => {
    const { session, local } = installStorage();
    const { router, db } = fixture();
    expect(await router.dispatch(getSettings)).toMatchObject({ ok: true, data: { keyStorage: 'session', hasKey: false } });
    expect((await router.dispatch(saveSettings({ apiKey: 'test-key' }))).ok).toBe(true);
    expect(session.minimaxSessionKey).toEqual({ region: 'global', apiKey: 'test-key' });
    expect(local).toEqual({});
    expect(JSON.stringify(await router.dispatch(getSettings))).not.toContain('test-key');
    expect(JSON.stringify(vi.mocked(db.meta.put).mock.calls)).not.toContain('test-key');
    expect(chrome.storage.session.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
  });

  it('persists only after opt-in and survives a session reset and handler restart', async () => {
    const { session, local } = installStorage();
    const { router, db } = fixture();
    await router.dispatch(saveSettings({ apiKey: 'test-key' }));
    expect((await router.dispatch(saveSettings({ keyStorage: 'local' }))).ok).toBe(true);
    expect(session).toEqual({});
    expect(local.minimaxSessionKey).toEqual({ region: 'global', apiKey: 'test-key' });
    for(const key of Object.keys(session)) delete session[key];
    const restarted = new BackgroundRouter({} as ConstructorParameters<typeof BackgroundRouter>[0]);
    registerWorkspaceHandlers(restarted, { db, planService: {} as PlanService, canFetch: async () => true });
    expect(await restarted.dispatch(getSettings)).toMatchObject({ ok: true, data: { keyStorage: 'local', hasKey: true } });
    expect(chrome.storage.local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    await restarted.dispatch(saveSettings({ keyStorage: 'session' }));
    expect(local).toEqual({});
    expect(session.minimaxSessionKey).toEqual({ region: 'global', apiKey: 'test-key' });
  });

  it.each(['clear', 'empty', 'region'])('clears both stores on %s', async action => {
    const { session, local } = installStorage();
    const { router } = fixture();
    await router.dispatch(saveSettings({ keyStorage: 'local', apiKey: 'test-key' }));
    session.minimaxSessionKey = { region: 'global', apiKey: 'stale-test-key' };
    const request = action === 'clear' ? { type: 'ASSISTANT_KEY_CLEAR', requestId: 'clear' }
      : saveSettings({ keyStorage: 'local', ...(action === 'empty' ? { apiKey: '' } : { region: 'cn' }) });
    expect((await router.dispatch(request)).ok).toBe(true);
    expect(session).toEqual({});
    expect(local).toEqual({});
    expect(await router.dispatch(getSettings)).toMatchObject({ ok: true, data: { hasKey: false } });
  });

  it('rejects a mismatched region and never falls back to another store', async () => {
    const { session, local } = installStorage();
    const { router } = fixture();
    session.minimaxSessionKey = { region: 'cn', apiKey: 'test-wrong-region' };
    local.minimaxSessionKey = { region: 'global', apiKey: 'test-other-store' };
    expect(await router.dispatch(getSettings)).toMatchObject({ ok: true, data: { hasKey: false } });
    expect((await router.dispatch(turn)).ok).toBe(false);
    expect(mocks.turn).not.toHaveBeenCalled();
  });

  it('fails closed and sanitizes storage read errors without using another store', async () => {
    installStorage();
    const { router } = fixture();
    vi.mocked(chrome.storage.session.get).mockRejectedValue(new Error('test-secret-in-error'));
    const result = await router.dispatch(turn);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('test-secret-in-error');
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(mocks.turn).not.toHaveBeenCalled();
  });

  it('cleans both stores and blocks use when saving settings fails after migration', async () => {
    const { session, local } = installStorage();
    const { router, db } = fixture();
    await router.dispatch(saveSettings({ apiKey: 'test-key' }));
    vi.mocked(db.meta.put).mockRejectedValueOnce(new Error('write failed'));
    expect((await router.dispatch(saveSettings({ keyStorage: 'local' }))).ok).toBe(false);
    expect(session).toEqual({});
    expect(local).toEqual({});
    expect((await router.dispatch(turn)).ok).toBe(false);
    expect(mocks.turn).not.toHaveBeenCalled();
    expect((await router.dispatch(saveSettings({ apiKey: 'test-replacement' }))).ok).toBe(true);
  });

  it('does not persist a key if restricting access fails', async () => {
    const { local } = installStorage();
    const { router } = fixture();
    vi.mocked(chrome.storage.local.setAccessLevel).mockRejectedValueOnce(new Error('access denied'));
    expect((await router.dispatch(saveSettings({ keyStorage: 'local', apiKey: 'test-key' }))).ok).toBe(false);
    expect(local).toEqual({});
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('rejects unsupported persistence and unavailable storage without leaking errors', async () => {
    const { router } = fixture();
    expect((await router.dispatch(saveSettings({ keyStorage: 'sync', apiKey: 'test-key' }))).ok).toBe(false);
    expect((await router.dispatch(saveSettings({ keyStorage: 'local', apiKey: 'test-key' }))).ok).toBe(false);
    expect(chrome.storage.session.set).not.toHaveBeenCalled();
  });

  it('still clears local storage when session removal fails and allows a clear retry', async () => {
    const { session, local } = installStorage();
    const { router } = fixture();
    session.minimaxSessionKey = { region: 'global', apiKey: 'test-key' };
    local.minimaxSessionKey = { region: 'global', apiKey: 'test-key' };
    vi.mocked(chrome.storage.session.remove).mockRejectedValueOnce(new Error('test-key'));
    const clear = { type: 'ASSISTANT_KEY_CLEAR', requestId: 'clear' };
    const result = await router.dispatch(clear);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('test-key');
    expect(local).toEqual({});
    expect((await router.dispatch(turn)).ok).toBe(false);
    expect((await router.dispatch(clear)).ok).toBe(true);
    expect(session).toEqual({});
  });

  it('binds an explicit replacement key to a newly selected region', async () => {
    const { session, local } = installStorage();
    const { router } = fixture();
    await router.dispatch(saveSettings({ keyStorage: 'local', apiKey: 'old-test-key' }));
    expect((await router.dispatch(saveSettings({ keyStorage: 'local', region: 'cn', apiKey: 'new-test-key' }))).ok).toBe(true);
    expect(session).toEqual({});
    expect(local.minimaxSessionKey).toEqual({ region: 'cn', apiKey: 'new-test-key' });
    expect((await router.dispatch(turn)).ok).toBe(true);
    expect(mocks.turn.mock.calls[0][0]).toMatchObject({ apiKey: 'new-test-key', settings: { region: 'cn' } });
  });

});
