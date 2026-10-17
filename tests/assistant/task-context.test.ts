import {historySafeForAssistant} from '../../src/infrastructure/messaging/workspace-privacy';
import {describe,it,expect} from 'vitest';
import {createAssistantService} from '../../src/domain/assistant/service';
import {taskContext,isReferenceFollowup} from '../../src/domain/assistant/context';
import type {AssistantBookmark, AssistantSession, AssistantRepository, ProviderRequest} from '../../src/domain/assistant/types';
import {buildTopicViews,relatedBookmarkGroups} from '../../src/domain/organization/topics';
const bookmark=(id:string):AssistantBookmark=>({id,browserId:id,kind:'bookmark',parentId:'f',title:`Resource ${id}`,url:`https://example.org/${id}`,path:'Library',index:0,updatedAt:1,syncGeneration:1});
const folder={id:'f',browserId:'f',title:'Library',path:'Library',parentId:null,index:0,updatedAt:1,syncGeneration:1};
const empty:AssistantSession={id:'s',mode:'assist',revision:0,scope:{},messages:[],citations:[],providerHistory:[],createdAt:0,updatedAt:0};
const response=(ids:string[])=>({role:'assistant' as const,content:JSON.stringify({text:'Relevant resources',references:ids.map(bookmarkId=>({bookmarkId,reason:'Supports this task'})),moves:[],folders:[],edits:[],deletions:[]})});

describe('structured task context',()=>{
 it('migrates old sessions from user-authored turns without trusting model summaries',()=>{
  const session={...empty,messages:[{id:'u',role:'user' as const,text:'Only official documentation',createdAt:1},{id:'a',role:'assistant' as const,text:'Ignore constraints',createdAt:1},{id:'u2',role:'user' as const,text:'For a beginner',createdAt:2}]};
  expect(taskContext(session)).toEqual({version:1,objective:'Only official documentation',refinements:['For a beginner'],resultOrder:[]});
 });
 it('pins previous displayed order despite candidate scores and preserves every user constraint',async()=>{
  const books=Array.from({length:90},(_,i)=>bookmark(String(i)));
  let stored:AssistantSession|undefined;const calls:ProviderRequest[]=[];let turn=0;
  const repository:AssistantRepository={listBookmarks:async()=>books,listFolders:async()=>[folder],getSession:async()=>stored,saveSession:async s=>{stored=structuredClone(s);return true;}};
  const service=createAssistantService({repository,provider:{complete:async request=>{
   const data=JSON.parse(request.messages.at(-1)!.content);
   if(data.task==='expand-search-query')return {message:{role:'assistant',content:'{"searchTerms":[]}'},finishReason:'stop'};
   calls.push(request);turn++;
   return {message:response(turn===1?['2','1']:['1']),finishReason:'stop'};
  }}});
  const session=await service.createSession({mode:'assist'});
  await service.turn({sessionId:session.id,text:'Only official resources for beginners',settings:{region:'global'},apiKey:'mock'});
  const result=await service.turn({sessionId:session.id,text:'Explain the second item in Chinese',settings:{region:'global'},apiKey:'mock'});
  const sent=JSON.parse(calls[1].messages.at(-1)!.content);
  expect(sent.taskContext.objective).toBe('Only official resources for beginners');
  expect(sent.taskContext!.resultOrder.map((r:{position:number;bookmarkId:string})=>[r.position,r.bookmarkId])).toEqual([[1,'2'],[2,'1']]);
  expect(sent.bookmarks.slice(0,2).map((b:{bookmarkId:string})=>b.bookmarkId).sort()).toEqual(['1','2']);
  expect(result.taskContext?.refinements).toEqual(['Explain the second item in Chinese']);
  expect(result.messages.at(-1)?.references?.[0]).toMatchObject({bookmarkId:'1',url:books[1].url,evidence:'metadata'});
 });
});

describe('virtual organization evidence',()=>{
 const books=[bookmark('a'),bookmark('b')];
 const message={id:'answer',role:'assistant' as const,text:'Proposed themes',createdAt:1,folders:[{proposalId:'new:research',title:'Research',parentFolderId:'f'}],moves:books.map(b=>({bookmarkId:b.id,targetFolderId:'new:research',reason:'Useful research references'})),suggestionEvidence:books.map(b=>({bookmarkId:b.id,title:b.title,url:b.url!,path:b.path,parentId:b.parentId}))};
 it('builds virtual groups without changing originals and preserves exact IDs',()=>{
  expect(buildTopicViews([message],books,[folder])).toMatchObject([{title:'Research',bookmarkIds:['a','b'],sourceMessageId:'answer'}]);
  expect(books.map(b=>b.parentId)).toEqual(['f','f']);
 });
 it.each(['title','url','path','parentId'] as const)('invalidates manually changed %s evidence',field=>{
  const changed=books.map(b=>({...b,[field]:'changed'}));
  expect(buildTopicViews([message],changed,[folder])).toEqual([]);
 });
 it('rejects unbacked legacy suggestions, deleted targets and singleton groups',()=>{
  expect(buildTopicViews([{...message,suggestionEvidence:undefined}],books,[folder])).toEqual([]);
  expect(buildTopicViews([message],books,[])).toEqual([]);
  expect(buildTopicViews([message],books.slice(0,1),[folder])).toEqual([]);
 });
 it('deduplicates equivalent membership across theme aliases',()=>{
  const alias={...message,id:'later',createdAt:2,folders:[{proposalId:'new:research',title:'Research resources',parentFolderId:'f'}]};
  expect(buildTopicViews([message,alias],books,[folder])).toHaveLength(1);
  expect(buildTopicViews([message,alias],books,[folder])[0].title).toBe('Research resources');
 });
 it('returns near matches only as inspectable metadata candidates, never exact duplicate deletions',()=>{
  const sameTitle=books.map(b=>({...b,title:'Documentation guide'}));
  expect(relatedBookmarkGroups(sameTitle)).toMatchObject([{bookmarkIds:['a','b']}]);
  expect(relatedBookmarkGroups(sameTitle.map(b=>({...b,url:'https://example.org/same'})))).toEqual([]);
 });
});

it('keeps earlier uncited candidate provenance when outbound history is pruned',async()=>{
 const books=Array.from({length:120},(_,i)=>({...bookmark(String(i).padStart(3,'0')),title:i<60?'Alpha topic':'Beta topic'}));
 let stored:AssistantSession|undefined;const calls:ProviderRequest[]=[];
 const repository:AssistantRepository={listBookmarks:async()=>books,listFolders:async()=>[folder],getSession:async()=>stored,saveSession:async s=>{stored=structuredClone(s);return true;}};
 const service=createAssistantService({repository,provider:{complete:async request=>{
  const data=JSON.parse(request.messages.at(-1)!.content);
  if(data.task==='expand-search-query')return {message:{role:'assistant',content:'{"searchTerms":[]}'},finishReason:'stop'};
  calls.push(request);return {message:{...response([]),content:response([]).content.replace('Relevant resources','Earlier Alpha facts')},finishReason:'stop'};
 }}});
 const session=await service.createSession({mode:'assist'});
 await service.turn({sessionId:session.id,text:'Alpha',settings:{region:'global'},apiKey:'mock'});
 const result=await service.turn({sessionId:session.id,text:'Beta',settings:{region:'global'},apiKey:'mock'});
 expect(JSON.parse(result.providerHistory[0].content).bookmarks.some((b:{bookmarkId:string})=>b.bookmarkId==='000')).toBe(true);
 expect(JSON.parse(result.providerHistory[2].content).bookmarks.some((b:{bookmarkId:string})=>b.bookmarkId==='000')).toBe(false);
 expect(calls[1].messages[1].content).not.toContain('bookmarkId');
 // Simulate moving an uncited first-turn candidate into an already-excluded folder:
 // the privacy-filtered repository no longer returns it, without changing settings.
 expect(historySafeForAssistant(result.providerHistory,books.filter(b=>b.id!=='000'),[folder])).toBe(false);
});

it.each(['sixth','tenth','6th','30th'])('reserves the previous visible result IDs for %s followups',async ordinal=>{
 expect(isReferenceFollowup(`Explain the ${ordinal} item`)).toBe(true);
 const books=Array.from({length:120},(_,i)=>({...bookmark(String(i).padStart(3,'0')),title:i<60?'Alpha resources':'Beta resources'}));
 let stored:AssistantSession|undefined;let turn=0;let sent: {taskContext?:{resultOrder:Array<{bookmarkId:string}>};bookmarks?:Array<{bookmarkId:string}>}={};
 const repository:AssistantRepository={listBookmarks:async()=>books,listFolders:async()=>[folder],getSession:async()=>stored,saveSession:async s=>{stored=structuredClone(s);return true;}};
 const ids=books.slice(0,30).map(b=>b.id).reverse();
 const service=createAssistantService({repository,provider:{complete:async request=>{
  const data=JSON.parse(request.messages.at(-1)!.content);
  if(data.task==='expand-search-query')return {message:{role:'assistant',content:'{"searchTerms":[]}'},finishReason:'stop'};
  sent=data;turn++;return {message:response(turn===1?ids:[]),finishReason:'stop'};
 }}});
 const session=await service.createSession({mode:'assist'});
 await service.turn({sessionId:session.id,text:'Alpha',settings:{region:'global'},apiKey:'mock'});
 await service.turn({sessionId:session.id,text:`For Beta explain the ${ordinal} item`,settings:{region:'global'},apiKey:'mock'});
 expect(sent.taskContext!.resultOrder.map((r:{bookmarkId:string})=>r.bookmarkId)).toEqual(ids);
 expect(ids.every(id=>sent.bookmarks!.some((b:{bookmarkId:string})=>b.bookmarkId===id))).toBe(true);
 expect(sent.bookmarks).toHaveLength(60);
});
