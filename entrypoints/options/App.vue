<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useBookmarkStore } from '../../src/store';
import { request } from '../../src/client';
import type { FolderRecord } from '../../src/domain/bookmarks/types';
import ImportFlow from './components/ImportFlow.vue';
import HealthView from './components/HealthView.vue';

type TabName = 'bookmarks' | 'health';
const VALID_TABS: TabName[] = ['bookmarks', 'health'];

const store = useBookmarkStore();
const query = ref('');
const folderId = ref('');
const page = ref(1);
const syncing = ref(false);
const activeTab = ref<TabName>('bookmarks');
let debounce: ReturnType<typeof setTimeout> | undefined;
const folders = computed(() =>
  store.folders
    .filter((x: FolderRecord) => x.title && x.id !== '0')
    .sort((a: FolderRecord, b: FolderRecord) => a.path.localeCompare(b.path) || a.title.localeCompare(b.title)),
);
let reqSeq = 0;
const reqId = (): string => `r${Date.now().toString(36)}_${(++reqSeq).toString(36)}`;

/**
 * Open the page at chrome-extension://<id>/options.html#health and
 * the link health tab is selected on mount and stays in sync with
 * the URL hash. This lets the user bookmark or link to a specific
 * view, and lets commands / context-menu entries navigate to it.
 */
function tabFromHash(): TabName {
  const raw = (typeof window !== 'undefined' ? window.location.hash : '').replace(/^#/, '').toLowerCase();
  return (VALID_TABS as string[]).includes(raw) ? (raw as TabName) : 'bookmarks';
}
function syncHash() {
  if (typeof window === 'undefined') return;
  const target = `#${activeTab.value}`;
  if (window.location.hash !== target) {
    // Use replaceState to avoid spamming browser history with every
    // tab switch — only the first navigation should be in history.
    window.history.replaceState(null, '', `${window.location.pathname}${target}`);
  }
}

async function refresh() { await store.load(query.value, folderId.value || undefined, (page.value - 1) * 200); }
watch([query, folderId], () => { page.value = 1; if (debounce) clearTimeout(debounce); debounce = setTimeout(() => void refresh(), 200); });
watch(page, () => void refresh());
async function sync() {
  syncing.value = true;
  try { await store.sync(); page.value = 1; folderId.value = ''; query.value = ''; ElMessage.success('同步完成'); }
  catch (e) { ElMessage.error(String(e)); }
  finally { syncing.value = false; }
}
async function backup() {
  try {
    const data = await request<unknown>({ type: 'EXPORT', requestId: reqId() });
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url;
    a.download = `bookmarks-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
    ElMessage.success('备份已导出');
  } catch (e) { ElMessage.error(String(e)); }
}
onMounted(async () => {
  // Honor the URL hash on first paint so deep links open the right
  // tab. The hash listener below keeps it in sync after that.
  activeTab.value = tabFromHash();
  syncHash();
  window.addEventListener('hashchange', () => { activeTab.value = tabFromHash(); });
  // Keep the URL hash in sync when the user clicks a tab in the UI.
  watch(activeTab, syncHash);

  await refresh();
  if (!store.stats.lastSync) await sync();
  // Lightweight UI refresh; native browser bookmark changes remain authoritative.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
});
</script>
<template>
  <div class="shell">
    <header><div><h1>AI Bookmark Manager</h1><p>本地优先 · 书签管理工作台</p></div>
      <div class="actions">
        <el-button :loading="syncing" @click="sync">重新同步</el-button>
        <el-button @click="backup">导出 JSON 备份</el-button>
        <ImportFlow />
        <!-- 链接健康 tab switcher: 始终可见；处于健康 tab 时高亮 (primary) -->
        <el-button
          data-testid="link-health-button"
          :type="activeTab === 'health' ? 'primary' : 'warning'"
          round
          @click="activeTab = 'health'"
        >
          <span style="margin-right: 4px">🩺</span>链接健康
        </el-button>
      </div>
    </header>
    <div class="stats">
      <el-card shadow="never"><div class="number">{{ store.stats.bookmarks }}</div><span>书签总数</span></el-card>
      <el-card shadow="never"><div class="number">{{ store.stats.folders }}</div><span>目录节点</span></el-card>
      <el-card shadow="never"><div class="date">{{ store.stats.lastSync ? new Date(store.stats.lastSync).toLocaleString() : '尚未同步' }}</div><span>最近同步</span></el-card>
    </div>
    <el-tabs v-model="activeTab">
      <el-tab-pane label="书签" name="bookmarks">
        <el-card shadow="never" class="main">
          <div class="toolbar"><el-input v-model="query" clearable placeholder="搜索标题、URL、目录路径" style="max-width:420px"/>
            <el-select v-model="folderId" filterable style="width:300px" placeholder="选择目录"><el-option label="全部目录" value=""/><el-option v-for="f in folders" :key="f.id" :value="f.id" :label="`${f.path ? f.path + ' / ' : ''}${f.title}`"/></el-select>
          </div>
          <el-alert v-if="store.error" :title="store.error" type="error" show-icon :closable="false"/>
          <el-table :data="store.rows" v-loading="store.loading" stripe height="min(60vh,650px)" row-key="id">
            <el-table-column label="标题" min-width="240"><template #default="{row}"><span class="kind">{{ row.kind === 'folder' ? '📁' : '🔖' }}</span>{{ row.title || '(无标题)' }}</template></el-table-column>
            <el-table-column prop="path" label="目录路径" min-width="220" show-overflow-tooltip/>
            <el-table-column label="URL" min-width="300" show-overflow-tooltip><template #default="{row}"><a v-if="row.url && /^https?:\/\//i.test(row.url)" :href="row.url" target="_blank" rel="noopener noreferrer">{{ row.url }}</a><span v-else>{{ row.url || '—' }}</span></template></el-table-column>
            <el-table-column label="添加时间" width="175"><template #default="{row}">{{ row.dateAdded ? new Date(row.dateAdded).toLocaleString() : '—' }}</template></el-table-column>
          </el-table>
          <div class="footer"><span>共 {{ store.total }} 条（每页 200 条）</span><el-pagination v-model:current-page="page" :page-size="200" layout="prev, pager, next" :total="store.total"/></div>
        </el-card>
        <p class="notice">导入 JSON 备份是受控操作：仅在批准后才写入浏览器。删除操作会要求二次确认。所有写入由 OperationExecutor 统一执行并产生审计日志。</p>
      </el-tab-pane>
      <el-tab-pane label="链接健康" name="health">
        <HealthView />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>
<style scoped>
:global(body){margin:0;background:#f5f7fb;color:#263044;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.shell{max-width:1500px;margin:auto;padding:28px}header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}h1{font-size:25px;margin:0 0 5px}header p{margin:0;color:#8490a3}.actions{display:flex;gap:8px}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:20px}.number{font-size:32px;font-weight:700;margin-bottom:8px}.date{font-size:19px;font-weight:600;margin:9px 0 12px}.stats span{color:#8490a3}.toolbar{display:flex;gap:12px;margin-bottom:18px}.kind{margin-right:8px}a{color:#2563eb;text-decoration:none}.footer{display:flex;align-items:center;justify-content:space-between;margin-top:16px;color:#8490a3}.notice{font-size:12px;color:#8490a3;margin-top:15px}@media(max-width:800px){.shell{padding:12px}header{align-items:start;gap:14px;flex-direction:column}.stats{grid-template-columns:1fr}.toolbar{flex-direction:column}}
</style>
