import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {BookmarkDatabase} from '../../src/infrastructure/database/db';
import {BackgroundRouter} from '../../src/infrastructure/messaging/background-router';
import {registerWorkspaceHandlers} from '../../src/infrastructure/messaging/workspace-handlers';
import type {RawBookmarkNode} from '../../src/domain/bookmarks/types';
import type {PlanService} from '../../src/domain/operations/plan-service';
import type {AssistantRepository} from '../../src/domain/assistant/types';
const state=vi.hoisted(()=>({repository:undefined as AssistantRepository|undefined,turn:vi.fn(),advice:vi.fn(),content:vi.fn()}));
vi.mock('../../src/domain/assistant',()=>({createMiniMaxProvider:()=>({}),createAssistantService:({repository}:{repository:AssistantRepository})=>{state.repository=repository;return {turn:state.turn,adviseBookmark:state.advice};}}));
vi.mock('../../src/domain/content',()=>({fetchBookmarkContent:state.content}));
const dbs:BookmarkDatabase[]=[];
const item=(id:string,url:string,parentId='public')=>({id,browserId:id,kind:'bookmark' as const,parentId,index:0,title:id,url,path:'Bar',updatedAt:1,syncGeneration:1});
async function fixture(){
 const db=new BookmarkDatabase('flows-'+crypto.randomUUID());dbs.push(db);
 const session:Record<string,unknown>={minimaxSessionKey:{region:'global',apiKey:'fixture-key'}};
 const area={get:vi.fn(async(key:string)=>({[key]:session[key]})),set:vi.fn(async(data:Record<string,unknown>)=>{Object.assign(session,data);}),remove:vi.fn(async(key:string)=>{delete session[key];}),setAccessLevel:vi.fn(async()=>{})};
 vi.stubGlobal('chrome',{storage:{session:area,local:{...area}},runtime:{getManifest:()=>({version:'1'})}});
 await db.meta.put({key:'assistant:settings',value:{region:'global',model:'MiniMax-M2.5',consent:true,excludedFolderIds:['private']},updatedAt:1});
 await db.folders.bulkPut(['public','private','child'].map(id=>({id,browserId:id,parentId:id==='child'?'private':null,index:0,title:id,path:id,updatedAt:1,syncGeneration:1})));
 const planService={draftOrganization:vi.fn(async(input)=>({id:'plan',...input})),draftRecovery:vi.fn(async(id)=>({id:'recovery',source:id}))};
 const router=new BackgroundRouter({} as ConstructorParameters<typeof BackgroundRouter>[0]);const canFetch=vi.fn(async()=>true);
 const readTree=vi.fn(async():Promise<RawBookmarkNode[]>=>[{id:'0',children:[{id:'bar',parentId:'0',children:[{id:'nested',parentId:'bar',children:[]},{id:'leaf',parentId:'bar',url:'https://example.com'}]}]}]);
 registerWorkspaceHandlers(router,{db,planService:planService as unknown as PlanService,canFetch,readTree});return {db,router,session,planService,canFetch,readTree};
}
beforeEach(()=>{state.content.mockReset().mockImplementation(async({url}:{url:string})=>({originalUrl:url,status:'ready',text:'fixture content',fetchedAt:Date.now()}));state.turn.mockReset().mockResolvedValue({id:'s',providerHistory:[]});state.advice.mockReset().mockResolvedValue({title:'Suggested',targetFolderId:'public',reason:'topic'});});
afterEach(async()=>{await Promise.all(dbs.splice(0).map(db=>db.delete()));vi.unstubAllGlobals();});
describe('redesigned workspace flows',()=>{
 it('filters excluded descendants and sensitive URLs from outbound repository only',async()=>{const {db}=await fixture();await db.bookmarks.bulkPut([item('ok','https://example.com/a'),item('excluded','https://example.com/b','child'),item('token','https://example.com/?token=x'),item('private','http://127.0.0.1/')]);expect((await state.repository!.listBookmarks()).map(b=>b.id)).toEqual(['ok']);expect((await state.repository!.listFolders()).map(f=>f.id)).toEqual(['public']);expect(await db.bookmarks.count()).toBe(4);});
 it('stores capture privately by opaque session ID and expires it',async()=>{const {router,session}=await fixture();const r=await router.dispatch({type:'CAPTURE_STORE',requestId:'c',input:{title:'Page',url:'https://example.com/?Case=YES#original'}});expect(r.ok).toBe(true);if(!r.ok)return;const captureId=(r.data as {captureId:string}).captureId;expect(captureId).not.toContain('example');expect(await router.dispatch({type:'CAPTURE_GET',requestId:'g',captureId})).toMatchObject({ok:true,data:{title:'Page',url:'https://example.com/?Case=YES#original'}});(session['capture:'+captureId] as {createdAt:number}).createdAt=0;expect(await router.dispatch({type:'CAPTURE_GET',requestId:'g2',captureId})).toMatchObject({ok:true,data:undefined});});
 it('preserves the selected native folder and omits it with a warning if deleted later',async()=>{
  const {router,readTree}=await fixture();const input={title:'Page',url:'https://example.com/?Original=YES#frag',parentFolderId:'nested'};
  const stored=await router.dispatch({type:'CAPTURE_STORE',requestId:'c',input});expect(stored.ok).toBe(true);if(!stored.ok)return;
  const {captureId}=stored.data as {captureId:string};expect(await router.dispatch({type:'CAPTURE_GET',requestId:'g',captureId})).toMatchObject({ok:true,data:input});
  readTree.mockResolvedValue([{id:'0',children:[{id:'bar',parentId:'0',children:[]}]}]);
  const recovered=await router.dispatch({type:'CAPTURE_GET',requestId:'g2',captureId});expect(recovered).toMatchObject({ok:true,data:{title:input.title,url:input.url,destinationUnavailable:true}});if(recovered.ok)expect(recovered.data).not.toHaveProperty('parentFolderId');
 });
 it.each(['0','missing','leaf','',' bad','bad\nfolder','x'.repeat(201)])('rejects unusable capture destination %j before storing',async parentFolderId=>{
  const {router}=await fixture();expect((await router.dispatch({type:'CAPTURE_STORE',requestId:'c',input:{title:'Page',url:'https://example.com',parentFolderId}})).ok).toBe(false);expect(chrome.storage.session.set).not.toHaveBeenCalled();
 });
 it('retains the draft with a warning when destination validation is interrupted',async()=>{
  const {router,readTree}=await fixture();const stored=await router.dispatch({type:'CAPTURE_STORE',requestId:'c',input:{title:'Page',url:'https://example.com',parentFolderId:'bar'}});expect(stored.ok).toBe(true);if(!stored.ok)return;
  readTree.mockRejectedValue(new Error('Native access interrupted'));expect(await router.dispatch({type:'CAPTURE_GET',requestId:'g',captureId:(stored.data as {captureId:string}).captureId})).toMatchObject({ok:true,data:{title:'Page',url:'https://example.com',destinationUnavailable:true}});
 });
 it('rejects executable capture URLs before storage',async()=>{const {router}=await fixture();expect((await router.dispatch({type:'CAPTURE_STORE',requestId:'bad',input:{title:'bad',url:'javascript:alert(1)'}})).ok).toBe(false);expect(chrome.storage.session.set).not.toHaveBeenCalled();});
 it('routes native update and recovery into reviewable plans only',async()=>{const {router,planService}=await fixture();expect((await router.dispatch({type:'ORGANIZATION_PREPARE',requestId:'p',input:{title:'Edit',steps:[{action:'update',targetBrowserId:'x',desiredAfter:{title:'New'}}]}})).ok).toBe(true);expect(planService.draftOrganization).toHaveBeenCalledOnce();expect(await router.dispatch({type:'PLAN_RECOVERY_PREPARE',requestId:'r',planId:'original'})).toMatchObject({ok:true,data:{id:'recovery',source:'original'}});});
 it('advice is ephemeral and no write plan is created',async()=>{const {router,planService}=await fixture();expect((await router.dispatch({type:'ASSISTANT_ADVISE_BOOKMARK',requestId:'a',input:{title:'Page',url:'https://example.com/'}})).ok).toBe(true);expect(state.advice).toHaveBeenCalledWith(expect.objectContaining({url:'https://example.com/',apiKey:'fixture-key'}));expect(planService.draftOrganization).not.toHaveBeenCalled();});
 it('blocks sensitive advice and prompt URLs before provider use',async()=>{const {router}=await fixture();expect((await router.dispatch({type:'ASSISTANT_ADVISE_BOOKMARK',requestId:'a',input:{title:'Page',url:'https://example.com/?api_key=x'}})).ok).toBe(false);expect((await router.dispatch({type:'ASSISTANT_TURN',requestId:'t',sessionId:'s',text:'看 http://localhost/private'})).ok).toBe(false);expect(state.advice).not.toHaveBeenCalled();expect(state.turn).not.toHaveBeenCalled();});
 it('requires new task after exclusions change to avoid resending prior context',async()=>{const {db,router}=await fixture();await db.meta.bulkPut([{key:'assistant:session:s',value:{id:'s',createdAt:10,citations:[],providerHistory:[]},updatedAt:10},{key:'assistant:privacyUpdatedAt',value:20,updatedAt:20}]);const r=await router.dispatch({type:'ASSISTANT_TURN',requestId:'t',sessionId:'s',text:'Find docs'});expect(r.ok).toBe(false);expect(state.turn).not.toHaveBeenCalled();});
 it('reports stale cached content and clears only selected cached text',async()=>{const {db,router}=await fixture();await db.bookmarks.add(item('a','https://example.com/new'));await db.meta.bulkPut([{key:'content:a',value:{originalUrl:'https://example.com/old',status:'ready'},updatedAt:1},{key:'content:b',value:{status:'ready'},updatedAt:1}]);expect(await router.dispatch({type:'CONTENT_STATUS',requestId:'s',bookmarkIds:['a']})).toMatchObject({ok:true,data:{results:[{bookmarkId:'a',status:'outdated'}]}});expect((await router.dispatch({type:'CONTENT_CLEAR',requestId:'c',bookmarkIds:['a']})).ok).toBe(true);expect(await db.meta.get('content:a')).toBeUndefined();expect(await db.meta.get('content:b')).toBeDefined();});
});


describe('bounded opt-in content enrichment',()=>{
 async function ready(enabled:boolean){const f=await fixture();await f.db.bookmarks.bulkPut(Array.from({length:8},(_,i)=>item('Guide'+i,'https://example.com/'+i)));await f.db.meta.bulkPut([{key:'assistant:session:s',value:{id:'s',createdAt:Date.now(),scope:{},citations:[],providerHistory:[]},updatedAt:1},{key:'assistant:settings',value:{region:'global',model:'MiniMax-M2.5',consent:true,contentEnhancement:enabled},updatedAt:1}]);return f;}
 it('never fetches pages when enrichment is off',async()=>{const {router}=await ready(false);expect((await router.dispatch({type:'ASSISTANT_TURN',requestId:'t',sessionId:'s',text:'Guide'})).ok).toBe(true);expect(state.content).not.toHaveBeenCalled();});
 it('reads at most three already-authorized relevant pages and reuses cache',async()=>{const {router}=await ready(true);expect((await router.dispatch({type:'ASSISTANT_TURN',requestId:'t',sessionId:'s',text:'Guide'})).ok).toBe(true);expect(state.content).toHaveBeenCalledTimes(3);await router.dispatch({type:'ASSISTANT_TURN',requestId:'t2',sessionId:'s',text:'Guide'});expect(state.content).toHaveBeenCalledTimes(3);});
 it('does not request unauthorized website access',async()=>{const {router,canFetch}=await ready(true);canFetch.mockImplementation(async(url?:string)=>!!url?.includes('api.minimax.io'));expect((await router.dispatch({type:'ASSISTANT_TURN',requestId:'t',sessionId:'s',text:'Guide'})).ok).toBe(true);expect(state.content).not.toHaveBeenCalled();});
});
