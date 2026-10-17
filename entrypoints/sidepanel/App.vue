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
.sidepanel-shell { min-width:0; }
.panel-bar { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 12px; border-bottom:1px solid var(--bookmark-line); background:var(--bookmark-surface); color:var(--bookmark-secondary); font:12px var(--bookmark-font); }
.panel-bar button { min-height:32px; border:0; padding:4px 0; background:transparent; color:var(--bookmark-accent); font:inherit; cursor:pointer; text-align:right; }
.panel-bar button:hover { text-decoration:underline; }
.sidepanel-shell>p { font:12px var(--bookmark-font); color:#b42318; padding:8px 12px; overflow-wrap:anywhere; }
</style>
