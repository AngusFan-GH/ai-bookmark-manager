import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, provide, inject, computed, type ComputedRef, type App } from 'vue';
import ImportFlow from '../../entrypoints/options/components/ImportFlow.vue';
import HealthView from '../../entrypoints/options/components/HealthView.vue';
const mocks = vi.hoisted(() => ({
  previewImport: vi.fn(), draftPlan: vi.fn(), approve: vi.fn(), execute: vi.fn(), getPlan: vi.fn(), load:vi.fn(),
  getSetting:vi.fn(), healthPermissionStatus:vi.fn(), healthStatus:vi.fn(), healthList:vi.fn(), request:vi.fn(), exportPlanBackup:vi.fn(),
}));
vi.mock('../../src/store', () => ({ useToolsBookmarkStore: () => ({...mocks, rows:[], folders:[]}) }));
vi.mock('../../src/client', () => ({ request: mocks.request }));
vi.mock('../../src/workspace-client', () => ({ exportPlanBackup: mocks.exportPlanBackup }));
vi.mock('element-plus', () => ({ ElMessage: {error:vi.fn(),info:vi.fn(),success:vi.fn(),warning:vi.fn()}, ElMessageBox: {confirm:vi.fn().mockResolvedValue(true)} }));
const passthrough = defineComponent({setup(_, {slots}) {return () => h('div', [slots.header?.(),slots.default?.(),slots.footer?.()]);}});
let app: App | undefined; let host: HTMLDivElement;
async function flush() { for (let i=0;i<8;i++) await nextTick(); await new Promise(resolve => setTimeout(resolve,0)); }
function mount(component: typeof ImportFlow | typeof HealthView) {
  host = document.createElement('div');document.body.append(host);app=createApp(component);
  for (const name of ['ElCard','ElForm','ElFormItem','ElRadioGroup','ElRadioButton','ElTag','ElEmpty','ElResult','ElProgress','ElSwitch']) app.component(name,passthrough);
  app.component('ElAlert',defineComponent({props:['title'],setup(props){return()=>h('p',props.title);}}));
  app.component('ElTable',defineComponent({props:['data'],setup(props,{slots}){provide('rows',computed(()=>props.data));return()=>h('div',slots.default?.());}}));
  app.component('ElTableColumn',defineComponent({setup(_,{slots}){const rows=inject<ComputedRef<Array<Record<string,unknown>>>>('rows');return()=>h('div',(rows?.value??[]).map(row=>slots.default?.({row})));}}));
  app.component('ElButton',defineComponent({props:['disabled','loading'],setup(props,{slots}){return()=>h('button',{disabled:!!props.disabled||!!props.loading},slots.default?.());}}));
  app.component('ElDialog',defineComponent({props:['modelValue'],emits:['update:modelValue','closed'],setup(props,{slots,emit}){return()=>props.modelValue?h('section',[h('button', {onClick:()=>{emit('update:modelValue',false);emit('closed');}},'关闭弹窗'),slots.default?.(),slots.footer?.()]):null;}}));
  app.component('ElCheckbox',defineComponent({props:['modelValue','disabled'],emits:['update:modelValue'],setup(props,{slots,emit}){return()=>h('label',[h('input',{type:'checkbox',checked:props.modelValue,disabled:props.disabled,onChange:(e:Event)=>emit('update:modelValue',(e.target as HTMLInputElement).checked)}),slots.default?.()]);}}));
  app.component('ElInput',defineComponent({props:['modelValue'],emits:['update:modelValue'],setup(props,{emit}){return()=>h('input',{value:props.modelValue,onInput:(e:Event)=>emit('update:modelValue',(e.target as HTMLInputElement).value)});}}));
  app.directive('loading',{});
  app.mount(host);
}
async function click(text: string) {const button=[...host.querySelectorAll('button')].find(b=>b.textContent?.trim()===text);expect(button,`button ${text}`).toBeTruthy();button!.click();await flush();}
async function pick() {const input=host.querySelector('input[type=file]') as HTMLInputElement;Object.defineProperty(input,'files',{configurable:true,value:[{name:'backup.json',size:10,text:async()=>'{"formatVersion":1}'}]});input.dispatchEvent(new Event('change'));await flush();}
const plan = () => ({id:crypto.randomUUID(), title:'Import test',status:'draft',steps:[{id:'s',action:'create',desiredAfter:{title:'Recovered'},expectedBefore:{},riskLevel:'low',status:'pending'}]});
beforeEach(()=>{vi.clearAllMocks();mocks.previewImport.mockResolvedValue({formatVersion:1,totalNodes:1,summary:{adds:1,updates:0,moves:0,deletes:0,noops:0},conflicts:[]});mocks.draftPlan.mockImplementation(async()=>plan());mocks.approve.mockResolvedValue({token:'token',expiresAt:Date.now()+300000});mocks.load.mockResolvedValue(undefined);mocks.request.mockResolvedValue({rows:[],total:0});mocks.getSetting.mockResolvedValue(false);mocks.healthPermissionStatus.mockResolvedValue({granted:false});mocks.healthStatus.mockResolvedValue(null);mocks.healthList.mockResolvedValue({rows:[]});});
afterEach(()=>{app?.unmount();host?.remove();});
describe('import interaction safety',()=>{
  it('allows reviewed approval with automatic snapshot and no mandatory download',async()=>{
    mount(ImportFlow);await click('导入 JSON 备份');await pick();await click('创建计划');
    expect(host.textContent).toContain('已自动保留本地恢复快照');
    const review=[...host.querySelectorAll('label')].find(l=>l.textContent?.includes('我已逐项核对'))!.querySelector('input')!;
    review.click();await flush();await click('批准');
    expect(mocks.approve).toHaveBeenCalledTimes(1);expect(mocks.exportPlanBackup).not.toHaveBeenCalled();
  });
  it('requires typed confirmation before approving deletions',async()=>{
    mocks.draftPlan.mockResolvedValue({...plan(),steps:[{id:'s',action:'delete',targetBrowserId:'saved',desiredAfter:{},expectedBefore:{title:'Saved page',url:'https://saved.test'},riskLevel:'high',status:'pending'}]});
    mount(ImportFlow);await click('导入 JSON 备份');await pick();await click('创建计划');
    [...host.querySelectorAll('label')].find(l=>l.textContent?.includes('我已逐项核对'))!.querySelector('input')!.click();await flush();
    const approve=[...host.querySelectorAll('button')].find(b=>b.textContent==='批准')!;expect(approve.disabled).toBe(true);
    const confirmation=[...host.querySelectorAll('label')].find(l=>l.textContent?.includes('确认删除'))!.querySelector('input')!;
    confirmation.value='删除';confirmation.dispatchEvent(new Event('input'));await flush();expect(approve.disabled).toBe(false);
    await click('批准');expect(mocks.approve).toHaveBeenCalledTimes(1);
  });
  it('back from approval creates a fresh draft and clears review',async()=>{
    mount(ImportFlow);await click('导入 JSON 备份');await pick();await click('创建计划');
    [...host.querySelectorAll('label')].find(l=>l.textContent?.includes('我已逐项核对'))!.querySelector('input')!.click();await flush();await click('批准');await click('上一步');
    expect(mocks.draftPlan).toHaveBeenCalledTimes(2);
    const approve=[...host.querySelectorAll('button')].find(b=>b.textContent==='批准')!;expect(approve.disabled).toBe(true);
    expect(mocks.approve).toHaveBeenCalledTimes(1);
  });
  it('reopens in additive mode and accepts the same file again',async()=>{
    mount(ImportFlow);await click('导入 JSON 备份');await pick();await click('关闭弹窗');await click('导入 JSON 备份');await pick();
    expect(mocks.previewImport).toHaveBeenCalledTimes(2);expect(mocks.previewImport.mock.calls.every(call=>call[1]==='additive')).toBe(true);
    expect(host.textContent).not.toContain('添加 + 本地元数据');
  });
  it('rejects oversized replacement without preserving the previous preview',async()=>{
    mount(ImportFlow);await click('导入 JSON 备份');await pick();const input=host.querySelector('input[type=file]')!;
    Object.defineProperty(input,'files',{configurable:true,value:[{name:'too-large.json',size:51*1024*1024}]});input.dispatchEvent(new Event('change'));await flush();
    expect([...host.querySelectorAll('button')].find(b=>b.textContent==='创建计划')!.disabled).toBe(true);expect(mocks.previewImport).toHaveBeenCalledTimes(1);
  });
});

describe('health result rendering',()=>{
  it('shows bookmark titles and keeps unsafe schemes as plain text',async()=>{
    mocks.request.mockResolvedValue({rows:[{id:'private-id',title:'Bookmarklet',path:'Tools',url:'javascript:alert(1)',kind:'bookmark',syncGeneration:1},{id:'web',title:'Saved page',path:'Docs',url:'https://saved.test',kind:'bookmark',syncGeneration:1}],total:2});
    mocks.healthList.mockResolvedValue({rows:[{bookmarkId:'private-id',url:'javascript:alert(1)',status:'unsupported',checkedAt:1,evidence:[],syncGeneration:1},{bookmarkId:'web',url:'https://saved.test',status:'healthy',checkedAt:1,evidence:[],syncGeneration:1}]});
    mount(HealthView);await flush();
    expect(host.textContent).toContain('Bookmarklet');expect(host.textContent).toContain('Tools');expect(host.textContent).not.toContain('private-id');
    expect(host.querySelector('a[href^="javascript:"]')).toBeNull();expect(host.querySelector('a[href="https://saved.test"]')).not.toBeNull();
    expect([...host.querySelectorAll('button')].find(b=>b.textContent?.startsWith('预览删除'))!.disabled).toBe(true);
  });
});
