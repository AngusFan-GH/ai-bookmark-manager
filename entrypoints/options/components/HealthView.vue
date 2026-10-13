<script setup lang="ts">
// HealthView.vue — link health report UI.
//
// Displays the most recent check per bookmark (from the linkChecks
// store), grouped by LinkStatus, with simple filters. Lets the user
// trigger a scan of all bookmarks or a subset.

import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { useBookmarkStore } from '../../../src/store';
import type { LinkStatus } from '../../../src/domain/health/types';
import type { HealthStatusSummary } from '../../../src/infrastructure/messaging/contracts';

const store = useBookmarkStore();

const loading = ref(false);
type HealthRow = {
  bookmarkId: string;
  status: LinkStatus;
  httpCode?: number;
  finalUrl?: string;
  checkedAt: number;
  evidence: string[];
  syncGeneration?: number;
};

const status = ref<HealthStatusSummary | null>(null);
const rows = ref<HealthRow[]>([]);
const filter = ref<'all' | LinkStatus>('all');
const _selectedIds = ref<string[]>([]); // reserved for Phase 4 bulk-recheck

const statusLabels: Record<LinkStatus, string> = {
  unchecked: '未检测',
  checking: '检测中',
  healthy: '健康',
  redirected: '已重定向',
  auth_required: '需登录',
  forbidden: '已禁止',
  rate_limited: '限流',
  suspected_dead: '疑似失效',
  confirmed_dead: '已确认失效',
  network_error: '网络错误',
  unsupported: '不支持',
  permission_required: '需要权限',
};

const statusColors: Record<LinkStatus, string> = {
  unchecked: 'info',
  checking: 'warning',
  healthy: 'success',
  redirected: 'success',
  auth_required: 'warning',
  forbidden: 'warning',
  rate_limited: 'warning',
  suspected_dead: 'danger',
  confirmed_dead: 'danger',
  network_error: 'danger',
  unsupported: 'info',
  permission_required: 'info',
};

const visible = computed<HealthRow[]>(() => {
  if (filter.value === 'all') return rows.value;
  return rows.value.filter((r) => r.status === filter.value);
});

const counts = computed(() => {
  const map: Record<string, number> = { all: rows.value.length };
  for (const r of rows.value) map[r.status] = (map[r.status] ?? 0) + 1;
  return map;
});

async function refresh() {
  loading.value = true;
  try {
    const s = await store.healthStatus();
    status.value = s;
    const list = await store.healthList();
    rows.value = (list.rows ?? []) as HealthRow[];
  } catch (e) {
    ElMessage.error(String(e));
  } finally {
    loading.value = false;
  }
}

async function startScan() {
  loading.value = true;
  try {
    const r = await store.startHealth();
    ElMessage.success(`已入队: ${r.enqueued}（跳过: ${r.skipped}）`);
    await refresh();
  } catch (e) {
    ElMessage.error(String(e));
  } finally {
    loading.value = false;
  }
}

async function cancelScan() {
  try {
    await store.cancelHealth();
    ElMessage.info('已取消');
    await refresh();
  } catch (e) { ElMessage.error(String(e)); }
}

onMounted(refresh);
</script>

<template>
  <el-card shadow="never" class="health-card">
    <template #header>
      <div class="health-head">
        <div>
          <h2>链接健康</h2>
          <p class="muted">扫描书签的 URL，统计失效 / 限流 / 需登录 / 不可达等状态。检测结果仅供参考，不会删除任何书签。</p>
        </div>
        <div class="actions">
          <el-button :loading="loading" @click="refresh">刷新</el-button>
          <el-button :loading="loading" type="primary" @click="startScan">开始扫描</el-button>
          <el-button :disabled="!status || status.status !== 'running'" @click="cancelScan">取消</el-button>
        </div>
      </div>
    </template>

    <div v-if="status" class="status-row">
      <el-tag :type="status.status === 'running' ? 'warning' : 'info'" size="small">
        状态: {{ status.status }}
      </el-tag>
      <span class="muted small">已处理 {{ status.processed }} / {{ status.total }} · 队列 {{ status.queued }} · 进行中 {{ status.inflight }}</span>
    </div>

    <div class="filters">
      <el-radio-group v-model="filter" size="small">
        <el-radio-button value="all">全部 ({{ counts.all ?? 0 }})</el-radio-button>
        <el-radio-button value="healthy">健康 ({{ counts.healthy ?? 0 }})</el-radio-button>
        <el-radio-button value="redirected">重定向 ({{ counts.redirected ?? 0 }})</el-radio-button>
        <el-radio-button value="auth_required">需登录 ({{ counts.auth_required ?? 0 }})</el-radio-button>
        <el-radio-button value="forbidden">禁止 ({{ counts.forbidden ?? 0 }})</el-radio-button>
        <el-radio-button value="rate_limited">限流 ({{ counts.rate_limited ?? 0 }})</el-radio-button>
        <el-radio-button value="suspected_dead">疑似失效 ({{ counts.suspected_dead ?? 0 }})</el-radio-button>
        <el-radio-button value="confirmed_dead">确认失效 ({{ counts.confirmed_dead ?? 0 }})</el-radio-button>
        <el-radio-button value="network_error">网络错误 ({{ counts.network_error ?? 0 }})</el-radio-button>
        <el-radio-button value="unsupported">不支持 ({{ counts.unsupported ?? 0 }})</el-radio-button>
      </el-radio-group>
    </div>

    <el-table :data="visible" v-loading="loading" stripe max-height="500" empty-text="尚无检测结果 — 点击「开始扫描」">
      <el-table-column label="状态" width="140">
        <template #default="{ row }">
          <el-tag :type="statusColors[(row as HealthRow).status] || 'info'" size="small">{{ statusLabels[(row as HealthRow).status] || (row as HealthRow).status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="bookmarkId" label="书签 ID" width="200" show-overflow-tooltip />
      <el-table-column label="HTTP" width="80">
        <template #default="{ row }">{{ row.httpCode || '—' }}</template>
      </el-table-column>
      <el-table-column prop="finalUrl" label="最终 URL" min-width="280" show-overflow-tooltip />
      <el-table-column label="证据" min-width="200" show-overflow-tooltip>
        <template #default="{ row }">{{ row.evidence.join(' · ') }}</template>
      </el-table-column>
      <el-table-column label="检测时间" width="170">
        <template #default="{ row }">{{ new Date(row.checkedAt).toLocaleString() }}</template>
      </el-table-column>
    </el-table>

    <p class="muted small notice">
      注意：链接检测是只读的；任何状态都不会触发删除。即便检测到"失效"或网络错误，
      也只是标记，并等你人工决定。429 等限流状态会按服务器的 Retry-After 头自动避开。
    </p>
  </el-card>
</template>

<style scoped>
.muted { color: #8490a3; }
.small { font-size: 12px; }
.health-head { display: flex; align-items: flex-start; justify-content: space-between; }
.health-head h2 { margin: 0 0 6px; font-size: 18px; }
.health-head p { margin: 0; max-width: 600px; }
.actions { display: flex; gap: 8px; }
.status-row { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.filters { margin-bottom: 14px; }
.notice { margin-top: 12px; }
</style>
