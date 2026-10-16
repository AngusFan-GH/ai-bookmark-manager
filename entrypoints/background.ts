import { registerWorkspaceHandlers } from '../src/infrastructure/messaging/workspace-handlers';
// entrypoints/background.ts
//
// MV3 service worker. Wires:
//   - BrowserBookmarksAdapter  → reads chrome.bookmarks.getTree
//   - SyncCoordinator          → owns the single Dexie writer (dev guide § 2.1)
//   - DebouncedSync            → coalesces event bursts
//   - PlanService (Phase 2)    → the ONLY caller of chrome.bookmarks.* writes
//   - BackgroundRouter         → typed dispatch for UI messages
//
// On startup we run one full sync; events trigger debounced reconcile.
// UI calls come in via chrome.runtime.onMessage and are answered with
// the typed BackgroundResponse shape from contracts.ts.

import { defineBackground } from 'wxt/utils/define-background';
import { createBrowserBookmarksAdapter } from '../src/infrastructure/browser/bookmark-adapter';
import { BackgroundRouter } from '../src/infrastructure/messaging/background-router';
import {
  nextGeneration,
  readSyncState,
  writeSyncState,
  db,
  getCurrentGeneration,
} from '../src/infrastructure/database/db';
import { SyncCoordinator, DebouncedSync } from '../src/domain/bookmarks/sync';
import { matchesSearch } from '../src/domain/bookmarks/normalize';
import { PlanService } from '../src/domain/operations/plan-service';
import type { Approval } from '../src/domain/operations/types';
import { HealthService } from '../src/domain/health/service';
import { DEFAULT_HEALTH_CONFIG } from '../src/domain/health/types';
import type { LinkCheckRecord } from '../src/domain/health/types';
import {
  ok,
  type BackgroundRequest,
  type BackgroundResponse,
  type ExportPayload,
  type ListResult,
  type StatsSummary,
  type SyncState,
  type HealthStatusSummary,
  type HealthRunSummary,
} from '../src/infrastructure/messaging/contracts';

type BookmarkTreeNode = chrome.bookmarks.BookmarkTreeNode;

/**
 * Read the `allowPrivateHosts` flag from chrome.storage.local.
 * Defaults to false (dev guide § 0.1). We do NOT cache at
 * module-init: the service worker can be suspended at any time and
 * re-reads from storage on every read. The previous design
 * (`let ALLOW_PRIVATE_HOSTS = false` + fire-and-forget get) lost
 * the user's setting because the in-memory copy was initialized
 * before the async storage read resolved, and subsequent writes
 * updated the storage but not necessarily the cached value the
 * next time the worker spun up.
 */
async function readAllowPrivateHostsFlag(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      chrome.storage?.local?.get(['allowPrivateHosts'], (data) => {
        resolve(data?.allowPrivateHosts === true);
      });
    } catch {
      resolve(false);
    }
  });
}

function writeAllowPrivateHostsFlag(v: boolean): void {
  // The UI side already calls SETTINGS_SET; we also write here for
  // symmetry (e.g. future inline toggles). Storage writes are
  // observed by other service-worker starts automatically.
  try { chrome.storage?.local?.set({ allowPrivateHosts: v }); } catch { /* ignore */ }
}

const HEALTH_HOST_PATTERNS = ['http://*/*', 'https://*/*'];

function healthOriginPattern(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return null;
  }
}

function containsHealthPermission(rawUrl: string): Promise<boolean> {
  const origin = healthOriginPattern(rawUrl);
  if (!origin) return Promise.resolve(false);
  return new Promise((resolve) => {
    chrome.permissions.contains({ origins: [origin] }, (granted) => {
      resolve(chrome.runtime.lastError ? false : granted);
    });
  });
}

function requestHealthPermission(): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.permissions.request({ origins: HEALTH_HOST_PATTERNS }, (granted) => {
      resolve(chrome.runtime.lastError ? false : granted);
    });
  });
}

function removeHealthPermission(): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.permissions.remove({ origins: HEALTH_HOST_PATTERNS }, (removed) => {
      resolve(chrome.runtime.lastError ? false : removed);
    });
  });
}

function healthPermissionStatus(): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.permissions.contains({ origins: HEALTH_HOST_PATTERNS }, (granted) => {
      resolve(chrome.runtime.lastError ? false : granted);
    });
  });
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/**
 * Walk a chrome.bookmarks tree and return the node with the given id
 * (or null). Used by the PlanService to look up a target before
 * passing it to the bookmarks API.
 */
function findById(roots: BookmarkTreeNode[], id: string): BookmarkTreeNode | null {
  for (const r of roots) {
    if (r.id === id) return r;
    if (r.children) {
      const f = findById(r.children, id);
      if (f) return f;
    }
  }
  return null;
}

export default defineBackground(() => {
  // ---- Browser adapter ---------------------------------------------------
  const adapter = createBrowserBookmarksAdapter({
    bookmarks: chrome.bookmarks as any,
  });

  // ---- Coordinator + debouncer ------------------------------------------
  const coordinator = new SyncCoordinator({
    db: db as any,
    readTree: () => adapter.getTree(),
    readState: () => readSyncState(),
    writeState: (s: SyncState) => writeSyncState(s),
    nextGeneration,
    now: () => Date.now(),
  });
  const debouncer = new DebouncedSync(coordinator, 350);

  // ---- Subscriptions ----------------------------------------------------
  // Re-run on relevant events. Debouncer coalesces bursts.
  const unsubscribe = adapter.onAnyChange((reason) => {
    debouncer.schedule('event');
    void reason;
  });

  // Initial sync on install/startup.
  chrome.runtime.onInstalled.addListener(() => {
    debouncer.schedule('startup');
  });
  chrome.runtime.onStartup.addListener(() => {
    debouncer.schedule('startup');
  });

  // ---- Router -----------------------------------------------------------
  // Build the deps object once; both the router constructor and the
  // .register() callbacks need to call them.
  const deps = {
    async listBookmarks(query: string, folderId: string | undefined, limit: number, offset: number) {
      const all = await db.bookmarks.toArray();
      let rows = all;
      if (folderId) rows = rows.filter((r) => r.parentId === folderId);
      if (query.trim()) {
        rows = rows.filter((r) => matchesSearch(r, query));
      }
      rows.sort((a, b) => (a.path ?? '').localeCompare(b.path ?? '') || a.title.localeCompare(b.title));
      const total = rows.length;
      const capped = Math.max(1, Math.min(limit | 0 || 200, 1000));
      return { rows: rows.slice(offset, offset + capped), total } satisfies ListResult<unknown>;
    },
    async listFolders() {
      const folders = await db.folders.toArray();
      return folders.sort((a, b) => (a.path ?? '').localeCompare(b.path ?? '') || a.title.localeCompare(b.title));
    },
    async getStats(): Promise<StatsSummary> {
      const [all, folders, syncState] = await Promise.all([
        db.bookmarks.toArray(),
        db.folders.toArray(),
        readSyncState(),
      ]);
      return {
        bookmarks: all.length,
        folders: folders.length,
        lastSync: syncState.lastSyncAt,
        syncState,
      };
    },
    async fullSync(reason: 'manual' | 'startup' | 'event') {
      const r = await coordinator.fullSync(reason);
      return { count: r.count };
    },
    async exportBackup(): Promise<ExportPayload> {
      // We persist the already-synced index; we re-read the tree at
      // export time for fidelity. The export never includes API keys,
      // auth, page text, or chat history (dev guide § 3.3 + § 10).
      const [bookmarks, folders, browserTree] = await Promise.all([
        db.bookmarks.toArray(),
        db.folders.toArray(),
        adapter.getTree(),
      ]);
      return {
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        appVersion: chrome.runtime.getManifest().version,
        browserTree,
        localIndex: { bookmarks, folders },
        includes: { browserTree: true, localIndex: true },
      };
    },
    async readSyncState() {
      return readSyncState();
    },
    // Phase 2: backup import + plan execution
    previewImport: (rawJson: string, mode: 'additive' | 'additive-with-meta' | 'controlled-merge') =>
      planService.previewImport(rawJson, mode) as unknown as Promise<unknown>,
    draftPlan: (rawJson: string, mode: 'additive' | 'additive-with-meta' | 'controlled-merge', title?: string) =>
      planService.draftPlan(rawJson, mode, title) as unknown as Promise<unknown>,
    approvePlan: async (planId: string, ttlMs?: number) => {
      const a = await planService.approve(planId, ttlMs);
      return { token: a.token, planId: a.planId, expiresAt: a.issuedAt + a.ttlMs };
    },
    executePlan: async (planId: string, token: string, dryRun?: boolean) => {
      const r = await planService.execute(planId, token, dryRun ?? false);
      return r as { planId: string; status: string; succeeded: number; failed: number; compensated: number };
    },
    listPlans: async () => (await planService.listPlans()).sort((a,b) => b.createdAt-a.createdAt).map(p => ({planId:p.id,status:p.status,title:p.title,stepCount:p.steps.length,createdAt:p.createdAt})),
    getPlan: async (planId: string) => {
      const [plan, steps] = await Promise.all([
        planService.getPlan(planId),
        planService.getPlanSteps(planId),
      ]);
      if (!plan) return null;
      return { ...plan, steps };
    },
    // Phase 3: link health
    startHealth: (bookmarkIds?: string[]) => healthService.start(bookmarkIds) as unknown as Promise<HealthRunSummary>,
    cancelHealth: () => { healthService.cancel(); return Promise.resolve({ status: 'cancelled' }); },
    pauseHealth: () => { healthService.pause(); return Promise.resolve({ status: 'paused' }); },
    resumeHealth: () => { healthService.resume(); return Promise.resolve({ status: 'running' }); },
    healthStatus: () => healthService.snapshotStatus() as unknown as Promise<HealthStatusSummary>,
    listHealth: () => healthService.snapshot() as unknown as Promise<unknown[]>,
    healthPermissionStatus: async () => ({ granted: await healthPermissionStatus() }),
    requestHealthPermission: async () => ({ granted: await requestHealthPermission() }),
    removeHealthPermission: async () => ({ granted: await removeHealthPermission() }),
    getSetting: (_key: 'allowPrivateHosts') => Promise.resolve(readAllowPrivateHostsFlag()),
    setSetting: (_key: 'allowPrivateHosts', value: boolean) => {
      writeAllowPrivateHostsFlag(value);
      return Promise.resolve();
    },
  };

  // Wire every BackgroundRequest type to its handler. Without these
  // registrations, dispatch() returns INVALID_REQUEST for every type
  // (regression history: Phase 1 refactor originally forgot this).
  const router = new BackgroundRouter(deps)
    .register('BOOKMARKS_LIST', (req) => deps.listBookmarks(
      req.query ?? '', req.folderId, req.limit ?? 200, req.offset ?? 0,
    ))
    .register('BOOKMARKS_TREE', () => deps.listFolders())
    .register('STATS', () => deps.getStats())
    .register('SYNC', (req) => deps.fullSync(req.reason ?? 'manual'))
    .register('EXPORT', () => deps.exportBackup())
    .register('SYNC_STATE', () => deps.readSyncState())
    .register('IMPORT_PREVIEW', (req) => deps.previewImport(req.rawJson, req.mode))
    .register('PLAN_DRAFT', (req) => deps.draftPlan(req.rawJson, req.mode, req.title))
    .register('PLAN_LIST', () => deps.listPlans())
    .register('PLAN_GET', (req) => deps.getPlan(req.planId))
    .register('APPROVE', (req) => deps.approvePlan(req.planId, req.ttlMs))
    .register('EXECUTE', (req) => deps.executePlan(req.planId, req.approvalToken, req.dryRun))
    .register('HEALTH_START', (req) => deps.startHealth(req.bookmarkIds))
    .register('HEALTH_CANCEL', () => deps.cancelHealth())
    .register('HEALTH_PAUSE', () => deps.pauseHealth())
    .register('HEALTH_RESUME', () => deps.resumeHealth())
    .register('HEALTH_STATUS', () => deps.healthStatus())
    .register('HEALTH_LIST', () => deps.listHealth())
    .register('HEALTH_PERMISSION_STATUS', () => deps.healthPermissionStatus())
    .register('HEALTH_PERMISSION_REQUEST', () => deps.requestHealthPermission())
    .register('HEALTH_PERMISSION_REMOVE', () => deps.removeHealthPermission())
    .register('SETTINGS_GET', (req) => deps.getSetting(req.key))
    .register('SETTINGS_SET', (req) => deps.setSetting(req.key, req.value));

  // ---- PlanService (Phase 2) --------------------------------------------
  // The only place in the codebase that wraps the bookmarks API for
  // *writes* (create/update/move/remove) is PlanService. The router
  // delegates the 6 new request types to it via the deps facade above.
  let nextIdCounter = 0;
  const newId = (): string => {
    nextIdCounter += 1;
    return `${Date.now().toString(36)}-${nextIdCounter.toString(36)}`;
  };
  const approvalsMap = new Map<string, Approval>();

  const planService = new PlanService({
    bookmarksApi: {
      get: async (id: string) => {
        const tree = await adapter.getTree();
        const found = findById(tree as any, id);
        if (!found) throw new Error(`bookmark ${id} not found`);
        return found as any;
      },
      getSubTree: () => Promise.resolve([]),
      getTree: () => adapter.getTree(),
      create: (input) => chrome.bookmarks.create(input as any) as any,
      update: (id, changes) => chrome.bookmarks.update(id, changes as any).then(() => undefined as void),
      move: (id, dest) => chrome.bookmarks.move(id, dest as any).then(() => undefined as void),
      remove: (id) => chrome.bookmarks.remove(id).then(() => undefined as void),
    },
    plansStore: {
      put: async (p) => { await db.plans.put(p); },
      get: async (id) => db.plans.get(id),
      list: async () => db.plans.toArray(),
    },
    stepsStore: {
      put: async (s) => { await db.operationSteps.put(s); },
      listByPlan: async (planId) => db.operationSteps.where('planId').equals(planId).toArray(),
    },
    auditStore: {
      append: async (e) => { await db.audit.put(e); },
    },
    snapshotsStore: {
      put: async (s) => { await db.snapshots.put(s); },
      get: async (id) => db.snapshots.get(id),
      listByPlan: async (planId) => db.snapshots.where('planId').equals(planId).toArray(),
    },
    approvalsStore: {
      put: async (a) => { approvalsMap.set(a.token, a); },
      take: async (token) => {
        const a = approvalsMap.get(token);
        if (a) approvalsMap.delete(token);
        return a;
      },
    },
    captureLocalIndex: async () => ({bookmarks: await db.bookmarks.toArray(), folders: await db.folders.toArray()}),
    currentSyncGeneration: () => getCurrentGeneration(),
    newId,
    now: () => Date.now(),
  });

  // ---- HealthService (Phase 3) ------------------------------------------
  // Link health scan facade. Reads bookmarks from Dexie, runs the
  // FetchClient (with HEAD→GET fallback) per item via the
  // TaskScheduler, persists results to the linkChecks store.
  // Pause flag — the service is constructed with a closure that
  // reads this flag, avoiding the self-referential initializer.
  let healthPaused = false;
  // The service worker is suspended at any time; the user may toggle
  // `allowPrivateHosts` while we are alive. We resolve the flag
  // fresh on every `startHealth` so the next scan sees the new
  // value without needing a worker restart.
  const healthService: HealthService = new HealthService({
    listBookmarks: async () => db.bookmarks.toArray(),
    latestChecks: async () => db.linkChecks.toArray(),
    saveCheck: async (rec: LinkCheckRecord) => { await db.linkChecks.put(rec); },
    canFetch: containsHealthPermission,
    fetch: async (req) => {
      // Real browser fetch. AbortSignal is honored. Response body is
      // capped at req.maxResponseBytes.
      if (req.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), req.timeoutMs);
      const onAbort = () => ac.abort();
      req.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const res = await fetch(req.url, {
          method: req.method,
          credentials: 'omit',
          cache: 'no-store',
          // Never allow the browser to silently follow a redirect to a host
          // that has not gone through our static guard and permission check.
          redirect: 'manual',
          signal: ac.signal,
        });
        if (res.type === 'opaqueredirect') {
          return { status: 0, url: req.url, retryAfterSec: null, redirectBlocked: true };
        }
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        let body: string | undefined;
        if (req.method === 'GET' && res.body) {
          const reader = res.body.getReader();
          const chunks: Uint8Array[] = [];
          let received = 0;
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              received += value.byteLength;
              if (received > req.maxResponseBytes) { await reader.cancel().catch(() => undefined); break; }
              chunks.push(value);
            }
          }
          const decoder = new TextDecoder();
          body = chunks.map((c) => decoder.decode(c, { stream: true })).join('');
        }
        return {
          status: res.status,
          url: res.url,
          retryAfterSec: retryAfter,
          ...(body !== undefined ? { body } : {}),
        };
      } finally {
        clearTimeout(t);
        req.signal?.removeEventListener('abort', onAbort);
      }
    },
    config: {
      defaultTimeoutMs: DEFAULT_HEALTH_CONFIG.timeoutMs,
      defaultMaxRedirects: DEFAULT_HEALTH_CONFIG.maxRedirects,
      defaultMaxResponseBytes: DEFAULT_HEALTH_CONFIG.maxResponseBytes,
      defaultUserAgent: DEFAULT_HEALTH_CONFIG.userAgent,
      globalConcurrency: DEFAULT_HEALTH_CONFIG.globalConcurrency,
      perHostConcurrency: DEFAULT_HEALTH_CONFIG.perHostConcurrency,
      maxRetries: DEFAULT_HEALTH_CONFIG.maxRetries,
      // The static snapshot is still passed for code paths that
      // don't need a live re-read (e.g. snapshot status). The
      // service's `start()` calls `readAllowPrivateHosts()` itself
      // to pick up the user's latest toggle.
      allowPrivateHosts: false,
    },
    // Re-reads chrome.storage on every call. The service worker may
    // have been alive for a long time; the in-memory snapshot is
    // never used by the gating path.
    readAllowPrivateHosts: () => readAllowPrivateHostsFlag(),
    now: () => Date.now(),
    newId,
    isPaused: () => healthPaused,
  });

  registerWorkspaceHandlers(router, { db, planService, canFetch: containsHealthPermission });

  // ---- Message handler --------------------------------------------------
  // Reject messages from other extensions.
  chrome.runtime.onMessage.addListener(
    (request: BackgroundRequest, sender, sendResponse: (r: BackgroundResponse<unknown>) => void) => {
      if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) {
        sendResponse(ok('?', null)); // ignore, but still respond
        return false;
      }
      void router.dispatch(request).then(sendResponse);
      return true; // keep channel open for async sendResponse
    },
  );

  // Service-worker teardown: best-effort flush of any pending debounced sync.
  // MV3 may not run this in all shutdowns (dev guide § 2.1); the worst case
  // is a missed event, which the next onStartup full sync will catch up.

  (self as any).addEventListener('unload', () => {
    unsubscribe();
    void debouncer.flush();
  });

  // ---- Custom commands (Phase 3+) --------------------------------------
  // `open-link-health` (Alt+H by default) opens the Options page
  // with the link-health tab pre-selected via URL hash.
  try {
    chrome.commands?.onCommand?.addListener((command) => {
      if (command === 'open-link-health') {
        const url = chrome.runtime.getURL('options.html#health');
        void chrome.tabs.create({ url });
      }
    });
  } catch {
    // Older Chrome / non-MV3 builds may not expose chrome.commands.
    // Fail silently — the popup + hash deep link still work.
  }
});
