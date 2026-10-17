import type {BookmarkRecord, RawBookmarkNode} from '../../domain/bookmarks/types';

/** Browser serialization only: query order, path case, fragments and tracking remain meaningful. */
export function serializeCaptureUrl(raw:string):string {
  if(typeof raw!=='string'||raw.length>10000)throw new Error('页面地址无效');
  let url:URL;
  try {url=new URL(raw);}catch {throw new Error('页面地址无效');}
  if(!['http:','https:'].includes(url.protocol))throw new Error('当前页面不是可收藏的网页');
  return url.href;
}

/** Local-only native lookup; never uses the eventual-consistency index or AI privacy exclusions. */
export function findExactNativeBookmarks(tree:RawBookmarkNode[],rawUrl:string,now=Date.now()):BookmarkRecord[] {
  const target=serializeCaptureUrl(rawUrl);
  if(!Array.isArray(tree))throw new Error('无法读取当前书签，请重试');
  const matches:BookmarkRecord[]=[];
  const walk=(nodes:RawBookmarkNode[],parents:string[],parentId:string|null) => {
    for(const node of nodes){
      if(!node||typeof node.id!=='string')throw new Error('无法读取当前书签，请重试');
      if(node.url){
        let serialized:string;
        try {serialized=serializeCaptureUrl(node.url);}catch {continue;}
        if(serialized===target)matches.push({id:node.id,browserId:node.id,kind:'bookmark',parentId:node.parentId??parentId,index:node.index??0,title:node.title??'',url:node.url,path:parents.join(' / '),dateAdded:node.dateAdded,dateGroupModified:node.dateGroupModified,updatedAt:now,syncGeneration:0});
      }else if(node.children){
        if(!Array.isArray(node.children))throw new Error('无法读取当前书签，请重试');
        walk(node.children,node.title?[...parents,node.title]:parents,node.id);
      }
    }
  };
  walk(tree,[],null);
  return matches;
}
