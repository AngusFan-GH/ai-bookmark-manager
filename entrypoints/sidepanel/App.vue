<script setup lang="ts">
import { ref } from 'vue';
import Workspace from '../options/App.vue';
import { expandedWorkspacePath } from '../popup/helpers';
const error = ref('');
async function expand() {
  try { await chrome.tabs.create({ url: chrome.runtime.getURL(expandedWorkspacePath(location.search, location.hash)) }); }
  catch (e) { error.value = e instanceof Error ? e.message : String(e); }
}
</script>
<template><div class="sidepanel-shell"><div class="panel-bar"><span>书签工作台</span><button @click="expand">在完整页面继续 ↗</button></div><p v-if="error" role="alert">{{ error }}</p><Workspace /></div></template>
<style scoped>
.panel-bar{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#eef2ff;color:#4338ca;font:12px system-ui}.panel-bar button{border:0;background:transparent;color:inherit;font:inherit;cursor:pointer}.sidepanel-shell{min-width:0}.sidepanel-shell>p{font:12px system-ui;color:#b42318;padding:8px}
</style>
