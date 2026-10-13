// src/store.ts
//
// Pinia store used by Options.vue / Popup.vue. Issues typed
// BackgroundRequests via src/client.ts.

import { defineStore } from 'pinia';
import { ref } from 'vue';
import { request } from './client';
import type { BookmarkRecord, FolderRecord } from './domain/bookmarks/types';
import type {
  StatsSummary,
  ImportPreview,
  OperationPlan,
  OperationStep,
  ApprovalToken,
  ExecuteResultMsg,
  HealthRunSummary,
  HealthStatusSummary,
} from './infrastructure/messaging/contracts';
import type { LinkCheckRecord } from './domain/health/types';

let nextRequestId = 1;
const reqId = (): string => `r${Date.now().toString(36)}_${(nextRequestId++).toString(36)}`;

export const useBookmarkStore = defineStore('bookmarks', () => {
  const rows = ref<BookmarkRecord[]>([]);
  const folders = ref<FolderRecord[]>([]);
  const stats = ref<StatsSummary>({
    bookmarks: 0,
    folders: 0,
    lastSync: null,
    syncState: { status: 'idle', lastSyncAt: null, lastError: null, count: 0, generation: 0 },
  });
  const total = ref(0);
  const loading = ref(false);
  const error = ref('');

  async function load(query = '', folderId?: string, offset = 0): Promise<void> {
    loading.value = true;
    error.value = '';
    try {
      const list = await request<{ rows: BookmarkRecord[]; total: number }>({
        type: 'BOOKMARKS_LIST',
        requestId: reqId(),
        query,
        folderId,
        limit: 200,
        offset,
      });
      rows.value = list.rows;
      total.value = list.total;
      const s = await request<StatsSummary>({ type: 'STATS', requestId: reqId() });
      stats.value = s;
      const f = await request<FolderRecord[]>({ type: 'BOOKMARKS_TREE', requestId: reqId() });
      folders.value = f;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  async function sync(): Promise<void> {
    await request<{ count: number }>({ type: 'SYNC', requestId: reqId(), reason: 'manual' });
    await load();
  }

  // ---- Phase 2: backup import + plan + execute -------------------------

  async function previewImport(rawJson: string, mode: 'additive' | 'additive-with-meta' | 'controlled-merge'): Promise<ImportPreview> {
    return request<ImportPreview>({ type: 'IMPORT_PREVIEW', requestId: reqId(), rawJson, mode });
  }

  async function draftPlan(rawJson: string, mode: 'additive' | 'additive-with-meta' | 'controlled-merge', title?: string): Promise<OperationPlan> {
    return request<OperationPlan>({ type: 'PLAN_DRAFT', requestId: reqId(), rawJson, mode, title });
  }

  async function approve(planId: string, ttlMs?: number): Promise<ApprovalToken> {
    return request<ApprovalToken>({ type: 'APPROVE', requestId: reqId(), planId, ttlMs });
  }

  async function execute(planId: string, approvalToken: string, dryRun?: boolean): Promise<ExecuteResultMsg> {
    return request<ExecuteResultMsg>({ type: 'EXECUTE', requestId: reqId(), planId, approvalToken, dryRun });
  }

  async function getPlan(planId: string): Promise<OperationPlan & { steps: OperationStep[] }> {
    return request<OperationPlan & { steps: OperationStep[] }>({ type: 'PLAN_GET', requestId: reqId(), planId });
  }

  // ---- Phase 3: link health -----------------------------------------------

  async function startHealth(bookmarkIds?: string[]): Promise<HealthRunSummary> {
    return request<HealthRunSummary>({ type: 'HEALTH_START', requestId: reqId(), bookmarkIds });
  }
  async function cancelHealth(): Promise<{ status: string }> {
    return request<{ status: string }>({ type: 'HEALTH_CANCEL', requestId: reqId() });
  }
  async function healthStatus(): Promise<HealthStatusSummary> {
    return request<HealthStatusSummary>({ type: 'HEALTH_STATUS', requestId: reqId() });
  }
  async function healthList(): Promise<{ rows: LinkCheckRecord[] }> {
    return request<{ rows: LinkCheckRecord[] }>({ type: 'HEALTH_LIST', requestId: reqId() });
  }

  // ---- Phase 3.5: settings ----------------------------------------------

  async function getSetting(key: 'allowPrivateHosts'): Promise<boolean> {
    return request<boolean>({ type: 'SETTINGS_GET', requestId: reqId(), key });
  }
  async function setSetting(key: 'allowPrivateHosts', value: boolean): Promise<void> {
    return request<void>({ type: 'SETTINGS_SET', requestId: reqId(), key, value });
  }

  return {
    rows, folders, stats, total, loading, error,
    load, sync,
    previewImport, draftPlan, approve, execute, getPlan,
    startHealth, cancelHealth, healthStatus, healthList,
    getSetting, setSetting,
  };
});
