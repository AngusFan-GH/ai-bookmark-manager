import { defineStore } from 'pinia';
import { ref } from 'vue';
import { request } from './client';
import type { BookmarkRow } from './types';

type Stats = { bookmarks: number; folders: number; lastSync: number | string | null };
export const useBookmarkStore = defineStore('bookmarks', () => {
  const rows = ref<BookmarkRow[]>([]);
  const folders = ref<BookmarkRow[]>([]);
  const stats = ref<Stats>({ bookmarks: 0, folders: 0, lastSync: null });
  const total = ref(0);
  const loading = ref(false);
  const error = ref('');
  async function load(query = '', folderId?: string, offset = 0) {
    loading.value = true; error.value = '';
    try {
      const result = await request<{ rows: BookmarkRow[]; total: number }>({ type: 'LIST', query, folderId, limit: 200, offset });
      rows.value = result.rows; total.value = result.total;
      stats.value = await request<Stats>({ type: 'STATS' });
      folders.value = await request<BookmarkRow[]>({ type: 'TREE' });
    } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
    finally { loading.value = false; }
  }
  async function sync() { await request({ type: 'SYNC' }); await load(); }
  return { rows, folders, stats, total, loading, error, load, sync };
});
