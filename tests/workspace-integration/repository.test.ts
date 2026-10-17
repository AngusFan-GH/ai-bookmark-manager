import { afterEach, describe, expect, it, vi } from 'vitest';
import { BookmarkDatabase } from '../../src/infrastructure/database/db';
import { createAssistantRepository, sessionView, scopedBookmarks, validateSettings } from '../../src/infrastructure/messaging/workspace-handlers';
import type { AssistantSession } from '../../src/domain/assistant/types';
const databases:BookmarkDatabase[]=[];
function database(){const db=new BookmarkDatabase('workspace-test-'+crypto.randomUUID());databases.push(db);return db;}
function session():AssistantSession{return {id:'s1',mode:'recommend',revision:0,scope:{},messages:[],citations:[],providerHistory:[{role:'assistant',content:'hidden',reasoning_content:'not for UI'}],createdAt:1,updatedAt:1};}
afterEach(async()=>{await Promise.all(databases.splice(0).map(d=>d.delete()));});
describe('durable assistant repository',()=>{
 it('uses atomic revision compare-and-set and survives a new repository instance',async()=>{
  const db=database();const a=createAssistantRepository(db);const b=createAssistantRepository(db);const s=session();
  expect(await a.saveSession(s,null)).toBe(true);expect(await b.saveSession(s,null)).toBe(false);
  const next={...s,revision:1};
  const attempts=await Promise.all([a.saveSession(next,0),b.saveSession(next,0)]);
  expect(attempts.filter(Boolean)).toHaveLength(1);expect((await b.getSession('s1'))?.revision).toBe(1);
 });
 it('never returns raw provider history to UI',()=>{expect(sessionView(session())).not.toHaveProperty('providerHistory');});
 it('loads full corpus and excludes cached content for changed URLs',async()=>{
  const db=database();await db.bookmarks.bulkPut(Array.from({length:205},(_,i)=>({id:String(i),browserId:String(i),kind:'bookmark',parentId:'1',index:i,title:'t',url:`https://example.com/${i}`,path:'root',updatedAt:0,syncGeneration:1})));
  await db.meta.bulkPut([{key:'content:0',value:{originalUrl:'https://example.com/0',status:'ready',text:'valid'},updatedAt:1},{key:'content:1',value:{originalUrl:'https://old.example/',status:'ready',text:'stale'},updatedAt:1}]);
  const rows=await createAssistantRepository(db).listBookmarks();expect(rows).toHaveLength(205);expect(rows.find(r=>r.id==='0')?.contentSnippet).toBe('valid');expect(rows.find(r=>r.id==='1')?.contentSnippet).toBeUndefined();
 });
});
describe('workspace request validation',()=>{
 it('includes nested descendants and terminates with malformed cycles',()=>{
  const rows=[{parentId:'child'},{parentId:'other'}];expect(scopedBookmarks(rows,[{id:'root',parentId:'child'},{id:'child',parentId:'root'}],'root')).toEqual([rows[0]]);
 });
 it('rejects arbitrary provider destination and invalid model settings',()=>{
  expect(()=>validateSettings({region:'evil' as 'cn',model:'m',consent:true})).toThrow();
  expect(()=>validateSettings({region:'cn',model:'../bad',consent:true})).toThrow();
  expect(()=>validateSettings({region:'cn',model:'MiniMax-M2.5',consent:true})).not.toThrow();
 });
});


describe('assistant commit cancellation boundary',()=>{
 it('rolls back a staged session write when Stop arrives before transaction commit',async()=>{
  const db=database();const repository=createAssistantRepository(db);const original=session();await repository.saveSession(original,null);
  const controller=new AbortController();
  const put=db.meta.put.bind(db.meta);
  const spy=vi.spyOn(db.meta,'put').mockImplementationOnce((...args:Parameters<typeof put>)=>put(...args).then(result=>{controller.abort();return result;}));
  const next={...original,revision:1,lastTurnRequestId:'request-to-cancel'};
  const pending=repository.saveSession(next,0,controller.signal);const assertion=expect(pending).rejects.toThrow();
  await assertion;spy.mockRestore();
  expect(await repository.getSession(original.id)).toEqual(original);
 });
 it('leaves a turn committed before Stop available for terminal reconciliation',async()=>{
  const db=database();const repository=createAssistantRepository(db);const original=session();await repository.saveSession(original,null);const controller=new AbortController();
  const next={...original,revision:1,lastTurnRequestId:'completed-request'};expect(await repository.saveSession(next,0,controller.signal)).toBe(true);controller.abort();
  expect((await repository.getSession(original.id))?.lastTurnRequestId).toBe('completed-request');expect((await repository.getSession(original.id))?.revision).toBe(1);
 });
});
