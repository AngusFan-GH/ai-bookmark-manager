import { guardUrl } from '../../domain/health/url-guard';
/** Conservative outbound-data filter; this cannot detect every secret or DNS rebinding. */
export function safeForAssistant(raw:string):boolean {
 const verdict=guardUrl(raw);if(!verdict.ok)return false;
 const url=verdict.parsed;if(url.username||url.password)return false;
 const sensitive=/(?:^|[_-])(?:token|secret|password|passwd|authorization|credential|signature|api[_-]?key|access[_-]?key|sig|code)(?:$|[_-])/i;
 if([...url.searchParams.keys()].some(k=>sensitive.test(k)||/^x-amz-/i.test(k)))return false;
 if(/(?:token|secret|password|api[_-]?key|authorization|signature)=/i.test(url.hash))return false;
 return true;
}
export function excludedFolderSet(folders:Array<{id:string;parentId:string|null}>,excluded:string[]):Set<string>{
 const ids=new Set(excluded);let changed=true;
 while(changed){changed=false;for(const f of folders)if(f.parentId&&ids.has(f.parentId)&&!ids.has(f.id)){ids.add(f.id);changed=true;}}
 return ids;
}
export function assertSafePromptUrls(text:string):void {
 const urls=text.match(/https?:\/\/[^\s<>"']+/gi)??[];
 if(urls.some(url=>!safeForAssistant(url)))throw new Error('消息包含内网地址或疑似带凭据的链接，请移除敏感链接后重试。原始书签仍保留在本地。');
}

/** Historical candidates (including uncited ones) must still satisfy today's privacy scope. */
export function historySafeForAssistant(history:Array<{role:string;content:string}>|undefined,bookmarks:Array<{id:string;url?:string;title?:string;path?:string}>,folders:Array<{id:string}>):boolean{
 if(!Array.isArray(history))return false;
 const allowedBookmarks=new Map(bookmarks.map(b=>[b.id,b]));const allowedFolders=new Set(folders.map(f=>f.id));
 for(const message of history){
  if(message.role==='assistant')continue;
  if(message.role!=='user'||typeof message.content!=='string')return false;
  let payload:Record<string,unknown>;try{payload=JSON.parse(message.content);}catch{return false;}
  if(!payload||!Array.isArray(payload.bookmarks)||!Array.isArray(payload.existingFolders))return false;
  try{if(typeof payload.request!=='string')return false;assertSafePromptUrls(payload.request);}catch{return false;}
  for(const item of payload.bookmarks){
   if(!item||typeof item.bookmarkId!=='string'||typeof item.url!=='string'||!allowedBookmarks.has(item.bookmarkId)||!safeForAssistant(item.url))return false;
   // If the user changed a URL, do not resend an earlier private resource by stale ID.
   const current=allowedBookmarks.get(item.bookmarkId)!;
   if(current.url?.slice(0,2000)!==item.url)return false;
   if(current.title!==undefined && item.title!==current.title.slice(0,300))return false;
   if(current.path!==undefined && item.path!==current.path.slice(0,500))return false;
  }
  for(const folder of payload.existingFolders)if(!folder||typeof folder.id!=='string'||!allowedFolders.has(folder.id))return false;
 }
 return true;
}
