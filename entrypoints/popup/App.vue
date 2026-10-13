<script setup lang="ts">
// popup/App.vue — entry point shown when the user clicks the
// extension's toolbar icon. Two shortcuts are exposed:
//   1. "打开书签管理中心"  → standard options page
//   2. "查看链接健康"      → options page with #health hash, so the
//                            user lands directly on the link-health tab
// The link-health shortcut is provided because reload-chrome-extension
// workflows make it easy to forget that the health view exists, and
// because the dev guide (§ 3.4) calls out a dedicated UI for it.

import { onMounted, ref } from 'vue';
import { request } from '../../src/client';
import type { StatsSummary } from '../../src/infrastructure/messaging/contracts';

const count = ref<number | null>(null);
const error = ref('');

onMounted(async () => {
  try {
    count.value = (await request<StatsSummary>({ type: 'STATS', requestId: 'p' })).bookmarks;
  } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
});

function open() {
  void chrome.runtime.openOptionsPage();
}

function openHealth() {
  // chrome.runtime.getURL returns a path like
  //   chrome-extension://<id>/options.html
  // Append #health so App.vue's hash listener lands the user on the
  // link-health tab. We open a new tab so the popup window can be
  // dismissed without losing the destination.
  const url = chrome.runtime.getURL('options.html#health');
  void chrome.tabs.create({ url });
  // Best-effort: close the popup so the user sees the new tab right
  // away. `window.close()` is supported by extension popups.
  window.close();
}
</script>
<template>
  <div class="popup">
    <h3>🔖 AI Bookmark Manager</h3>
    <p v-if="error" class="err">{{ error }}</p>
    <p v-else>已索引书签：{{ count ?? '加载中...' }}</p>
    <el-button type="primary" style="width:100%" @click="open">打开书签管理中心</el-button>
    <el-button style="width:100%; margin-top: 8px" @click="openHealth">查看链接健康</el-button>
  </div>
</template>
<style scoped>
.popup { width: 280px; padding: 16px; font-family: Arial, sans-serif }
h3 { margin: 0 0 14px }
p { color: #64748b }
.err { color: #c45656; font-size: 12px }
</style>
