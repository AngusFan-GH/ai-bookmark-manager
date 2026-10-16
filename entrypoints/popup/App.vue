<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { request } from '../../src/client';
import * as workspace from '../../src/workspace-client';
import type { BookmarkRecord, FolderRecord } from '../../src/domain/bookmarks/types';
import type { ApprovalToken, ExecuteResultMsg, ListResult } from '../../src/infrastructure/messaging/contracts';
import { isWebUrl, workspacePath, writableFolders } from './helpers';

const query = ref('');
const rows = ref<BookmarkRecord[]>([]);
const searching = ref(false);
const searched = ref(false);
const searchError = ref('');
const error = ref('');
const folders = ref<FolderRecord[]>([]);
const title = ref('');
const url = ref('');
const parentId = ref('');
const windowId = ref<number>();
const loading = ref(true);
const busy = ref(false);
const saved = ref(false);
const executionAttempted = ref(false);
const advice = ref('');
const suggesting = ref(false);
const canSave = computed(() => isWebUrl(url.value) && !!title.value.trim() && !!parentId.value && !loading.value && !busy.value && !saved.value && !executionAttempted.value);
const id = () => crypto.randomUUID();
let sequence = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

onMounted(async () => {
  try {
    const [tabs, tree] = await Promise.all([
      chrome.tabs.query({ active: true, currentWindow: true }),
      request<FolderRecord[]>({ type: 'BOOKMARKS_TREE', requestId: id() }),
    ]);
    const tab = tabs[0];
    windowId.value = tab?.windowId;
    url.value = isWebUrl(tab?.url) ? tab.url : '';
    title.value = tab?.title || url.value;
    folders.value = writableFolders(tree);
    parentId.value = folders.value.find(folder => folder.parentId === '0')?.browserId ?? folders.value[0]?.browserId ?? '';
  } catch (e) { error.value = message(e); }
  finally { loading.value = false; }
});
function message(e: unknown) { return e instanceof Error ? e.message : String(e); }
watch(query, () => {
  const current = ++sequence;
  clearTimeout(timer);
  rows.value = []; searched.value = false; searchError.value = '';
  searching.value = !!query.value.trim();
  if (!query.value.trim()) return;
  timer = setTimeout(async () => {
    try {
      const result = await request<ListResult<BookmarkRecord>>({ type: 'BOOKMARKS_LIST', requestId: id(), query: query.value.trim(), limit: 5, offset: 0 });
      if (current === sequence) { rows.value = result.rows; searched.value = true; }
    } catch (e) { if (current === sequence) searchError.value = message(e); }
    finally { if (current === sequence) searching.value = false; }
  }, 160);
});
onBeforeUnmount(() => { ++sequence; clearTimeout(timer); });
async function openWorkspace() {
  try { await chrome.tabs.create({ url: chrome.runtime.getURL(workspacePath(query.value)) }); }
  catch (e) { error.value = message(e); }
}
async function editInWorkspace() {
  try {
    const { captureId } = await workspace.storeCapture({ title: title.value, url: url.value });
    await chrome.tabs.create({ url: chrome.runtime.getURL(workspacePath(query.value, captureId)) });
  } catch (e) { error.value = message(e); }
}
async function save() {
  if (!canSave.value) return;
  busy.value = true; error.value = '';
  try {
    const plan = await workspace.prepareOrganization({ title: '收藏当前页面', steps: [{ action: 'create', parentBrowserId: parentId.value, desiredAfter: { title: title.value.trim(), url: url.value }, reason: '用户在快捷收藏中确认标题、原始网址和文件夹' }] });
    const approval = await request<ApprovalToken>({ type: 'APPROVE', requestId: id(), planId: plan.id });
    executionAttempted.value = true;
    const result = await request<ExecuteResultMsg>({ type: 'EXECUTE', requestId: id(), planId: plan.id, approvalToken: approval.token });
    if (result.status !== 'completed' || result.failed > 0 || result.succeeded !== 1) throw new Error('收藏未完成，请在工作台的操作历史中查看结果后再试。');
    saved.value = true;
  } catch (e) { error.value = message(e); }
  finally { busy.value = false; }
}
async function suggest() {
  suggesting.value = true; error.value = ''; advice.value = '';
  try {
    const result = await workspace.adviseBookmark({ title: title.value, url: url.value, parentFolderId: parentId.value });
    if (result.title) title.value = result.title;
    if (folders.value.some(folder => folder.browserId === result.targetFolderId)) parentId.value = result.targetFolderId;
    advice.value = result.reason;
  } catch (e) { error.value = message(e); }
  finally { suggesting.value = false; }
}
function openSidepanel() {
  if (windowId.value === undefined) return;
  // Invoke open directly in the click handler, before asynchronous work loses activation.
  void chrome.sidePanel.open({ windowId: windowId.value }).then(() =>
    chrome.sidePanel.setOptions({ path: workspacePath(query.value).replace(/^options/, 'sidepanel'), enabled: true }),
  ).catch(e => { error.value = message(e); });
}
async function openBookmark(bookmark: BookmarkRecord) {
  if (!isWebUrl(bookmark.url)) return;
  try { await chrome.tabs.create({ url: bookmark.url }); }
  catch (e) { searchError.value = message(e); }
}
</script>
<template>
  <main class="popup">
    <header><span class="logo">✦</span><div><h1>书签工作台</h1><p>收好当下，随时找到</p></div><button class="text-button" aria-label="打开完整工作台" @click="openWorkspace">↗</button></header>
    <form class="search" @submit.prevent="openWorkspace"><input v-model="query" autofocus type="search" aria-label="搜索已有书签" placeholder="搜索已有书签…"><button type="submit" aria-label="在工作台查看全部结果">↵</button></form>
    <section v-if="query.trim()" class="results" aria-live="polite" aria-label="本地搜索结果">
      <p v-if="searching" class="muted">正在搜索本地书签…</p>
      <p v-else-if="searchError" role="alert" class="error">{{ searchError }}</p>
      <p v-else-if="searched && !rows.length" class="muted">未找到书签，试试其他关键词。</p>
      <button v-for="row in rows" :key="row.id" class="result" :disabled="!isWebUrl(row.url)" @click="openBookmark(row)"><strong>{{ row.title || row.url }}</strong><span>{{ row.url }}</span></button>
      <button v-if="rows.length" class="text-button all-results" @click="openWorkspace">在工作台查看全部结果 →</button>
    </section>
    <section class="capture" aria-label="收藏当前页面">
      <div class="section-title"><h2>收藏当前页面</h2><span class="badge">本地保存</span></div>
      <p v-if="loading" class="muted">正在读取当前页面…</p>
      <p v-else-if="!url" class="muted">这个页面无法快捷收藏。请在普通网页中打开扩展。</p>
      <template v-else>
        <label for="capture-title">标题</label><input id="capture-title" v-model="title" :disabled="busy || saved || suggesting" maxlength="500">
        <p class="url" :title="url">{{ url }}</p>
        <label for="capture-folder">保存到</label><select id="capture-folder" v-model="parentId" :disabled="busy || saved || suggesting"><option v-for="folder in folders" :key="folder.browserId" :value="folder.browserId">{{ folder.path || folder.title || '未命名文件夹' }}</option></select>
        <p v-if="!folders.length" class="muted">暂无可用文件夹，请先打开工作台同步书签。</p>
        <div class="ai-row"><button class="text-button" :disabled="busy || saved || suggesting" @click="suggest">{{ suggesting ? 'AI 正在建议…' : '✦ AI 建议标题和位置' }}</button><button class="text-button" :disabled="busy || suggesting" @click="editInWorkspace">更多编辑</button></div>
        <p class="privacy">AI 仅在点击后使用；需先在工作台启用并确认信息发送。</p>
        <p v-if="advice" class="advice">{{ advice }}</p>
        <button class="primary" :disabled="!canSave || suggesting" @click="save">{{ saved ? '✓ 已收藏' : busy ? '正在安全保存…' : executionAttempted ? '请到工作台核对结果' : '确认收藏' }}</button>
        <p class="privacy">确认后写入浏览器书签，并自动保留操作前快照。</p>
      </template>
    </section>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <footer><button :disabled="windowId === undefined" @click="openSidepanel">侧边栏工作台</button><button @click="openWorkspace">完整工作台 ↗</button></footer>
  </main>
</template>
<style scoped>
:global(body){margin:0;background:#f5f7fc;color:#1e293b;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.popup{width:360px;box-sizing:border-box;padding:20px}header{display:flex;gap:10px;align-items:center;margin-bottom:18px}.logo{display:grid;place-items:center;background:#4f46e5;color:white;border-radius:12px;width:38px;height:38px;font-size:24px}header>div{flex:1}h1{font-size:17px;margin:0;font-weight:700}header p{font-size:11px;color:#64748b;margin:4px 0 0}button,input,select{font:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.55}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #6366f1;outline-offset:2px}input,select{box-sizing:border-box;width:100%;border:1px solid #dbe2ed;border-radius:9px;padding:10px;background:white;color:#1e293b;font-size:13px}.search{display:flex;background:white;border:1px solid #dbe2ed;border-radius:10px;overflow:hidden}.search input{border:0}.search button{border:0;background:transparent;color:#64748b;padding:0 12px}.capture{margin-top:18px;background:white;border:1px solid #e5e9f2;border-radius:14px;padding:15px}.section-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}h2{font-size:13px;margin:0}.badge{font-size:10px;background:#eef2ff;color:#4f46e5;padding:4px 7px;border-radius:20px}label{display:block;font-size:11px;color:#64748b;margin:10px 0 5px}.url{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#64748b;margin:6px 0 14px}.text-button{border:0;background:transparent;color:#4f46e5;font-size:12px;padding:4px 0}.ai-row{display:flex;justify-content:space-between;gap:8px;margin-top:12px}.privacy{color:#64748b;font-size:10px;line-height:1.6;margin:7px 0 0}.primary{background:#4f46e5;color:white;border:0;width:100%;border-radius:9px;padding:11px;margin-top:12px;font-weight:600}.muted{font-size:12px;color:#64748b;line-height:1.6}.error{font-size:12px;color:#b42318;line-height:1.5;overflow-wrap:anywhere}.advice{font-size:11px;color:#4338ca;line-height:1.6;background:#eef2ff;padding:8px;border-radius:8px}.results{padding:8px 0}.result{display:block;width:100%;text-align:left;border:0;background:white;padding:10px;margin-top:5px;border-radius:8px}.result strong,.result span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.result strong{font-size:12px}.result span{color:#64748b;font-size:10px;margin-top:4px}.all-results{margin-top:8px}footer{display:flex;gap:10px;justify-content:space-between;margin-top:14px}footer button{border:0;background:none;color:#64748b;font-size:12px;padding:5px 0}
</style>
