<script setup lang="ts">
// ImportFlow.vue — Phase 2 backup import wizard.
//
// User flow (3 steps, presented in modals):
//   1. Pick JSON file → preview shows diff summary + conflicts
//   2. Pick mode + click "Create Plan" → review step list
//   3. Click "Approve" then "Execute" → see succeeded/failed
//
// Each step is a separate modal; closing the wizard at any point
// abandons the in-progress plan (it stays in Dexie as 'draft' and
// can be inspected via the store / dev tools, but is not auto-run).

import { ref, computed, watch } from 'vue';
import { exportPlanBackup } from '../../../src/workspace-client';
import { downloadableJson } from '../workspace-helpers';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useBookmarkStore } from '../../../src/store';
import type {
  ImportPreview,
  OperationPlan,
  OperationStep,
  ApprovalToken,
  ExecuteResultMsg,
} from '../../../src/infrastructure/messaging/contracts';

const store = useBookmarkStore();

const open = ref(false);
const step = ref<'preview' | 'plan' | 'execute' | 'done'>('preview');
const loading = ref(false);

// Step 1: file selection + preview
const fileInput = ref<HTMLInputElement | null>(null);
const rawJson = ref<string>('');
const fileName = ref<string>('');
const mode = ref<'additive' | 'additive-with-meta' | 'controlled-merge'>('additive');
const preview = ref<ImportPreview | null>(null);
const previewError = ref('');

// Step 2: plan + steps
const plan = ref<(OperationPlan & { steps: OperationStep[] }) | null>(null);

// Step 3: approval + execution
const approval = ref<ApprovalToken | null>(null);
const backupDownloaded = ref(false);
const backupConfirmed = ref(false);
watch(plan,()=>{approval.value=null;backupDownloaded.value=false;backupConfirmed.value=false;},{deep:true});
async function downloadBackup() {
  if(!plan.value||loading.value)return;loading.value=true;
  try {const data=await exportPlanBackup(plan.value.id);const url=URL.createObjectURL(downloadableJson(data));const a=document.createElement('a');a.href=url;a.download=`bookmark-import-backup-${plan.value.id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);backupDownloaded.value=true;}
  catch(e){ElMessage.error('备份导出失败: '+(e instanceof Error?e.message:String(e)));}
  finally{loading.value=false;}
}
const executing = ref(false);
const result = ref<ExecuteResultMsg | null>(null);

function reset() {
  step.value = 'preview';
  loading.value = false;
  rawJson.value = '';
  fileName.value = '';
  preview.value = null;
  previewError.value = '';
  plan.value = null;
  approval.value = null;
  executing.value = false;
  result.value = null;
}

function openModal() {
  reset();
  open.value = true;
}

function closeModal() {
  open.value = false;
}

function pickFile() {
  fileInput.value?.click();
}

async function onFileChange(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 50 * 1024 * 1024) {
    ElMessage.error('文件超过 50 MB 上限');
    return;
  }
  fileName.value = file.name;
  rawJson.value = await file.text();
  await runPreview();
}

async function runPreview() {
  if (!rawJson.value) return;
  loading.value = true;
  previewError.value = '';
  preview.value = null;
  try {
    preview.value = await store.previewImport(rawJson.value, mode.value);
  } catch (e) {
    previewError.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function onModeChange() {
  if (rawJson.value) await runPreview();
}

const conflictsLabel = computed(() => {
  if (!preview.value) return '';
  return preview.value.conflicts.length === 0
    ? '无冲突'
    : `检测到 ${preview.value.conflicts.length} 个冲突（同 id 但内容不同，将跳过）`;
});

async function createPlan() {
  if (!rawJson.value) return;
  loading.value = true;
  try {
    const p = await store.draftPlan(rawJson.value, mode.value, `Import: ${fileName.value || 'backup'}`);
    plan.value = p;
    step.value = 'plan';
  } catch (e) {
    ElMessage.error('创建计划失败: ' + (e instanceof Error ? e.message : String(e)));
  } finally {
    loading.value = false;
  }
}

const highRiskCount = computed(() =>
  plan.value?.steps.filter((s) => s.riskLevel === 'high').length ?? 0,
);

async function approvePlan() {
  if (!plan.value || !backupDownloaded.value || !backupConfirmed.value || loading.value) return;
  if (highRiskCount.value > 0) {
    try {
      await ElMessageBox.confirm(
        `此计划包含 ${highRiskCount.value} 个高风险步骤（删除）。继续？`,
        '高风险操作',
        { confirmButtonText: '继续批准', cancelButtonText: '取消', type: 'warning' },
      );
    } catch {
      return; // user cancelled
    }
  }
  loading.value = true;
  try {
    approval.value = await store.approve(plan.value.id, 5 * 60_000);
    step.value = 'execute';
  } catch (e) {
    ElMessage.error('批准失败: ' + (e instanceof Error ? e.message : String(e)));
  } finally {
    loading.value = false;
  }
}

async function runExecute() {
  if (!plan.value || !approval.value) return;
  executing.value = true;
  try {
    const r = await store.execute(plan.value.id, approval.value.token, false);
    result.value = r;
    step.value = 'done';
    if (r.failed === 0) {
      ElMessage.success(`完成: ${r.succeeded} 步成功`);
    } else {
      ElMessage.warning(`部分完成: ${r.succeeded} 成功 / ${r.failed} 失败 / ${r.compensated} 已补偿`);
    }
    // Refresh the bookmark list so the UI reflects the new state.
    void store.load();
  } catch (e) {
    ElMessage.error('执行失败: ' + (e instanceof Error ? e.message : String(e)));
  } finally {
    executing.value = false;
  }
}

function back() {
  if (step.value === 'plan') step.value = 'preview';
  else if (step.value === 'execute') step.value = 'plan';
}

const actionLabel = (a: OperationStep['action']): string => {
  switch (a) {
    case 'create': return '新建';
    case 'rename': return '重命名';
    case 'update': return '更新';
    case 'move': return '移动';
    case 'delete': return '删除';
  }
};

defineExpose({ open: openModal });
</script>

<template>
  <span>
    <input
      ref="fileInput"
      type="file"
      accept="application/json,.json"
      style="display:none"
      @change="onFileChange"
    />
    <el-button @click="openModal">导入 JSON 备份</el-button>

    <el-dialog
      v-model="open"
      title="导入 JSON 备份"
      width="780"
      :close-on-click-modal="false"
      :show-close="!loading && !executing"
      :close-on-press-escape="!loading && !executing"
      append-to-body
      align-center
      @closed="reset"
    >
      <!-- Step 1: Preview -->
      <div v-if="step === 'preview'" class="step-pane">
        <p class="muted">选择一个导出的 JSON 备份文件，预览它对当前浏览器书签的影响。导入是只读预览；只有在你点击"批准并执行"后才会真正写入浏览器。</p>
        <div class="row">
          <el-button @click="pickFile" :loading="loading">{{ fileName ? '更换文件' : '选择文件' }}</el-button>
          <span v-if="fileName" class="file-name">{{ fileName }}</span>
        </div>
        <el-form label-width="80" class="mode-form">
          <el-form-item label="导入模式">
            <el-radio-group v-model="mode" @change="onModeChange">
              <el-radio-button value="additive">仅添加</el-radio-button>
              <el-radio-button value="additive-with-meta">添加 + 本地元数据</el-radio-button>
              <el-radio-button value="controlled-merge">受控合并</el-radio-button>
            </el-radio-group>
            <div class="mode-hint">
              <span v-if="mode === 'additive'">只创建当前不存在的节点；不会修改或删除任何现有书签。</span>
              <span v-else-if="mode === 'additive-with-meta'">同"仅添加"；本地索引中的元数据会与导入合并。</span>
              <span v-else>可更新同名节点；可删除导入中不存在的节点。删除前会要求再次确认。</span>
            </div>
          </el-form-item>
        </el-form>
        <el-alert v-if="previewError" :title="previewError" type="error" show-icon :closable="false" />
        <el-card v-if="preview" shadow="never" class="preview-card">
          <div class="preview-row">
            <div class="metric"><div class="num">{{ preview.summary.adds }}</div><span>添加</span></div>
            <div class="metric"><div class="num">{{ preview.summary.updates }}</div><span>更新</span></div>
            <div class="metric"><div class="num">{{ preview.summary.moves }}</div><span>移动</span></div>
            <div class="metric"><div class="num warn">{{ preview.summary.deletes }}</div><span>删除</span></div>
            <div class="metric"><div class="num">{{ preview.summary.noops }}</div><span>无变化</span></div>
          </div>
          <div class="preview-meta">
            <span>导入格式: v{{ preview.formatVersion }}</span>
            <span>导入节点数: {{ preview.totalNodes }}</span>
            <span :class="{ conflict: preview.conflicts.length > 0 }">{{ conflictsLabel }}</span>
          </div>
        </el-card>
      </div>

      <!-- Step 2: Plan review -->
      <div v-else-if="step === 'plan' && plan" class="step-pane">
        <el-card shadow="never" class="plan-card">
          <div class="plan-head">
            <div><b>{{ plan.title }}</b></div>
            <div class="muted">{{ plan.description }}</div>
            <div class="muted small">计划 id: {{ plan.id }} · 步骤: {{ plan.steps.length }}</div>
          </div>
          <el-table :data="plan.steps" max-height="380" stripe size="small">
            <el-table-column prop="order" label="#" width="60" />
            <el-table-column label="操作" width="100">
              <template #default="{ row }">
                <el-tag :type="row.riskLevel === 'high' ? 'danger' : 'info'" size="small">{{ actionLabel(row.action) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="目标" min-width="200">
              <template #default="{ row }">{{ row.targetBrowserId || row.parentBrowserId || '—' }}</template>
            </el-table-column>
            <el-table-column label="预期 → 期望" min-width="240" show-overflow-tooltip>
              <template #default="{ row }">
                <span class="muted small">{{ JSON.stringify(row.expectedBefore) }}</span>
                <span class="arrow">→</span>
                <span class="small">{{ JSON.stringify(row.desiredAfter) }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="reason" label="原因" min-width="180" show-overflow-tooltip />
          </el-table>
          <el-alert
            v-if="highRiskCount > 0"
            type="warning"
            show-icon
            :closable="false"
            :title="`包含 ${highRiskCount} 个高风险步骤（删除）。点击批准时会要求再次确认。`"
          />
        </el-card>
        <div class="backup-review"><el-button :loading="loading" @click="downloadBackup">导出此计划的恢复备份</el-button><el-checkbox v-model="backupConfirmed" :disabled="!backupDownloaded || loading">我已保存备份，并核对以上所有更改</el-checkbox></div>
      </div>

      <!-- Step 3: Approve + execute -->
      <div v-else-if="step === 'execute' && plan" class="step-pane">
        <p class="muted">点击"执行"会立即按上面的步骤操作浏览器书签。批准令牌（一次性，5 分钟内有效）已签发。如不希望执行可关闭此对话框。</p>
        <el-card shadow="never" class="exec-card">
          <div>已批准当前计划，执行权限一次性有效。</div>
          <div><b>过期时间</b>: {{ approval ? new Date(approval.expiresAt).toLocaleString() : '—' }}</div>
          <div><b>计划</b>: {{ plan.id }}</div>
        </el-card>
      </div>

      <!-- Step 4: Done -->
      <div v-else-if="step === 'done' && result" class="step-pane">
        <el-result
          :icon="result.failed === 0 ? 'success' : 'warning'"
          :title="result.status"
          :sub-title="`${result.succeeded} 成功 / ${result.failed} 失败 / ${result.compensated} 已补偿`"
        />
      </div>

      <template #footer>
        <div class="footer">
          <el-button v-if="step === 'plan' || step === 'execute'" @click="back" :disabled="loading || executing">上一步</el-button>
          <el-button v-if="step === 'preview'" :disabled="!rawJson" @click="runPreview" :loading="loading">刷新预览</el-button>
          <el-button v-if="step === 'preview'" :disabled="!preview" type="primary" @click="createPlan" :loading="loading">创建计划</el-button>
          <el-button v-if="step === 'plan'" :disabled="!backupDownloaded || !backupConfirmed" type="primary" @click="approvePlan" :loading="loading">批准</el-button>
          <el-button v-if="step === 'execute'" type="primary" @click="runExecute" :loading="executing">执行</el-button>
          <el-button v-if="step === 'done'" @click="closeModal">关闭</el-button>
        </div>
      </template>
    </el-dialog>
  </span>
</template>

<style scoped>
.backup-review { display:flex; flex-direction:column; gap:12px; align-items:flex-start; margin-top:16px; }
.muted { color: #8490a3; }
.small { font-size: 12px; }
.row { display: flex; align-items: center; gap: 12px; margin: 12px 0; }
.file-name { color: #263044; font-weight: 500; }
.mode-form { margin-top: 16px; }
.mode-hint { font-size: 12px; color: #8490a3; margin-top: 6px; }
.preview-card { margin-top: 16px; }
.preview-row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; }
.metric { text-align: center; padding: 12px; background: #f5f7fb; border-radius: 6px; }
.metric .num { font-size: 28px; font-weight: 700; color: #2563eb; }
.metric .num.warn { color: #ef4444; }
.metric span { color: #8490a3; font-size: 12px; }
.preview-meta { display: flex; gap: 16px; margin-top: 14px; font-size: 13px; color: #8490a3; }
.preview-meta .conflict { color: #ef4444; font-weight: 500; }
.plan-head { padding: 4px 0 16px; }
.arrow { color: #8490a3; margin: 0 6px; }
.exec-card { padding: 12px; }
.footer { display: flex; justify-content: flex-end; gap: 8px; }
code { background: #f5f7fb; padding: 2px 6px; border-radius: 4px; }
</style>
