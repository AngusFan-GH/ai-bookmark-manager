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
import {
  ok,
  type BackgroundRequest,
  type BackgroundResponse,
  type ExportPayload,
  type ListResult,
  type StatsSummary,
  type SyncState,
} from '../src/infrastructure/messaging/contracts';

type BookmarkTreeNode = chrome.bookmarks.BookmarkTreeNode;

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
    listPlans: () => planService.listPlans() as unknown as Promise<unknown[]>,
    getPlan: async (planId: string) => {
      const [plan, steps] = await Promise.all([
        planService.getPlan(planId),
        planService.getPlanSteps(planId),
      ]);
      if (!plan) return null;
      return { ...plan, steps };
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
    .register('PLAN_DRAFT', (req) => deps.draftPlan(req.rawJson, req.mode))
    .register('PLAN_LIST', () => deps.listPlans())
    .register('PLAN_GET', (req) => deps.getPlan(req.planId))
    .register('APPROVE', (req) => deps.approvePlan(req.planId, req.ttlMs))
    .register('EXECUTE', (req) => deps.executePlan(req.planId, req.approvalToken, req.dryRun));

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
    currentSyncGeneration: () => getCurrentGeneration(),
    newId,
    now: () => Date.now(),
  });

  // ---- Message handler --------------------------------------------------
  // Reject messages from other extensions.
  chrome.runtime.onMessage.addListener(
    (request: BackgroundRequest, sender, sendResponse: (r: BackgroundResponse<unknown>) => void) => {
      if (sender.id !== chrome.runtime.id) {
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
});
