import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import Popup from '../../entrypoints/popup/App.vue';
const mocks = vi.hoisted(() => ({ request:vi.fn(), prepareOrganization:vi.fn(), storeCapture:vi.fn(), adviseBookmark:vi.fn(), getAssistantSettings:vi.fn(), findExistingBookmarks:vi.fn(), cancelAdvice:vi.fn(), query:vi.fn(), create:vi.fn(), open:vi.fn(), setOptions:vi.fn() }));
vi.mock('../../src/client', () => ({request:mocks.request}));
vi.mock('../../src/workspace-client', () => ({prepareOrganization:mocks.prepareOrganization,storeCapture:mocks.storeCapture,adviseBookmark:mocks.adviseBookmark,getAssistantSettings:mocks.getAssistantSettings,findExistingBookmarks:mocks.findExistingBookmarks,cancelAdvice:mocks.cancelAdvice}));
let app: App; let host: HTMLDivElement;
async function flush() { for(let i=0;i<12;i++) await nextTick(); }
async function mount() {host=document.createElement('div');document.body.append(host);app=createApp(Popup);app.mount(host);await flush();}
async function click(text:string) {const button=[...host.querySelectorAll('button')].find(b=>b.textContent?.trim()===text);expect(button).toBeTruthy();button!.click();await flush();}
async function search(text:string) {const input=host.querySelector('input[type=search]') as HTMLInputElement;input.value=text;input.dispatchEvent(new Event('input'));await flush();await vi.advanceTimersByTimeAsync(170);await flush();}
const rawUrl='https://example.test/Path?Original=YES#frag';
beforeEach(()=>{
  vi.useFakeTimers();vi.resetAllMocks();
  vi.stubGlobal('chrome',{tabs:{query:mocks.query,create:mocks.create},runtime:{getURL:(path:string)=>`chrome-extension://synthetic/${path}`},sidePanel:{open:mocks.open,setOptions:mocks.setOptions}});
  mocks.getAssistantSettings.mockResolvedValue({hasKey:false,consent:false,autoSuggestions:false,connectionTested:false});
  mocks.findExistingBookmarks.mockResolvedValue({bookmarks:[]});
  mocks.cancelAdvice.mockResolvedValue(undefined);
  mocks.query.mockResolvedValue([{id:10,windowId:7,title:'Current page',url:rawUrl}]);
  mocks.request.mockImplementation(async payload=>{
    if(payload.type==='BOOKMARKS_TREE')return [{browserId:'0',parentId:null},{browserId:'1',parentId:'0',title:'Bookmarks bar',path:'Bookmarks bar'}];
    if(payload.type==='APPROVE')return {token:'approved'};
    if(payload.type==='EXECUTE')return {status:'completed',succeeded:1,failed:0};
    return {rows:[{id:'found',title:'Found bookmark',url:rawUrl}],total:1};
  });
  mocks.prepareOrganization.mockResolvedValue({id:'plan-1'});mocks.create.mockResolvedValue({});mocks.open.mockResolvedValue(undefined);mocks.setOptions.mockResolvedValue(undefined);mocks.storeCapture.mockResolvedValue({captureId:'opaque-123'});
});
afterEach(()=>{app?.unmount();host?.remove();vi.useRealTimers();vi.unstubAllGlobals();});
describe('popup quick actions',()=>{
  it('reads only the active tab and saves reviewed original URL once through plan approval',async()=>{
    await mount();expect(mocks.query).toHaveBeenCalledWith({active:true,currentWindow:true});expect(mocks.prepareOrganization).not.toHaveBeenCalled();
    await click('确认收藏');
    expect(mocks.prepareOrganization).toHaveBeenCalledWith(expect.objectContaining({steps:[expect.objectContaining({action:'create',parentBrowserId:'1',desiredAfter:{title:'Current page',url:rawUrl}})]}));
    expect(mocks.request.mock.calls.filter(([p])=>p.type==='EXECUTE')).toHaveLength(1);
    expect(host.textContent).toContain('已收藏');await click('✓ 已收藏');expect(mocks.prepareOrganization).toHaveBeenCalledTimes(1);
  });
  it('recovers an initialization failure without reopening the popup',async()=>{
    mocks.query.mockRejectedValueOnce(new Error('Tab read interrupted'));
    await mount();expect(host.textContent).toContain('Tab read interrupted');expect(host.querySelector('.primary')).toBeNull();
    await click('重新读取当前页面');
    expect(host.textContent).not.toContain('Tab read interrupted');expect((host.querySelector('#capture-title') as HTMLInputElement).value).toBe('Current page');
    await click('确认收藏');expect(mocks.prepareOrganization).toHaveBeenCalledTimes(1);
  });
  it('supports Enter to save and prevents repeated preparation while saving',async()=>{
    let resolve!:(value:unknown)=>void;mocks.prepareOrganization.mockImplementation(()=>new Promise(r=>{resolve=r;}));
    await mount();const input=host.querySelector('#capture-title') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,isComposing:true}));await flush();expect(mocks.prepareOrganization).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await flush();
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await flush();
    expect(mocks.prepareOrganization).toHaveBeenCalledTimes(1);expect(input.disabled).toBe(true);
    resolve({id:'plan-1'});await flush();expect(host.textContent).toContain('✓ 已收藏');expect(host.textContent).not.toContain('更多编辑');
  });
  it('keeps the draft after a pre-execution error and allows a safe retry',async()=>{
    mocks.prepareOrganization.mockRejectedValueOnce(new Error('Preview unavailable')).mockResolvedValueOnce({id:'plan-2'});
    await mount();await click('确认收藏');expect(host.textContent).toContain('Preview unavailable');
    expect((host.querySelector('#capture-title') as HTMLInputElement).value).toBe('Current page');
    await click('确认收藏');expect(host.textContent).toContain('✓ 已收藏');expect(host.textContent).not.toContain('Preview unavailable');
    expect(mocks.request.mock.calls.filter(([p])=>p.type==='EXECUTE')).toHaveLength(1);
  });
  it('opens one editor for rapid clicks and preserves retry after a failed handoff',async()=>{
    let reject!:(reason:Error)=>void;mocks.storeCapture.mockImplementationOnce(()=>new Promise((_,r)=>{reject=r;}));
    await mount();const button=[...host.querySelectorAll('button')].find(b=>b.textContent==='更多编辑')!;
    button.click();button.click();await flush();expect(mocks.storeCapture).toHaveBeenCalledTimes(1);expect(button.disabled).toBe(true);expect((host.querySelector('.primary') as HTMLButtonElement).disabled).toBe(true);
    reject(new Error('Draft unavailable'));await flush();expect(host.textContent).toContain('Draft unavailable');expect(button.disabled).toBe(false);
    await click('更多编辑');expect(mocks.create).toHaveBeenCalledTimes(1);expect(host.textContent).not.toContain('Draft unavailable');
  });
  it('suppresses delayed automatic advice while opening the workspace editor',async()=>{
    let resolveSettings!:(value:unknown)=>void;let resolveCapture!:(value:unknown)=>void;
    mocks.getAssistantSettings.mockImplementation(()=>new Promise(r=>{resolveSettings=r;}));mocks.storeCapture.mockImplementation(()=>new Promise(r=>{resolveCapture=r;}));
    await mount();await click('更多编辑');resolveSettings(enabled);await flush();await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.adviseBookmark).not.toHaveBeenCalled();expect(host.textContent).toContain('正在打开…');
    resolveCapture({captureId:'opaque-123'});await flush();expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it('searches local rows and opens the exact saved URL',async()=>{
    await mount();await search('Found');expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({type:'BOOKMARKS_LIST',query:'Found',limit:5}));
    const result=host.querySelector('.result') as HTMLButtonElement;result.click();await flush();expect(mocks.create).toHaveBeenCalledWith({url:rawUrl});
  });
  it('ignores a late search response after the query is cleared',async()=>{
    await mount();let resolve!: (value:unknown)=>void;
    mocks.request.mockImplementation(payload=>payload.type==='BOOKMARKS_LIST'?new Promise(r=>{resolve=r;}):Promise.resolve([]));
    await search('old');await search('');resolve({rows:[{id:'old',title:'Stale result',url:rawUrl}],total:1});await flush();expect(host.textContent).not.toContain('Stale result');
  });
  it('does not silently repeat an execution after an uncertain response',async()=>{
    await mount();mocks.request.mockImplementation(async p=>{if(p.type==='APPROVE')return{token:'token'};throw new Error('Background disconnected');});
    await click('确认收藏');expect(host.textContent).toContain('请到工作台核对结果');expect((host.querySelector('.primary') as HTMLButtonElement).disabled).toBe(true);expect(host.textContent).not.toContain('更多编辑');
    await click('打开工作台核对');expect(mocks.create).toHaveBeenCalledWith({url:'chrome-extension://synthetic/options.html'});
  });
  it('stores captured data privately and opens only an opaque ID',async()=>{
    await mount();await click('更多编辑');expect(mocks.storeCapture).toHaveBeenCalledWith({title:'Current page',url:rawUrl,parentFolderId:'1'});expect(mocks.create).toHaveBeenCalledWith({url:'chrome-extension://synthetic/options.html?capture=opaque-123'});
  });
  it('hands off the explicitly changed destination rather than the default folder',async()=>{
    mocks.request.mockResolvedValueOnce([{browserId:'0',parentId:null},{browserId:'1',parentId:'0',title:'Bar'},{browserId:'nested',parentId:'1',title:'Chosen folder'}]);
    await mount();const select=host.querySelector('#capture-folder') as HTMLSelectElement;select.value='nested';select.dispatchEvent(new Event('change'));await flush();
    await click('更多编辑');expect(mocks.storeCapture).toHaveBeenCalledWith({title:'Current page',url:rawUrl,parentFolderId:'nested'});
    expect(mocks.create).toHaveBeenCalledWith({url:'chrome-extension://synthetic/options.html?capture=opaque-123'});
  });
  it('does not collect or save restricted pages',async()=>{
    mocks.query.mockResolvedValue([{windowId:7,title:'Settings',url:'chrome://settings'}]);await mount();expect(host.textContent).toContain('这个页面无法快捷收藏');expect(host.querySelector('.primary')).toBeNull();expect(mocks.prepareOrganization).not.toHaveBeenCalled();
  });
  it('opens the side panel directly from user interaction with current search',async()=>{
    await mount();await search('design');await click('在侧边栏继续任务 →');expect(mocks.open).toHaveBeenCalledWith({windowId:7});expect(mocks.setOptions).toHaveBeenCalledWith({path:'sidepanel.html?q=design',enabled:true});expect(mocks.open.mock.invocationCallOrder[0]).toBeLessThan(mocks.setOptions.mock.invocationCallOrder[0]);
  });
  it.each(['hasKey','consent','autoSuggestions','connectionTested'])('does not send metadata without %s',async missing=>{
    mocks.getAssistantSettings.mockResolvedValue({...enabled,[missing]:false});await mount();await vi.advanceTimersByTimeAsync(900);expect(mocks.adviseBookmark).not.toHaveBeenCalled();expect(host.textContent).toContain('设置 AI');expect((host.querySelector('.primary') as HTMLButtonElement).disabled).toBe(false);
  });
  it('automatically shows suggestions without overwriting inputs or writing bookmarks',async()=>{
    mocks.getAssistantSettings.mockResolvedValue(enabled);mocks.adviseBookmark.mockResolvedValue({title:'Suggested title',targetFolderId:'1',reason:'Synthetic reason'});
    await mount();await vi.advanceTimersByTimeAsync(900);await flush();
    expect(mocks.adviseBookmark).toHaveBeenCalledWith({title:'Current page',url:rawUrl,parentFolderId:'1'},expect.objectContaining({automatic:true,requestId:expect.any(String)}));
    expect((host.querySelector('#capture-title') as HTMLInputElement).value).toBe('Current page');expect(host.textContent).toContain('Suggested title');expect(mocks.prepareOrganization).not.toHaveBeenCalled();
    await click('采用标题');expect((host.querySelector('#capture-title') as HTMLInputElement).value).toBe('Suggested title');
    await vi.advanceTimersByTimeAsync(1000);expect(mocks.adviseBookmark).toHaveBeenCalledTimes(1);
  });
  it('discards a late result after editing and cancels the old request',async()=>{
    let resolve!:(value:unknown)=>void;mocks.getAssistantSettings.mockResolvedValue(enabled);mocks.adviseBookmark.mockImplementation(()=>new Promise(r=>{resolve=r;}));
    await mount();await vi.advanceTimersByTimeAsync(900);
    const input=host.querySelector('#capture-title') as HTMLInputElement;expect(input.disabled).toBe(false);input.value='User edited';input.dispatchEvent(new Event('input'));await flush();
    resolve({title:'Stale AI title',targetFolderId:'1',reason:'Stale'});await flush();expect(input.value).toBe('User edited');expect(host.textContent).not.toContain('Stale AI title');expect(mocks.cancelAdvice).toHaveBeenCalled();
  });
  it('allows saving while advice is pending and ignores its late result',async()=>{
    let resolve!:(value:unknown)=>void;mocks.getAssistantSettings.mockResolvedValue(enabled);mocks.adviseBookmark.mockImplementation(()=>new Promise(r=>{resolve=r;}));
    await mount();await vi.advanceTimersByTimeAsync(900);await click('确认收藏');resolve({title:'Late title',targetFolderId:'1',reason:'Late'});await flush();expect(host.textContent).toContain('已收藏');expect(host.textContent).not.toContain('Late title');
  });
  it('preserves local capture after an AI error, with an explicit retry',async()=>{
    mocks.getAssistantSettings.mockResolvedValue(enabled);mocks.adviseBookmark.mockRejectedValue(new Error('Service unavailable'));await mount();await vi.advanceTimersByTimeAsync(900);await flush();
    expect(host.textContent).toContain('暂时没有建议');expect((host.querySelector('.primary') as HTMLButtonElement).disabled).toBe(false);await click('重试建议');expect(mocks.adviseBookmark).toHaveBeenCalledTimes(2);
  });
  it('refuses an unavailable suggested directory',async()=>{
    mocks.getAssistantSettings.mockResolvedValue(enabled);mocks.adviseBookmark.mockResolvedValue({title:'AI title',targetFolderId:'invented',reason:'reason'});await mount();await vi.advanceTimersByTimeAsync(900);await flush();
    expect([...host.querySelectorAll('button')].some(b=>b.textContent==='采用位置')).toBe(false);expect((host.querySelector('#capture-folder') as HTMLSelectElement).value).toBe('1');
  });
  it('checks existing bookmarks before AI and shows saved locations with edit actions',async()=>{
    mocks.getAssistantSettings.mockResolvedValue(enabled);mocks.findExistingBookmarks.mockResolvedValue({bookmarks:[{id:'saved',browserId:'saved',title:'Saved',url:rawUrl,parentId:'1',path:'Bar / Saved'}]});
    await mount();await vi.advanceTimersByTimeAsync(2000);expect(mocks.adviseBookmark).not.toHaveBeenCalled();expect(host.textContent).toContain('这个页面已收藏');expect(host.textContent).toContain('Bar / Saved');
    await click('编辑已有书签');expect(mocks.create).toHaveBeenCalledWith({url:'chrome-extension://synthetic/options.html?edit=saved'});
  });
  it('waits for membership lookup and fails closed while leaving local capture usable',async()=>{
    let reject!:(reason:Error)=>void;mocks.getAssistantSettings.mockResolvedValue(enabled);mocks.findExistingBookmarks.mockImplementation(()=>new Promise((_,r)=>{reject=r;}));
    await mount();await vi.advanceTimersByTimeAsync(2000);expect(mocks.adviseBookmark).not.toHaveBeenCalled();expect(host.textContent).toContain('正在检查是否已收藏');
    reject(new Error('Unavailable'));await flush();await vi.advanceTimersByTimeAsync(2000);expect(mocks.adviseBookmark).not.toHaveBeenCalled();expect(host.textContent).toContain('已暂停建议');expect((host.querySelector('.primary') as HTMLButtonElement).disabled).toBe(false);
  });

  it('refreshes membership on native changes and retracts suggestions immediately',async()=>{
    const listeners=new Set<()=>void>();const event={addListener:(fn:()=>void)=>listeners.add(fn),removeListener:(fn:()=>void)=>listeners.delete(fn)};
    Object.assign(chrome,{bookmarks:{onCreated:event}});mocks.getAssistantSettings.mockResolvedValue(enabled);mocks.adviseBookmark.mockResolvedValue({title:'AI title',targetFolderId:'1',reason:'Reason'});
    await mount();await vi.advanceTimersByTimeAsync(900);await flush();expect(host.textContent).toContain('建议标题');
    mocks.findExistingBookmarks.mockResolvedValue({bookmarks:[{browserId:'new',title:'Saved elsewhere',path:'Elsewhere'}]});listeners.forEach(fn=>fn());await flush();expect(host.textContent).not.toContain('建议标题');
    await vi.advanceTimersByTimeAsync(1000);await flush();expect(host.textContent).toContain('Elsewhere');expect(mocks.adviseBookmark).toHaveBeenCalledTimes(1);app.unmount();expect(listeners.size).toBe(0);
  });

});
const enabled={hasKey:true,consent:true,autoSuggestions:true,connectionTested:true};
