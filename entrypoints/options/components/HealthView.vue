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
  /**
   * Phase 3.6: the **original** URL the user asked us to scan. For
   * pre-v4 rows (and for some redirected rows where we have only
   * finalUrl) this is undefined; the UI falls back to finalUrl.
   * Crucial for the "unsupported" case: those rows never reach the
   * fetch client, so finalUrl is always missing — without `url`
   * the link cell would be unclickable.
   */
  url?: string;
  checkedAt: number;
  evidence: string[];
  syncGeneration?: number;
};

const status = ref<HealthStatusSummary | null>(null);
const rows = ref<HealthRow[]>([]);
const filter = ref<'all' | LinkStatus>('all');
const _selectedIds = ref<string[]>([]); // reserved for Phase 4 bulk-recheck

// Phase 3.5: per-extension setting. Defaults to false (dev guide
// § 0.1 SSRF defense). Toggling it on causes a re-scan to pick up
// localhost / 192.168.x.x / .local / .lan hosts.
const allowPrivate = ref(false);
async function loadSetting() {
  try { allowPrivate.value = await store.getSetting('allowPrivateHosts'); } catch { /* ignore */ }
}
async function onAllowPrivateChange(v: boolean) {
  allowPrivate.value = v;
  try {
    await store.setSetting('allowPrivateHosts', v);
    ElMessage.success(v ? '已开启内网扫描（注意 SSRF 风险）' : '已关闭内网扫描');
  } catch (e) { ElMessage.error(String(e)); }
}

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

onMounted(() => { void loadSetting(); void refresh(); });
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

    <!-- Phase 3.5: settings card. Off by default; enabling lets the
         user opt in to scanning localhost / 192.168.x.x / .local. The
         dev guide § 0.1 warns this is a SSRF surface; we surface that
         warning text in the help line. -->
    <el-card shadow="never" class="settings-card">
      <div class="settings-row">
        <div>
          <div class="settings-title">允许扫描内网地址</div>
          <div class="muted small">开启后会尝试 localhost、192.168.x.x、.local、.lan 等内网主机。<br>
            关闭状态下这些 URL 会被标为「不支持」并跳过。<br>
            <b>注意</b>：开启此选项意味着扩展会向你的内网发送请求（SSRF 风险）。</div>
        </div>
        <el-switch
          :model-value="allowPrivate"
          @update:model-value="onAllowPrivateChange"
          inline-prompt
          active-text="开"
          inactive-text="关"
        />
      </div>
    </el-card>

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
        <template #default="{ row }">{{ (row as HealthRow).httpCode || '—' }}</template>
      </el-table-column>
      <el-table-column label="URL" min-width="300" show-overflow-tooltip>
        <template #default="{ row }">
          <!--
            Phase 3.6: prefer the original URL the user bookmarked
            (so unsupported rows are clickable too). Fall back to
            finalUrl for pre-v4 rows. A plain <a target="_blank"
            rel="noopener noreferrer"> works for any http/https URL
            in an extension page; for chrome:// / file:// the user
            gets the browser's default behaviour (open in new tab
            for valid schemes; ignored otherwise).
          -->
          <a
            v-if="(row as HealthRow).url || (row as HealthRow).finalUrl"
            :href="(row as HealthRow).url || (row as HealthRow).finalUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="url-link"
          >{{ (row as HealthRow).url || (row as HealthRow).finalUrl }}</a>
          <span v-else class="muted">—</span>
          <!-- If the row was redirected, show a small hint that
               the finalUrl differs from the bookmarked URL. -->
          <span
            v-if="(row as HealthRow).url && (row as HealthRow).finalUrl
                 && (row as HealthRow).url !== (row as HealthRow).finalUrl"
            class="muted small redirect-hint"
          > → {{ (row as HealthRow).finalUrl }}</span>
        </template>
      </el-table-column>
      <el-table-column label="证据" min-width="200" show-overflow-tooltip>
        <template #default="{ row }">{{ (row as HealthRow).evidence.join(' · ') }}</template>
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
.url-link {
  color: #2563eb;
  text-decoration: none;
  word-break: break-all;
}
.url-link:hover { text-decoration: underline; }
.redirect-hint { margin-left: 6px; word-break: break-all; }
.small { font-size: 12px; }
.health-head { display: flex; align-items: flex-start; justify-content: space-between; }
.health-head h2 { margin: 0 0 6px; font-size: 18px; }
.health-head p { margin: 0; max-width: 600px; }
.actions { display: flex; gap: 8px; }
.status-row { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.settings-card { margin-bottom: 14px; }
.settings-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.settings-title { font-weight: 500; margin-bottom: 4px; }
.filters { margin-bottom: 14px; }
.notice { margin-top: 12px; }
</style>
