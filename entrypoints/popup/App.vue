<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { request } from '../../src/client';
import * as workspace from '../../src/workspace-client';
import { useCaptureStatus } from '../../src/use-capture-status';
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
const { bookmarks: existingBookmarks, state: lookupState, unsaved: confirmedUnsaved, check: checkExisting } = useCaptureStatus(() => url.value);
const windowId = ref<number>();
const loading = ref(true);
const loadFailed = ref(false);
const openingEditor = ref(false);
const busy = ref(false);
const saved = ref(false);
const executionAttempted = ref(false);
const advice = ref<workspace.BookmarkAdvice>();
const adviceError = ref('');
const settings = ref<workspace.AssistantSettingsView>();
const autoEnabled = computed(() => !!(settings.value?.hasKey && settings.value.consent && settings.value.autoSuggestions && settings.value.connectionTested));
const suggestedFolder = computed(() => folders.value.find(folder => folder.browserId === advice.value?.targetFolderId || folder.id === advice.value?.targetFolderId));
let adviceSequence = 0;
let applyingAdvice = false;
let adviceTimer: ReturnType<typeof setTimeout> | undefined;
let activeAdviceId: string | undefined;
const automaticRequests = ref(0);
const requestedContexts = new Set<string>();
const contextKey = computed(() => JSON.stringify([title.value, url.value, parentId.value]));
const suggesting = ref(false);
const canSave = computed(() => isWebUrl(url.value) && !!title.value.trim() && !!parentId.value && !loading.value && !openingEditor.value && !busy.value && !saved.value && !executionAttempted.value);
const id = () => crypto.randomUUID();
let sequence = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

onMounted(async () => {
  void workspace.getAssistantSettings().then(value => { settings.value = value; }).catch(() => { /* Local capture remains available. */ });
  await loadCapture();
});
async function loadCapture() {
  loading.value = true; loadFailed.value = false; error.value = '';
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
  } catch (e) { loadFailed.value = true; error.value = message(e); }
  finally { loading.value = false; }
}
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
onBeforeUnmount(() => { ++sequence; clearTimeout(timer); invalidateAdvice(); });
async function openWorkspace() {
  try { await chrome.tabs.create({ url: chrome.runtime.getURL(workspacePath(query.value)) }); }
  catch (e) { error.value = message(e); }
}
async function editInWorkspace() {
  if (openingEditor.value || busy.value || saved.value || executionAttempted.value) return;
  openingEditor.value = true; error.value = '';
  invalidateAdvice();
  try {
    const { captureId } = await workspace.storeCapture({ title: title.value, url: url.value, ...(parentId.value ? { parentFolderId: parentId.value } : {}) });
    await chrome.tabs.create({ url: chrome.runtime.getURL(workspacePath(query.value, captureId)) });
  } catch (e) { error.value = message(e); }
  finally { openingEditor.value = false; }
}
function saveFromKeyboard(event: KeyboardEvent) {
  if (event.isComposing) return;
  event.preventDefault();
  void save();
}
async function save() {
  if (!canSave.value) return;
  invalidateAdvice();
  busy.value = true; error.value = '';
  try {
    const plan = await workspace.prepareOrganization({ title: '收藏当前页面', steps: [{ action: 'create', parentBrowserId: parentId.value, desiredAfter: { title: title.value.trim(), url: url.value }, reason: '用户在快捷收藏中确认标题、原始网址和文件夹' }] });
    const approval = await request<ApprovalToken>({ type: 'APPROVE', requestId: id(), planId: plan.id });
    executionAttempted.value = true;
    const result = await request<ExecuteResultMsg>({ type: 'EXECUTE', requestId: id(), planId: plan.id, approvalToken: approval.token });
    if (result.status !== 'completed' || result.failed > 0 || result.succeeded !== 1) throw new Error('收藏未完成，请在工作台的操作历史中查看结果后再试。');
    saved.value = true;
    void checkExisting();
    if(result.syncWarning) error.value = result.syncWarning;
  } catch (e) { error.value = message(e); }
  finally { busy.value = false; }
}
function invalidateAdvice() {
  ++adviceSequence;
  clearTimeout(adviceTimer);
  if (activeAdviceId) void workspace.cancelAdvice(activeAdviceId).catch(() => {});
  activeAdviceId = undefined;
  suggesting.value = false;
  advice.value = undefined;
  adviceError.value = '';
}
watch([contextKey, autoEnabled, confirmedUnsaved, loading, busy, saved, openingEditor], () => {
  if (applyingAdvice && confirmedUnsaved.value && !openingEditor.value && !busy.value && !saved.value) { applyingAdvice = false; return; }
  applyingAdvice = false;
  invalidateAdvice();
  if (!confirmedUnsaved.value || !autoEnabled.value || loading.value || openingEditor.value || busy.value || saved.value || executionAttempted.value || !isWebUrl(url.value) || !title.value.trim() || !parentId.value) return;
  const context = contextKey.value;
  if (requestedContexts.has(context) || automaticRequests.value >= 3) return;
  adviceTimer = setTimeout(() => { void suggest(); }, 800);
});
async function suggest() {
  if (!confirmedUnsaved.value || !autoEnabled.value || openingEditor.value || busy.value || saved.value || executionAttempted.value) return;
  invalidateAdvice();
  const current = adviceSequence;
  const requestId = id();
  activeAdviceId = requestId;
  requestedContexts.add(contextKey.value);
  automaticRequests.value++;
  suggesting.value = true;
  try {
    const result = await workspace.adviseBookmark({ title: title.value, url: url.value, parentFolderId: parentId.value }, { automatic: true, requestId });
    if (current === adviceSequence) advice.value = result;
  } catch (e) { if (current === adviceSequence) adviceError.value = message(e); }
  finally { if (current === adviceSequence) { suggesting.value = false; activeAdviceId = undefined; } }
}
function applyAdvice(field: 'title' | 'folder') {
  if (!advice.value || busy.value || saved.value) return;
  const retained = advice.value;
  applyingAdvice = true;
  if (field === 'title' && retained.title.trim()) title.value = retained.title.trim();
  if (field === 'folder' && suggestedFolder.value) parentId.value = suggestedFolder.value.browserId;
  requestedContexts.add(contextKey.value);

}
async function openExisting(browserId: string, edit = false) {
  try { await chrome.tabs.create({ url: chrome.runtime.getURL('options.html?' + (edit ? 'edit=' : 'view=') + encodeURIComponent(browserId)) }); }
  catch (e) { error.value = message(e); }
}
async function openSettings() {
  try { await chrome.tabs.create({ url: chrome.runtime.getURL('options.html?settings=ai') }); }
  catch (e) { error.value = message(e); }
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
      <div class="section-title"><h2>{{ saved || existingBookmarks.length ? '已收藏当前页面' : '收藏当前页面' }}</h2><span class="badge">本地保存</span></div>
      <p v-if="loading" class="muted">正在读取当前页面…</p>
      <p v-else-if="loadFailed" class="muted">读取失败，请重试。<button class="text-button" @click="loadCapture">重新读取当前页面</button></p>
      <p v-else-if="!url" class="muted">这个页面无法快捷收藏。请在普通网页中打开扩展。</p>
      <template v-else>
        <p v-if="lookupState === 'checking'" class="privacy" role="status">正在检查是否已收藏…</p>
        <p v-else-if="lookupState === 'error'" class="privacy">暂时无法确认收藏状态，已暂停建议；继续保存可能产生重复书签。<button class="text-button" @click="checkExisting">重新检查</button></p>
        <div v-if="existingBookmarks.length" class="saved-status" role="status"><strong>这个页面已收藏</strong><p v-for="bookmark in existingBookmarks" :key="bookmark.browserId">{{ bookmark.path || bookmark.title }} <button class="text-button" @click="openExisting(bookmark.browserId)">查看</button> <button class="text-button" @click="openExisting(bookmark.browserId, true)">编辑已有书签</button></p><span v-if="!saved && !executionAttempted" class="privacy">仍可确认另存一份。</span></div>
        <label for="capture-title">标题</label><input id="capture-title" v-model="title" :disabled="busy || saved || openingEditor || executionAttempted" maxlength="500" @keydown.enter="saveFromKeyboard">
        <p v-if="advice?.title.trim() && advice.title.trim() !== title.trim()" class="inline-suggestion" :title="advice.reason"><span>建议标题：{{ advice.title }}</span><button class="text-button" :disabled="busy || saved" @click="applyAdvice('title')">采用标题</button></p>
        <p class="url"  :title="url">{{ url }}</p>
        <label for="capture-folder">保存到</label><select id="capture-folder" v-model="parentId" :disabled="busy || saved || openingEditor || executionAttempted"><option v-for="folder in folders" :key="folder.browserId" :value="folder.browserId">{{ folder.path || folder.title || '未命名文件夹' }}</option></select>
        <p v-if="advice && suggestedFolder && suggestedFolder.browserId !== parentId" class="inline-suggestion" :title="advice.reason"><span>建议位置：{{ suggestedFolder.path || suggestedFolder.title }}</span><button class="text-button" :disabled="busy || saved" @click="applyAdvice('folder')">采用位置</button></p>
        <p v-if="!folders.length"  class="muted">暂无可用文件夹，请先打开工作台同步书签。</p>
        <div class="ai-row"><span class="privacy" role="status">{{ suggesting ? '正在看看有没有更合适的标题和位置…' : '' }}</span><button v-if="!saved && !executionAttempted" class="text-button" :disabled="busy || openingEditor" @click="editInWorkspace">{{ openingEditor ? '正在打开…' : '更多编辑' }}</button></div>
        <p v-if="confirmedUnsaved && !autoEnabled" class="privacy">需要标题和目录建议？<button class="text-button" @click="openSettings">设置 AI</button></p>
        <p v-if="confirmedUnsaved && autoEnabled && !suggesting && !advice && !adviceError && automaticRequests >= 3" class="privacy">可以按当前内容直接收藏。</p>
        <p v-if="adviceError && confirmedUnsaved" class="privacy">暂时没有建议，不影响收藏。<button class="text-button" :disabled="busy || saved" @click="suggest">重试建议</button></p>
        <button class="primary" :disabled="!canSave" @click="save">{{ saved ? '✓ 已收藏' : busy ? '正在安全保存…' : executionAttempted ? '请到工作台核对结果' : existingBookmarks.length ? '确认另存一份' : '确认收藏' }}</button>
        <p v-if="executionAttempted && !saved && !busy" class="privacy" role="status">保存结果尚未确认，请先核对操作历史，避免重复收藏。<button class="text-button" @click="openWorkspace">打开工作台核对</button></p>
        <p v-else-if="saved" class="privacy" role="status">收藏已保存。可在工作台查看或编辑。</p>
        <p v-else class="privacy">确认后写入浏览器书签，并自动保留操作前快照。</p>
      </template>
    </section>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <footer><button :disabled="windowId === undefined" @click="openSidepanel">侧边栏工作台</button><button @click="openWorkspace">完整工作台 ↗</button></footer>
  </main>
</template>
<style scoped>
:global(body){background:#f5f7fc;color:#1e293b;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}.popup{width:100%;box-sizing:border-box;padding:20px}header{display:flex;gap:10px;align-items:center;margin-bottom:18px}.logo{flex-shrink:0;display:grid;place-items:center;background:#4f46e5;color:white;border-radius:12px;width:38px;height:38px;font-size:24px}header>div{flex:1}h1{font-size:17px;margin:0;font-weight:700}header p{font-size:11px;color:#64748b;margin:4px 0 0}button,input,select{font:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.55}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #6366f1;outline-offset:2px}input,select{box-sizing:border-box;width:100%;border:1px solid #dbe2ed;border-radius:9px;padding:10px;background:white;color:#1e293b;font-size:13px}.search{display:flex;background:white;border:1px solid #dbe2ed;border-radius:10px;overflow:hidden}.search input{border:0;min-width:0}.search button{border:0;background:transparent;color:#64748b;padding:0 12px}.capture{margin-top:18px;background:white;border:1px solid #e5e9f2;border-radius:14px;padding:15px}.section-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}h2{font-size:13px;margin:0}.badge{font-size:10px;background:#eef2ff;color:#4f46e5;padding:4px 7px;border-radius:20px}label{display:block;font-size:11px;color:#64748b;margin:10px 0 5px}.url{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#64748b;margin:6px 0 14px}.text-button{border:0;background:transparent;color:#4f46e5;font-size:12px;padding:4px 0}.ai-row{display:flex;justify-content:space-between;gap:8px;margin-top:12px}.privacy{color:#64748b;font-size:10px;line-height:1.6;margin:7px 0 0}.primary{background:#4f46e5;color:white;border:0;width:100%;border-radius:9px;padding:11px;margin-top:12px;font-weight:600}.muted{font-size:12px;color:#64748b;line-height:1.6}.error{font-size:12px;color:#b42318;line-height:1.5;overflow-wrap:anywhere}.inline-suggestion{display:flex;align-items:center;gap:8px;font-size:11px;color:#64748b;line-height:1.6;margin:6px 0}.inline-suggestion span{flex:1;min-width:0;overflow-wrap:anywhere}.inline-suggestion button{flex-shrink:0}.saved-status{overflow-wrap:anywhere;font-size:12px;color:#526b59;border-left:2px solid #a9c4b0;padding-left:9px;margin-bottom:12px}.results{padding:8px 0}.result{display:block;width:100%;text-align:left;border:0;background:white;padding:10px;margin-top:5px;border-radius:8px}.result strong,.result span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.result strong{font-size:12px}.result span{color:#64748b;font-size:10px;margin-top:4px}.all-results{margin-top:8px}footer{display:flex;gap:10px;justify-content:space-between;margin-top:14px}footer button{border:0;background:none;color:#64748b;font-size:12px;padding:5px 0}
</style>
