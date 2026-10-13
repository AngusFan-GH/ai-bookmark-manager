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

onMounted(async () => {
  try {
    count.value = (await request<StatsSummary>({ type: 'STATS', requestId: 'p' })).bookmarks;
  } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
});

function open() {
  void chrome.runtime.openOptionsPage();
}
</script>
<template>
  <div class="popup">
    <h3>🔖 AI Bookmark Manager</h3>
    <p v-if="error" class="err">{{ error }}</p>
    <p v-else>已索引书签：{{ count ?? '加载中...' }}</p>
    <el-button type="primary" style="width:100%" @click="open">打开书签管理中心</el-button>
  </div>
</template>
<style scoped>
.popup { width: 280px; padding: 16px; font-family: Arial, sans-serif }
h3 { margin: 0 0 14px }
p { color: #64748b }
.err { color: #c45656; font-size: 12px }
</style>
