import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useBookmarkStore, useToolsBookmarkStore } from '../../src/store';
const { request } = vi.hoisted(()=>({request:vi.fn()}));
vi.mock('../../src/client',()=>({request}));
const row=(id:string)=>({id,browserId:id,title:id,kind:'bookmark',parentId:'1',index:0,path:'Bar',updatedAt:1,syncGeneration:1});
beforeEach(()=>{setActivePinia(createPinia());request.mockReset();request.mockImplementation(async (r:{type:string;query?:string})=>r.type==='BOOKMARKS_LIST'?{rows:[row(r.query||'all')],total:1}:r.type==='BOOKMARKS_TREE'?[]:r.type==='SYNC'?{count:1}:{bookmarks:1,folders:0,lastSync:1});});
describe('independent bookmark view stores',()=>{
 it('tools queries cannot replace workspace rows or scope',async()=>{const main=useBookmarkStore();const tools=useToolsBookmarkStore();await main.load('scoped','folder');await tools.load('tools');expect(main.rows[0].id).toBe('scoped');expect(tools.rows[0].id).toBe('tools');});
 it('ignores a slower old query after a newer load finishes',async()=>{let resolve!:(v:unknown)=>void;request.mockImplementation(async(r:{type:string;query?:string})=>r.type==='BOOKMARKS_LIST'?(r.query==='old'?new Promise(res=>resolve=res):{rows:[row('new')],total:1}):r.type==='BOOKMARKS_TREE'?[]:{});const store=useBookmarkStore();const old=store.load('old');await store.load('new');resolve({rows:[row('old')],total:1});await old;expect(store.rows[0].id).toBe('new');expect(store.loading).toBe(false);});
 it('sync preserves the current query, directory and page',async()=>{const store=useBookmarkStore();await store.load('needle','folder',200);request.mockClear();await store.sync();expect(request).toHaveBeenCalledWith(expect.objectContaining({type:'BOOKMARKS_LIST',query:'needle',folderId:'folder',offset:200}));});
 it('does not commit partial rows if metadata loading fails',async()=>{const store=useBookmarkStore();await store.load('old');request.mockImplementation(async(r:{type:string})=>{if(r.type==='STATS')throw new Error('metadata unavailable');return {rows:[row('new')],total:1};});await store.load('new');expect(store.rows).toEqual([]);expect(store.error).toBe('metadata unavailable');});
});
