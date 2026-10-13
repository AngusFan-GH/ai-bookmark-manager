// src/store.ts
//
// Pinia store used by Options.vue / Popup.vue. Issues typed
// BackgroundRequests via src/client.ts.

import { defineStore } from 'pinia';
import { ref } from 'vue';
import { request } from './client';
import type { BookmarkRecord, FolderRecord } from './domain/bookmarks/types';
import type { StatsSummary } from './infrastructure/messaging/contracts';

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

  return { rows, folders, stats, total, loading, error, load, sync };
});
