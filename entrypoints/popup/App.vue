<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { request } from '../../src/client';
const count = ref<number | null>(null);
const error = ref('');
onMounted(async () => { try { count.value = (await request<{bookmarks:number}>({type:'STATS'})).bookmarks; } catch(e) { error.value = String(e); } });
function open() { void chrome.runtime.openOptionsPage(); }
</script>
<template><div class="popup"><h3>🔖 AI Bookmark Manager</h3><p v-if="error">{{ error }}</p><p v-else>已索引书签：{{ count ?? '加载中...' }}</p><el-button type="primary" style="width:100%" @click="open">打开书签管理中心</el-button></div></template>
<style scoped>.popup{width:280px;padding:16px;font-family:Arial,sans-serif}h3{margin:0 0 14px}p{color:#64748b}</style>
