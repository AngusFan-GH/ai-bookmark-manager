import type {BookmarkRecord,FolderRecord} from '../../domain/bookmarks/types';
import type {OrganizationInput} from '../../workspace-client';
/** Expand a user-selected folder deletion for complete review; no browser write happens here. */
export function expandFolderDeletes(input:OrganizationInput,bookmarks:BookmarkRecord[],folders:FolderRecord[]):OrganizationInput {
 const all=[...bookmarks,...folders];const byId=new Map(all.map(r=>[r.browserId,r]));
 const deletions=new Set(input.steps.filter(s=>s.action==='delete'&&s.targetBrowserId).map(s=>s.targetBrowserId!));
 let changed=true;while(changed){changed=false;for(const r of all)if(r.parentId&&deletions.has(r.parentId)&&!deletions.has(r.browserId)){deletions.add(r.browserId);changed=true;}}
 const depth=(id:string)=>{let n=0;let r=byId.get(id);const seen=new Set<string>();while(r?.parentId&&!seen.has(r.browserId)){seen.add(r.browserId);n++;r=byId.get(r.parentId);}return n;};
 const deletes=[...deletions].sort((a,b)=>depth(b)-depth(a)).map(id=>({action:'delete' as const,targetBrowserId:id,reason:input.steps.find(s=>s.action==='delete'&&s.targetBrowserId===id)?.reason||'用户选择删除的目录中包含此条目'}));
 const steps=[...input.steps.filter(s=>s.action!=='delete'),...deletes];
 if(steps.length>500)throw new Error('包含子项后超过每批 500 项，请缩小删除范围');
 return {...input,steps};
}
