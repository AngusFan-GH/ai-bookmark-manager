import {describe,it,expect} from 'vitest';
import {expandFolderDeletes} from '../../src/infrastructure/messaging/workspace-plans';
import type {BookmarkRecord,FolderRecord} from '../../src/domain/bookmarks/types';
const folder=(id:string,parentId:string|null):FolderRecord=>({id,browserId:id,parentId,title:id,path:id,index:0,updatedAt:0,syncGeneration:1});
const bookmark=(id:string,parentId:string):BookmarkRecord=>({...folder(id,parentId),kind:'bookmark',url:'https://example.com/'+id});
describe('reviewable folder removal expansion',()=>{
 it('includes each nested child once before its parent',()=>{const plan=expandFolderDeletes({title:'Delete folder',steps:[{action:'delete',targetBrowserId:'f'},{action:'delete',targetBrowserId:'b'}]},[bookmark('b','nested'),bookmark('unrelated','other')],[folder('f','1'),folder('nested','f'),folder('other','1')]);expect(plan.steps.map(s=>s.targetBrowserId)).toEqual(['b','nested','f']);});
 it('bounds expanded deletion before any plan creation',()=>expect(()=>expandFolderDeletes({title:'Delete',steps:[{action:'delete',targetBrowserId:'f'}]},Array.from({length:500},(_,i)=>bookmark(String(i),'f')),[folder('f','1')])).toThrow('500'));
});
