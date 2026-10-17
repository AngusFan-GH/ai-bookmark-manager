import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {findExactNativeBookmarks} from '../../src/infrastructure/messaging/capture-lookup';
import {BackgroundRouter} from '../../src/infrastructure/messaging/background-router';
import {registerWorkspaceHandlers} from '../../src/infrastructure/messaging/workspace-handlers';
import type {BookmarkDatabase} from '../../src/infrastructure/database/db';
import type {PlanService} from '../../src/domain/operations/plan-service';
import type {RawBookmarkNode} from '../../src/domain/bookmarks/types';
const state=vi.hoisted(()=>({advice:vi.fn()}));
vi.mock('../../src/domain/assistant',()=>({createMiniMaxProvider:()=>({}),createAssistantService:()=>({adviseBookmark:state.advice})}));
const url='https://example.com/Page?a=1&b=2#Section';
const tree=(address=url):RawBookmarkNode[]=>[{id:'0',title:'',children:[{id:'bar',title:'Bookmarks bar',children:[{id:'private',title:'Private',children:[{id:'saved',title:'Original title',url:address,dateAdded:123,index:2}]}]}]}];
function fixture(){
 let native=tree();
 const readTree=vi.fn(async()=>native);
 const values=new Map([['assistant:settings',{region:'global',model:'MiniMax-M2.5',consent:true,keyStorage:'session',autoSuggestions:true,configRevision:'rev',testedRevision:'rev',excludedFolderIds:['private']}]]);
 const db={meta:{get:vi.fn(async(key:string)=>({value:values.get(key)}))},bookmarks:{toArray:vi.fn(async()=>[])}} as unknown as BookmarkDatabase;
 vi.stubGlobal('chrome',{storage:{session:{get:vi.fn(async()=>({minimaxSessionKey:{region:'global',apiKey:'fixture'}})),setAccessLevel:vi.fn(async()=>{})}}});
 const router=new BackgroundRouter({} as ConstructorParameters<typeof BackgroundRouter>[0]);
 registerWorkspaceHandlers(router,{db,planService:{} as PlanService,readTree,canFetch:async()=>true});
 const dispatch=(type:string,extra:object={})=>router.dispatch({type,requestId:crypto.randomUUID(),...extra});
 const advice=(automatic=true)=>dispatch('ASSISTANT_ADVISE_BOOKMARK',{automatic,input:{title:'Title',url}});
 return {dispatch,advice,readTree,db,setTree:(next:RawBookmarkNode[])=>{native=next;}};
}
beforeEach(()=>state.advice.mockReset().mockResolvedValue({title:'Suggestion',targetFolderId:'f',reason:'Topic'}));
afterEach(()=>vi.unstubAllGlobals());
describe('fresh local exact native bookmark lookup',()=>{
 it('returns original URL, native identifiers and current nested folder path',()=>{expect(findExactNativeBookmarks(tree(),url,456)).toEqual([{id:'saved',browserId:'saved',kind:'bookmark',parentId:'private',index:2,title:'Original title',url,path:'Bookmarks bar / Private',dateAdded:123,dateGroupModified:undefined,updatedAt:456,syncGeneration:0}]);});
 it('only applies browser serialization and preserves original stored URL',()=>{const original='https://EXAMPLE.com:443';const rows=findExactNativeBookmarks(tree(original),'https://example.com/');expect(rows).toHaveLength(1);expect(rows[0].url).toBe(original);});
 it.each(['https://example.com/Page?a=1&b=2#Other','https://example.com/page?a=1&b=2#Section','https://example.com/Page?b=2&a=1#Section','https://example.com/Page?a=1&b=2&utm_source=test#Section','https://example.com/Page?a=1&b=2'])('does not conflate distinct address %s',other=>{expect(findExactNativeBookmarks(tree(),other)).toEqual([]);});
 it('returns all copies, including private and excluded folders, without a provider call',async()=>{const f=fixture();const roots=tree();roots.push({id:'other',title:'Other',children:[{id:'copy',title:'Copy',url}]});f.setTree(roots);expect(await f.dispatch('CAPTURE_LOOKUP',{url})).toMatchObject({ok:true,data:{bookmarks:[{id:'saved',path:'Bookmarks bar / Private'},{id:'copy',path:'Other'}]}});expect(state.advice).not.toHaveBeenCalled();expect(f.db.bookmarks.toArray).not.toHaveBeenCalled();});
 it('reads native additions and renames each time without waiting for index sync',async()=>{const f=fixture();f.setTree([]);expect(await f.dispatch('CAPTURE_LOOKUP',{url})).toMatchObject({data:{bookmarks:[]}});f.setTree(tree());expect(await f.dispatch('CAPTURE_LOOKUP',{url})).toMatchObject({data:{bookmarks:[{id:'saved'}]}});const renamed=tree();renamed[0].children![0].title='Renamed bar';f.setTree(renamed);expect(await f.dispatch('CAPTURE_LOOKUP',{url})).toMatchObject({data:{bookmarks:[{path:'Renamed bar / Private'}]}});expect(f.readTree).toHaveBeenCalledTimes(3);});
 it('blocks automatic provider calls when fresh native tree already contains URL',async()=>{const f=fixture();expect((await f.advice()).ok).toBe(false);expect(state.advice).not.toHaveBeenCalled();});
 it('checks again in the automatic handler even after an earlier clear UI lookup',async()=>{const f=fixture();f.setTree([]);expect(await f.dispatch('CAPTURE_LOOKUP',{url})).toMatchObject({data:{bookmarks:[]}});f.setTree(tree());expect((await f.advice()).ok).toBe(false);expect(f.readTree).toHaveBeenCalledTimes(2);expect(state.advice).not.toHaveBeenCalled();});
 it('allows automatic advice only after a successful fresh no-match lookup',async()=>{const f=fixture();f.setTree([]);expect((await f.advice()).ok).toBe(true);expect(f.readTree).toHaveBeenCalledOnce();expect(state.advice).toHaveBeenCalledOnce();});
 it('fails closed on unavailable native lookup, leaving explicit manual advice unchanged',async()=>{const f=fixture();f.readTree.mockRejectedValue(new Error('Browser unavailable'));expect((await f.dispatch('CAPTURE_LOOKUP',{url})).ok).toBe(false);expect((await f.advice()).ok).toBe(false);expect(state.advice).not.toHaveBeenCalled();expect((await f.advice(false)).ok).toBe(true);expect(state.advice).toHaveBeenCalledOnce();});
 it('honors cancellation while the native lookup is still pending',async()=>{const f=fixture();let resolve!:(rows:RawBookmarkNode[])=>void;f.readTree.mockImplementation(()=>new Promise(done=>{resolve=done;}));const pending=f.dispatch('ASSISTANT_ADVISE_BOOKMARK',{requestId:'pending-advice',automatic:true,input:{title:'Title',url}});await vi.waitFor(()=>expect(f.readTree).toHaveBeenCalled());await f.dispatch('ASSISTANT_ADVICE_CANCEL',{adviceRequestId:'pending-advice'});resolve([]);expect((await pending).ok).toBe(false);expect(state.advice).not.toHaveBeenCalled();});
 it('rejects invalid addresses and malformed native snapshots',async()=>{const f=fixture();expect((await f.dispatch('CAPTURE_LOOKUP',{url:'javascript:alert(1)'})).ok).toBe(false);expect(f.readTree).not.toHaveBeenCalled();f.readTree.mockResolvedValue(undefined as unknown as RawBookmarkNode[]);expect((await f.advice()).ok).toBe(false);expect(state.advice).not.toHaveBeenCalled();});
});
