import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, reactive, type App } from 'vue';
import Editor from '../../entrypoints/options/components/BookmarkEditor.vue';
import type { FolderRecord } from '../../src/domain/bookmarks/types';

let app: App; let host: HTMLDivElement;
const requestAdvice = vi.fn(), cancelAdvice = vi.fn(), prepare = vi.fn();
const folder: FolderRecord = { id:'local-bar',browserId:'bar',parentId:'0',title:'Bar',path:'Bar',index:0,updatedAt:0,syncGeneration:1 };
let props: { modelValue:boolean; autoEnabled:boolean; requestingAdvice:boolean; advice?:{title:string;targetFolderId:string;reason:string}; adviceError:string };
async function flush(){for(let i=0;i<8;i++)await nextTick();}
async function mount(enabled=true) {
  props=reactive({modelValue:true,autoEnabled:enabled,requestingAdvice:false,adviceError:''});
  host=document.createElement('div');document.body.append(host);
  app=createApp(defineComponent({setup(){return()=>h(Editor,{...props,kind:'bookmark',records:[],folders:[folder],defaultParentId:folder.id,busy:false,initialBookmark:{title:'Original',url:'https://example.test'},onRequestAdvice:requestAdvice,onCancelAdvice:cancelAdvice,onPrepare:prepare,'onUpdate:modelValue':(open:boolean)=>{props.modelValue=open;}});}}));
  const pass=defineComponent({setup(_,{slots}){return()=>h('div',[slots.default?.(),slots.footer?.()]);}});
  for(const name of ['ElDialog','ElIcon','ElOption'])app.component(name,pass);
  app.component('ElButton',defineComponent({props:['disabled','loading'],setup(p,{slots}){return()=>h('button',{disabled:!!p.disabled||!!p.loading},slots.default?.());}}));
  for(const name of ['ElInput','ElSelect'])app.component(name,defineComponent({props:['modelValue','disabled'],emits:['update:modelValue','input'],setup(p,{emit}){return()=>h('input',{value:p.modelValue,disabled:p.disabled,onInput:(event:Event)=>{emit('update:modelValue',(event.target as HTMLInputElement).value);emit('input');}});}}));
  app.component('ElAlert',pass);app.mount(host);await flush();
}
async function editTitle(title:string){const input=host.querySelector('#bookmark-editor-title') as HTMLInputElement;input.value=title;input.dispatchEvent(new Event('input'));await flush();}
beforeEach(()=>{vi.useFakeTimers();vi.clearAllMocks();});
afterEach(()=>{app?.unmount();host?.remove();vi.useRealTimers();});
describe('automatic editor advice',()=>{
  it('debounces valid drafts and never writes or applies advice automatically',async()=>{
    await mount();await vi.advanceTimersByTimeAsync(799);expect(requestAdvice).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);expect(requestAdvice).toHaveBeenCalledWith({title:'Original',url:'https://example.test',parentFolderId:'bar'});
    props.advice={title:'Suggested',targetFolderId:'bar',reason:'Reason'};await flush();
    expect(host.textContent).toContain('Suggested');expect((host.querySelector('#bookmark-editor-title') as HTMLInputElement).value).toBe('Original');expect(prepare).not.toHaveBeenCalled();
  });
  it('makes no requests when automatic AI is unavailable',async()=>{
    await mount(false);await vi.advanceTimersByTimeAsync(1000);expect(requestAdvice).not.toHaveBeenCalled();expect(host.textContent).toContain('设置 AI');
  });
  it('keeps fields editable and invalidates stale advice after editing',async()=>{
    await mount();await vi.advanceTimersByTimeAsync(800);props.requestingAdvice=true;await flush();
    expect((host.querySelector('#bookmark-editor-title') as HTMLInputElement).disabled).toBe(false);
    await editTitle('My edit');props.advice={title:'Stale result',targetFolderId:'bar',reason:'Stale'};await flush();
    expect(host.textContent).not.toContain('Stale result');expect(cancelAdvice).toHaveBeenCalled();
  });
  it('limits automatic suggestions to three contexts per opening',async()=>{
    await mount();await vi.advanceTimersByTimeAsync(800);
    for(const title of ['Second','Third','Fourth']){await editTitle(title);await vi.advanceTimersByTimeAsync(800);}
    expect(requestAdvice).toHaveBeenCalledTimes(3);
  });
  it('cancels pending work on close and unmount',async()=>{
    await mount();await vi.advanceTimersByTimeAsync(800);cancelAdvice.mockClear();props.modelValue=false;await flush();expect(cancelAdvice).toHaveBeenCalledTimes(1);
    app.unmount();expect(cancelAdvice).toHaveBeenCalledTimes(2);
  });
  it('shows retry only after an error and leaves local preview usable',async()=>{
    await mount();await vi.advanceTimersByTimeAsync(800);props.adviceError='Unavailable';await flush();
    const retry=[...host.querySelectorAll('button')].find(b=>b.textContent==='重试建议')!;expect(retry.disabled).toBe(false);retry.click();await flush();expect(requestAdvice).toHaveBeenCalledTimes(2);
    expect((host.querySelector('#bookmark-editor-title') as HTMLInputElement).disabled).toBe(false);
  });
});
