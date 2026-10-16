<script setup lang="ts">
import { ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { backupFileName } from './components/tools-helpers';
import { downloadableJson } from './workspace-helpers';
import { request } from '../../src/client';
import type { BookmarkRecord } from '../../src/domain/bookmarks/types';
import ImportFlow from './components/ImportFlow.vue';
import HealthView from './components/HealthView.vue';
const props = defineProps<{ initialTab?: 'bookmarks' | 'health' }>();
const emit = defineEmits<{ 'preview-delete': [records: BookmarkRecord[]] }>();
const activeTab = ref(props.initialTab ?? 'bookmarks');
watch(() => props.initialTab, tab => { if (tab) activeTab.value = tab; });
const exporting = ref(false);
const error = ref('');
async function backup() {
  if (exporting.value) return;
  exporting.value = true; error.value = '';
  try {
    const data = await request<unknown>({ type: 'EXPORT', requestId: crypto.randomUUID() });
    const url = URL.createObjectURL(downloadableJson(data));
    const a = document.createElement('a'); a.href = url; a.download = backupFileName();
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
    ElMessage.info('已发起备份下载，请确认文件已保存。');
  } catch { error.value = '备份下载未能开始，请重试。当前书签没有因此改变。'; }
  finally { exporting.value = false; }
}
</script>
<template>
  <div class="tools-panel">
    <el-tabs v-model="activeTab">
      <el-tab-pane label="备份与导入" name="bookmarks">
        <section class="backup-panel">
          <h2>保留一份独立备份</h2>
          <p>每次更改前会自动保留本地恢复快照。你也可以下载 JSON 文件，独立保存在电脑上；卸载扩展或清除扩展数据可能丢失本地快照。</p>
          <el-button type="primary" :loading="exporting" @click="backup">下载完整 JSON 备份</el-button>
          <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
          <h2>从文件导入</h2>
          <p>选择本扩展导出的 JSON 文件，先预览，再审核执行。导入恢复原生书签结构，不恢复本地元数据。浏览器原生导出的 HTML 文件暂不支持。</p>
          <ImportFlow />
          <p class="hint">只想撤销最近的一次整理？关闭此窗口，在操作历史中选择该次操作的恢复预览，可避免用旧文件覆盖后来的更改。</p>
        </section>
      </el-tab-pane>
      <el-tab-pane label="链接健康" name="health" lazy>
        <HealthView v-if="activeTab === 'health'" @preview-delete="emit('preview-delete', $event)" />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>
<style scoped>
.tools-panel { min-width:0; }
.backup-panel { max-width:760px; padding:8px 4px 20px; }
h2 { font-size:19px; margin:20px 0 12px; }
p { font-size:14px; color:#526277; line-height:1.8; }
.hint { padding:14px; background:#f0f4fb; border-radius:8px; margin-top:24px; }
.backup-panel :deep(.el-alert) { margin-top:12px; }
</style>
