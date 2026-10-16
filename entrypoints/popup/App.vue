<script setup lang="ts">
// popup/App.vue — entry point shown when the user clicks the
// extension's toolbar icon. Single-purpose: open the Options page in
// a regular Chrome tab. The link-health view is reached from the
// Options header (🩺 button) or via the Alt+H shortcut; it does
// NOT live in the popup, so the popup stays a single, obvious
// "open the manager" affordance.

import { onMounted, ref } from 'vue';
import { request } from '../../src/client';
import type { StatsSummary } from '../../src/infrastructure/messaging/contracts';

const count = ref<number | null>(null);
const error = ref('');
const query = ref('');

onMounted(async () => {
  try {
    count.value = (await request<StatsSummary>({ type: 'STATS', requestId: 'p' })).bookmarks;
  } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
});

function open() {
  if (query.value.trim()) void chrome.tabs.create({ url: chrome.runtime.getURL('options.html') + '?q=' + encodeURIComponent(query.value.trim()) });
  else void chrome.runtime.openOptionsPage();
}
</script>
<template>
  <div class="popup">
    <h3>🔖 AI Bookmark Manager</h3>
    <p v-if="error" class="err">{{ error }}</p>
    <p v-else>已索引书签：{{ count ?? '加载中...' }}</p>
    <form @submit.prevent="open"><el-input v-model="query" clearable aria-label="搜索书签" placeholder="搜索书签…" style="margin-bottom:12px"/><el-button type="primary" native-type="submit" style="width:100%">{{ query.trim() ? '在工作台搜索' : '打开书签工作台' }}</el-button></form><p class="hint">推荐、整理与多轮对话在完整工作台中进行。</p>
  </div>
</template>
<style scoped>
.popup { width: 280px; padding: 16px; font-family: Arial, sans-serif }
h3 { margin: 0 0 14px }
p { color: #64748b }
.err { color: #c45656; font-size: 12px }
</style>
