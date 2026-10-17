<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import type { InputInstance, SelectInstance } from 'element-plus';
import { CollectionTag, EditPen, FolderAdd, FolderOpened, ArrowRight } from '@element-plus/icons-vue';
import type { BookmarkRecord, FolderRecord } from '../../../src/domain/bookmarks/types';
import type { OrganizationInput } from '../../../src/workspace-client';
import { buildBookmarkEditorInput, editorDestinationFolders, initialBookmarkEditorDraft, isEditorWebUrl, type BookmarkEditorErrors, type BookmarkEditorKind } from './bookmark-editor-helpers';

const props = defineProps<{
  modelValue: boolean;
  kind: BookmarkEditorKind;
  records: BookmarkRecord[];
  folders: FolderRecord[];
  defaultParentId: string;
  busy: boolean;
  initialBookmark?: { title: string; url: string; parentFolderId?: string };
  advice?: { title: string; targetFolderId: string; reason: string };
  requestingAdvice?: boolean;
  aiAvailable?: boolean;
  autoEnabled?: boolean;
  adviceError?: string;
  serverError?: string;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  prepare: [input: { title: string; steps: OrganizationInput['steps'] }];
  'request-advice': [input: { title: string; url: string; parentFolderId?: string }];
  'open-settings': [];
  'cancel-advice': [];
}>();
const draft = reactive({ title: '', url: '', parentId: '' });
const errors = ref<BookmarkEditorErrors>({});
const titleInput = ref<InputInstance>();
const urlInput = ref<InputInstance>();
const destinationInput = ref<SelectInstance>();
const submitting = ref(false);
const adviceDraftKey = ref('');
const draftKey = computed(() => JSON.stringify([draft.title, draft.url, draft.parentId]));
const visibleAdvice = computed(() => props.advice && adviceDraftKey.value === draftKey.value ? props.advice : undefined);
const suggestedFolder = computed(() => props.folders.find(folder => folder.id === visibleAdvice.value?.targetFolderId || folder.browserId === visibleAdvice.value?.targetFolderId));
const canUseAdvice = computed(() => !!visibleAdvice.value?.title?.trim() && !!destinations.value.find(folder => folder.id === suggestedFolder.value?.id));
const pending = computed(() => props.busy || submitting.value);
let adviceTimer: ReturnType<typeof setTimeout> | undefined;
const automaticRequests = ref(0);
const requestedContexts = new Set<string>();
const target = computed(() => props.records[0]);
const selectionCount = computed(() => new Set(props.records.map(record => record.browserId)).size);
const editingFolder = computed(() => props.kind === 'edit' && target.value?.kind === 'folder');
const showUrl = computed(() => props.kind === 'bookmark' || (props.kind === 'edit' && target.value?.kind === 'bookmark'));
const unchangedSpecialUrl = computed(() => props.kind === 'edit' && !!target.value?.url && draft.url === target.value.url && !isEditorWebUrl(target.value.url));
const destinations = computed(() => editorDestinationFolders(props.folders, props.kind === 'move' ? props.records : []));
const destination = computed(() => destinations.value.find(folder => folder.id === draft.parentId));
const currentFolder = computed(() => {
  const folder = props.folders.find(folder => folder.id === target.value?.parentId || folder.browserId === target.value?.parentId);
  return folder?.path || folder?.title || target.value?.path || '目录名称不可用';
});
const heading = computed(() => props.kind === 'bookmark' ? '添加书签' : props.kind === 'folder' ? '新建目录' : props.kind === 'move' ? '移动到目录' : editingFolder.value ? '重命名目录' : '编辑书签');
const headingIcon = computed(() => props.kind === 'bookmark' ? CollectionTag : props.kind === 'folder' ? FolderAdd : props.kind === 'move' ? FolderOpened : EditPen);
const subtitle = computed(() => props.kind === 'move' ? `为选中的 ${selectionCount.value} 个条目选择新的位置。` : props.kind === 'folder' ? '给相关书签一个清晰的归属。' : props.kind === 'edit' ? '让标题和地址保持准确、易于查找。' : '保存值得再次打开的网页。');

function reset() {
  Object.assign(draft, initialBookmarkEditorDraft(props.kind, props.records, props.folders, props.defaultParentId));
  if (props.kind === 'bookmark' && props.initialBookmark) {
    draft.title = props.initialBookmark.title;
    draft.url = props.initialBookmark.url;
    const parent = props.folders.find(folder => folder.id === props.initialBookmark?.parentFolderId || folder.browserId === props.initialBookmark?.parentFolderId);
    if (parent && destinations.value.some(folder => folder.id === parent.id)) draft.parentId = parent.id;
  }
  errors.value = {};
  submitting.value = false;
  adviceDraftKey.value = '';
  automaticRequests.value = 0;
  requestedContexts.clear();
}
watch(() => [props.modelValue, props.kind] as const, ([open]) => { if (open) reset(); }, { immediate: true });
watch(() => props.busy, (busy, previous) => { if (previous && !busy) submitting.value = false; });
function clearError(field: keyof BookmarkEditorErrors) {
  errors.value = { ...errors.value, [field]: undefined, form: undefined };
}
function close() { if (!pending.value) { invalidateAdvice(); emit('update:modelValue', false); } }
function updateOpen(open: boolean) { if (!open) close(); }
async function focusFirstField() {
  await nextTick();
  if (props.kind === 'move') destinationInput.value?.focus();
  else titleInput.value?.focus();
}
function invalidateAdvice() {
  clearTimeout(adviceTimer);
  adviceDraftKey.value = '';
  emit('cancel-advice');
}
watch([draftKey, () => props.modelValue, () => props.autoEnabled, pending], () => {
  invalidateAdvice();
  if (!props.modelValue || props.kind !== 'bookmark' || !props.autoEnabled || pending.value || !draft.title.trim() || !isEditorWebUrl(draft.url.trim()) || !destination.value) return;
  if (requestedContexts.has(draftKey.value) || automaticRequests.value >= 3) return;
  adviceTimer = setTimeout(requestAdvice, 800);
}, { immediate: true });
onBeforeUnmount(invalidateAdvice);
function requestAdvice() {
  if (pending.value || !props.modelValue || !props.autoEnabled || !draft.title.trim() || !isEditorWebUrl(draft.url.trim()) || !destination.value) return;
  invalidateAdvice();
  adviceDraftKey.value = draftKey.value;
  requestedContexts.add(draftKey.value);
  automaticRequests.value++;
  emit('request-advice', { title: draft.title.trim(), url: draft.url.trim(), parentFolderId: destination.value.browserId });
}
function useAdvice() {
  if (!visibleAdvice.value || !suggestedFolder.value || !canUseAdvice.value || pending.value) return;
  const title = visibleAdvice.value.title.trim();
  const parentId = suggestedFolder.value.id;
  draft.title = title;
  draft.parentId = parentId;
  errors.value = {};
  requestedContexts.add(draftKey.value);
  invalidateAdvice();
}
async function submit() {
  if (pending.value) return;
  const result = buildBookmarkEditorInput(props.kind, draft, props.records, props.folders);
  errors.value = result.errors;
  if (!result.input) {
    await nextTick();
    if (result.errors.title) titleInput.value?.focus();
    else if (result.errors.url) urlInput.value?.focus();
    else if (result.errors.parentId) destinationInput.value?.focus();
    return;
  }
  invalidateAdvice();
  submitting.value = true;
  emit('prepare', result.input);
  await nextTick();
  if (!props.busy) submitting.value = false;
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="heading"
    width="min(600px, calc(100vw - 32px))"
    class="bookmark-editor-dialog"
    :close-on-click-modal="false"
    :close-on-press-escape="!pending"
    :show-close="!pending"
    append-to-body
    align-center
    destroy-on-close
    @update:model-value="updateOpen"
    @opened="focusFirstField"
  >
    <template #header="{ titleId, titleClass }">
      <div class="editor-heading">
        <span class="editor-heading-icon" aria-hidden="true"><component :is="headingIcon" /></span>
        <div><h2 :id="titleId" :class="titleClass">{{ heading }}</h2><p>{{ subtitle }}</p></div>
      </div>
    </template>

    <form id="bookmark-editor-form" class="editor-form" novalidate :aria-busy="pending" @submit.prevent="submit">
      <div v-if="kind === 'move'" class="selection-summary">
        <div class="selection-summary-heading"><span>已选择</span><span class="selection-count">{{ selectionCount }} 个条目</span></div>
        <ul>
          <li v-for="record in records.slice(0, 3)" :key="record.browserId">
            <el-icon aria-hidden="true"><FolderOpened v-if="record.kind === 'folder'" /><CollectionTag v-else /></el-icon>
            <span>{{ record.title || (record.kind === 'folder' ? '未命名目录' : '未命名书签') }}</span>
          </li>
        </ul>
        <p v-if="selectionCount > 3" class="selection-more">以及另外 {{ selectionCount - 3 }} 个条目</p>
      </div>

      <div v-if="kind !== 'move'" class="editor-field">
        <label for="bookmark-editor-title">{{ kind === 'folder' || editingFolder ? '目录名称' : '书签标题' }}<span class="required-mark" aria-hidden="true">*</span></label>
        <el-input id="bookmark-editor-title" ref="titleInput" v-model="draft.title" :placeholder="kind === 'folder' || editingFolder ? '例如：设计灵感' : '为这个网页取一个好找的名字'" :disabled="pending" size="large" autocomplete="off" :aria-invalid="!!errors.title" :aria-describedby="errors.title ? 'bookmark-editor-title-error' : undefined" aria-required="true" @input="clearError('title')" />
        <p v-if="errors.title" id="bookmark-editor-title-error" class="field-error" role="alert">{{ errors.title }}</p>
      </div>

      <div v-if="showUrl" class="editor-field">
        <label for="bookmark-editor-url">网页地址<span class="required-mark" aria-hidden="true">*</span></label>
        <el-input id="bookmark-editor-url" ref="urlInput" v-model="draft.url" placeholder="https://example.com" :disabled="pending" size="large" autocomplete="off" spellcheck="false" :aria-invalid="!!errors.url" :aria-describedby="errors.url ? 'bookmark-editor-url-error' : 'bookmark-editor-url-hint'" aria-required="true" @input="clearError('url')" />
        <p v-if="errors.url" id="bookmark-editor-url-error" class="field-error" role="alert">{{ errors.url }}</p>
        <p v-else id="bookmark-editor-url-hint" class="field-hint">{{ unchangedSpecialUrl ? '此地址不是普通网页；可保留原地址修改标题，或替换为 HTTP(S) 地址。' : '支持 HTTP 和 HTTPS 地址，保留你输入的路径与参数。' }}</p>
      </div>

      <div v-if="kind !== 'edit'" class="editor-field">
        <label for="bookmark-editor-destination">{{ kind === 'move' ? '目标目录' : '保存到' }}<span class="required-mark" aria-hidden="true">*</span></label>
        <el-select id="bookmark-editor-destination" ref="destinationInput" v-model="draft.parentId" filterable placeholder="搜索并选择目录" :disabled="pending || !destinations.length" size="large" class="destination-select" no-match-text="没有匹配的目录" no-data-text="没有可用的目录" :aria-invalid="!!errors.parentId" :aria-describedby="errors.parentId ? 'bookmark-editor-destination-error' : 'bookmark-editor-destination-hint'" aria-required="true" @change="clearError('parentId')">
          <el-option v-for="folder in destinations" :key="folder.id" :label="folder.path || folder.title || '未命名目录'" :value="folder.id">
            <span class="folder-option"><el-icon aria-hidden="true"><FolderOpened /></el-icon><span>{{ folder.path || folder.title || '未命名目录' }}</span></span>
          </el-option>
        </el-select>
        <p v-if="errors.parentId" id="bookmark-editor-destination-error" class="field-error" role="alert">{{ errors.parentId }}</p>
        <p v-else id="bookmark-editor-destination-hint" class="field-hint">{{ !destinations.length ? '没有可写入的目录。请先在浏览器中创建一个书签目录。' : destination ? `保存位置：${destination.path || destination.title || '未命名目录'}` : '请选择一个书签目录，浏览器根目录不能直接写入。' }}</p>
      </div>
      <div v-else class="current-location"><el-icon aria-hidden="true"><FolderOpened /></el-icon><div><span>当前目录</span><p>{{ currentFolder }}</p></div></div>

      <div v-if="kind === 'bookmark'" class="advice-section">
        <div class="advice-prompt"><div><strong>AI 自动归类建议</strong><p>{{ requestingAdvice ? '正在根据标题、网址和目录信息生成建议，可继续编辑或保存。' : autoEnabled ? '填写后自动建议标题和目录，采用前不会修改你的输入。' : '本地功能可直接使用；配置并测试 AI、同意元数据发送后，可开启自动建议。' }}</p></div><el-button v-if="!autoEnabled" @click="emit('open-settings')">设置 AI</el-button></div>
        <p v-if="autoEnabled && automaticRequests >= 3 && !visibleAdvice && !requestingAdvice && !adviceError" class="field-hint">本次自动建议次数已用完，仍可直接预览更改。</p>
        <p v-if="adviceError" class="field-error" role="alert">AI 建议暂不可用：{{ adviceError }} <el-button size="small" :disabled="pending || requestingAdvice" @click="requestAdvice">重试建议</el-button></p>
        <div v-if="visibleAdvice" class="advice-result" aria-live="polite">
          <span class="advice-label">AI 建议</span><strong>{{ visibleAdvice.title }}</strong><p class="advice-folder"><el-icon aria-hidden="true"><FolderOpened /></el-icon>{{ suggestedFolder?.path || suggestedFolder?.title || '建议目录已不可用' }}</p><p>{{ visibleAdvice.reason }}</p>
          <el-button size="small" :disabled="!canUseAdvice || pending" @click="useAdvice">采用建议</el-button><span v-if="!canUseAdvice" class="field-error">建议已失效，可以重新获取。</span>
        </div>
      </div>
      <el-alert v-if="serverError" :title="serverError" type="error" :closable="false" show-icon />
      <div v-if="errors.form" class="form-error" role="alert">{{ errors.form }}</div>
      <div class="preview-note"><span class="preview-dot" aria-hidden="true"></span><p>系统自动保存写入前快照，审核并确认后才会写入原生书签。</p></div>
    </form>

    <template #footer>
      <div class="editor-footer"><el-button :disabled="pending" size="large" @click="close">取消</el-button><el-button native-type="submit" form="bookmark-editor-form" type="primary" :loading="pending" size="large">预览更改<el-icon class="preview-arrow" aria-hidden="true"><ArrowRight /></el-icon></el-button></div>
    </template>
  </el-dialog>
</template>

<style scoped>
.editor-heading { display: flex; align-items: flex-start; gap: 13px; padding-right: 24px; }
.editor-heading-icon { width: 44px; height: 44px; display: grid; place-items: center; flex: 0 0 auto; border: 1px solid #e1e7fd; border-radius: 13px; background: #eef2ff; color: #5066d8; }
.editor-heading-icon svg { width: 22px; height: 22px; }
.editor-heading h2 { margin: 0; color: #25334a; font-size: 20px; line-height: 1.4; font-weight: 650; letter-spacing: -.4px; }
.editor-heading p { color: #68778e; font-size: 13px; line-height: 1.6; margin: 5px 0 0; }
.editor-form { display: grid; gap: 22px; padding: 6px 0 2px; }
.editor-field { min-width: 0; }
.editor-field label { display: block; margin-bottom: 9px; color: #34435a; font-size: 13px; font-weight: 650; }
.required-mark { color: #a24c50; margin-left: 5px; }
.editor-field :deep(.el-input__wrapper), .editor-field :deep(.el-select__wrapper) { border-radius: 9px; }
.editor-field :deep(.el-input__inner) { font-size: 14px; }
.field-hint, .field-error { font-size: 12px; line-height: 1.65; margin: 7px 1px 0; overflow-wrap: anywhere; }
.field-hint { color: #68778e; }
.field-error { color: #b3343c; }
.destination-select { width: 100%; }
.folder-option { display: flex; align-items: center; gap: 9px; }
.folder-option .el-icon { color: #8c97aa; flex-shrink: 0; }
.folder-option > span { overflow: hidden; text-overflow: ellipsis; }
.selection-summary { border: 1px solid #e6eaf2; background: #f8f9fc; border-radius: 12px; padding: 14px 16px; }
.selection-summary-heading { display: flex; align-items: center; justify-content: space-between; color: #62718a; font-size: 12px; margin-bottom: 12px; }
.selection-count { background: #e9eefc; color: #4b60b6; padding: 3px 8px; border-radius: 6px; font-weight: 600; }
.selection-summary ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 9px; }
.selection-summary li { display: flex; align-items: center; gap: 8px; color: #34435a; font-size: 13px; }
.selection-summary li > span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.selection-summary li .el-icon { color: #7688a4; flex: 0 0 auto; }
.selection-more { font-size: 12px; color: #68778e; margin: 10px 0 0 22px; }
.current-location { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border: 1px solid #e7ebf3; border-radius: 10px; background: #f8f9fc; }
.current-location > .el-icon { color: #7b89a0; margin-top: 3px; }
.current-location span { color: #68778e; font-size: 12px; }
.current-location p { margin: 4px 0 0; color: #34435a; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.form-error { padding: 11px 13px; border: 1px solid #f2d4d4; background: #fff7f6; color: #a33a40; font-size: 13px; line-height: 1.65; border-radius: 9px; }
.advice-section { border: 1px solid #e7eaf6; border-radius: 11px; padding: 13px 14px; background: #fafbff; }
.advice-prompt { display: flex; align-items: center; gap: 14px; }
.advice-prompt > div { flex: 1; }
.advice-prompt strong { color: #4d5973; font-size: 13px; }
.advice-prompt p, .advice-result p { color: #68778e; font-size: 12px; line-height: 1.65; margin: 5px 0 0; overflow-wrap: anywhere; }
.advice-result { margin-top: 12px; padding: 13px; border: 1px solid #e1e7fc; border-radius: 9px; background: #fff; }
.advice-label { display: block; color: #6477c7; font-size: 11px; margin-bottom: 7px; }
.advice-result > strong { color: #34435a; font-size: 14px; overflow-wrap: anywhere; }
.advice-result .advice-folder { display: flex; align-items: center; gap: 6px; color: #4f60a0; }
.advice-result .el-button { margin-top: 10px; }
.advice-result .field-error { display: block; }
.preview-note { display: flex; align-items: flex-start; gap: 8px; padding-top: 1px; color: #68778e; }
.preview-dot { width: 6px; height: 6px; border-radius: 50%; background: #8799ce; margin-top: 7px; flex: 0 0 auto; }
.preview-note p { margin: 0; font-size: 12px; line-height: 1.7; }
.editor-footer { display: flex; justify-content: flex-end; gap: 8px; padding-top: 2px; }
.editor-footer .el-button { margin-left: 0; border-radius: 9px; }
.preview-arrow { margin-left: 8px; }
@media (max-width: 600px) { .editor-form { gap: 18px; } .editor-heading-icon { width: 38px; height: 38px; } .editor-heading h2 { font-size: 18px; } .editor-footer .el-button { flex: 1; } }
</style>
