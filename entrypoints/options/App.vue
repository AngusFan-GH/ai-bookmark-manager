<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useBookmarkStore } from '../../src/store';
import * as workspace from '../../src/workspace-client';
import type { BookmarkRecord } from '../../src/domain/bookmarks/types';
import type { OperationPlan } from '../../src/domain/operations/types';
import type { AssistantScope } from '../../src/domain/assistant/types';
import BookmarkEditor from './components/BookmarkEditor.vue';
import { buildFolderTree, safeBookmarkHref, initialSearch, downloadableJson, canExecuteReviewedPlan, selectedOrigins, organizationSteps, describePlanStep, planStatusLabel, stepStatusLabel, stepErrorLabel, hasPlanExecutionResult, folderDisplayPath, duplicateDeleteSteps, contentResultLabel, workspaceErrorLabel } from './workspace-helpers';
import LegacyTools from './LegacyTools.vue';
type SessionView = workspace.AssistantSessionView;
const store = useBookmarkStore();
const query = ref(initialSearch(window.location.search)); const folderId = ref(''); const page = ref(1);
const section = ref<'browse'|'organize'|'conversation'>('browse'); const directoryOpen = ref(false); const historyOpen=ref(false); const toolsOpen = ref(window.location.hash === '#health'); const settingsOpen = ref(false);
const busy = ref(false); const sending = ref(false); const error = ref(''); const prompt = ref(initialSearch(window.location.search)); const scopeChoice=ref<'folder'|'all'|'selected'>('folder'); const scopeSelection=ref<BookmarkRecord[]>([]);
const session = ref<SessionView>(); const sessions = ref<Array<{id:string;title:string}>>([]); const selected = ref<BookmarkRecord[]>([]);
const settings = ref<workspace.AssistantSettingsView>({ region: 'global' as 'global'|'cn', model: 'MiniMax-M2.5', hasKey: false, consent: false, keyStorage:'session' }); const apiKey = ref('');
const settingsDraft = ref({region:'global' as 'global'|'cn',model:'MiniMax-M2.5',consent:false,excludedFolderIds:[] as string[],contentEnhancement:false,maxCompletionTokens:4096,autoSuggestions:false}); const rememberKey=ref(false); const settingsError=ref('');
const onboarding=ref(false); const settingsNotice=ref('');
const settingsSaving=ref(false);
const settingsHasUsableKey=computed(()=>!!apiKey.value.trim()||(settings.value.hasKey&&settingsDraft.value.region===settings.value.region));
const settingsDraftChanged=computed(()=>!!apiKey.value.trim()||settingsDraft.value.region!==settings.value.region||settingsDraft.value.model.trim()!==settings.value.model||settingsDraft.value.maxCompletionTokens!==(settings.value.maxCompletionTokens??4096)||rememberKey.value!==(settings.value.keyStorage==='local'));
const automaticReady=computed(()=>!!(settings.value.hasKey&&settings.value.consent&&settings.value.autoSuggestions&&settings.value.connectionTested));
const contentResults=ref<Array<{id:string;title:string;url:string;path:string;label:string}>>([]); const contentPending=ref(false);
const duplicateSelection=ref<string[]>([]); const duplicatesChecked=ref(false); const duplicateScope=ref('');
const messagesElement=ref<HTMLElement>(); const followMessages=ref(true); const canceling=ref(false);
const turnNeedsReview=ref(false);const streamingText=ref('');const pendingQuestion=ref('');const turnNotice=ref('');let turnController:AbortController|undefined;let turnGeneration=0;
const scopeName=computed(()=>scopeLabel(session.value?.scope??prospectiveScope.value));
const prospectiveScope=computed<AssistantScope>(()=>scopeChoice.value==='selected'?{bookmarkIds:scopeSelection.value.map(b=>b.id)}:scopeChoice.value==='folder'&&folderId.value?{folderId:folderId.value}:{});
function scopeLabel(scope:AssistantScope){const label=scope.bookmarkIds!==undefined?`所选 ${scope.bookmarkIds.length} 个书签`:scope.folderId?folderDisplayPath(store.folders.find(f=>f.id===scope.folderId)):'全部书签';return scope.query?`${label} · 对话筛选：${scope.query}`:label;}
const scopeDiffers=computed(()=>!!session.value&&JSON.stringify(session.value.scope)!==JSON.stringify(prospectiveScope.value));
const locked=computed(()=>busy.value||sending.value||contentPending.value);
const initialBookmark=ref<{title:string;url:string;parentFolderId?:string;destinationUnavailable?:boolean}>();const bookmarkAdvice=ref<workspace.BookmarkAdvice>();const requestingAdvice=ref(false);const editorError=ref('');const adviceError=ref('');let adviceGeneration=0;let adviceRequestId='';
function cancelBookmarkAdvice(){++adviceGeneration;if(adviceRequestId)void workspace.cancelAdvice(adviceRequestId).catch(()=>{});adviceRequestId='';requestingAdvice.value=false;bookmarkAdvice.value=undefined;adviceError.value='';}
const editorOpen=ref(false);const editorKind=ref<'bookmark'|'folder'|'edit'|'move'>('bookmark');const editorRecords=ref<BookmarkRecord[]>([]);
const writableFolders=computed(()=>store.folders.filter(f=>f.parentId!==null));
const defaultParent=computed(()=>{const captured=initialBookmark.value?.parentFolderId;return captured&&writableFolders.value.some(f=>f.id===captured||f.browserId===captured)?writableFolders.value.find(f=>f.id===captured||f.browserId===captured)!.id:folderId.value&&writableFolders.value.some(f=>f.id===folderId.value)?folderId.value:writableFolders.value[0]?.id??'';});
function openEditor(kind:'bookmark'|'folder'|'edit'|'move',records:BookmarkRecord[]=[]){if(locked.value)return;initialBookmark.value=undefined;bookmarkAdvice.value=undefined;editorError.value='';editorKind.value=kind;editorRecords.value=records.map(record=>({...record}));editorOpen.value=true;}
async function navigateExistingBookmark(browserId:string,edit:boolean){
  if(typeof browserId!=='string'||!browserId.trim()||browserId.length>200||[...browserId].some(char=>char.charCodeAt(0)<32))throw new Error('书签引用无效，请重新检查收藏状态。');
  const nodes=await chrome.bookmarks.get(browserId);const node=nodes[0];
  if(!node?.url||node.id!==browserId||!node.parentId)throw new Error('这条收藏已移动或删除，请重新检查收藏状态。');
  await store.sync();await refresh();
  const record:BookmarkRecord={id:node.id,browserId:node.id,kind:'bookmark',parentId:node.parentId,index:node.index??0,title:node.title,url:node.url,path:folderDisplayPath(store.folders.find(f=>f.id===node.parentId)),updatedAt:Date.now(),syncGeneration:0};
  cancelBookmarkAdvice();stopAutomatic();initialBookmark.value=undefined;
  if(edit){editorKind.value='edit';editorRecords.value=[record];editorError.value='';editorOpen.value=true;}
  else{editorOpen.value=false;folderId.value=node.parentId;query.value=node.url;section.value='browse';}
}
async function openExistingBookmark(browserId:string,edit:boolean){if(locked.value)return;busy.value=true;try{await navigateExistingBookmark(browserId,edit);}catch(e){editorError.value=workspaceErrorLabel(e);error.value=editorError.value;}finally{busy.value=false;}}
function isEditable(row:BookmarkRecord){return !!row.parentId && !store.folders.some(f=>f.id===row.parentId&&f.parentId===null);}
async function prepareManual(input:workspace.OrganizationInput){if(locked.value)return;stopAutomatic();cancelBookmarkAdvice();busy.value=true;editorError.value='';try{plan.value=await workspace.prepareOrganization(input);editorOpen.value=false;section.value='organize';}catch(e){editorError.value=workspaceErrorLabel(e);}finally{busy.value=false;}}
async function requestBookmarkAdvice(input:{title:string;url:string;parentFolderId?:string}){if(locked.value||!automaticReady.value)return;cancelBookmarkAdvice();const generation=adviceGeneration;const requestId=crypto.randomUUID();adviceRequestId=requestId;requestingAdvice.value=true;try{const result=await workspace.adviseBookmark(input,{automatic:true,requestId});if(generation===adviceGeneration&&editorOpen.value)bookmarkAdvice.value=result;}catch(e){if(generation===adviceGeneration)adviceError.value=workspaceErrorLabel(e);}finally{if(generation===adviceGeneration){requestingAdvice.value=false;adviceRequestId='';}}}
function localSearch(){const scope={...prospectiveScope.value,...(prospectiveScope.value.bookmarkIds?{bookmarkIds:[...prospectiveScope.value.bookmarkIds]}:{})};query.value=prompt.value.trim();section.value='browse';void nextTick(()=>queueAutomatic('search',false,scope));}
function clearSearch(){query.value='';prompt.value='';}
async function startTask(text='',records:BookmarkRecord[]=[]){if(locked.value||!await confirmDraft())return;session.value=undefined;turnNotice.value='';turnNeedsReview.value=false;focusedMessage.value='';scopeSelection.value=records.filter(r=>r.kind==='bookmark').map(r=>({...r}));scopeChoice.value=scopeSelection.value.length?'selected':'folder';prompt.value=text;section.value='conversation';followMessages.value=true;}
watch(selected,rows=>{if(scopeChoice.value==='selected')scopeSelection.value=rows.filter(b=>b.kind==='bookmark').map(b=>({...b}));});
function chooseScope(value:'folder'|'all'|'selected'){scopeChoice.value=value;if(value==='selected')scopeSelection.value=selected.value.filter(b=>b.kind==='bookmark').map(b=>({...b}));}
function showSuggestions(messageId:string){focusedMessage.value=messageId;section.value='organize';}
const suggestedMoves=ref<Array<{bookmarkId:string;targetFolderId:string;reason:string}>>([]);
const suggestedFolders=ref<Array<{proposalId:string;title:string;parentFolderId:string}>>([]);
watch(settingsOpen,open=>{if(open){settingsDraft.value={region:settings.value.region,model:settings.value.model,consent:settings.value.consent,excludedFolderIds:[...(settings.value.excludedFolderIds??[])],contentEnhancement:settings.value.contentEnhancement??false,maxCompletionTokens:settings.value.maxCompletionTokens??4096,autoSuggestions:settings.value.autoSuggestions??false};settingsNotice.value='';apiKey.value='';rememberKey.value=settings.value.keyStorage==='local';settingsError.value='';}});
watch(()=>settingsDraft.value.region,(region,previous)=>{if(region!==previous)apiKey.value='';});
function trackScroll(){const element=messagesElement.value;if(element)followMessages.value=element.scrollHeight-element.scrollTop-element.clientHeight<100;}
async function scrollMessages(){await nextTick();if(followMessages.value&&messagesElement.value)messagesElement.value.scrollTop=messagesElement.value.scrollHeight;}
watch(()=>[session.value?.messages.length,sending.value,streamingText.value],()=>void scrollMessages());
function invalidateDuplicates(){duplicates.value=[];duplicateSelection.value=[];duplicatesChecked.value=false;duplicateScope.value='';}
watch(folderId,invalidateDuplicates);
watch(()=>store.stats.lastSync,invalidateDuplicates);
const plan = ref<OperationPlan>(); const backedUp = ref(false); const reviewed = ref(false); const deleteConfirmation = ref(''); const executedPlanIds = ref(new Set<string>());
const applied = computed(()=>hasPlanExecutionResult(plan.value,executedPlanIds.value));
const duplicates = ref<Array<{url:string;bookmarks:BookmarkRecord[]}>>([]); const history = ref<Array<{id:string;title:string;status:string;createdAt:number;stepCount:number}>>([]);
const tree = computed(() => buildFolderTree(store.folders));
const currentFolder = computed(() => folderId.value?folderDisplayPath(store.folders.find(f => f.id === folderId.value)):'全部书签');
const toolsTab=ref<'bookmarks'|'health'>(window.location.hash==='#health'?'health':'bookmarks');
function openTools(tab:'bookmarks'|'health'='bookmarks'){toolsTab.value=tab;toolsOpen.value=true;}
async function prepareHealthDelete(rows:BookmarkRecord[]){if(busy.value||sending.value)return;await run(async()=>{plan.value=await workspace.prepareOrganization({title:'移除选中的失效书签',steps:rows.filter(b=>b.kind==='bookmark').map(b=>({action:'delete' as const,targetBrowserId:b.browserId,reason:'用户从链接健康报告明确选择'}))});section.value='organize';toolsOpen.value=false;});}
const focusedMessage = ref('');
const focusedAssistant = computed(() => session.value?.messages.find(m=>m.id===focusedMessage.value) ?? [...(session.value?.messages ?? [])].reverse().find(m=>m.role==='assistant'));
const moves = computed(() => suggestedMoves.value);
const selectedMoves = ref<string[]>([]);
watch(focusedAssistant,()=>{suggestedMoves.value=(focusedAssistant.value?.moves??[]).map(item=>({...item}));suggestedFolders.value=(focusedAssistant.value?.folders??[]).map(item=>({...item}));selectedMoves.value=suggestedMoves.value.map(m=>m.bookmarkId);selectedEdits.value=[];selectedDeletions.value=[];});
const selectedEdits=ref<string[]>([]);const selectedDeletions=ref<string[]>([]);
const suggestedEdits=computed(()=>focusedAssistant.value?.edits??[]);const suggestedDeletions=computed(()=>focusedAssistant.value?.deletions??[]);
watch([selectedMoves,suggestedMoves,suggestedFolders,selectedEdits,selectedDeletions],()=>{if(plan.value?.title==='AI 目录整理建议'&&!applied.value)plan.value=undefined;},{deep:true});
watch(duplicateSelection,()=>{if(plan.value?.title==='移除选中的重复书签'&&!applied.value)plan.value=undefined;});
function moveDestination(id:string) {const proposed=suggestedFolders.value.find(f=>f.proposalId===id);if(proposed){const parent=store.folders.find(f=>f.id===proposed.parentFolderId);return `${folderDisplayPath(parent)} / ${proposed.title}（新建）`;}return folderDisplayPath(store.folders.find(f=>f.id===id));}
function bookmarkTitle(id:string){return store.rows.find(b=>b.id===id)?.title||session.value?.citations?.find(c=>c.bookmarkId===id)?.title||`书签 ${id}`;}
const planCards=computed(()=>(plan.value?.steps??[]).map(step=>({step,view:describePlanStep(step,plan.value?.steps??[],store.folders,[...store.rows,...(session.value?.citations??[]).map(c=>({id:c.bookmarkId,title:c.title,url:c.url,path:c.path}))])})));
const executionCounts=computed(()=>({succeeded:plan.value?.steps.filter(s=>s.status==='succeeded').length??0,failed:plan.value?.steps.filter(s=>s.status==='failed').length??0,compensated:plan.value?.steps.filter(s=>s.status==='compensated').length??0,skipped:plan.value?.steps.filter(s=>s.status==='skipped').length??0}));
const hasDeletes = computed(() => plan.value?.steps.some(s => s.action === 'delete') ?? false);
const canApply = computed(() => canExecuteReviewedPlan({status:plan.value?.status,stepCount:plan.value?.steps.length??0,applied:applied.value,backedUp:!!plan.value?.metadata['plan-service.snapshot'],reviewed:reviewed.value,hasDeletes:hasDeletes.value,deleteConfirmation:deleteConfirmation.value,busy:busy.value||sending.value||contentPending.value}));
let timer: ReturnType<typeof setTimeout> | undefined;
async function run(action:()=>Promise<void>) { if(busy.value||sending.value||contentPending.value)return;error.value=''; busy.value=true; try { await action(); } catch(e) {error.value=workspaceErrorLabel(e);} finally {busy.value=false;} }
let refreshQueue=Promise.resolve();let refreshVersion=0;
async function refresh() {const version=++refreshVersion;const args=[query.value,folderId.value||undefined,(page.value-1)*200] as const;refreshQueue=refreshQueue.catch(()=>{}).then(async()=>{if(version===refreshVersion)await store.load(...args);});await refreshQueue;}
watch([query,folderId],()=>{page.value=1; selected.value=[]; if(timer)clearTimeout(timer); timer=setTimeout(()=>void refresh(),200);});
watch(page,()=>void refresh());
watch(plan,()=>{backedUp.value=false;reviewed.value=false;deleteConfirmation.value='';},{deep:true});
function pickFolder(node:{id:string}) {folderId.value=node.id;section.value='browse';directoryOpen.value=false;}
async function copy(url:string) { try {await navigator.clipboard.writeText(url);ElMessage.success('原始 URL 已复制');}catch{ElMessage.error('无法复制，请从详情中选择原始 URL');} }
function download(data:unknown,name:string) {const url=URL.createObjectURL(downloadableJson(data));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);}
async function confirmDraft(){if(!prompt.value.trim())return true;try{await ElMessageBox.confirm('当前消息尚未发送。继续会清空草稿，并切换到新的对话。','切换对话',{confirmButtonText:'清空草稿并继续',cancelButtonText:'保留草稿'});return true;}catch{return false;}}
async function newSession(){if(locked.value||!await confirmDraft())return;session.value=undefined;turnNotice.value='';turnNeedsReview.value=false;focusedMessage.value='';prompt.value='';section.value='conversation';followMessages.value=true;}
async function switchSession(id:string) {if(locked.value||!await confirmDraft())return;await run(async()=>{session.value=await workspace.getSession(id);turnNotice.value='';turnNeedsReview.value=false;focusedMessage.value='';prompt.value='';followMessages.value=true;section.value='conversation';historyOpen.value=false;});}
async function send() {
  if(!prompt.value.trim()||locked.value||turnNeedsReview.value)return;stopAutomatic();
  if(!settings.value.hasKey||!settings.value.consent){settingsOpen.value=true;return;}
  if(!session.value&&scopeChoice.value==='selected'&&!scopeSelection.value.length){error.value='请先在浏览结果中选择要询问的书签。';return;}
  if(!session.value&&scopeChoice.value==='selected'&&scopeSelection.value.length>60){error.value='AI 每次最多使用 60 个明确选择的书签，请减少选择或改用目录范围。';return;}
  error.value='';turnNotice.value='';sending.value=true;streamingText.value='';const text=prompt.value.trim();pendingQuestion.value=text;const scope={...prospectiveScope.value};followMessages.value=true;section.value='conversation';
  const controller=new AbortController();turnController=controller;const generation=++turnGeneration;let acceptingText=true;
  try {
    if(!session.value){const created=await workspace.createSession({mode:'assist',scope});if(generation!==turnGeneration)return;if(controller.signal.aborted){turnNotice.value='已停止生成，问题已保留，可以修改后重试。';return;}session.value=created;}
    const id=session.value.id;
    const result=await workspace.sendTurn(id,text,{expectedRevision:session.value.revision,signal:controller.signal,onText:partial=>{if(acceptingText&&generation===turnGeneration&&!controller.signal.aborted){streamingText.value=partial;}}});
    if(generation!==turnGeneration)return;
    if(controller.signal.aborted)turnNotice.value='回答已在停止前完成，已保留完整结果。';
    acceptingText=false;session.value=result;streamingText.value='';pendingQuestion.value='';prompt.value='';focusedMessage.value='';sessions.value=await workspace.listSessions();
  } catch(e){if(generation===turnGeneration){const message=e instanceof Error?e.message:String(e);turnNotice.value='';if(controller.signal.aborted&&/^(Request cancel(?:ed|led)\.?|请求已停止|canceled|cancelled)$/i.test(message))turnNotice.value='已停止生成，问题已保留，可以修改后重试。';else{turnNeedsReview.value=message==='无法确认本次回答是否已保存，请重新打开对话核对后再发送。';error.value=workspaceErrorLabel(e);}}}
  finally{acceptingText=false;if(generation===turnGeneration){streamingText.value='';pendingQuestion.value='';sending.value=false;canceling.value=false;turnController=undefined;}}
}
function cancel() {if(!sending.value||canceling.value)return;canceling.value=true;streamingText.value='';turnNotice.value='正在停止并核对保存状态…';turnController?.abort();}
async function reviewCurrentTurn(){if(!session.value||locked.value)return;const id=session.value.id;await run(async()=>{session.value=await workspace.getSession(id);turnNeedsReview.value=false;turnNotice.value='已载入最新对话，请先核对回复，再决定是否发送保留的问题。';});}
async function saveSettings(testConnection=false) {
  if(busy.value||sending.value)return;settingsError.value='';settingsNotice.value='';
  if(!settingsDraft.value.model.trim()){settingsError.value='请输入模型名称。';return;}
  if(!Number.isInteger(settingsDraft.value.maxCompletionTokens)||settingsDraft.value.maxCompletionTokens<1024||settingsDraft.value.maxCompletionTokens>16384){settingsError.value='输出 token 上限需为 1024 至 16384 之间的整数。';return;}
  if(settingsDraft.value.autoSuggestions&&!settingsDraft.value.consent){settingsError.value='开启自动建议前，请先确认下面的数据发送说明。';return;}
  if(testConnection&&!settingsHasUsableKey.value){settingsError.value='请先输入所选区域的 API Key，再测试连接。';return;}
  busy.value=true;settingsSaving.value=true;stopAutomatic();cancelBookmarkAdvice();let saved=false;let phase:'saving'|'loading'|'testing'|'finishing'='saving';
  try {
    const draft={...settingsDraft.value,model:settingsDraft.value.model.trim()};
    if(draft.consent||testConnection){const granted=await chrome.permissions.request({origins:[draft.region==='cn'?'https://api.minimax.cn/*':'https://api.minimax.io/*']});if(!granted){settingsError.value='未授予所选 MiniMax 服务的网络权限，设置未保存。';return;}}
    const privacyChanged=JSON.stringify([...draft.excludedFolderIds].sort())!==JSON.stringify([...(settings.value.excludedFolderIds??[])].sort());
    await workspace.saveAssistantSettings({...draft,keyStorage:rememberKey.value?'local':'session',...(apiKey.value.trim()?{apiKey:apiKey.value.trim()}:{})});
    saved=true;phase='loading';apiKey.value='';settings.value=await workspace.getAssistantSettings();
    if(privacyChanged){session.value=undefined;turnNeedsReview.value=false;turnNotice.value='';focusedMessage.value='';}
    if(testConnection){phase='testing';settings.value=await workspace.testAssistantConnection();settingsNotice.value='连接测试通过。现在可以收藏、搜索或进入整理，AI 会按你的设置自动提供建议。';}
    if(onboarding.value||testConnection){phase='finishing';await workspace.completeOnboarding();settings.value={...settings.value,onboardingCompleted:true};onboarding.value=false;}
    settingsOpen.value=false;ElMessage.success(testConnection?'连接测试通过，设置已保存':'AI 设置已保存');
  }catch(e){if(testConnection&&phase==='testing'){settings.value={...settings.value,connectionTested:false};try{settings.value=await workspace.getAssistantSettings();}catch{/* Keep the conservative unverified state. */}}settingsError.value=workspaceErrorLabel(e);if(testConnection)settingsError.value+=!saved?' 设置未保存，请检查后重试。':phase==='testing'?' 设置已保存，但连接测试未通过。请检查密钥、区域、模型和账户额度后重新测试。':phase==='finishing'?' 连接测试已通过，但未能完成引导。可稍后重试或先使用本地功能。':' 设置已保存，但无法读取最新状态。请关闭设置后重新打开核对。';}
  finally{busy.value=false;settingsSaving.value=false;}
}
async function skipOnboarding(){if(busy.value)return;busy.value=true;try{await workspace.completeOnboarding();settings.value={...settings.value,onboardingCompleted:true};onboarding.value=false;settingsOpen.value=false;}catch(e){settingsError.value=workspaceErrorLabel(e);}finally{busy.value=false;}}
async function clearKey(){if(busy.value||sending.value)return;stopAutomatic();cancelBookmarkAdvice();busy.value=true;settingsError.value='';try{await workspace.clearAssistantKey();apiKey.value='';settings.value=await workspace.getAssistantSettings();}catch(e){settingsError.value=workspaceErrorLabel(e);}finally{busy.value=false;}}
async function checkDuplicates(){const scope=folderId.value;await run(async()=>{invalidateDuplicates();const result=await workspace.analyzeDuplicates(scope||undefined);if(scope!==folderId.value)return;duplicates.value=result.groups;duplicatesChecked.value=true;duplicateScope.value=currentFolder.value;});}
function duplicateDisabled(group:{bookmarks:BookmarkRecord[]},id:string){return !duplicateSelection.value.includes(id)&&group.bookmarks.filter(b=>!duplicateSelection.value.includes(b.id)).length<=1;}
async function prepareDuplicates(){await run(async()=>{plan.value=await workspace.prepareOrganization({title:'移除选中的重复书签',steps:duplicateDeleteSteps(duplicates.value,duplicateSelection.value)});});}
async function prepareMoves() {await run(async()=>{const steps=organizationSteps(moves.value,suggestedFolders.value,selectedMoves.value);
for(const edit of suggestedEdits.value.filter(item=>selectedEdits.value.includes(item.bookmarkId)))steps.push({action:'update',targetBrowserId:edit.bookmarkId,desiredAfter:{title:edit.title},reason:edit.reason});
for(const deletion of suggestedDeletions.value.filter(item=>selectedDeletions.value.includes(item.bookmarkId)))steps.push({action:'delete',targetBrowserId:deletion.bookmarkId,reason:deletion.reason});plan.value=await workspace.prepareOrganization({title:'AI 目录整理建议',steps});section.value='organize';});}
async function prepareDelete(records:BookmarkRecord[]=selected.value) {if(!records.length)return;const targets=records.filter(isEditable).map(b=>({...b}));if(!targets.length)return;await run(async()=>{plan.value=await workspace.prepareOrganization({title:'删除选中的书签或目录',steps:targets.map(b=>({action:'delete' as const,targetBrowserId:b.browserId,reason:'用户在工作台明确选择'}))});section.value='organize';});}
async function backupPlan() {await run(async()=>{if(!plan.value)return;const data=await workspace.exportPlanBackup(plan.value.id);download(data,`bookmark-plan-${plan.value.id}.json`);backedUp.value=true;});}
async function applyPlan() {if(!canApply.value||!plan.value)return;await run(async()=>{const id=plan.value!.id;reviewed.value=false;const approval=await store.approve(id);const result=await store.execute(id,approval.token);executedPlanIds.value.add(id);if(result.syncWarning)error.value=result.syncWarning;reviewed.value=false;await refresh();plan.value=await store.getPlan(id);ElMessage.info(`执行结果：${planStatusLabel(result.status)}。${result.succeeded} 项成功，${result.failed} 项失败，${result.compensated} 项已补偿。请在历史中查看各步骤。`);});}
async function openHistory() {historyOpen.value=true;await run(async()=>{history.value=(await workspace.listHistory()).map(item=>({...item,id:item.planId}));});}
async function viewHistory(id:string){await run(async()=>{plan.value=await store.getPlan(id);section.value='organize';historyOpen.value=false;});}
async function prepareRestore(id:string){await run(async()=>{plan.value=await workspace.prepareRecovery(id);section.value='organize';historyOpen.value=false;});}
async function extractContent() {
  if(busy.value||sending.value||contentPending.value)return;
  const targets=selected.value.filter(b=>b.kind==='bookmark').map(b=>({...b}));
  if(!targets.length)return;
  if(targets.length>50){error.value='每次最多读取 50 个书签。请减少选择后再试。';return;}
  const origins=selectedOrigins(targets.map(b=>b.url));
  if(!origins.length){error.value='所选书签中没有可读取的 HTTP(S) 地址。';return;}
  contentPending.value=true;error.value='';
  try {
    try{await ElMessageBox.confirm(`将访问选中的 ${targets.length} 个书签网页，提取有长度限制的文本。不会读取登录信息；网站将收到网络请求。是否继续？`,'读取书签内容',{confirmButtonText:'读取所选页面',cancelButtonText:'取消',type:'warning'});}catch{return;}
    const granted=await chrome.permissions.request({origins});if(!granted){error.value='未授予所选网站的访问权限，未读取页面。';return;}
    const result=await workspace.fetchContent(targets.map(b=>b.id));
    contentResults.value=targets.map(b=>{const r=result.results.find(item=>item.bookmarkId===b.id);return {id:b.id,title:b.title||'未命名书签',url:b.url||'',path:b.path||'根目录',label:contentResultLabel(r?.status??'unavailable',r?.reason)};});
  }catch(e){error.value=workspaceErrorLabel(e);}finally{contentPending.value=false;}
}
async function inspectContent(){const targets=selected.value.filter(b=>b.kind==='bookmark').map(b=>({...b}));if(!targets.length||locked.value)return;if(targets.length>50){error.value='每次最多查看 50 个书签的内容状态。';return;}await run(async()=>{const result=await workspace.getContentStatus(targets.map(b=>b.id));contentResults.value=targets.map(b=>{const r=result.results.find(item=>item.bookmarkId===b.id);return{id:b.id,title:b.title||'未命名书签',url:b.url||'',path:b.path||'根目录',label:r?contentResultLabel(r.status,r.reason):'尚未读取内容'};});});}
async function clearExtractedContent(){const targets=contentResults.value.map(r=>({...r}));if(!targets.length||locked.value)return;await run(async()=>{await workspace.clearContent(targets.map(r=>r.id));contentResults.value=targets.map(r=>({...r,label:'已清除提取文本；已发送的历史对话不会因此删除'}));});}
function visibility(){if(!document.hidden)void refresh();}
function hashChange(){if(window.location.hash==='#health')openTools('health');if(window.location.hash==='#settings')settingsOpen.value=true;}
watch(toolsOpen,open=>{if(!open)void refresh();});
function persistLocation(){const url=new URL(window.location.href);if(query.value)url.searchParams.set('q',query.value);else url.searchParams.delete('q');if(session.value)url.searchParams.set('session',session.value.id);else url.searchParams.delete('session');window.history.replaceState(null,'',url.pathname+url.search+url.hash);}
watch([query,()=>session.value?.id],persistLocation);
watch(editorOpen,open=>{if(!open){const url=new URL(window.location.href);url.searchParams.delete('capture');window.history.replaceState(null,'',url.pathname+url.search+url.hash);initialBookmark.value=undefined;bookmarkAdvice.value=undefined;editorError.value='';}});
const automaticSession=ref<SessionView>();const automaticBusy=ref(false);const automaticError=ref('');const automaticLabel=ref('');const automaticScopeDescription=ref('');
let lastAutomaticRequest:{kind:'search'|'organize';scope:AssistantScope}|undefined;
let automaticTimer:ReturnType<typeof setTimeout>|undefined;let automaticGeneration=0;let automaticSessionId='';let automaticCount=0;const attemptedContexts=new Set<string>();
function stopAutomatic(clear=true){++automaticGeneration;clearTimeout(automaticTimer);if(automaticSessionId)void workspace.cancelTurn(automaticSessionId).catch(()=>{});automaticSessionId='';automaticBusy.value=false;if(clear){automaticSession.value=undefined;automaticError.value='';lastAutomaticRequest=undefined;}}
function queueAutomatic(kind:'search'|'organize',retry=false,requestedScope:AssistantScope={...prospectiveScope.value}){
  stopAutomatic();if(!automaticReady.value||settingsOpen.value||editorOpen.value||toolsOpen.value)return;
  if(kind==='search'&&!query.value.trim())return;
  lastAutomaticRequest={kind,scope:{...requestedScope,...(requestedScope.bookmarkIds?{bookmarkIds:[...requestedScope.bookmarkIds]}:{})}};
  if(automaticCount>=6){automaticError.value='本次工作台已达到 6 次自动建议上限；仍可使用“询问 AI”继续。';return;}
  const generation=automaticGeneration;automaticLabel.value=kind==='search'?'搜索建议':'整理建议';
  automaticTimer=setTimeout(async()=>{
    if(generation!==automaticGeneration||!automaticReady.value||locked.value)return;
    try{await refresh();}catch(e){if(generation===automaticGeneration)automaticError.value=workspaceErrorLabel(e);return;}if(generation!==automaticGeneration)return;
    const available=(selected.value.length?selected.value:store.rows).filter(b=>b.kind==='bookmark'&&safeBookmarkHref(b.url));
    if(kind==='organize'&&selected.value.length&&available.length>20){automaticError.value='已选择超过 20 个书签。请减少选择后重新进入整理；没有发送任何书签。';return;}
    const chosen=available.slice(0,20);
    if(kind==='organize'&&!chosen.length)return;
    const scope:AssistantScope=kind==='organize'?{bookmarkIds:chosen.map(b=>b.id)}:requestedScope;
    if(scope.bookmarkIds!==undefined&&(!scope.bookmarkIds.length||scope.bookmarkIds.length>60)){automaticError.value='搜索的明确选择范围需为 1–60 个书签。请重新选择范围后搜索；没有发送任何书签。';return;}
    automaticScopeDescription.value=kind==='organize'?`${selected.value.length?'所选':'当前页'} ${chosen.length} / ${available.length} 个书签${available.length>20?'（仅前 20 个，其余未发送）':''}`:scopeLabel(scope);
    const context=JSON.stringify([kind,query.value,scope,page.value,automaticDataFingerprint.value,settings.value]);
    if(!retry&&attemptedContexts.has(context))return;
    const text=kind==='search'?`根据搜索“${query.value.trim().slice(0,500)}”，推荐最相关的收藏并简要说明用途。仅推荐，不提出更改。`:'为这批书签提供简短的标题和目录整理建议。不要删除，不要执行任何更改。';
    automaticBusy.value=true;attemptedContexts.add(context);automaticCount++;
    try{const created=await workspace.createSession({mode:kind==='search'?'recommend':'organize',scope});
      if(generation!==automaticGeneration)return;automaticSessionId=created.id;
      const result=await workspace.sendTurn(created.id,text,{automatic:true});
      if(generation!==automaticGeneration)return;automaticSession.value=result;
    }catch(e){if(generation===automaticGeneration)automaticError.value=workspaceErrorLabel(e);}
    finally{if(generation===automaticGeneration){automaticBusy.value=false;automaticSessionId='';}}
  },800);
}
function retryAutomatic(){const request=lastAutomaticRequest;if(request)queueAutomatic(request.kind,true,request.scope);}
function reviewAutomatic(){if(!automaticSession.value||locked.value)return;session.value=automaticSession.value;turnNeedsReview.value=false;turnNotice.value='';focusedMessage.value='';section.value=automaticLabel.value==='整理建议'?'organize':'conversation';}
const automaticMessage=computed(()=>automaticSession.value?.messages.filter(m=>m.role==='assistant').at(-1));
watch([query,folderId,page,scopeChoice,()=>selected.value.map(b=>b.id).join('|')],()=>stopAutomatic());
const automaticDataFingerprint=computed(()=>JSON.stringify([store.stats.lastSync,store.rows.map(b=>[b.id,b.title,b.url,b.path,b.parentId]),store.folders.map(f=>[f.id,f.title,f.path,f.parentId])]));
watch(automaticDataFingerprint,()=>{attemptedContexts.clear();if(automaticBusy.value||automaticSession.value)stopAutomatic();});
watch(settings,()=>{attemptedContexts.clear();stopAutomatic();},{deep:true});
watch(section,(value,previous)=>{stopAutomatic();if(value==='organize'&&previous!=='organize'&&!plan.value&&!focusedAssistant.value)queueAutomatic('organize');});
watch([settingsOpen,editorOpen,toolsOpen],values=>{if(values.some(Boolean))stopAutomatic();});
watch(automaticReady,ready=>{if(!ready){stopAutomatic();cancelBookmarkAdvice();}});
onMounted(async()=>{
  await run(async()=>{await refresh();if(!store.stats.lastSync){await store.sync();await refresh();}settings.value=await workspace.getAssistantSettings();if(settings.value.onboardingCompleted===false){onboarding.value=true;settingsOpen.value=true;}else if(window.location.hash==='#settings'||new URLSearchParams(window.location.search).get('settings')==='ai')settingsOpen.value=true;sessions.value=await workspace.listSessions();
    const params=new URLSearchParams(window.location.search);const capture=params.get('capture');const sessionId=params.get('session');const editId=params.get('edit');const viewId=params.get('view');
    if(capture){const captured=await workspace.getCapture(capture);if(captured){initialBookmark.value=captured;if(captured.destinationUnavailable||(captured.parentFolderId&&!writableFolders.value.some(f=>f.id===captured.parentFolderId||f.browserId===captured.parentFolderId)))editorError.value='原先选择的目录已不可用，请重新确认目标目录。';editorKind.value='bookmark';editorOpen.value=true;}else error.value='此收藏草稿已过期，请从原网页重新点击收藏，或手动输入网址。';}
    if(editId||viewId){await navigateExistingBookmark((editId||viewId)!,!!editId);const url=new URL(window.location.href);url.searchParams.delete('edit');url.searchParams.delete('view');window.history.replaceState(null,'',url.pathname+url.search+url.hash);}
    if(sessionId){session.value=await workspace.getSession(sessionId);prompt.value='';section.value='conversation';}
  });
  document.addEventListener('visibilitychange',visibility);window.addEventListener('hashchange',hashChange);
});
onUnmounted(()=>{++turnGeneration;turnController?.abort();stopAutomatic();cancelBookmarkAdvice();if(timer)clearTimeout(timer);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('hashchange',hashChange);});
</script>
<template>
<div class="workspace">
  <header class="topbar">
    <a class="brand" href="#" @click.prevent="section='browse'"><span class="brand-mark">B</span><span><strong>Bookmark Workspace</strong><small>收藏有序，随时用得上</small></span></a>
    <nav class="header-actions" aria-label="工作台工具">
      <details class="utility-menu">
        <summary>更多工具</summary>
        <div class="utility-actions" aria-label="备份、恢复与维护">
          <el-button text :disabled="locked" @click="openHistory">历史与恢复</el-button>
          <el-button text @click="openTools()">导入 / 导出</el-button>
          <el-button text @click="openTools('health')">链接健康</el-button>
          <el-button text :disabled="locked" @click="run(async()=>{await store.sync();await refresh();})">刷新原生书签</el-button>
        </div>
      </details>
      <el-button :disabled="locked" @click="settingsOpen=true">AI 设置</el-button>
    </nav>
  </header>
  <main class="main-pane">
    <section class="goal-panel" aria-label="书签任务入口">
      <div class="hero-heading"><div><h1>今天，想用收藏做什么？</h1></div><span class="local-badge">本地原生书签 · {{store.stats.bookmarks}} 个</span></div>
      <form class="goal-form" @submit.prevent="section==='conversation'?send():localSearch()">
        <label class="sr-only" for="workspace-goal">搜索书签或描述你的目标</label>
        <el-input id="workspace-goal" v-model="prompt" type="textarea" :rows="2" maxlength="8000" resize="none" aria-label="搜索书签或描述你的目标" placeholder="搜索标题、网址，或问：用我的收藏，帮我规划 Vue 入门学习…" :disabled="sending" @keydown.ctrl.enter.prevent="send" @keydown.meta.enter.prevent="send"/>
        <div class="goal-actions"><small>{{automaticReady?'搜索后自动补充 AI 建议 · 可在设置中关闭':'本地搜索不会发送数据 · Ctrl / ⌘ + Enter 询问 AI'}}</small><div><el-button :type="section==='conversation'?'default':'primary'" :disabled="locked" @click="localSearch">本地搜索</el-button><el-button v-if="sending" :loading="canceling" @click="cancel">取消生成</el-button><el-button v-else :type="section==='conversation'?'primary':'default'" :disabled="!prompt.trim()||locked||turnNeedsReview" @click="send">{{session?'继续对话':'询问 AI'}}</el-button></div></div>
      </form>
      <div class="task-context">
        <span>AI 范围：</span><el-select :model-value="scopeChoice" aria-label="新任务的书签范围" :disabled="locked" @change="chooseScope"><el-option :label="`当前目录：${currentFolder}`" value="folder"/><el-option label="全部书签" value="all"/><el-option :label="`所选书签（${selected.filter(b=>b.kind==='bookmark').length}）`" value="selected" :disabled="!selected.some(b=>b.kind==='bookmark')"/></el-select>
        <span class="muted">{{scopeLabel(prospectiveScope)}}{{scopeChoice==='selected'?'':' · 包含子目录'}}，搜索关键词不限制 AI 范围</span><details v-if="scopeChoice==='selected'&&scopeSelection.length" class="scope-selection"><summary>查看所选范围</summary><p v-for="item in scopeSelection" :key="item.id">{{item.title||'未命名书签'}} · {{item.path||'根目录'}}</p></details>
        <el-button v-if="session" text :disabled="locked" @click="newSession">新任务</el-button>
      </div>
      <div v-if="scopeDiffers" class="scope-warning" role="status">当前对话仍使用“{{scopeName}}”。要使用新的范围，请点“新任务”；继续对话不会偷偷切换范围。</div>
      <p v-if="!settings.hasKey||!settings.consent" class="setup-notice">AI 尚未配置或会话密钥已失效。<button class="text-button" :disabled="locked" @click="settingsOpen=true">配置 MiniMax</button> · 浏览、收藏和手动管理可直接使用。</p>
      <p v-if="settings.hasKey&&settings.consent&&!automaticReady" class="setup-notice">{{settings.autoSuggestions?'当前连接尚未测试，自动建议暂未启动。':'自动建议尚未开启。'}}<button class="text-button" @click="settingsOpen=true">{{settings.autoSuggestions?'测试连接':'开启自动建议'}}</button> · 仍可手动询问 AI。</p>
      <nav class="quick-actions" aria-label="常用任务">
        <button :disabled="locked" @click="openEditor('bookmark')"><span>＋</span> 收藏网址</button>
        <button :class="{active:section==='browse'}" @click="section='browse'"><span>▦</span> 浏览书签</button>
        <button :class="{active:section==='organize'}" @click="section='organize'"><span>⇄</span> 整理书签 <small v-if="plan">{{plan.steps.length}}</small></button>
        <button v-if="session" :class="{active:section==='conversation'}" @click="section='conversation'"><span>✦</span> 当前对话</button>
      </nav>
    </section>

    <el-alert v-if="error||store.error" :title="error||(store.error?workspaceErrorLabel(store.error):'')" type="error" show-icon :closable="false" class="error"/>

    <aside v-if="(automaticBusy||automaticMessage||automaticError)&&section!=='conversation'" class="automatic-card" aria-label="自动 AI 建议" aria-live="polite">
      <strong>✦ {{automaticLabel||'自动 AI 建议'}}</strong><p v-if="automaticScopeDescription" class="muted">本次范围：{{automaticScopeDescription}}</p><p v-if="automaticBusy">正在自动生成建议…你可以继续浏览，或取消本次生成。</p><p v-if="automaticMessage">{{automaticMessage.text}}</p><p v-if="automaticError" class="muted">{{automaticError}} 不会自动重试；本地功能仍可使用。</p>
      <p class="muted">仅发送当前任务的查询、候选标题、网址和目录；不会读取网页正文。整理每次最多 20 个，搜索最多 60 个。实际更改仍需预览并确认。</p>
      <el-button v-if="automaticBusy" @click="stopAutomatic()">取消本次建议</el-button><el-button v-if="automaticMessage" @click="reviewAutomatic">查看建议详情</el-button><el-button v-if="automaticError" @click="retryAutomatic">重试本次建议</el-button>
    </aside>
    <section v-if="section==='browse'" class="results-panel" aria-label="浏览书签">
      <div class="section-heading"><div><h2>{{currentFolder}}</h2><p class="muted">{{query?`搜索“${query}” · `:''}}{{store.total}} 条记录{{folderId?' · 包含当前目录和全部子目录':''}}</p></div><div class="button-row"><el-button @click="directoryOpen=true">选择目录</el-button><el-button :disabled="locked" @click="openEditor('folder')">新建目录</el-button><el-button v-if="query" text @click="clearSearch">清除搜索</el-button></div></div>
      <div v-if="selected.length" class="selection-toolbar" role="region" aria-label="所选项目操作"><strong>已选 {{selected.length}} 项</strong><span v-if="selected.some(b=>b.kind==='folder')" class="muted">删除目录将包含其子目录和书签，预览会逐项列出。</span><el-button :disabled="locked" @click="openEditor('move',selected)">移动所选</el-button><el-button :disabled="locked" @click="prepareDelete()">预览删除</el-button><el-button :disabled="locked||!selected.some(b=>b.kind==='bookmark')" @click="startTask('帮我整理所选书签，提出标题和目录建议，并说明每项理由。',selected)">AI 整理所选</el-button><details class="content-tools"><summary>页面内容（可选）</summary><p class="muted">需要阅读原文时再提取；默认搜索和 AI 建议使用书签元数据。</p><div class="button-row"><el-button :loading="contentPending" :disabled="locked||!selected.some(b=>b.kind==='bookmark')" @click="extractContent">读取内容</el-button><el-button :disabled="locked||!selected.some(b=>b.kind==='bookmark')" @click="inspectContent">内容状态</el-button></div></details></div>
      <el-table :data="store.rows" v-loading="store.loading" row-key="id" @selection-change="(rows:BookmarkRecord[])=>selected=rows" empty-text="暂无匹配书签。清除搜索、选择其他目录，或收藏一个网址。">
        <el-table-column type="selection" width="42" :selectable="isEditable"/>
        <el-table-column label="书签与目录" min-width="210"><template #default="{row}"><a v-if="safeBookmarkHref(row.url)" class="bookmark-title" :href="safeBookmarkHref(row.url)" target="_blank" rel="noopener noreferrer">{{row.title||'未命名书签'}} ↗</a><button v-else-if="row.kind==='folder'" class="folder-link" @click="pickFolder(row)">▸ {{row.title||'书签根目录'}}</button><strong v-else>{{row.title||'未命名书签'}}</strong><div class="bookmark-url">{{row.url||'原生目录'}}</div><div class="bookmark-path">{{row.path||'根目录'}}</div><div class="row-actions"><button v-if="row.url" class="text-button" @click="copy(row.url)">复制 URL</button><template v-if="isEditable(row)"><button class="text-button" :disabled="locked" @click="openEditor('edit',[row])">{{row.kind==='folder'?'重命名':'编辑'}}</button><button class="text-button" :disabled="locked" @click="openEditor('move',[row])">移动</button><button class="text-button danger" :disabled="locked" @click="prepareDelete([row])">删除</button><button v-if="row.kind==='bookmark'" class="text-button" :disabled="locked" @click="startTask('这个收藏适合用来做什么？请给出具体建议。',[row])">问 AI</button></template></div></template></el-table-column>
      </el-table>
      <el-pagination v-model:current-page="page" :page-size="200" :total="store.total" layout="prev, pager, next" class="pagination"/>
      <section v-if="contentResults.length" class="content-results" aria-live="polite"><div class="section-heading"><h3>内容读取状态</h3><el-button :disabled="locked" @click="clearExtractedContent">清除此批提取内容</el-button></div><p class="muted">结果对应发起读取时的选择。成功提取的有限文本可用于后续对话。</p><article v-for="result in contentResults" :key="result.id" class="reference-card"><div><a v-if="safeBookmarkHref(result.url)" :href="safeBookmarkHref(result.url)" target="_blank" rel="noopener noreferrer">{{result.title}}</a><strong v-else>{{result.title}}</strong><p>{{result.label}}</p><small>{{result.path}}</small><div class="bookmark-url">{{result.url}}</div></div></article></section>
    </section>

    <section v-else-if="section==='conversation'" class="results-panel conversation-panel" aria-label="AI 多轮对话">
      <div class="section-heading"><div><h2>书签助手</h2><p class="muted">{{scopeName}} · 可继续追问，引用始终保留原始 URL</p></div><el-button :disabled="locked" @click="openHistory">历史对话</el-button></div>
      <div ref="messagesElement" class="messages" @scroll="trackScroll" aria-live="polite" :aria-busy="sending">
        <div v-if="!session?.messages.length&&!sending" class="chat-empty"><span>✦</span><h3>从“存下来”，到“用起来”</h3><p>在上方写下你的目标，再点“询问 AI”。你可以找资料、比较来源、制定阅读顺序，或请求整理建议。</p><p class="muted">默认使用标题、URL 和目录。只有明确读取内容后，才可能使用已提取的有限文本。所有书签更改都需你审核。</p></div>
        <article v-for="message in session?.messages" :key="message.id" class="message" :class="message.role"><small>{{message.role==='user'?'你':'书签助手'}}</small><p class="message-text">{{message.text}}</p><div v-if="message.disclosure" class="disclosure">{{message.disclosure.metadataOnly?'仅元数据':'含有限已提取文本'}} · 已发送 {{message.disclosure.transmitted}} / {{message.disclosure.totalInScope}} 条 · 省略 {{message.disclosure.omitted}} 条</div>
          <section v-if="message.references?.length" class="message-references" aria-label="本轮来源引用"><h3>来源引用（{{message.references.length}}）</h3><div class="reference-grid"><article v-for="r in message.references" :key="r.citationId" class="chat-reference"><a v-if="safeBookmarkHref(r.url)" :href="safeBookmarkHref(r.url)" target="_blank" rel="noopener noreferrer">{{r.citationId}} · {{r.title||r.url}} ↗</a><strong v-else>{{r.citationId}} · {{r.title}}</strong><p>{{r.reason}}</p><small>{{r.path||'根目录'}}</small><div class="bookmark-url">{{r.url}}</div><el-button text size="small" @click="copy(r.url)">复制 URL</el-button></article></div></section>
          <el-button v-if="message.moves?.length||message.edits?.length||message.deletions?.length" class="suggestion-button" @click="showSuggestions(message.id)">审核整理建议（{{(message.moves?.length??0)+(message.edits?.length??0)+(message.deletions?.length??0)}}）</el-button>
        </article>
        <article v-if="sending&&pendingQuestion" class="message user" aria-label="正在发送的问题"><small>你</small><p class="message-text">{{pendingQuestion}}</p></article>
        <article v-if="sending&&streamingText" class="message streaming-message" aria-label="正在生成的回复"><small>书签助手 · 正在生成</small><p class="message-text">{{streamingText}}</p><p class="muted">回复尚未完成，引用和整理建议将在完整校验后显示。</p></article>
        <div v-if="sending" class="working-state" role="status"><span class="working-dot"/>{{canceling?'正在停止…':streamingText?'正在继续生成…':'正在检索收藏并等待回复…'}}<span class="muted">可以取消，书签不会自动更改</span></div>
        <p v-if="turnNotice" class="muted" role="status">{{turnNotice}}</p><el-button v-if="turnNeedsReview" :disabled="locked" @click="reviewCurrentTurn">重新核对当前对话</el-button>
      </div>
    </section>

    <section v-else class="results-panel" aria-label="整理与更改预览">
      <div class="section-heading"><div><h2>整理与更改</h2><p class="muted">自动保存写入前快照。你审核后才会更改浏览器原生书签。</p></div><div class="button-row"><el-button :disabled="locked" @click="startTask('请整理当前范围的书签，提出清晰的目录结构、标题改进和可删除候选；每项给出原因。')">请 AI 提出整理建议</el-button><el-button :disabled="locked" :loading="busy" @click="checkDuplicates">检查完全相同的 URL</el-button></div></div>
      <p class="muted">重复检查范围：{{currentFolder}}（包含子目录，不受搜索关键词限制）。目录或书签变化后请重新检查。</p>
      <section v-if="moves.length||suggestedEdits.length||suggestedDeletions.length" class="suggestions-section"><h3>本轮建议 · 选择后生成完整预览</h3><p class="muted">可调整移动目标和新目录名称。标题建议与删除候选默认不选；AI 不会直接写入。</p>
        <article v-for="folder in suggestedFolders" :key="folder.proposalId" class="proposal-folder"><strong>建议新目录</strong><el-input v-model="folder.title" aria-label="建议新目录名称" :disabled="locked"/><el-select v-model="folder.parentFolderId" aria-label="新目录的上级目录" filterable :disabled="locked"><el-option v-for="f in writableFolders" :key="f.id" :label="folderDisplayPath(f)" :value="f.id"/></el-select></article>
        <el-checkbox-group v-model="selectedMoves" :disabled="locked"><article v-for="move in moves" :key="move.bookmarkId" class="plan-step"><el-checkbox :value="move.bookmarkId">{{bookmarkTitle(move.bookmarkId)}}</el-checkbox><p class="muted">{{move.reason}}</p><label class="destination-editor">移动至<el-select v-model="move.targetFolderId" :aria-label="`${bookmarkTitle(move.bookmarkId)} 的目标目录`" filterable :disabled="locked"><el-option v-for="f in writableFolders" :key="f.id" :label="folderDisplayPath(f)" :value="f.id"/><el-option v-for="f in suggestedFolders" :key="f.proposalId" :label="`${folderDisplayPath(store.folders.find(parent=>parent.id===f.parentFolderId))} / ${f.title}（新建）`" :value="f.proposalId"/></el-select></label><p class="muted">{{moveDestination(move.targetFolderId)}}</p></article></el-checkbox-group>
        <el-checkbox-group v-model="selectedEdits" :disabled="locked"><article v-for="edit in suggestedEdits" :key="edit.bookmarkId" class="plan-step"><el-checkbox :value="edit.bookmarkId">修改标题：{{bookmarkTitle(edit.bookmarkId)}}</el-checkbox><p>建议标题：{{edit.title}}</p><p class="muted">{{edit.reason}}</p></article></el-checkbox-group>
        <el-checkbox-group v-model="selectedDeletions" :disabled="locked"><article v-for="deletion in suggestedDeletions" :key="deletion.bookmarkId" class="plan-step"><el-checkbox :value="deletion.bookmarkId">删除候选：{{bookmarkTitle(deletion.bookmarkId)}}</el-checkbox><p class="muted">{{deletion.reason}}</p></article></el-checkbox-group>
        <el-button type="primary" :disabled="locked||!(selectedMoves.length+selectedEdits.length+selectedDeletions.length)" @click="prepareMoves">预览已选 AI 建议</el-button>
      </section>
      <section v-if="duplicatesChecked" class="duplicates-section"><h3>重复 URL · {{duplicates.length}} 组</h3><p class="muted">范围：{{duplicateScope}}。勾选要移除的条目，每组至少保留一个。默认不选择任何条目。</p><el-empty v-if="!duplicates.length" description="当前范围没有完全相同的 URL，无需清理。" :image-size="64"/>
        <el-checkbox-group v-model="duplicateSelection" :disabled="locked"><article v-for="g in duplicates" :key="g.url" class="duplicate-card"><div class="bookmark-url">{{g.url}}</div><div v-for="b in g.bookmarks" :key="b.id" class="duplicate-row"><el-checkbox :value="b.id" :disabled="duplicateDisabled(g,b.id)">{{b.title||'未命名书签'}}</el-checkbox><p>{{b.path||'根目录'}} · 目录内第 {{b.index+1}} 项</p><small>{{duplicateSelection.includes(b.id)?'将移除':'保留'}} · <a v-if="safeBookmarkHref(b.url)" :href="safeBookmarkHref(b.url)" target="_blank" rel="noopener noreferrer">打开原始网页 ↗</a></small></div></article></el-checkbox-group>
        <el-button v-if="duplicates.length" :disabled="!duplicateSelection.length||locked" @click="prepareDuplicates">预览移除 {{duplicateSelection.length}} 个重复书签</el-button>
      </section>
      <section v-if="plan" class="plan-review" aria-label="更改计划预览">
        <div class="plan-heading"><h3>{{plan.title}}</h3><el-tag>{{planStatusLabel(plan.status)}}</el-tag><span class="muted">{{plan.steps.length}} 项更改</span></div>
        <el-alert v-if="applied" :title="`执行结果：${executionCounts.succeeded} 项成功，${executionCounts.failed} 项失败，${executionCounts.compensated} 项已补偿，${executionCounts.skipped} 项已跳过`" :type="executionCounts.failed?'warning':'info'" :closable="false"/>
        <article v-for="{step,view} in planCards" :key="step.id" class="plan-step"><div class="step-heading"><el-tag :type="step.action==='delete'?'danger':'info'">{{view.action}}</el-tag><strong>{{step.action==='create'?view.targetTitle:view.sourceTitle}}</strong><span class="muted">{{view.risk}}</span><el-tag :type="step.status==='failed'?'danger':step.status==='succeeded'?'success':'info'" size="small">{{stepStatusLabel(step.status)}}</el-tag></div><p>{{step.reason}}</p><el-alert v-if="step.errorMessage" :title="stepErrorLabel(step.errorMessage)" type="warning" :closable="false"/>
          <dl><template v-if="step.action!=='create'"><dt>原目录</dt><dd>{{view.sourcePath}}</dd><dt v-if="view.sourceUrl">原始 URL</dt><dd v-if="view.sourceUrl">{{view.sourceUrl}}</dd></template><template v-if="step.action==='delete'"><dt>更改结果</dt><dd>从浏览器原生书签中删除此条目<span v-if="!view.sourceUrl">及其目录内的所有子项</span></dd></template><template v-else><dt>{{step.action==='create'?'创建位置':'目标目录'}}</dt><dd>{{view.targetPath}}</dd><dt v-if="view.targetTitle!==view.sourceTitle&&step.action!=='create'">新标题</dt><dd v-if="view.targetTitle!==view.sourceTitle&&step.action!=='create'">{{view.targetTitle}}</dd><dt v-if="view.targetUrl&&(view.targetUrl!==view.sourceUrl||step.action==='create')">{{step.action==='create'?'网址':'新 URL'}}</dt><dd v-if="view.targetUrl&&(view.targetUrl!==view.sourceUrl||step.action==='create')">{{view.targetUrl}}</dd></template></dl>
          <details class="technical-details"><summary>技术详情</summary><p>书签 ID：{{step.targetBrowserId||'执行时创建'}} · 步骤：{{step.id}}</p><p>索引版本：{{plan.basedOnGeneration}}</p></details>
        </article>
        <div class="approval-box"><p v-if="plan.metadata['plan-service.snapshot']" class="snapshot-status">✓ 写入前快照已自动保存到此设备</p><el-alert v-else title="此历史计划没有可验证的本地快照。请重新生成计划后再执行。" type="warning" :closable="false"/>
          <template v-if="!applied&&['draft','validated'].includes(plan.status)"><el-checkbox v-model="reviewed" :disabled="locked">已逐项核对并批准以上更改</el-checkbox><label v-if="hasDeletes" class="delete-confirmation">包含删除操作，请输入“删除”确认<el-input v-model="deleteConfirmation" placeholder="删除" :disabled="locked"/></label><el-button type="primary" :disabled="!canApply" :loading="busy" @click="applyPlan">批准并执行 {{plan.steps.length}} 项更改</el-button></template>
          <p v-if="applied" role="status">此计划已执行，不能重复执行。恢复操作也会先生成新的预览供你审核。</p><div class="button-row"><el-button :disabled="locked" @click="backupPlan">导出此计划的恢复备份</el-button><el-button v-if="applied" :disabled="locked" @click="prepareRestore(plan.id)">预览恢复</el-button></div><p v-if="backedUp" class="muted" role="status">备份已发起下载，请检查浏览器下载列表。</p><p class="muted">快照保存在此设备，清除扩展数据会移除快照。重要更改可另行导出备份；恢复会说明哪些内容追加、哪些位置可恢复，不会静默覆盖现有书签。</p>
        </div>
      </section>
      <div v-else-if="!duplicatesChecked&&!moves.length&&!suggestedEdits.length&&!suggestedDeletions.length" class="empty-guide"><span>⇄</span><h3>从一个明确的小步骤开始</h3><p>检查重复网址，选择书签批量移动，或请 AI 提出整理建议。每次更改都先展示完整预览。</p><el-button @click="section='browse'">去浏览并选择书签</el-button></div>
    </section>
  </main>

  <el-drawer v-model="directoryOpen" title="我的书签目录" direction="ltr" size="min(360px,94vw)"><button class="folder-all" :class="{active:!folderId}" @click="folderId='';section='browse';directoryOpen=false">▤ 全部书签</button><el-tree :data="tree" node-key="id" :current-node-key="folderId" highlight-current :expand-on-click-node="false" :default-expanded-keys="tree.map(node=>node.id)" @node-click="pickFolder"/><el-empty v-if="!tree.length&&!store.loading" description="暂无目录" :image-size="48"/><p class="muted">目录来自浏览器原生书签。选择目录后，在浏览结果中重命名、移动或新建子目录。</p></el-drawer>
  <el-drawer v-model="historyOpen" title="历史与恢复" size="min(560px,96vw)"><h3>最近的对话</h3><el-empty v-if="!sessions.length" description="还没有对话记录" :image-size="48"/><button v-for="item in sessions" :key="item.id" class="session-row" :disabled="locked" @click="switchSession(item.id)"><strong>{{item.title||'未命名对话'}}</strong><span>继续对话 →</span></button><h3>书签更改记录</h3><p class="muted">查看每次写入的结果，导出备份或审核恢复预览。</p><el-empty v-if="!history.length" description="暂无操作记录" :image-size="48"/><article v-for="item in history" :key="item.id" class="history-card"><div><strong>{{item.title}}</strong><p class="muted">{{new Date(item.createdAt).toLocaleString()}} · {{item.stepCount}} 项更改</p></div><el-tag>{{planStatusLabel(item.status)}}</el-tag><el-button :disabled="locked" @click="viewHistory(item.id)">查看计划</el-button></article></el-drawer>
  <BookmarkEditor v-model="editorOpen" :kind="editorKind" :records="editorRecords" :folders="store.folders" :default-parent-id="defaultParent" :busy="busy||sending||contentPending" :initial-bookmark="initialBookmark" :advice="bookmarkAdvice" :requesting-advice="requestingAdvice" :ai-available="settings.hasKey&&settings.consent" :auto-enabled="automaticReady" :advice-error="adviceError" @cancel-advice="cancelBookmarkAdvice" :server-error="editorError" @prepare="prepareManual" @request-advice="requestBookmarkAdvice" @configure-ai="settingsOpen=true" @open-settings="settingsOpen=true" @edit-existing="id=>openExistingBookmark(id,true)" @view-existing="id=>openExistingBookmark(id,false)"/>
  <el-dialog class="tools-dialog" top="4vh" v-model="toolsOpen" title="书签工具" width="min(1100px,96vw)" destroy-on-close><LegacyTools :initial-tab="toolsTab" @preview-delete="prepareHealthDelete"/><template #footer><el-button @click="toolsOpen=false">返回工作台</el-button></template></el-dialog>
<el-dialog class="settings-dialog" top="4vh" v-model="settingsOpen" :title="onboarding?'欢迎使用 · 连接你的 AI 助手':'AI 连接与数据范围'" width="min(560px,94vw)" @closed="apiKey=''" :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy&&!onboarding"><ol v-if="onboarding" class="setup-steps" aria-label="连接步骤"><li>1 · 选择区域并填写密钥</li><li>2 · 选择数据范围</li><li>3 · 保存并测试</li></ol><p v-if="onboarding" class="onboarding-intro">先连接 MiniMax，收藏时获得标题和位置建议，搜索和整理时自动补充建议。填写密钥并选择是否开启自动建议，一次保存并测试即可开始；也可以跳过，所有本地功能照常使用。</p><el-form label-position="top" :disabled="busy"><el-form-item label="MiniMax 服务区域"><el-select v-model="settingsDraft.region"><el-option label="全球区 · api.minimax.io" value="global"/><el-option label="中国区 · api.minimax.cn" value="cn"/></el-select></el-form-item><p v-if="settingsDraft.region!==settings.region" class="setup-notice">保存新区设置会清除原区域密钥。请为新区输入对应密钥；取消不会改变现有设置。</p><p class="muted">请使用所选 MiniMax 区域的 API 密钥。连接测试只发送固定的“Reply with OK.”文本，不含书签；测试可能产生少量 API 费用。</p><el-form-item label="API Key"><el-input v-model="apiKey" type="password" autocomplete="off" :placeholder="settings.hasKey&&settingsDraft.region===settings.region?'留空保留已保存的密钥':'输入此区域的密钥'"/></el-form-item><p role="status">{{settings.hasKey?`已保存密钥 · ${settings.keyStorage==='local'?'此设备本地保存':'仅当前浏览器会话'}${settings.connectionTested&&!settingsDraftChanged?' · 当前配置已测试通过':' · 当前配置未测试'}`:'未配置密钥或会话密钥已过期。'}}</p><el-checkbox v-model="rememberKey">在此设备记住密钥（可选）</el-checkbox><p class="muted">默认只在当前浏览器会话保存，关闭浏览器会话后需重新输入。选择记住后保存在此设备的扩展本地存储，不额外加密，不同步，不包含在导出、备份、历史或日志中。共享设备请勿勾选。</p><el-checkbox v-model="settingsDraft.autoSuggestions" class="consent">自动提供 AI 建议</el-checkbox><p class="muted">自愿开启：收藏草稿稳定后、提交搜索后、进入整理时自动请求。仅发送当前页面标题和网址、查询及最多 60 个候选的元数据和最多 120 个目录；不自动读取正文，不后台扫描全库。每个收藏窗口最多 3 次、工作台最多 6 次；失败不自动重试。MiniMax 可能按用量计费，可随时关闭。</p><details class="privacy-settings"><summary>高级设置 · 模型、隐私与内容增强</summary><el-form-item label="模型"><el-input v-model="settingsDraft.model"/></el-form-item><el-form-item label="模型输出 token 上限"><el-input-number v-model="settingsDraft.maxCompletionTokens" :min="1024" :max="16384" :step="1024" :precision="0" aria-label="模型输出 token 上限"/></el-form-item><p class="muted">默认 4096。提高上限可能增加等待时间和使用费用；仅在输出被截断时按需调整。</p><el-form-item label="不发送给 AI 的目录（包含子目录）"><el-select v-model="settingsDraft.excludedFolderIds" multiple filterable collapse-tags aria-label="排除的 AI 目录"><el-option v-for="f in store.folders" :key="f.id" :label="folderDisplayPath(f)" :value="f.id"/></el-select></el-form-item><p class="muted">修改排除目录会结束当前任务上下文，下次发送创建新任务；已有历史不会自动删除。</p><el-checkbox v-model="settingsDraft.contentEnhancement" class="consent">允许自动补充相关页面的有限文本</el-checkbox><p class="muted">默认关闭。开启后仅读取已授予网站权限的少量相关公开页面，不会为未授权网站弹窗或读取登录状态。网站会收到请求；内容状态中可清除已提取文本。</p></details><el-checkbox v-model="settingsDraft.consent" class="consent">我同意将当前对话范围内选中的候选书签标题、原始 URL、目录路径及已提取的有限文本发送至以上 MiniMax 服务，用于回答问题或生成整理建议；自动建议仅发送元数据，不发送已提取文本。</el-checkbox></el-form><template #footer><div class="settings-feedback" aria-live="polite"><el-alert v-if="settingsError" :title="settingsError" type="error" :closable="false" show-icon/><p v-else-if="settingsSaving" role="status">正在保存并验证，请稍候…</p><p v-else-if="!settingsHasUsableKey" class="muted">尚未填写密钥；你可以先使用全部本地功能。</p></div><div class="settings-actions"><el-button v-if="settings.hasKey" :disabled="busy||sending" @click="clearKey">清除密钥</el-button><el-button v-if="onboarding" :disabled="busy" @click="skipOnboarding">稍后配置，先用本地功能</el-button><el-button v-else :disabled="busy" @click="settingsOpen=false">取消</el-button><el-button v-if="!onboarding" :disabled="busy||sending" @click="saveSettings(false)">保存设置</el-button><el-button type="primary" :loading="busy" :disabled="sending" @click="saveSettings(true)">保存并测试连接</el-button></div></template></el-dialog></div>
</template>
<style scoped>
/* Anchor the dropdown to the whole toolbar, which is at least as wide as the
   menu. The menu then fits both the right-aligned and wrapped-left header. */
.utility-menu{position:static}
.utility-menu>summary,.content-tools>summary{cursor:pointer;padding:8px 12px;color:var(--bookmark-accent);font-size:13px}
.utility-actions{position:absolute;right:0;left:auto;top:100%;z-index:20;display:flex;flex-direction:column;align-items:stretch;width:180px;max-width:100%;min-width:0;padding:8px;background:#fff;border:1px solid var(--bookmark-line);border-radius:8px;box-shadow:var(--el-box-shadow-light)}
.utility-actions :deep(.el-button){justify-content:flex-start}
.content-tools{flex-basis:100%;border-top:1px solid #c9ddf0}
.content-tools>summary{padding-left:0}
.content-tools p{margin-top:0}


:global(.tools-dialog){display:flex;flex-direction:column;max-height:92vh;max-height:92dvh;overflow:hidden;margin-bottom:4vh}
:global(.tools-dialog .el-dialog__body){overflow-y:auto;min-height:0;overscroll-behavior:contain}
:global(.tools-dialog .el-dialog__header),:global(.tools-dialog .el-dialog__footer){flex-shrink:0}
:global(.tools-dialog .el-dialog__footer){border-top:1px solid var(--bookmark-line);padding-top:12px;margin-top:12px}

:global(.settings-dialog){display:flex;flex-direction:column;max-height:92vh;max-height:92dvh;margin-bottom:4vh;overflow:hidden;padding:18px 20px}
:global(.settings-dialog .el-dialog__body){overflow-y:auto;min-height:0;overscroll-behavior:contain;padding-right:4px}
:global(.settings-dialog .el-dialog__header){flex-shrink:0;padding-bottom:14px}
:global(.settings-dialog .el-dialog__footer){flex-shrink:0;border-top:1px solid var(--bookmark-line);padding-top:12px;margin-top:12px}
.settings-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}
.settings-actions :deep(.el-button){margin:0;white-space:normal;height:auto;min-height:32px;line-height:1.5}
.settings-feedback{text-align:left;overflow-wrap:anywhere}
.settings-feedback p{margin:0 0 10px;font-size:12px}
.settings-feedback :deep(.el-alert){margin-bottom:10px}
.setup-steps{display:flex;flex-wrap:wrap;gap:8px;list-style:none;padding:0;margin:0 0 12px;color:var(--bookmark-accent);font-size:12px}
.setup-steps li{padding:6px 9px;background:var(--bookmark-accent-soft);border-radius:6px}

.automatic-card{margin:0 0 20px;padding:20px;border:1px solid #c9ddf0;background:var(--bookmark-accent-soft);border-radius:12px;line-height:1.8;white-space:pre-wrap}
.onboarding-intro{line-height:1.8;color:var(--bookmark-secondary)}


:global(body){margin:0;background:var(--bookmark-canvas);color:var(--bookmark-ink);font-family:var(--bookmark-font);font-size:14px}
:global(*){box-sizing:border-box}
a{color:var(--bookmark-accent)}
button,a{touch-action:manipulation}
button{font:inherit}
button:focus-visible,a:focus-visible{outline:2px solid var(--bookmark-focus);outline-offset:3px}
button:disabled{cursor:not-allowed;opacity:.5}
.workspace{min-height:100vh}
.topbar{padding:16px 4vw;display:flex;justify-content:space-between;align-items:center;gap:20px;background:#fff;border-bottom:1px solid var(--bookmark-line)}
.brand{display:flex;align-items:center;gap:12px;text-decoration:none;color:var(--bookmark-ink);flex-shrink:0}
.brand-mark{padding:7px 12px;background:var(--bookmark-accent);color:white;font-weight:600;font-size:22px;border-radius:12px}
.brand strong{font-size:17px;font-weight:600;letter-spacing:-.3px;display:block}
.brand small{font-size:12px;color:var(--bookmark-secondary);display:block;margin-top:4px}
.header-actions{position:relative;min-width:min(180px,100%);display:flex;align-items:center;flex-wrap:wrap;justify-content:flex-end;gap:3px}
.header-actions :deep(.el-button){margin:0}
.main-pane{max-width:1120px;margin:0 auto;padding:40px 32px 72px;min-width:0}
.goal-panel{margin-bottom:28px}
.hero-heading{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:24px}
h1{font-size:32px;font-weight:600;letter-spacing:-.8px;margin:0;line-height:1.35}
h2{font-size:22px;font-weight:600;letter-spacing:-.4px;margin:0;line-height:1.5}
h3{font-size:16px;font-weight:600;margin:0 0 14px}
.local-badge{font-size:12px;color:var(--bookmark-secondary);padding:8px 0;border-radius:0;background:transparent;white-space:nowrap}
.goal-form{border:1px solid var(--bookmark-line);border-radius:16px;background:#fff;overflow:hidden;box-shadow:0 2px 6px #1d1d1f05}
.goal-form:focus-within{border-color:var(--bookmark-focus);box-shadow:0 0 0 3px #0071e31a}
.goal-form :deep(.el-textarea__inner){box-shadow:none!important;background:transparent;padding:20px 22px 10px;font-size:16px;line-height:1.8;color:var(--bookmark-ink)}
.goal-actions{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 16px 16px}
.goal-actions small{font-size:12px;color:var(--bookmark-secondary)}
.goal-actions>div{display:flex;flex-wrap:wrap;gap:8px;min-width:0;max-width:100%}
.goal-actions :deep(.el-button){margin:0;max-width:100%;white-space:normal;height:auto;min-height:32px;line-height:1.5}
.task-context{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:13px 2px;font-size:12px;color:var(--bookmark-secondary)}
.task-context :deep(.el-select){width:240px;max-width:100%}
.muted{font-size:12px;color:var(--bookmark-secondary);line-height:1.7}
.scope-selection{max-width:100%;overflow-wrap:anywhere}
.scope-selection summary{cursor:pointer;color:var(--bookmark-accent)}
.scope-selection p{font-size:12px;margin:5px 0}
.scope-warning{padding:11px 14px;background:#fff3d9;color:#71551b;border:1px solid #e9d6aa;border-radius:8px;font-size:12px;line-height:1.7;margin:4px 0 12px}
.setup-notice{font-size:12px;color:#735b2a;line-height:1.7;margin:0 0 12px}
.text-button{border:0;padding:0;background:transparent;color:var(--bookmark-accent);cursor:pointer;font-size:12px}
.text-button:hover{text-decoration:underline}
.text-button.danger{color:#ae3d3d}
.quick-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:5px}
.quick-actions>button{display:flex;align-items:center;gap:8px;border:1px solid var(--bookmark-line);border-radius:8px;padding:10px 14px;background:#fff;color:var(--bookmark-secondary);cursor:pointer;font-size:13px}
.quick-actions>button>span{font-size:18px;line-height:1}
.quick-actions>button.active,.quick-actions>button:hover{background:var(--bookmark-accent-soft);color:var(--bookmark-accent);border-color:#c9ddf0}
.quick-actions small{border-radius:10px;padding:2px 6px;background:#dceafa}
.results-panel{background:#fff;border:1px solid var(--bookmark-line);border-radius:16px;padding:24px;min-width:0}
.section-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:20px}
.section-heading .muted{margin:7px 0 0}
.button-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.button-row :deep(.el-button){margin:0;white-space:normal;height:auto;min-height:32px;line-height:1.4}
.selection-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;border-radius:8px;padding:12px;background:var(--bookmark-accent-soft);margin-bottom:12px}
.selection-toolbar>strong{margin-right:8px;font-size:13px}
.selection-toolbar :deep(.el-button){margin:0}
.bookmark-title{font-weight:600;font-size:14px;color:var(--bookmark-ink);text-decoration:none;overflow-wrap:anywhere}
.bookmark-title:hover{text-decoration:underline}
.bookmark-url{color:var(--bookmark-secondary);font-size:12px;line-height:1.7;overflow-wrap:anywhere;word-break:break-word}
.bookmark-path{color:var(--bookmark-secondary);font-size:12px;line-height:1.7;margin-top:3px}
.row-actions{display:flex;flex-wrap:wrap;gap:16px;margin-top:8px}
.folder-link{border:0;background:transparent;color:var(--bookmark-accent);cursor:pointer;padding:0;text-align:left;overflow-wrap:anywhere}
.results-panel :deep(.el-table){--el-table-header-bg-color:var(--bookmark-fill);--el-table-header-text-color:var(--bookmark-secondary);--el-table-border-color:var(--bookmark-line-soft);font-size:14px;width:100%}
.results-panel :deep(.el-table__cell){padding:16px 0}
.results-panel :deep(.el-table .cell){overflow-wrap:anywhere;word-break:break-word}
.pagination{margin:22px 0 0;justify-content:center;max-width:100%}
.messages{max-height:800px;overflow:auto;scroll-behavior:smooth;padding:2px}
.message{border-radius:14px;background:var(--bookmark-fill);padding:20px;margin:14px 0;font-size:14px;line-height:1.8;overflow-wrap:anywhere}
.message.user{background:var(--bookmark-accent-soft);margin-left:8%;}
.message>small{font-size:12px;font-weight:600;color:var(--bookmark-secondary)}
.message-text{white-space:pre-wrap;margin:8px 0 12px}
.disclosure{font-size:12px;color:var(--bookmark-secondary);padding-top:10px;border-top:1px solid var(--bookmark-line-soft)}
.message-references{margin-top:16px}
.message-references h3{font-size:13px}
.reference-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:12px}
.chat-reference,.reference-card{border:1px solid var(--bookmark-line);border-radius:8px;padding:14px;background:#fff;min-width:0;font-size:13px}
.chat-reference p{margin:6px 0;line-height:1.6}
.chat-reference a{font-weight:600;text-decoration:none;overflow-wrap:anywhere}
.chat-reference a:hover{text-decoration:underline}
.chat-reference small,.reference-card small{font-size:12px;color:var(--bookmark-secondary)}
.chat-reference :deep(.el-button){padding-left:0}
.suggestion-button{margin-top:16px}
.chat-empty,.empty-guide{text-align:center;max-width:550px;margin:30px auto;padding:15px;font-size:14px;line-height:1.9;color:var(--bookmark-secondary)}
.chat-empty>span,.empty-guide>span{display:block;font-size:34px;color:var(--bookmark-accent);margin-bottom:12px}
.chat-empty h3,.empty-guide h3{color:var(--bookmark-ink);margin-bottom:8px}
.working-state{display:flex;align-items:center;flex-wrap:wrap;gap:12px;padding:22px 8px;font-size:14px}
.working-dot{width:9px;height:9px;background:var(--bookmark-accent);border-radius:50%;animation:pulse 1.4s ease-in-out infinite}
@keyframes pulse{50%{opacity:.3}
}
.error{margin:18px 0}
.suggestions-section,.duplicates-section,.plan-review{margin-top:26px;padding-top:24px;border-top:1px solid var(--bookmark-line)}
.plan-step,.duplicate-card{border:1px solid var(--bookmark-line);border-radius:9px;padding:18px;margin:12px 0;background:var(--bookmark-fill);font-size:13px;overflow-wrap:anywhere}
.step-heading,.plan-heading{display:flex;align-items:center;flex-wrap:wrap;gap:10px}
.plan-heading h3{margin:0}
.plan-heading{margin-bottom:16px}
.plan-step dl{display:grid;grid-template-columns:80px minmax(0,1fr);gap:9px;line-height:1.7}
.plan-step dt{color:var(--bookmark-secondary)}
.plan-step dd{margin:0;overflow-wrap:anywhere}
.technical-details{font-size:11px;color:var(--bookmark-secondary);overflow-wrap:anywhere}
.technical-details summary{cursor:pointer}
.approval-box{display:flex;flex-direction:column;align-items:flex-start;gap:14px;padding:22px;border:1px solid #c9ddf0;border-radius:10px;background:var(--bookmark-accent-soft);font-size:13px}
.approval-box>p{margin:0;line-height:1.7}
.snapshot-status{color:#336c55}
.delete-confirmation{max-width:100%;display:flex;flex-direction:column;gap:8px}
.approval-box :deep(.el-checkbox),.plan-step :deep(.el-checkbox),.duplicate-row :deep(.el-checkbox){height:auto;white-space:normal}
.approval-box :deep(.el-checkbox__label),.plan-step :deep(.el-checkbox__label),.duplicate-row :deep(.el-checkbox__label){white-space:normal;overflow-wrap:anywhere}
.duplicate-row{padding:12px 0;border-top:1px solid var(--bookmark-line-soft);margin-top:10px}
.duplicate-row p{margin:6px 0;color:var(--bookmark-secondary)}
.duplicate-row small{font-size:12px;color:var(--bookmark-secondary)}
.proposal-folder{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:14px;background:var(--bookmark-fill);border-radius:8px;margin:10px 0}
.proposal-folder :deep(.el-input){flex:1;min-width:160px}
.proposal-folder :deep(.el-select){flex:2;min-width:180px}
.destination-editor{display:flex;align-items:center;gap:10px}
.destination-editor :deep(.el-select){width:100%;max-width:500px}
.content-results{margin-top:25px}
.content-results .reference-card{margin-top:10px}
.folder-all{border:0;padding:12px;text-align:left;border-radius:7px;width:100%;margin-bottom:12px;background:var(--bookmark-accent-soft);color:var(--bookmark-accent);cursor:pointer}
:deep(.el-tree-node__content){height:36px}
:deep(.el-tree-node__label){font-size:13px}
.history-card{display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:16px 0;border-bottom:1px solid var(--bookmark-line-soft)}
.history-card>div{flex:1;min-width:180px}
.history-card p{margin:5px 0}
.session-row{display:flex;justify-content:space-between;text-align:left;width:100%;gap:15px;padding:15px;border:1px solid var(--bookmark-line);background:var(--bookmark-fill);border-radius:8px;margin:10px 0;cursor:pointer;color:var(--bookmark-secondary)}
.session-row span{font-size:12px;flex-shrink:0}
.session-row strong{overflow-wrap:anywhere}
.privacy-settings{margin:16px 0;padding:14px;background:var(--bookmark-fill);border-radius:8px}
.privacy-settings summary{cursor:pointer;margin-bottom:12px;color:var(--bookmark-secondary)}
.privacy-settings :deep(.el-select){width:100%}
.consent{height:auto;align-items:flex-start}
.consent :deep(.el-checkbox__label){white-space:normal;line-height:1.7}
.consent :deep(.el-checkbox__input){margin-top:5px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:900px){.topbar{align-items:flex-start;flex-wrap:wrap;padding:16px 22px}
.header-actions{justify-content:flex-start}
.main-pane{padding:30px 22px 60px}
.hero-heading{align-items:flex-start}
.local-badge{display:none}
.section-heading{flex-direction:column}
.goal-actions{align-items:flex-start;flex-wrap:wrap}
.goal-actions>div{margin-left:auto}
.results-panel{padding:20px}
.hero-heading h1{font-size:28px}
}
@media(max-width:520px){.topbar{padding:14px}
.header-actions{gap:2px}
.header-actions :deep(.el-button){font-size:12px;padding:6px 9px}
.main-pane{padding:25px 12px 40px}
.hero-heading h1{font-size:25px}
.goal-form :deep(.el-textarea__inner){font-size:14px;padding:16px 14px 8px}
.goal-actions{padding:8px 12px 12px;gap:10px}
.goal-actions small{font-size:11px}
.task-context :deep(.el-select){width:calc(100% - 65px)}
.quick-actions{gap:6px}
.quick-actions>button{font-size:12px;padding:9px 10px}
.results-panel{padding:16px 12px}
.section-heading h2{font-size:19px}
.section-heading .button-row{gap:6px}
.button-row :deep(.el-button){font-size:12px;padding:7px 10px}
.message{padding:14px}
.message.user{margin-left:3%}
.approval-box{padding:16px}
.plan-step{padding:14px}
.plan-step dl{grid-template-columns:65px minmax(0,1fr)}
.plan-step,.duplicate-card{font-size:12px}
.destination-editor{align-items:flex-start;flex-direction:column}
.goal-actions>div{width:100%;justify-content:flex-end}
.proposal-folder{padding:12px}
.proposal-folder :deep(.el-input),.proposal-folder :deep(.el-select){min-width:100%}
.pagination :deep(.el-pager li){min-width:25px}
.row-actions{gap:12px}
}
@media(prefers-reduced-motion:reduce){.messages{scroll-behavior:auto}
.working-dot{animation:none}
}

/* Keep references and review steps readable without a card inside every card. */
.chat-reference { border:0; border-left:2px solid #c9ddf0; border-radius:0; background:transparent; padding:4px 0 4px 14px; }

.plan-step { border:0; border-bottom:1px solid var(--bookmark-line); border-radius:0; background:transparent; padding:18px 0; }

.approval-box { background:var(--bookmark-fill); border-color:var(--bookmark-line); border-radius:12px; }

.automatic-card { background:var(--bookmark-surface); border-color:var(--bookmark-line); border-left:3px solid var(--bookmark-accent); border-radius:10px; }

.setup-steps li { color:var(--bookmark-secondary); background:var(--bookmark-fill); }

.session-row { background:var(--bookmark-surface); color:var(--bookmark-ink); }

.session-row:hover { background:var(--bookmark-fill); }

.utility-menu>summary:hover, .content-tools>summary:hover { color:var(--bookmark-accent-hover); }

.utility-menu>summary:focus-visible, .content-tools>summary:focus-visible, .scope-selection summary:focus-visible, .privacy-settings summary:focus-visible { outline:2px solid var(--bookmark-focus); outline-offset:3px; border-radius:4px; }

.quick-actions>button { min-height:40px; font-weight:500; }

.quick-actions>button.active { box-shadow:inset 0 0 0 1px var(--bookmark-accent); }

.selection-toolbar { border-radius:10px; }

.results-panel :deep(.el-table__row:hover>td.el-table__cell) { background:var(--bookmark-fill); }

:global(.settings-dialog .el-dialog__footer), :global(.tools-dialog .el-dialog__footer) { background:var(--bookmark-surface); }

@media(max-width:520px) {
  .topbar { gap:14px; }

  .main-pane { padding-top:24px; }

  .hero-heading { margin-bottom:20px; }

  .results-panel { border-radius:12px; }

  .quick-actions>button { min-height:38px; }

  .plan-step { padding:16px 0; }

  .session-row { flex-wrap:wrap; gap:6px; }

}
</style>
