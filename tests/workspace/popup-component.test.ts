import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import Popup from '../../entrypoints/popup/App.vue';
const mocks = vi.hoisted(() => ({ request:vi.fn(), prepareOrganization:vi.fn(), storeCapture:vi.fn(), adviseBookmark:vi.fn(), query:vi.fn(), create:vi.fn(), open:vi.fn(), setOptions:vi.fn() }));
vi.mock('../../src/client', () => ({request:mocks.request}));
vi.mock('../../src/workspace-client', () => ({prepareOrganization:mocks.prepareOrganization,storeCapture:mocks.storeCapture,adviseBookmark:mocks.adviseBookmark}));
let app: App; let host: HTMLDivElement;
async function flush() { for(let i=0;i<12;i++) await nextTick(); }
async function mount() {host=document.createElement('div');document.body.append(host);app=createApp(Popup);app.mount(host);await flush();}
async function click(text:string) {const button=[...host.querySelectorAll('button')].find(b=>b.textContent?.trim()===text);expect(button).toBeTruthy();button!.click();await flush();}
async function search(text:string) {const input=host.querySelector('input[type=search]') as HTMLInputElement;input.value=text;input.dispatchEvent(new Event('input'));await flush();await vi.advanceTimersByTimeAsync(170);await flush();}
const rawUrl='https://example.test/Path?Original=YES#frag';
beforeEach(()=>{
  vi.useFakeTimers();vi.resetAllMocks();
  vi.stubGlobal('chrome',{tabs:{query:mocks.query,create:mocks.create},runtime:{getURL:(path:string)=>`chrome-extension://synthetic/${path}`},sidePanel:{open:mocks.open,setOptions:mocks.setOptions}});
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
    await click('确认收藏');expect(host.textContent).toContain('请到工作台核对结果');expect((host.querySelector('.primary') as HTMLButtonElement).disabled).toBe(true);
  });
  it('stores captured data privately and opens only an opaque ID',async()=>{
    await mount();await click('更多编辑');expect(mocks.storeCapture).toHaveBeenCalledWith({title:'Current page',url:rawUrl});expect(mocks.create).toHaveBeenCalledWith({url:'chrome-extension://synthetic/options.html?capture=opaque-123'});
  });
  it('does not collect or save restricted pages',async()=>{
    mocks.query.mockResolvedValue([{windowId:7,title:'Settings',url:'chrome://settings'}]);await mount();expect(host.textContent).toContain('这个页面无法快捷收藏');expect(host.querySelector('.primary')).toBeNull();expect(mocks.prepareOrganization).not.toHaveBeenCalled();
  });
  it('opens the side panel directly from user interaction with current search',async()=>{
    await mount();await search('design');await click('侧边栏工作台');expect(mocks.open).toHaveBeenCalledWith({windowId:7});expect(mocks.setOptions).toHaveBeenCalledWith({path:'sidepanel.html?q=design',enabled:true});expect(mocks.open.mock.invocationCallOrder[0]).toBeLessThan(mocks.setOptions.mock.invocationCallOrder[0]);
  });
  it('never requests AI automatically and accepts only existing destination IDs',async()=>{
    await mount();expect(mocks.adviseBookmark).not.toHaveBeenCalled();mocks.adviseBookmark.mockResolvedValue({title:'Suggested title',targetFolderId:'invented',reason:'Synthetic reason'});await click('✦ AI 建议标题和位置');expect((host.querySelector('#capture-title') as HTMLInputElement).value).toBe('Suggested title');expect((host.querySelector('#capture-folder') as HTMLSelectElement).value).toBe('1');expect(mocks.prepareOrganization).not.toHaveBeenCalled();
  });
});
