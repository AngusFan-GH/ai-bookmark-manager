import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, provide, inject, computed, reactive, type ComputedRef, type App } from 'vue';
import Workspace from '../../entrypoints/options/App.vue';
import type { BookmarkRecord } from '../../src/domain/bookmarks/types';
const mocks=vi.hoisted(()=>({load:vi.fn(),sync:vi.fn(),approve:vi.fn(),execute:vi.fn(),getPlan:vi.fn(),getAssistantSettings:vi.fn(),listSessions:vi.fn(),createSession:vi.fn(),sendTurn:vi.fn(),getSession:vi.fn(),cancelTurn:vi.fn(),saveAssistantSettings:vi.fn(),clearAssistantKey:vi.fn(),analyzeDuplicates:vi.fn(),prepareOrganization:vi.fn(),exportPlanBackup:vi.fn(),listHistory:vi.fn(),fetchContent:vi.fn(),prepareRecovery:vi.fn(),adviseBookmark:vi.fn(),getCapture:vi.fn(),clearContent:vi.fn(),getContentStatus:vi.fn(),confirm:vi.fn(),permission:vi.fn(),testAssistantConnection:vi.fn(),completeOnboarding:vi.fn(),cancelAdvice:vi.fn(),listTopicViews:vi.fn()}));
let state: {rows:BookmarkRecord[];folders:Array<{id:string;browserId:string;parentId:string|null;title:string;path:string;index:number;updatedAt:number;syncGeneration:number}>;stats:{bookmarks:number;lastSync:number};total:number;loading:boolean;error:string};
vi.mock('../../src/store',()=>({useBookmarkStore:()=>({...mocks,...state})}));
vi.mock('../../src/workspace-client',()=>mocks);
vi.mock('element-plus',()=>({ElMessage:{success:vi.fn(),error:vi.fn(),info:vi.fn()},ElMessageBox:{confirm:mocks.confirm}}));
vi.mock('../../entrypoints/options/LegacyTools.vue',()=>({default:defineComponent({render:()=>h('div','Tools')})}));
vi.mock('../../entrypoints/options/components/BookmarkEditor.vue',()=>({default:defineComponent({props:['modelValue','kind','serverError','records','defaultParentId'],emits:['prepare'],setup(props,{emit}){return()=>props.modelValue?h('section',[h('p',props.serverError),h('p',props.records?.[0]?.title),h('p',{'data-editor-parent':true},props.defaultParentId),h('button',{onClick:()=>emit('prepare',{title:'Manual change',steps:[{action:props.kind==='bookmark'?'create':'delete',targetBrowserId:'saved',parentBrowserId:'bar',desiredAfter:{title:'New',url:'https://example.test'}}]})},'Editor preview')]):null;}})}));
const passthrough=defineComponent({setup(_,{slots}){return()=>h('div',[slots.header?.(),slots.default?.(),slots.footer?.()]);}});
let app:App|undefined;let host:HTMLDivElement;
const bookmark=(index=1):BookmarkRecord=>({id:`b${index}`,browserId:`b${index}`,kind:'bookmark',parentId:'bar',index,title:`Saved ${index}`,path:'Bookmarks bar',url:`https://example.test/${index}`,updatedAt:1,syncGeneration:1});
const draft=(metadata:Record<string,string>={'plan-service.snapshot':'snapshot'},action='create')=>({id:'plan',title:'Preview',status:'validated',basedOnGeneration:1,metadata,steps:[{id:'step',action,targetBrowserId:action==='create'?null:'b1',parentBrowserId:'bar',expectedBefore:{title:'Saved 1',url:'https://example.test/1',parentId:'bar'},desiredAfter:{title:'New',url:'https://example.test/new'},reason:'User chose',riskLevel:action==='delete'?'high':'low',status:'pending',errorMessage:null}]});
async function flush(){for(let i=0;i<12;i++)await nextTick();await new Promise(resolve=>setTimeout(resolve,0));}
function button(text:string){const result=[...host.querySelectorAll('button')].find(item=>item.textContent?.trim()===text);expect(result,`button ${text}`).toBeTruthy();return result!;}
async function click(text:string){button(text).click();await flush();}
function setInput(input:HTMLInputElement|HTMLTextAreaElement,value:string){input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}
function mount(){host=document.createElement('div');document.body.append(host);app=createApp(Workspace);for(const name of ['ElTag','ElEmpty','ElForm','ElFormItem','ElTree','ElPagination','ElInputNumber'])app.component(name,passthrough);app.component('ElAlert',defineComponent({props:['title'],setup(props){return()=>h('p',props.title);}}));app.component('ElButton',defineComponent({props:['disabled','loading','nativeType','type'],setup(props,{slots}){return()=>h('button',{'data-variant':props.type,disabled:!!props.disabled||!!props.loading,type:props.nativeType||'button'},slots.default?.());}}));
const overlay=defineComponent({props:['modelValue'],setup(props,{slots}){return()=>props.modelValue?h('section',[slots.default?.(),slots.footer?.()]):null;}});app.component('ElDialog',overlay);app.component('ElDrawer',overlay);
app.component('ElInput',defineComponent({props:['modelValue','type','disabled'],emits:['update:modelValue'],setup(props,{emit,attrs}){return()=>h(props.type==='textarea'?'textarea':'input',{...attrs,type:props.type,value:props.modelValue,disabled:props.disabled,onInput:(event:Event)=>emit('update:modelValue',(event.target as HTMLInputElement).value)});}}));
app.component('ElSelect',defineComponent({props:['modelValue','disabled','multiple'],emits:['update:modelValue','change'],setup(props,{slots,emit,attrs}){return()=>h('select',{...attrs,value:props.modelValue,disabled:props.disabled,multiple:props.multiple,onChange:(event:Event)=>{const select=event.target as HTMLSelectElement;const value=props.multiple?[...select.selectedOptions].map(option=>option.value):select.value;emit('update:modelValue',value);emit('change',value);}},slots.default?.());}}));app.component('ElOption',defineComponent({props:['value','label','disabled'],setup(props){return()=>h('option',{value:props.value,disabled:props.disabled},props.label);}}));
app.component('ElCheckboxGroup',defineComponent({props:['modelValue','disabled'],emits:['update:modelValue'],setup(props,{slots,emit}){provide('checks',{values:computed(()=>props.modelValue),disabled:computed(()=>props.disabled),toggle:(value:string,checked:boolean)=>emit('update:modelValue',checked?[...props.modelValue,value]:props.modelValue.filter((item:string)=>item!==value))});return()=>h('div',slots.default?.());}}));app.component('ElCheckbox',defineComponent({props:['modelValue','value','disabled'],emits:['update:modelValue'],setup(props,{slots,emit}){const group=inject<{values:ComputedRef<string[]>;disabled:ComputedRef<boolean>;toggle:(value:string,checked:boolean)=>void}|undefined>('checks',undefined);return()=>h('label',[h('input',{type:'checkbox',checked:group?group.values.value.includes(props.value):props.modelValue,disabled:props.disabled||group?.disabled.value,onChange:(event:Event)=>{const checked=(event.target as HTMLInputElement).checked;if(group)group.toggle(props.value,checked);else emit('update:modelValue',checked);}}),slots.default?.()]);}}));
app.component('ElTable',defineComponent({props:['data'],emits:['selection-change'],setup(props,{slots,emit}){provide('rows',computed(()=>props.data));return()=>h('div',[h('button',{onClick:()=>emit('selection-change',props.data)},'Select fixture rows'),slots.default?.()]);}}));app.component('ElTableColumn',defineComponent({setup(_,{slots}){const rows=inject<ComputedRef<BookmarkRecord[]>>('rows');return()=>h('div',(rows?.value??[]).map(row=>slots.default?.({row})));}}));app.directive('loading',{});app.mount(host);}
beforeEach(()=>{vi.clearAllMocks();window.history.replaceState(null,'','/');state=reactive({rows:[bookmark()],folders:[{id:'root',browserId:'root',parentId:null,title:'',path:'',index:0,updatedAt:1,syncGeneration:1},{id:'bar',browserId:'bar',parentId:'root',title:'Bookmarks bar',path:'Bookmarks bar',index:0,updatedAt:1,syncGeneration:1}],stats:{bookmarks:1,lastSync:1},total:1,loading:false,error:''});mocks.getAssistantSettings.mockResolvedValue({region:'global',model:'MiniMax-M2.5',hasKey:false,consent:false,keyStorage:'session'});mocks.completeOnboarding.mockResolvedValue(undefined);mocks.cancelAdvice.mockResolvedValue(undefined);mocks.cancelTurn.mockResolvedValue(undefined);mocks.listSessions.mockResolvedValue([]);mocks.listTopicViews.mockResolvedValue([]);localStorage.clear();mocks.listHistory.mockResolvedValue([]);mocks.load.mockResolvedValue(undefined);mocks.prepareOrganization.mockResolvedValue(draft());mocks.analyzeDuplicates.mockResolvedValue({groups:[]});mocks.confirm.mockResolvedValue(true);mocks.permission.mockResolvedValue(true);vi.stubGlobal('chrome',{permissions:{request:mocks.permission}});});
afterEach(()=>{app?.unmount();host?.remove();vi.unstubAllGlobals();});
describe('integrated main workspace interactions',()=>{
 it('uses local search without needing a key or sending data to AI',async()=>{mount();await flush();setInput(host.querySelector('textarea')!,'Vue resources');await flush();host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();await new Promise(resolve=>setTimeout(resolve,220));expect(mocks.load).toHaveBeenLastCalledWith('Vue resources',undefined,0);expect(mocks.sendTurn).not.toHaveBeenCalled();expect(host.textContent).toContain('搜索“Vue resources”');});
 it('previews manual creation without AI and executes only after review, without mandatory export',async()=>{mount();await flush();await click('＋ 收藏网址');await click('Editor preview');expect(mocks.prepareOrganization).toHaveBeenCalledTimes(1);expect(button('批准并执行 1 项更改').disabled).toBe(true);expect(host.textContent).toContain('快照已自动保存');const review=[...host.querySelectorAll('label')].find(label=>label.textContent?.includes('已逐项核对'))!.querySelector('input')!;review.click();await flush();expect(button('批准并执行 1 项更改').disabled).toBe(false);expect(mocks.exportPlanBackup).not.toHaveBeenCalled();expect(mocks.sendTurn).not.toHaveBeenCalled();});
 it('blocks approval when a prepared plan lacks verified automatic snapshot evidence',async()=>{mocks.prepareOrganization.mockResolvedValue(draft({}));mount();await flush();await click('＋ 收藏网址');await click('Editor preview');[...host.querySelectorAll('label')].find(label=>label.textContent?.includes('已逐项核对'))!.querySelector('input')!.click();await flush();expect(button('批准并执行 1 项更改').disabled).toBe(true);expect(host.textContent).toContain('没有可验证的本地快照');});
 it('checks the 50-page limit before confirmation and permission requests',async()=>{state.rows=Array.from({length:51},(_,i)=>bookmark(i));mount();await flush();await click('Select fixture rows');await click('读取内容');expect(host.textContent).toContain('每次最多读取 50 个书签');expect(mocks.confirm).not.toHaveBeenCalled();expect(mocks.permission).not.toHaveBeenCalled();expect(mocks.fetchContent).not.toHaveBeenCalled();});
 it('preselects no duplicate deletions and prevents removing the last copy',async()=>{mocks.analyzeDuplicates.mockResolvedValue({groups:[{url:'https://example.test/same',bookmarks:[bookmark(1),bookmark(2)]}]});mount();await flush();await click('⇄ 整理书签');await click('检查完全相同的 URL');const inputs=[...host.querySelectorAll('.duplicate-card input')] as HTMLInputElement[];expect(inputs.every(input=>!input.checked)).toBe(true);expect(button('预览移除 0 个重复书签').disabled).toBe(true);inputs[0].click();await flush();expect(inputs[1].disabled).toBe(true);await click('预览移除 1 个重复书签');expect(mocks.prepareOrganization).toHaveBeenLastCalledWith({title:'移除选中的重复书签',steps:[{action:'delete',targetBrowserId:'b1',reason:expect.any(String)}],evidence:expect.objectContaining({exactDuplicateGroups:[{url:'https://example.test/same',bookmarkIds:['b1','b2']}]})});});
 it('keeps settings draft changes isolated when cancelled',async()=>{mount();await flush();await click('AI 设置');const selects=[...host.querySelectorAll('select')];const region=selects.find(select=>[...select.options].some(option=>option.value==='cn'))!;region.value='cn';region.dispatchEvent(new Event('change'));await flush();await click('取消');await click('AI 设置');const reopened=[...host.querySelectorAll('select')].find(select=>[...select.options].some(option=>option.value==='cn'))!;expect(reopened.value).toBe('global');expect(mocks.saveAssistantSettings).not.toHaveBeenCalled();});
 it('keeps manual preview failures visible inside the editor',async()=>{mocks.prepareOrganization.mockRejectedValue(new Error('API key secret-key'));mount();await flush();await click('＋ 收藏网址');await click('Editor preview');expect(host.textContent).toContain('密钥缺失');expect(host.textContent).not.toContain('secret-key');expect(button('Editor preview')).toBeTruthy();});
});

const configured={region:'global',model:'MiniMax-M2.5',hasKey:true,consent:true,keyStorage:'session',autoSuggestions:true,connectionTested:true,onboardingCompleted:true};
const autoResult={id:'auto-session',revision:3,mode:'recommend',scope:{},messages:[{id:'reply',role:'assistant',text:'Automatic useful suggestion'}],citations:[]};
async function waitAutomatic(){await new Promise(resolve=>setTimeout(resolve,850));await flush();}
describe('first-use guidance and proactive workspace advice',()=>{
 it('shows onboarding once, lets the user skip and keeps local search usable',async()=>{mocks.getAssistantSettings.mockResolvedValue({...configured,hasKey:false,consent:false,autoSuggestions:false,connectionTested:false,onboardingCompleted:false});mount();await flush();expect(host.textContent).toContain('先连接 MiniMax');await click('稍后配置，先用本地功能');expect(mocks.completeOnboarding).toHaveBeenCalledTimes(1);expect(host.textContent).not.toContain('先连接 MiniMax');expect(mocks.sendTurn).not.toHaveBeenCalled();await click('AI 设置');expect(button('保存并测试连接')).toBeTruthy();});
 it('saves then tests once and completes onboarding without exposing the key',async()=>{mocks.getAssistantSettings.mockResolvedValue({...configured,onboardingCompleted:false});mocks.testAssistantConnection.mockResolvedValue(configured);mount();await flush();const input=host.querySelector('input[type=password]')! as HTMLInputElement;setInput(input,'synthetic-only-key');await flush();await click('保存并测试连接');expect(mocks.saveAssistantSettings).toHaveBeenCalledWith(expect.objectContaining({apiKey:'synthetic-only-key',autoSuggestions:true}));expect(mocks.testAssistantConnection).toHaveBeenCalledTimes(1);expect(mocks.completeOnboarding).toHaveBeenCalledTimes(1);expect(host.textContent).not.toContain('synthetic-only-key');});
 it('does not retry a failed connection test and leaves settings recoverable',async()=>{mocks.getAssistantSettings.mockResolvedValue({...configured,onboardingCompleted:false});mocks.testAssistantConnection.mockRejectedValue(new Error('MiniMax 请求受限'));mount();await flush();await click('保存并测试连接');expect(host.textContent).toContain('重新测试');expect(mocks.completeOnboarding).not.toHaveBeenCalled();expect(mocks.testAssistantConnection).toHaveBeenCalledTimes(1);expect(button('稍后配置，先用本地功能')).toBeTruthy();});
 it('waits for explicit search submission then automatically recommends once for the same context',async()=>{mocks.getAssistantSettings.mockResolvedValue(configured);mocks.createSession.mockResolvedValue({...autoResult,messages:[]});mocks.sendTurn.mockResolvedValue(autoResult);mount();await flush();setInput(host.querySelector('textarea')!,'Vue resources');await flush();await waitAutomatic();expect(mocks.sendTurn).not.toHaveBeenCalled();host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();await waitAutomatic();expect(mocks.sendTurn).toHaveBeenCalledWith('auto-session',expect.stringContaining('Vue resources'),expect.objectContaining({signal:expect.any(AbortSignal)}));expect(host.textContent).toContain('Automatic useful suggestion');host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();await waitAutomatic();expect(mocks.sendTurn).toHaveBeenCalledTimes(1);expect(mocks.prepareOrganization).not.toHaveBeenCalled();});
 it('automatically suggests on deliberate organize entry using at most 20 visible bookmarks',async()=>{state.rows=Array.from({length:25},(_,i)=>bookmark(i));mocks.getAssistantSettings.mockResolvedValue(configured);mocks.createSession.mockResolvedValue({...autoResult,messages:[]});mocks.sendTurn.mockResolvedValue(autoResult);mount();await flush();expect(mocks.sendTurn).not.toHaveBeenCalled();await click('⇄ 整理书签');await waitAutomatic();expect(mocks.createSession).toHaveBeenCalledWith({mode:'organize',scope:{bookmarkIds:state.rows.slice(0,20).map(b=>b.id)}});expect(mocks.sendTurn).toHaveBeenCalledTimes(1);expect(mocks.prepareOrganization).not.toHaveBeenCalled();});
 it('cancels and ignores stale automatic responses when the user leaves the context',async()=>{let resolve!:(value:typeof autoResult)=>void;mocks.getAssistantSettings.mockResolvedValue(configured);mocks.createSession.mockResolvedValue({...autoResult,messages:[]});mocks.sendTurn.mockImplementation(()=>new Promise(r=>resolve=r));mount();await flush();await click('⇄ 整理书签');await waitAutomatic();await click('▦ 浏览书签');expect(mocks.cancelTurn).toHaveBeenCalledWith('auto-session');resolve(autoResult);await flush();expect(host.textContent).not.toContain('Automatic useful suggestion');});
 it.each(['hasKey','consent','autoSuggestions','connectionTested'])('does not automatically transmit when %s is false',async(field)=>{mocks.getAssistantSettings.mockResolvedValue({...configured,[field]:false});mount();await flush();await click('⇄ 整理书签');await waitAutomatic();expect(mocks.sendTurn).not.toHaveBeenCalled();});
});

describe('automatic guidance scope and freshness regressions',()=>{
 beforeEach(()=>{mocks.getAssistantSettings.mockResolvedValue(configured);mocks.createSession.mockResolvedValue({...autoResult,messages:[]});mocks.sendTurn.mockResolvedValue(autoResult);});
 it('captures the explicit selected search scope before local search clears table selection',async()=>{state.rows=[bookmark(1),bookmark(2)];mount();await flush();await click('Select fixture rows');const select=host.querySelector('select[aria-label="新任务的书签范围"]')! as HTMLSelectElement;select.value='selected';select.dispatchEvent(new Event('change'));await flush();setInput(host.querySelector('textarea')!,'Vue resources');host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();await waitAutomatic();expect(mocks.createSession).toHaveBeenCalledWith({mode:'assist',scope:{bookmarkIds:['b1','b2']}});expect(host.textContent).toContain('所选 2 个书签');});
 it('discloses visible organize truncation and refuses silent truncation of explicit selections',async()=>{state.rows=Array.from({length:25},(_,i)=>bookmark(i));mount();await flush();await click('⇄ 整理书签');await waitAutomatic();expect(host.textContent).toContain('当前页 20 / 25 个书签（仅前 20 个，其余未发送）');await click('▦ 浏览书签');await click('Select fixture rows');await click('⇄ 整理书签');await waitAutomatic();expect(host.textContent).toContain('已选择超过 20 个书签');expect(mocks.sendTurn).toHaveBeenCalledTimes(1);});
 it('clears displayed advice when bookmark data changes and never replays old cached answers',async()=>{mount();await flush();await click('⇄ 整理书签');await waitAutomatic();expect(host.textContent).toContain('Automatic useful suggestion');state.rows[0].title='Changed after suggestion';await flush();expect(host.textContent).not.toContain('Automatic useful suggestion');await click('▦ 浏览书签');mocks.sendTurn.mockResolvedValue({...autoResult,messages:[{id:'fresh',role:'assistant',text:'Fresh answer'}]});await click('⇄ 整理书签');await waitAutomatic();expect(host.textContent).toContain('Fresh answer');expect(mocks.sendTurn).toHaveBeenCalledTimes(2);});
 it('does not restore a cached answer after privacy exclusions change',async()=>{mount();await flush();setInput(host.querySelector('textarea')!,'Guide');host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();await waitAutomatic();expect(host.textContent).toContain('Automatic useful suggestion');await click('AI 设置');const excluded=host.querySelector('select[aria-label="排除的 AI 目录"]')! as HTMLSelectElement;excluded.value='bar';excluded.dispatchEvent(new Event('change'));await flush();mocks.getAssistantSettings.mockResolvedValue({...configured,excludedFolderIds:['bar']});await click('保存设置');expect(host.textContent).not.toContain('Automatic useful suggestion');mocks.sendTurn.mockResolvedValue({...autoResult,messages:[{id:'private-safe',role:'assistant',text:'New privacy-scoped answer'}]});setInput(host.querySelector('textarea')!,'Guide again');await flush();host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();await waitAutomatic();expect(mocks.sendTurn).toHaveBeenCalledTimes(2);expect(host.textContent).toContain('New privacy-scoped answer');expect(host.textContent).not.toContain('Automatic useful suggestion');});
 it('retries a failed selected search with its original explicit scope',async()=>{state.rows=[bookmark(1),bookmark(2)];mocks.sendTurn.mockRejectedValueOnce(new Error('Provider unavailable')).mockResolvedValue(autoResult);mount();await flush();await click('Select fixture rows');const select=host.querySelector('select[aria-label="新任务的书签范围"]')! as HTMLSelectElement;select.value='selected';select.dispatchEvent(new Event('change'));await flush();setInput(host.querySelector('textarea')!,'Guide');host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();await waitAutomatic();await click('继续任务');await waitAutomatic();expect(mocks.createSession).toHaveBeenCalledTimes(1);expect(mocks.createSession).toHaveBeenLastCalledWith({mode:'assist',scope:{bookmarkIds:['b1','b2']}});expect(host.textContent).toContain('Automatic useful suggestion');});
 it('clears tested UI state after a failed retest and prevents automatic work',async()=>{mount();await flush();await click('AI 设置');mocks.testAssistantConnection.mockRejectedValue(new Error('Connection failed'));mocks.getAssistantSettings.mockResolvedValue({...configured,connectionTested:false});await click('保存并测试连接');await click('取消');expect(host.textContent).toContain('当前连接尚未测试');await click('⇄ 整理书签');await waitAutomatic();expect(mocks.sendTurn).not.toHaveBeenCalled();});
});

describe('restored search and conversation navigation',()=>{
 it('keeps query-only new-task links prefilled',async()=>{window.history.replaceState(null,'','/?q=Saved');mount();await flush();expect((host.querySelector('textarea')! as HTMLTextAreaElement).value).toBe('Saved');expect(mocks.getSession).not.toHaveBeenCalled();});
 it('preserves local query without creating a phantom unsent draft when restoring a conversation',async()=>{window.history.replaceState(null,'','/?q=Saved&session=auto-session');mocks.getAssistantSettings.mockResolvedValue(configured);mocks.getSession.mockResolvedValue(autoResult);mocks.listSessions.mockResolvedValue([{id:'auto-session',title:'Restored conversation'}]);mount();await flush();expect((host.querySelector('textarea')! as HTMLTextAreaElement).value).toBe('');expect(mocks.load).toHaveBeenCalledWith('Saved',undefined,0);await click('历史与恢复');await click('Restored conversation继续对话 →');expect(mocks.confirm).not.toHaveBeenCalled();expect(mocks.getSession).toHaveBeenCalledTimes(2);});
 it('still protects an actual newly typed draft while switching restored conversations',async()=>{window.history.replaceState(null,'','/?q=Saved&session=auto-session');mocks.getSession.mockResolvedValue(autoResult);mocks.listSessions.mockResolvedValue([{id:'auto-session',title:'Restored conversation'}]);mount();await flush();setInput(host.querySelector('textarea')!,'Do not discard this draft');await flush();mocks.confirm.mockRejectedValueOnce(new Error('cancel'));await click('历史与恢复');await click('Restored conversation继续对话 →');expect(mocks.confirm).toHaveBeenCalledTimes(1);expect((host.querySelector('textarea')! as HTMLTextAreaElement).value).toBe('Do not discard this draft');expect(mocks.getSession).toHaveBeenCalledTimes(1);});
});

describe('existing bookmark capture navigation',()=>{
 it('opens the fresh native record for editing without automatic analysis',async()=>{window.history.replaceState(null,'','/?edit=already-saved');const get=vi.fn(async()=>[{id:'already-saved',parentId:'bar',title:'Existing native title',url:'https://example.test/existing?Case=YES#frag',index:2}]);vi.stubGlobal('chrome',{permissions:{request:mocks.permission},bookmarks:{get}});mocks.getAssistantSettings.mockResolvedValue(configured);mount();await flush();expect(get).toHaveBeenCalledWith('already-saved');expect(mocks.sync).toHaveBeenCalled();expect(host.textContent).toContain('Existing native title');expect(button('Editor preview')).toBeTruthy();expect(mocks.adviseBookmark).not.toHaveBeenCalled();expect(window.location.search).not.toContain('edit=');});
 it('opens a specific saved location in browse mode without creating or analyzing a duplicate',async()=>{window.history.replaceState(null,'','/?view=saved-here');const get=vi.fn(async()=>[{id:'saved-here',parentId:'bar',title:'Existing location',url:'https://example.test/existing?Case=YES#frag',index:2}]);vi.stubGlobal('chrome',{permissions:{request:mocks.permission},bookmarks:{get}});mount();await flush();await new Promise(resolve=>setTimeout(resolve,220));expect(get).toHaveBeenCalledWith('saved-here');expect(mocks.load).toHaveBeenLastCalledWith('https://example.test/existing?Case=YES#frag','bar',0);expect(window.location.search).not.toContain('view=');expect(mocks.adviseBookmark).not.toHaveBeenCalled();expect(mocks.prepareOrganization).not.toHaveBeenCalled();});
 it('keeps a missing native bookmark error visible and never substitutes a new capture',async()=>{window.history.replaceState(null,'','/?edit=gone');vi.stubGlobal('chrome',{permissions:{request:mocks.permission},bookmarks:{get:vi.fn(async()=>[])}});mount();await flush();expect(host.textContent).toContain('已移动或删除');expect(mocks.adviseBookmark).not.toHaveBeenCalled();expect([...host.querySelectorAll('button')].some(b=>b.textContent==='Editor preview')).toBe(false);});
});

describe('settings recovery and actionable feedback',()=>{
 it('keeps first-use actions present and validates a missing key before requesting permissions or saving',async()=>{
  mocks.getAssistantSettings.mockResolvedValue({...configured,hasKey:false,onboardingCompleted:false});mount();await flush();
  expect(host.querySelector('.setup-steps')?.textContent).toContain('保存并测试');
  expect(host.querySelector('.settings-actions')?.textContent).toContain('稍后配置，先用本地功能');
  await click('保存并测试连接');
  expect(host.querySelector('.settings-feedback')?.textContent).toContain('请先输入所选区域的 API Key');
  expect(mocks.permission).not.toHaveBeenCalled();expect(mocks.saveAssistantSettings).not.toHaveBeenCalled();expect(mocks.testAssistantConnection).not.toHaveBeenCalled();
 });
 it('does not treat a key saved for another region as usable for the new region',async()=>{
  mocks.getAssistantSettings.mockResolvedValue(configured);mount();await flush();await click('AI 设置');
  const region=[...host.querySelectorAll('select')].find(select=>[...select.options].some(option=>option.value==='cn'))!;
  region.value='cn';region.dispatchEvent(new Event('change'));await flush();await click('保存并测试连接');
  expect(host.querySelector('.settings-feedback')?.textContent).toContain('请先输入所选区域');expect(mocks.permission).not.toHaveBeenCalled();expect(mocks.saveAssistantSettings).not.toHaveBeenCalled();
 });
 it('reports a failed save honestly and preserves the entered key for retry',async()=>{
  mocks.getAssistantSettings.mockResolvedValue(configured);mocks.saveAssistantSettings.mockRejectedValueOnce(new Error('Storage unavailable'));mount();await flush();await click('AI 设置');
  setInput(host.querySelector('input[type=password]')!,'synthetic-retry-key');await flush();await click('保存并测试连接');
  expect(host.querySelector('.settings-feedback')?.textContent).toContain('设置未保存');expect(host.textContent).not.toContain('设置已保存');
  expect((host.querySelector('input[type=password]')! as HTMLInputElement).value).toBe('synthetic-retry-key');expect(mocks.testAssistantConnection).not.toHaveBeenCalled();expect(button('取消').disabled).toBe(false);
 });
 it('prevents duplicate save requests while awaiting the connection test and unlocks after failure',async()=>{
  let reject!:(error:Error)=>void;mocks.getAssistantSettings.mockResolvedValue(configured);mocks.testAssistantConnection.mockImplementationOnce(()=>new Promise((_resolve,r)=>reject=r));mount();await flush();await click('AI 设置');await click('保存并测试连接');
  expect(button('保存并测试连接').disabled).toBe(true);expect(button('取消').disabled).toBe(true);button('保存并测试连接').click();await flush();expect(mocks.saveAssistantSettings).toHaveBeenCalledTimes(1);
  reject(new Error('Connection failed'));await flush();expect(host.querySelector('.settings-feedback')?.textContent).toContain('设置已保存，但连接测试未通过');expect(button('保存并测试连接').disabled).toBe(false);
 });
});


describe('capture destination handoff',()=>{
 it('restores the chosen popup folder instead of replacing it with the first default folder',async()=>{
  state.folders.push({id:'chosen',browserId:'chosen',parentId:'bar',title:'Chosen',path:'Bookmarks bar / Chosen',index:0,updatedAt:1,syncGeneration:1});
  window.history.replaceState(null,'','/?capture=draft-id');mocks.getCapture.mockResolvedValue({title:'Draft',url:'https://example.test/draft',parentFolderId:'chosen'});mount();await flush();
  expect(host.querySelector('[data-editor-parent]')?.textContent).toBe('chosen');expect(mocks.prepareOrganization).not.toHaveBeenCalled();
 });
 it.each([{parentFolderId:'deleted-folder'},{destinationUnavailable:true}])('keeps a recoverable draft and explains when its destination is no longer available: %j',async(extra)=>{
  window.history.replaceState(null,'','/?capture=draft-id');mocks.getCapture.mockResolvedValue({title:'Draft',url:'https://example.test/draft',...extra});mount();await flush();
  expect(host.textContent).toContain('原先选择的目录已不可用');expect(host.querySelector('[data-editor-parent]')?.textContent).toBe('bar');expect(button('Editor preview')).toBeTruthy();expect(mocks.prepareOrganization).not.toHaveBeenCalled();
 });
});


it('does not mislabel a completion failure as a failed connection after the test succeeded',async()=>{
 mocks.getAssistantSettings.mockResolvedValue({...configured,onboardingCompleted:false});mocks.testAssistantConnection.mockResolvedValue(configured);mocks.completeOnboarding.mockRejectedValueOnce(new Error('Storage unavailable'));mount();await flush();await click('保存并测试连接');
 expect(host.querySelector('.settings-feedback')?.textContent).toContain('连接测试已通过，但未能完成引导');expect(host.textContent).not.toContain('连接测试未通过');expect(button('稍后配置，先用本地功能').disabled).toBe(false);expect(mocks.testAssistantConnection).toHaveBeenCalledTimes(1);
});


describe('first-principles task hierarchy',()=>{
 it('makes local search the single primary prompt action without requiring AI setup',async()=>{
  mount();await flush();const primary=host.querySelectorAll('.goal-form button[data-variant="primary"]');
  expect(primary).toHaveLength(1);expect(primary[0].textContent).toBe('开始任务');
  expect(host.textContent).not.toContain('帮我挑选值得读的');
  expect(host.querySelector('.header-actions')?.textContent).not.toContain('目录');
 });
 it('keeps maintenance discoverable in one closed disclosure and returns to the same workspace',async()=>{
  mount();await flush();const menu=host.querySelector('details.utility-menu') as HTMLDetailsElement;
  expect(menu.open).toBe(false);expect(menu.querySelector('summary')?.textContent).toBe('更多工具');
  for(const name of ['历史与恢复','导入 / 导出','链接健康','刷新原生书签'])expect(menu.textContent).toContain(name);
  menu.open=true;await click('导入 / 导出');expect(host.textContent).toContain('Tools');await click('返回工作台');
  expect(host.textContent).not.toContain('Tools');expect(host.querySelector('[aria-label="浏览书签"]')).not.toBeNull();
  expect(mocks.sendTurn).not.toHaveBeenCalled();expect(mocks.prepareOrganization).not.toHaveBeenCalled();
 });
 it('keeps optional content actions out of the default selection controls while retaining explicit access',async()=>{
  mount();await flush();await click('Select fixture rows');const details=host.querySelector('details.content-tools') as HTMLDetailsElement;
  expect(details.open).toBe(false);expect(details.querySelector('summary')?.textContent).toBe('页面内容（可选）');
  expect(details.textContent).toContain('读取内容');expect(details.textContent).toContain('内容状态');
  expect(button('移动所选').closest('details')).toBeNull();expect(button('预览删除').closest('details')).toBeNull();
  expect(mocks.fetchContent).not.toHaveBeenCalled();expect(mocks.permission).not.toHaveBeenCalled();
 });
 it('makes continuing a conversation primary and sends a form submission to that conversation',async()=>{
  mocks.getAssistantSettings.mockResolvedValue({...configured,autoSuggestions:false});
  mocks.createSession.mockResolvedValue({...autoResult,messages:[]});mocks.sendTurn.mockResolvedValue(autoResult);
  mount();await flush();setInput(host.querySelector('textarea')!,'Find a useful source');await flush();await click('开始任务');
  const primary=host.querySelectorAll('.goal-form button[data-variant="primary"]');expect(primary).toHaveLength(1);expect(primary[0].textContent).toBe('继续任务');
  setInput(host.querySelector('textarea')!,'Compare those sources');await flush();host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();
  expect(mocks.sendTurn).toHaveBeenLastCalledWith('auto-session','Compare those sources',expect.objectContaining({signal:expect.any(AbortSignal),onText:expect.any(Function)}));expect(host.querySelector('[aria-label="AI 多轮对话"]')).not.toBeNull();
 });
});

describe('streaming conversation presentation',()=>{
 type StreamOptions={expectedRevision:number;signal:AbortSignal;onText:(text:string)=>void};
 async function begin(){mocks.getAssistantSettings.mockResolvedValue({...configured,autoSuggestions:false});mocks.createSession.mockResolvedValue({...autoResult,messages:[]});mount();await flush();setInput(host.querySelector('textarea')!,'Compare my saved sources');await flush();await click('开始任务');}
 it('renders real partial text before completion, but exposes references and actions only from the final session',async()=>{
  let stream!:StreamOptions;let finish!:(result:unknown)=>void;
  mocks.sendTurn.mockImplementationOnce((_id,_text,options)=>{stream=options;return new Promise(resolve=>finish=resolve);});await begin();
  expect(host.querySelector('[aria-label="正在发送的问题"]')?.textContent).toContain('Compare my saved sources');
  stream.onText('The first source');await flush();expect(host.querySelector('[aria-label="正在生成的回复"]')?.textContent).toContain('The first source');
  stream.onText('The first source is useful.');await flush();expect(host.querySelector('.streaming-message .message-text')?.textContent).toBe('The first source is useful.');
  expect(host.querySelector('[aria-label="本轮来源引用"]')).toBeNull();expect(host.querySelector('.suggestion-button')).toBeNull();expect(mocks.prepareOrganization).not.toHaveBeenCalled();
  finish({...autoResult,messages:[{id:'final',role:'assistant',text:'The first source is useful.',references:[{citationId:'B1',title:'Source',url:'https://example.test/1',path:'Books',reason:'Relevant'}],moves:[{bookmarkId:'b1',targetFolderId:'bar',reason:'Useful'}]}]});await flush();
  expect(host.querySelector('.streaming-message')).toBeNull();expect(host.querySelector('[aria-label="本轮来源引用"]')).not.toBeNull();expect(host.querySelector('.suggestion-button')).not.toBeNull();expect((host.querySelector('textarea')! as HTMLTextAreaElement).value).toBe('');
  stream.onText('late event');await flush();expect(host.textContent).not.toContain('late event');
 });
 it('stops the request, drops partial output, preserves the question and ignores late callbacks',async()=>{
  let stream!:StreamOptions;
  mocks.sendTurn.mockImplementationOnce((_id,_text,options)=>{stream=options;return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('canceled')),{once:true}));});await begin();
  stream.onText('Unfinished reply');await flush();await click('取消生成');
  expect(stream.signal.aborted).toBe(true);expect(host.querySelector('.streaming-message')).toBeNull();expect(host.textContent).toContain('已停止生成');expect((host.querySelector('textarea')! as HTMLTextAreaElement).value).toBe('Compare my saved sources');
  stream.onText('Stale reply');await flush();expect(host.textContent).not.toContain('Stale reply');expect(button('继续任务').disabled).toBe(false);expect(mocks.prepareOrganization).not.toHaveBeenCalled();
 });
 it('keeps failed partial turns out of history and leaves a retryable draft',async()=>{
  let stream!:StreamOptions;let fail!:(error:Error)=>void;
  mocks.sendTurn.mockImplementationOnce((_id,_text,options)=>{stream=options;return new Promise((_resolve,reject)=>fail=reject);});await begin();stream.onText('Incomplete answer');await flush();fail(new Error('provider unavailable'));await flush();
  expect(host.querySelector('.streaming-message')).toBeNull();expect(host.textContent).not.toContain('Incomplete answer');expect((host.querySelector('textarea')! as HTMLTextAreaElement).value).toBe('Compare my saved sources');expect(button('继续任务').disabled).toBe(false);
  mocks.sendTurn.mockResolvedValueOnce({...autoResult,messages:[{id:'retry',role:'assistant',text:'Complete retry answer'}]});await click('继续任务');expect(host.textContent).toContain('Complete retry answer');
 });
 it('waits for the stop outcome and accepts a turn that committed before cancellation',async()=>{
  let stream!:StreamOptions;let finish!:(result:unknown)=>void;
  mocks.sendTurn.mockImplementationOnce((_id,_text,options)=>{stream=options;return new Promise(resolve=>finish=resolve);});await begin();
  expect(stream.expectedRevision).toBe(3);stream.onText('Pending reply');await flush();await click('取消生成');
  expect(stream.signal.aborted).toBe(true);expect(host.textContent).toContain('正在停止并核对保存状态');expect(host.textContent).not.toContain('已停止生成');expect(button('取消生成').disabled).toBe(true);expect(host.querySelector('.streaming-message')).toBeNull();
  finish({...autoResult,revision:4,messages:[{id:'saved-before-stop',role:'assistant',text:'Committed complete answer'}]});await flush();
  expect(host.textContent).toContain('Committed complete answer');expect(host.textContent).toContain('回答已在停止前完成');expect((host.querySelector('textarea')! as HTMLTextAreaElement).value).toBe('');expect(host.textContent).not.toContain('已停止生成');
 });
 it('does not claim safe cancellation on reconciliation failure and requires review before retry',async()=>{
  let fail!:(error:Error)=>void;mocks.sendTurn.mockImplementationOnce(()=>new Promise((_resolve,reject)=>fail=reject));await begin();await click('取消生成');
  fail(new Error('无法确认本次回答是否已保存，请重新打开对话核对后再发送。'));await flush();
  expect(host.textContent).toContain('无法确认本次回答是否已保存');expect(host.textContent).not.toContain('已停止生成');expect(button('继续任务').disabled).toBe(true);expect((host.querySelector('textarea')! as HTMLTextAreaElement).value).toBe('Compare my saved sources');
  host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();expect(mocks.sendTurn).toHaveBeenCalledTimes(1);
  mocks.getSession.mockRejectedValueOnce(new Error('offline'));await click('重新核对当前对话');expect(button('继续任务').disabled).toBe(true);
  mocks.getSession.mockResolvedValueOnce({...autoResult,revision:4,messages:[{id:'reconciled',role:'assistant',text:'Saved latest reply'}]});await click('重新核对当前对话');
  expect(host.textContent).toContain('Saved latest reply');expect(host.textContent).toContain('请先核对回复');expect(button('继续任务').disabled).toBe(false);
  mocks.sendTurn.mockResolvedValueOnce({...autoResult,revision:5});await click('继续任务');expect(mocks.sendTurn).toHaveBeenLastCalledWith('auto-session','Compare my saved sources',expect.objectContaining({expectedRevision:4}));
 });
 it('clears an unresolved-turn block when privacy changes deliberately start a new context',async()=>{
  mocks.sendTurn.mockRejectedValueOnce(new Error('无法确认本次回答是否已保存，请重新打开对话核对后再发送。'));await begin();expect(button('继续任务').disabled).toBe(true);
  await click('AI 设置');const excluded=host.querySelector('select[aria-label="排除的 AI 目录"]')! as HTMLSelectElement;excluded.value='bar';excluded.dispatchEvent(new Event('change'));await flush();await click('保存设置');
  expect(button('开始任务').disabled).toBe(false);expect(host.textContent).not.toContain('重新核对当前对话');expect(host.textContent).not.toContain('正在停止');
 });
 it('clears an unresolved-turn block when deliberately opening a completed automatic suggestion',async()=>{
  mocks.getAssistantSettings.mockResolvedValue(configured);mocks.createSession.mockResolvedValue({...autoResult,messages:[]});mocks.sendTurn.mockRejectedValueOnce(new Error('无法确认本次回答是否已保存，请重新打开对话核对后再发送。'));
  mount();await flush();setInput(host.querySelector('textarea')!,'Find sources');await flush();await click('开始任务');expect(button('继续任务').disabled).toBe(true);
  mocks.sendTurn.mockResolvedValueOnce(autoResult);await click('⇄ 整理书签');await waitAutomatic();await click('查看建议详情');
  expect(button('继续任务').disabled).toBe(false);expect(host.textContent).not.toContain('重新核对当前对话');
 });
 it('aborts when the workspace closes and suppresses stale text callbacks',async()=>{
  let stream!:StreamOptions;mocks.sendTurn.mockImplementationOnce((_id,_text,options)=>{stream=options;return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('canceled')),{once:true}));});await begin();app!.unmount();app=undefined;
  expect(stream.signal.aborted).toBe(true);stream.onText('Late after close');await flush();expect(host.textContent).not.toContain('Late after close');
 });
});

describe('task-first current results and virtual views',()=>{
 it('submits to AI with consent even when background advice is off, while local matching starts immediately',async()=>{
  mocks.getAssistantSettings.mockResolvedValue({...configured,autoSuggestions:false});mocks.createSession.mockResolvedValue({...autoResult,messages:[]});
  let finish!:(value:unknown)=>void;mocks.sendTurn.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));mount();await flush();setInput(host.querySelector('textarea')!,'Plan a reading task');await flush();await click('开始任务');
  expect(mocks.load).toHaveBeenLastCalledWith('Plan a reading task',undefined,0);expect(host.querySelector('.local-task-results')?.textContent).toContain('Saved 1');expect(mocks.sendTurn).toHaveBeenCalledTimes(1);finish(autoResult);await flush();
 });
 it('keeps the local-only alternative strictly local even with automatic suggestions enabled',async()=>{
  mocks.getAssistantSettings.mockResolvedValue(configured);mount();await flush();setInput(host.querySelector('textarea')!,'Saved');await flush();await click('仅本地搜索');await waitAutomatic();expect(mocks.sendTurn).not.toHaveBeenCalled();expect(mocks.createSession).not.toHaveBeenCalled();
 });
 it('renders one current result list, preserving IDs and showing prior references only on request',async()=>{
  window.history.replaceState(null,'','/?session=prior');mocks.getSession.mockResolvedValue({...autoResult,messages:[
   {id:'u1',role:'user',text:'First task'},{id:'a1',role:'assistant',text:'First answer',references:[{citationId:'B7',bookmarkId:'b1',title:'Prior source',url:'https://example.test/old',path:'Books',reason:'Earlier'}]},
   {id:'u2',role:'user',text:'Compare the second source'},{id:'a2',role:'assistant',text:'Current answer',references:[{citationId:'B12',bookmarkId:'b2',title:'Current source',url:'https://example.test/current?Case=YES#frag',path:'Books',reason:'Relevant',evidenceLabel:'仅依据书签元数据'}]}]});
  mount();await flush();expect(host.querySelectorAll('.task-result-list')).toHaveLength(1);expect(host.querySelector('.task-result-list')?.textContent).toContain('B12');expect(host.textContent).not.toContain('First answer');expect(host.querySelector('.task-result-list a')?.getAttribute('href')).toBe('https://example.test/current?Case=YES#frag');
  await click('查看之前 1 轮回答');expect(host.textContent).toContain('First answer');expect(host.querySelectorAll('.task-result-list')).toHaveLength(1);expect(host.querySelector('.previous-references')?.textContent).toContain('B7');expect((host.querySelector('.previous-references') as HTMLDetailsElement).open).toBe(false);
 });
 it('opens a virtual topic and persists its dismissal without preparing any native changes',async()=>{
  mocks.listTopicViews.mockResolvedValue([{id:'theme-1',title:'Design reading',bookmarkIds:['b9'],reason:'Related topic',sourceMessageId:'reply',bookmarks:[bookmark(9)]}]);mount();await flush();await click('Design reading · 1');expect(host.textContent).toContain('虚拟主题 · 1 个书签');expect(host.textContent).toContain('Saved 9');expect(mocks.prepareOrganization).not.toHaveBeenCalled();
  (host.querySelector('button[aria-label="隐藏主题 Design reading"]')! as HTMLButtonElement).click();await flush();expect(host.querySelector('[aria-label="虚拟主题视图"]')).toBeNull();expect(JSON.parse(localStorage.getItem('bookmark-workspace.dismissed-topics')!)).toEqual(['theme-1']);expect(mocks.sendTurn).not.toHaveBeenCalled();
 });
 it('excludes an operation by generating a fresh unapproved preview rather than executing it',async()=>{
  const original=draft({'plan-service.snapshot':'snapshot','plan-service.mode':'organization'});original.steps.push({...original.steps[0],id:'second',desiredAfter:{title:'Other',url:'https://example.test/other'}});mocks.prepareOrganization.mockResolvedValueOnce(original).mockResolvedValueOnce(draft());mount();await flush();await click('＋ 收藏网址');await click('Editor preview');await click('排除此项并重新预览');expect(mocks.prepareOrganization).toHaveBeenCalledTimes(2);expect(mocks.prepareOrganization.mock.calls[1][0].steps).toHaveLength(1);expect(button('批准并执行 1 项更改').disabled).toBe(true);expect(mocks.execute).not.toHaveBeenCalled();
 });
});

it('invalidates stale virtual themes on a native sync and ignores an older pending response',async()=>{
 const topic={id:'theme-sync',title:'Old topic',bookmarkIds:['b9'],reason:'Related',sourceMessageId:'reply',bookmarks:[bookmark(9)]};mocks.listTopicViews.mockResolvedValue([topic]);mount();await flush();await click('Old topic · 1');
 let finish!:(value:unknown)=>void;mocks.listTopicViews.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));state.stats.lastSync=2;await flush();expect(host.textContent).not.toContain('虚拟主题 · 1 个书签');
 mocks.listTopicViews.mockResolvedValue([]);state.stats.lastSync=3;await flush();finish([topic]);await flush();expect(host.querySelector('[aria-label="虚拟主题视图"]')).toBeNull();expect(mocks.prepareOrganization).not.toHaveBeenCalled();
});
