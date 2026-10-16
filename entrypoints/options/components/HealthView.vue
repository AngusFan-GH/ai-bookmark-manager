<script setup lang="ts">
// HealthView.vue — link health report UI.
//
// Displays the most recent check per bookmark (from the linkChecks
// store), grouped by LinkStatus, with simple filters. Lets the user
// trigger a scan of all bookmarks or a subset.

import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useToolsBookmarkStore } from '../../../src/store';
import { request } from '../../../src/client';
import type { BookmarkRecord } from '../../../src/domain/bookmarks/types';
import { safeBookmarkHref } from '../workspace-helpers';
import { confirmedRemovalRecords, healthEmptyText } from './tools-helpers';
import type { LinkStatus } from '../../../src/domain/health/types';
import type { HealthStatusSummary } from '../../../src/infrastructure/messaging/contracts';

const store = useToolsBookmarkStore();
const emit = defineEmits<{ updated: [rows: HealthRow[]]; 'preview-delete': [records: BookmarkRecord[]] }>();

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
const selectedIds = ref<string[]>([]);
const resultTable = ref<{clearSelection(): void}>();
watch(filter, () => { selectedIds.value = []; resultTable.value?.clearSelection(); });
const bookmarks = ref<BookmarkRecord[]>([]);
const error = ref('');
const settingBusy = ref(false);
let refreshing = false;
let disposed = false;
const bookmarkMap = computed(() => new Map(bookmarks.value.map(row => [row.id, row])));
const removalRecords = computed(() => confirmedRemovalRecords(selectedIds.value, rows.value, bookmarks.value));
async function loadBookmarks() {
  const all: BookmarkRecord[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await request<{rows: BookmarkRecord[]; total: number}>({type:'BOOKMARKS_LIST',requestId:crypto.randomUUID(),limit:200,offset});
    all.push(...page.rows);
    if (all.length >= page.total || !page.rows.length) break;
  }
  bookmarks.value = all;
}
async function previewRemoval() {
  if (loading.value || refreshing) return;
  const selected = [...selectedIds.value];
  await refresh();
  if (error.value) return;
  const records = confirmedRemovalRecords(selected, rows.value, bookmarks.value);
  if (!records.length) { ElMessage.warning('所选条目已变化，或尚未确认失效。请重新检查后再选择。'); return; }
  emit('preview-delete', records);
}
let pollTimer: ReturnType<typeof setInterval> | null = null;

// Phase 3.5: per-extension setting. Defaults to false (dev guide
// § 0.1 SSRF defense). Toggling it on causes a re-scan to pick up
// localhost / 192.168.x.x / .local / .lan hosts.
const allowPrivate = ref(false);
const hostPermissionGranted = ref(false);
async function loadSetting() {
  try { allowPrivate.value = await store.getSetting('allowPrivateHosts'); } catch { /* ignore */ }
}
async function loadHostPermission() {
  try { hostPermissionGranted.value = (await store.healthPermissionStatus()).granted; } catch { /* ignore */ }
}
async function requestHostPermission() {
  try {
    hostPermissionGranted.value = (await store.requestHealthPermission()).granted;
    ElMessage[hostPermissionGranted.value ? 'success' : 'warning'](
      hostPermissionGranted.value ? '已授权扫描网站链接' : '未授予网站访问权限',
    );
  } catch (e) { ElMessage.error(String(e)); }
}
async function removeHostPermission() {
  try {
    await store.removeHealthPermission();
    hostPermissionGranted.value = false;
    ElMessage.info('已撤销网站扫描权限');
  } catch (e) { ElMessage.error(String(e)); }
}
async function onAllowPrivateChange(v: boolean) {
  if (settingBusy.value) return;
  const previous = allowPrivate.value;
  settingBusy.value = true;
  allowPrivate.value = v;
  try {
    await store.setSetting('allowPrivateHosts', v);
    ElMessage.success(v ? '已开启内网扫描（注意 SSRF 风险）' : '已关闭内网扫描');
  } catch (e) { allowPrivate.value = previous; ElMessage.error(String(e)); }
  finally { settingBusy.value = false; }
}

const statusLabels: Record<LinkStatus, string> = {
  unchecked: '未检测',
  checking: '检测中',
  outdated: '结果已过期',
  healthy: '健康',
  redirected: '已重定向',
  redirect_pending: '跳转待确认',
  auth_required: '需登录',
  forbidden: '访问受限',
  rate_limited: '限流',
  suspected_dead: '疑似失效',
  confirmed_dead: '已确认失效',
  network_error: '暂时不可验证',
  unsupported: '安全策略跳过',
  permission_required: '需要权限',
};

const statusColors: Record<LinkStatus, string> = {
  unchecked: 'info',
  checking: 'warning',
  outdated: 'info',
  healthy: 'success',
  redirected: 'success',
  redirect_pending: 'warning',
  auth_required: 'warning',
  forbidden: 'warning',
  rate_limited: 'warning',
  suspected_dead: 'warning',
  confirmed_dead: 'danger',
  network_error: 'warning',
  unsupported: 'info',
  permission_required: 'info',
};

const visible = computed<HealthRow[]>(() => {
  if (filter.value === 'all') return rows.value;
  return rows.value.filter((r) => r.status === filter.value);
});

const isRunning = computed(() => status.value?.status === 'running');
const isPaused = computed(() => status.value?.status === 'paused');
const progressPercent = computed(() => {
  if (!status.value?.total) return 0;
  return Math.min(100, Math.round(((status.value.processed + status.value.cancelled) / status.value.total) * 100));
});
const statusText = computed(() => ({
  running: '正在检查', paused: '已暂停', completed: '检查完成', cancelled: '已取消', failed: '检查失败', idle: '尚未开始',
}[status.value?.status ?? 'idle']));
const nextRetryText = computed(() => status.value?.nextEligibleAt
  ? `部分链接受限，将在 ${new Date(status.value.nextEligibleAt).toLocaleTimeString()} 自动继续`
  : '');
function statusDescription(row: HealthRow): string {
  const evidence = row.evidence.join('；');
  if (row.status === 'permission_required') return '未向该网站发出请求。先授权网站扫描权限，再重新检查。';
  if (row.status === 'unchecked') return '尚未检查。授权后点击“开始检查”。';
  if (row.status === 'outdated') return '书签地址或同步版本已变化；旧结果不会作为当前结果使用。';
  if (row.status === 'redirect_pending') return '检测到跳转。为避免自动访问未知目标，扩展没有跟随；请在浏览器中打开确认。';
  if (row.status === 'unsupported') return evidence || '为保护本机和内网，未检查这个地址。';
  if (row.status === 'network_error') return evidence || '暂时无法连接；不代表链接已经失效。';
  if (row.status === 'rate_limited') return evidence || '网站暂时限制请求，稍后可再次检查。';
  if (row.status === 'suspected_dead') return '首次返回 404 或 410，建议人工确认后再处理。';
  if (row.status === 'confirmed_dead') return '多次检查后仍返回 404 或 410；不会自动删除书签。';
  return evidence || '检查已完成。';
}
function formatCheckedAt(row: HealthRow): string {
  return row.checkedAt > 0 ? new Date(row.checkedAt).toLocaleString() : '未检测';
}

const counts = computed(() => {
  const map: Record<string, number> = { all: rows.value.length };
  for (const r of rows.value) map[r.status] = (map[r.status] ?? 0) + 1;
  return map;
});

async function refresh(showLoading = true) {
  if (refreshing || disposed) return;
  refreshing = true;
  if (showLoading) loading.value = true;
  try {
    if (showLoading) await loadBookmarks();
    const s = await store.healthStatus();
    status.value = s;
    const list = await store.healthList();
    rows.value = ((list.rows ?? []) as HealthRow[]).sort((a, b) => b.checkedAt - a.checkedAt);
    emit('updated', rows.value);
    error.value = '';
    selectedIds.value = selectedIds.value.filter(id => rows.value.some(row => row.bookmarkId === id));
  } catch (e) {
    error.value = '无法刷新检测结果，请点击刷新重试。' + (e instanceof Error ? e.message : String(e));
  } finally {
    refreshing = false;
    if (showLoading) loading.value = false;
  }
}

async function startScan(ids?: string[]) {
  if (loading.value || isRunning.value || isPaused.value) return;
  if (!hostPermissionGranted.value) {
    ElMessage.warning('请先授权网站扫描权限；未授权时不会向任何外部链接发出请求。');
    return;
  }
  loading.value = true;
  try {
    const r = await store.startHealth(ids);
    ElMessage.success(`已入队: ${r.enqueued}（跳过: ${r.skipped}）`);
    await refresh();
  } catch (e) {
    ElMessage.error(String(e));
  } finally {
    loading.value = false;
  }
}

async function pauseOrResume() {
  try {
    if (isRunning.value) await store.pauseHealth();
    else if (isPaused.value) await store.resumeHealth();
    await refresh(false);
  } catch (e) { ElMessage.error(String(e)); }
}

async function cancelScan() {
  try {
    await store.cancelHealth();
    ElMessage.info('已取消');
    await refresh();
  } catch (e) { ElMessage.error(String(e)); }
}

onMounted(() => {
  void loadSetting();
  void loadHostPermission();
  void refresh();
  pollTimer = setInterval(() => {
    if (status.value?.status === 'running' || status.value?.status === 'paused') void refresh(false);
  }, 1_000);
});
onBeforeUnmount(() => { disposed = true; if (pollTimer) clearInterval(pollTimer); });
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
          <el-button :loading="loading" @click="() => refresh()">刷新</el-button>
          <el-button v-if="!hostPermissionGranted" type="warning" @click="requestHostPermission">授权扫描网站</el-button>
          <el-button v-else @click="removeHostPermission">撤销扫描权限</el-button>
          <el-button :loading="loading" :disabled="!hostPermissionGranted || isRunning || isPaused" type="primary" @click="startScan()">检查全部书签</el-button>
          <el-button :disabled="!isRunning && !isPaused" @click="pauseOrResume">{{ isRunning ? '暂停' : '继续' }}</el-button>
          <el-button :disabled="!isRunning && !isPaused" type="danger" plain @click="cancelScan">取消</el-button>
        </div>
      </div>
    </template>

    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <section v-if="status" class="progress-panel" aria-live="polite">
      <div class="progress-heading">
        <div>
          <el-tag :type="isRunning ? 'warning' : status.status === 'completed' ? 'success' : 'info'" effect="light">{{ statusText }}</el-tag>
          <strong>{{ status.processed + status.cancelled }} / {{ status.total }}</strong>
          <span class="muted small">已结算</span>
        </div>
        <span class="muted small">{{ progressPercent }}%</span>
      </div>
      <el-progress :percentage="progressPercent" :status="status.status === 'completed' ? 'success' : undefined" :stroke-width="10" />
      <div class="progress-stats">
        <span>已完成 {{ status.processed }}</span><span>检查中 {{ status.inflight }}</span><span>等待 {{ status.queued }}</span><span v-if="status.cancelled">已取消 {{ status.cancelled }}</span>
      </div>
      <p v-if="status.active.length" class="active-links"><b>正在检查：</b><span v-for="item in status.active" :key="item.bookmarkId">{{ item.url }}</span></p>
      <p v-if="nextRetryText" class="muted small">{{ nextRetryText }}</p>
      <el-alert v-if="status.lastError" :title="`检查异常：${status.lastError}`" type="error" :closable="false" show-icon />
    </section>
    <el-alert
      v-if="!hostPermissionGranted"
      title="扫描外部链接前需要你的授权；未授权的书签会标记为“需要权限”，不会被当作失效链接。"
      type="info"
      :closable="false"
      show-icon
      class="permission-notice"
    />

    <!-- Phase 3.5: settings card. Off by default; enabling lets the
         user opt in to scanning localhost / 192.168.x.x / .local. The
         dev guide § 0.1 warns this is a SSRF surface; we surface that
         warning text in the help line. -->
    <el-card shadow="never" class="settings-card">
      <div class="settings-row">
        <div>
          <div class="settings-title">允许扫描内网地址</div>
          <div class="muted small">开启后会尝试 localhost、192.168.x.x、.local、.lan 等内网主机。<br>
            关闭状态下这些 URL 会被标为「安全策略跳过」。<br>
            <b>注意</b>：开启此选项意味着扩展会向你的内网发送请求（SSRF 风险）。</div>
        </div>
        <el-switch
          :model-value="allowPrivate"
          :disabled="settingBusy || isRunning || isPaused"
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
        <el-radio-button value="unchecked">未检测 ({{ counts.unchecked ?? 0 }})</el-radio-button>
        <el-radio-button value="healthy">健康 ({{ counts.healthy ?? 0 }})</el-radio-button>
        <el-radio-button value="redirected">重定向 ({{ counts.redirected ?? 0 }})</el-radio-button>
        <el-radio-button value="redirect_pending">跳转待确认 ({{ counts.redirect_pending ?? 0 }})</el-radio-button>
        <el-radio-button value="auth_required">需登录 ({{ counts.auth_required ?? 0 }})</el-radio-button>
        <el-radio-button value="forbidden">访问受限 ({{ counts.forbidden ?? 0 }})</el-radio-button>
        <el-radio-button value="rate_limited">限流 ({{ counts.rate_limited ?? 0 }})</el-radio-button>
        <el-radio-button value="suspected_dead">疑似失效 ({{ counts.suspected_dead ?? 0 }})</el-radio-button>
        <el-radio-button value="confirmed_dead">确认失效 ({{ counts.confirmed_dead ?? 0 }})</el-radio-button>
        <el-radio-button value="network_error">暂不可验证 ({{ counts.network_error ?? 0 }})</el-radio-button>
        <el-radio-button value="unsupported">安全跳过 ({{ counts.unsupported ?? 0 }})</el-radio-button>
        <el-radio-button value="permission_required">需授权 ({{ counts.permission_required ?? 0 }})</el-radio-button>
        <el-radio-button value="outdated">已过期 ({{ counts.outdated ?? 0 }})</el-radio-button>
      </el-radio-group>
    </div>

    <div class="selection-actions"><span>已选择 {{selectedIds.length}} 条</span><el-button :disabled="!selectedIds.length || loading || isRunning || isPaused || !hostPermissionGranted" @click="startScan([...selectedIds])">重新检查所选</el-button><el-button type="danger" plain :disabled="!removalRecords.length || loading || isRunning || isPaused" @click="previewRemoval">预览删除所选已确认失效书签（{{removalRecords.length}}）</el-button></div>
    <p class="muted small">仅“已确认失效”的所选条目可以进入删除预览，仍会自动备份并要求逐项批准。疑似失效、需登录及网络错误不会被纳入删除。</p>
    <el-table ref="resultTable" :data="visible" row-key="bookmarkId" @selection-change="(items: HealthRow[]) => selectedIds = items.map(row => row.bookmarkId)" v-loading="loading" stripe max-height="500" :empty-text="healthEmptyText(rows.length, filter)">
      <el-table-column type="selection" :reserve-selection="true" width="45" />
      <el-table-column label="状态" width="140">
        <template #default="{ row }">
          <el-tag :type="statusColors[(row as HealthRow).status] || 'info'" size="small">{{ statusLabels[(row as HealthRow).status] || (row as HealthRow).status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="书签 / 目录" min-width="220"><template #default="{row}"><strong>{{bookmarkMap.get(row.bookmarkId)?.title || '未命名书签'}}</strong><div class="muted small">{{bookmarkMap.get(row.bookmarkId)?.path || '目录信息暂不可用'}}</div></template></el-table-column>
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
            v-if="safeBookmarkHref((row as HealthRow).url || (row as HealthRow).finalUrl)"
            :href="(row as HealthRow).url || (row as HealthRow).finalUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="url-link"
          >{{ (row as HealthRow).url || (row as HealthRow).finalUrl }}</a>
          <span v-else class="muted">{{(row as HealthRow).url || (row as HealthRow).finalUrl || '—'}}</span>
          <!-- If the row was redirected, show a small hint that
               the finalUrl differs from the bookmarked URL. -->
          <span
            v-if="(row as HealthRow).url && (row as HealthRow).finalUrl
                 && (row as HealthRow).url !== (row as HealthRow).finalUrl"
            class="muted small redirect-hint"
          > → {{ (row as HealthRow).finalUrl }}</span>
        </template>
      </el-table-column>
      <el-table-column label="检查说明" min-width="240" show-overflow-tooltip>
        <template #default="{ row }">{{ statusDescription(row as HealthRow) }}</template>
      </el-table-column>
      <el-table-column label="检测时间" width="170">
        <template #default="{ row }">{{ formatCheckedAt(row as HealthRow) }}</template>
      </el-table-column>
    </el-table>

    <p class="muted small notice">
      注意：链接检测是只读的；任何状态都不会触发删除。即便检测到"失效"或网络错误，
      也只是标记，并等你人工决定。429 等限流状态会按服务器的 Retry-After 头自动避开。
    </p>
  </el-card>
</template>

<style scoped>
.selection-actions { display:flex; align-items:center; flex-wrap:wrap; gap:10px; margin:12px 0; }
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
.actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.progress-panel { margin-bottom: 16px; padding: 16px; border: 1px solid var(--el-border-color-light); border-radius: 8px; background: var(--el-fill-color-lighter); }
.progress-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.progress-heading > div { display: flex; align-items: center; gap: 8px; }
.progress-stats { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-top: 10px; font-size: 13px; color: #475569; }
.active-links { display: grid; gap: 4px; margin: 12px 0 0; font-size: 12px; color: #475569; word-break: break-all; }
.active-links span { padding-left: 8px; border-left: 2px solid var(--el-color-warning); }
.permission-notice { margin-bottom: 14px; }
.settings-card { margin-bottom: 14px; }
.settings-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.settings-title { font-weight: 500; margin-bottom: 4px; }
.filters { margin-bottom: 14px; }
.notice { margin-top: 12px; }
@media (max-width: 760px) {
  .health-head { flex-direction: column; gap: 14px; }
  .actions { justify-content: flex-start; }
}
</style>
