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
import { downloadableJson, describePlanStep, planStatusLabel, stepStatusLabel, stepErrorLabel } from '../workspace-helpers';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useToolsBookmarkStore } from '../../../src/store';
import type {
  ImportPreview,
  OperationPlan,
  OperationStep,
  ApprovalToken,
  ExecuteResultMsg,
} from '../../../src/infrastructure/messaging/contracts';

const store = useToolsBookmarkStore();

const open = ref(false);
const step = ref<'preview' | 'plan' | 'execute' | 'done'>('preview');
const loading = ref(false);

// Step 1: file selection + preview
const fileInput = ref<HTMLInputElement | null>(null);
const rawJson = ref<string>('');
const fileName = ref<string>('');
const mode = ref<'additive' | 'controlled-merge'>('additive');
const advanced = ref(false);
const deleteConfirmation = ref('');
const actionError = ref('');
let previewVersion = 0;
const planCards = computed(() => (plan.value?.steps ?? []).map(step => ({ step, view: describePlanStep(step, plan.value?.steps ?? [], store.folders, store.rows) })));
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
  previewVersion++;
  if (fileInput.value) fileInput.value.value = '';
  mode.value = 'additive';
  advanced.value = false;
  deleteConfirmation.value = '';
  actionError.value = '';
  backupDownloaded.value = false;
  backupConfirmed.value = false;
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
  void store.load();
}

function closeModal() {
  open.value = false;
}

function pickFile() {
  if (fileInput.value) fileInput.value.value = '';
  fileInput.value?.click();
}

async function onFileChange(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  previewVersion++;
  preview.value = null; rawJson.value = ''; previewError.value = ''; fileName.value = file.name;
  if (file.size > 50 * 1024 * 1024) { previewError.value = '文件超过 50 MB 上限，请选择较小的备份文件。'; return; }
  loading.value = true;
  try { rawJson.value = await file.text(); }
  catch { previewError.value = '无法读取文件，请重新选择本机上的 JSON 备份。'; }
  finally { loading.value = false; }
  if (rawJson.value) await runPreview();
}

async function runPreview() {
  if (!rawJson.value) return;
  const version = ++previewVersion;
  loading.value = true; previewError.value = ''; preview.value = null;
  try {
    const next = await store.previewImport(rawJson.value, mode.value);
    if (version === previewVersion) preview.value = next;
  } catch (e) {
    if (version === previewVersion) previewError.value = e instanceof Error ? e.message : String(e);
  } finally { if (version === previewVersion) loading.value = false; }
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
  if (!rawJson.value || loading.value) return;
  loading.value = true; actionError.value = ''; deleteConfirmation.value = '';
  try {
    const p = await store.draftPlan(rawJson.value, mode.value, `Import: ${fileName.value || 'backup'}`);
    plan.value = p;
    step.value = 'plan';
  } catch (e) {
    actionError.value = '创建计划失败：' + (e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

const highRiskCount = computed(() =>
  plan.value?.steps.filter((s) => s.riskLevel === 'high').length ?? 0,
);

async function approvePlan() {
  if (!plan.value || !backupConfirmed.value || loading.value || (highRiskCount.value > 0 && deleteConfirmation.value !== '删除')) return;
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
    actionError.value = '批准未完成，请重新生成计划并审核：' + (e instanceof Error ? e.message : String(e));
  } finally {
    loading.value = false;
  }
}

async function runExecute() {
  if (!plan.value || !approval.value || executing.value) return;
  if (Date.now() >= approval.value.expiresAt) { actionError.value = '批准已过期。请重新生成计划，并再次审核。'; return; }
  actionError.value = '';
  executing.value = true;
  try {
    const r = await store.execute(plan.value.id, approval.value.token, false);
    result.value = r;
    step.value = 'done';
    try { plan.value = await store.getPlan(plan.value.id); } catch { actionError.value = '执行结果已返回，但步骤详情暂未加载。可关闭后在操作历史查看。'; }
    if (r.failed === 0) {
      ElMessage.success(`完成: ${r.succeeded} 步成功`);
    } else {
      ElMessage.warning(`部分完成: ${r.succeeded} 成功 / ${r.failed} 失败 / ${r.compensated} 已补偿`);
    }
    // Refresh the bookmark list so the UI reflects the new state.
    void store.load();
  } catch (e) {
    actionError.value = '执行未完成。请先到操作历史核对结果；需要重试时重新生成并审核计划。' + (e instanceof Error ? e.message : String(e));
    approval.value = null;
  } finally {
    executing.value = false;
  }
}

function back() {
  if (step.value === 'plan') step.value = 'preview';
  else if (step.value === 'execute') { approval.value = null; void createPlan(); }
}

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
      width="min(880px,94vw)"
      :close-on-click-modal="false"
      :show-close="!loading && !executing"
      :close-on-press-escape="!loading && !executing"
      append-to-body
      align-center
      @closed="reset"
    >
      <p class="stage-label">{{step === 'preview' ? '1 / 3 · 选择文件并预览' : step === 'plan' ? '2 / 3 · 核对更改' : step === 'execute' ? '3 / 3 · 执行已审核计划' : '导入结果'}}</p>
      <el-alert v-if="actionError" :title="actionError" type="warning" :closable="false" show-icon />
      <!-- Step 1: Preview -->
      <div v-if="step === 'preview'" class="step-pane">
        <p class="muted">选择本扩展导出的 JSON 备份文件，预览它对当前浏览器书签的影响。预览不会更改书签；只有审核批准后再点击“执行”才会写入浏览器。</p>
        <div class="row">
          <el-button @click="pickFile" :loading="loading">{{ fileName ? '更换文件' : '选择文件' }}</el-button>
          <span v-if="fileName" class="file-name">{{ fileName }}</span>
        </div>
        <p class="muted">此工具恢复原生书签结构，不恢复本地元数据。备份中的浏览器 ID 用于匹配；重复导入已恢复的条目可能产生副本。建议先使用“仅添加”并核对计划。</p>
        <el-checkbox v-model="advanced" :disabled="loading || mode === 'controlled-merge'">显示高级合并模式（可能修改和删除当前书签）</el-checkbox>
        <el-form label-width="80" class="mode-form">
          <el-form-item label="导入模式">
            <el-radio-group v-model="mode" :disabled="loading" @change="onModeChange">
              <el-radio-button value="additive">仅添加</el-radio-button>
              <el-radio-button v-if="advanced" value="controlled-merge">受控合并</el-radio-button>
            </el-radio-group>
            <div class="mode-hint">
              <span v-if="mode === 'additive'">只创建当前不存在的节点；不会修改或删除任何现有书签。</span>
              <span v-else>按照浏览器书签 ID 匹配并更新或移动现有节点，还会删除备份中不存在的当前节点。不同浏览器或配置文件的相同 ID 可能属于无关书签，请勿用于跨浏览器合并。</span>
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
            <div class="muted">{{ mode === 'additive' ? '仅添加缺失节点，保留现有书签' : '高级合并：可能修改、移动和删除现有书签' }}</div>
            <div class="muted small">共 {{ plan.steps.length }} 项更改</div>
          </div>
          <article v-for="{step: item, view} in planCards" :key="item.id" class="review-step">
            <el-tag :type="item.action === 'delete' ? 'danger' : 'info'">{{view.action}}</el-tag>
            <strong>{{item.action === 'create' ? view.targetTitle : view.sourceTitle}}</strong>
            <p v-if="item.action !== 'create'">原目录：{{view.sourcePath}}</p>
            <p v-if="view.sourceUrl">原始 URL：{{view.sourceUrl}}</p>
            <p v-if="item.action === 'delete'">将从浏览器原生书签中删除此条目。</p>
            <template v-else><p>目标目录：{{view.targetPath}}</p><p v-if="view.targetTitle !== view.sourceTitle">新标题：{{view.targetTitle}}</p><p v-if="view.targetUrl !== view.sourceUrl">新 URL：{{view.targetUrl}}</p></template>
            <details><summary>技术详情</summary><p>目标 ID：{{item.targetBrowserId || item.parentBrowserId}}</p><p>{{JSON.stringify(item.expectedBefore)}} → {{JSON.stringify(item.desiredAfter)}}</p></details>
          </article>
          <el-empty v-if="!plan.steps.length" description="无需更改，当前书签与此导入模式一致。" />
          <el-alert
            v-if="highRiskCount > 0"
            type="warning"
            show-icon
            :closable="false"
            :title="`包含 ${highRiskCount} 个高风险步骤（删除）。点击批准时会要求再次确认。`"
          />
        </el-card>
        <el-alert title="已自动保留本地恢复快照，执行前还会重新备份。可另存文件到电脑上。" type="info" :closable="false" />
        <p v-if="backupDownloaded" role="status">已发起下载，请确认备份文件已保存。</p>
        <label v-if="highRiskCount > 0">确认删除：输入“删除”<el-input v-model="deleteConfirmation" placeholder="删除" :disabled="loading" /></label>
        <div class="backup-review"><el-button :loading="loading" @click="downloadBackup">另存恢复备份（可选）</el-button><el-checkbox v-model="backupConfirmed" :disabled="loading">我已逐项核对并同意以上所有更改</el-checkbox></div>
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
        <el-alert v-if="result.syncWarning" :title="result.syncWarning" type="warning" :closable="false"/>
        <el-result
          :icon="result.failed === 0 ? 'success' : 'warning'"
          :title="planStatusLabel(result.status)"
          :sub-title="`${result.succeeded} 成功 / ${result.failed} 失败 / ${result.compensated} 已补偿`"
        />
        <p>关闭工具后，可在工作台“操作历史”查看本计划。若有失败，请先核对原生书签，再使用备份恢复或重新生成计划。</p>
        <article v-for="item in plan?.steps" :key="item.id" class="review-step"><strong>{{item.expectedBefore.title || item.desiredAfter.title || item.targetBrowserId}}</strong> · {{stepStatusLabel(item.status)}}<p v-if="item.errorMessage">{{stepErrorLabel(item.errorMessage)}}</p></article>
      </div>

      <template #footer>
        <div class="footer">
          <el-button v-if="step === 'plan' || step === 'execute'" @click="back" :disabled="loading || executing">上一步</el-button>
          <el-button v-if="step === 'preview'" :disabled="!rawJson" @click="runPreview" :loading="loading">刷新预览</el-button>
          <el-button v-if="step === 'preview'" :disabled="!preview || loading" type="primary" @click="createPlan" :loading="loading">创建计划</el-button>
          <el-button v-if="step === 'plan'" :disabled="!plan?.steps.length || !backupConfirmed || (highRiskCount > 0 && deleteConfirmation !== '删除')" type="primary" @click="approvePlan" :loading="loading">批准</el-button>
          <el-button v-if="step === 'execute' && actionError" :disabled="executing || loading" @click="createPlan">重新生成并审核</el-button>
          <el-button v-if="step === 'execute'" :disabled="!approval || !!actionError" type="primary" @click="runExecute" :loading="executing">执行</el-button>
          <el-button v-if="step === 'done'" @click="closeModal">关闭</el-button>
        </div>
      </template>
    </el-dialog>
  </span>
</template>

<style scoped>
.review-step { border:1px solid #e3e7ef; border-radius:8px; padding:14px; margin:10px 0; overflow-wrap:anywhere; }
.review-step strong { margin-left:8px; }
.review-step details { color:#66738a; font-size:12px; }
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
