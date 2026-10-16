import type { BackgroundRouter } from './background-router';
import type { BookmarkDatabase } from '../database/db';
import type { PlanService } from '../../domain/operations/plan-service';
import { createAssistantService, createMiniMaxProvider } from '../../domain/assistant';
import type { AssistantSession, AssistantRepository } from '../../domain/assistant/types';
import { fetchBookmarkContent } from '../../domain/content';
import type { AssistantSettingsView, SettingsInput, AssistantSessionView } from '../../workspace-client';

const SESSION_PREFIX = 'assistant:session:';
const CONTENT_PREFIX = 'content:';
const SETTINGS_KEY = 'assistant:settings';
const SECRET_KEY = 'minimaxSessionKey';
const DEFAULT_SETTINGS = {region:'cn' as const,model:'MiniMax-M2.5',consent:false};
export function sessionView(session:AssistantSession):AssistantSessionView {
  const {providerHistory: _history, ...view} = session;
  return view;
}
export function createAssistantRepository(db:BookmarkDatabase):AssistantRepository {
  return {
    async listBookmarks() {
      const [bookmarks,contents] = await Promise.all([db.bookmarks.toArray(),db.meta.where('key').startsWith(CONTENT_PREFIX).toArray()]);
      const map = new Map(contents.map(row => [row.key.slice(CONTENT_PREFIX.length),row.value as {text?:string;originalUrl?:string;status?:string}]));
      return bookmarks.map(bookmark => {
        const content = map.get(bookmark.id);
        return {...bookmark, ...(content?.status === 'ready' && content.originalUrl === bookmark.url ? {contentSnippet:content.text} : {})};
      });
    },
    listFolders: () => db.folders.toArray(),
    async getSession(id) { return (await db.meta.get(SESSION_PREFIX+id))?.value as AssistantSession|undefined; },
    async saveSession(session,expectedRevision) {
      return db.transaction('rw',db.meta,async () => {
        const key = SESSION_PREFIX+session.id;
        const existing = (await db.meta.get(key))?.value as AssistantSession|undefined;
        if (expectedRevision === null ? !!existing : !existing || existing.revision !== expectedRevision) return false;
        await db.meta.put({key,value:session,updatedAt:Date.now()}); return true;
      });
    },
  };
}
export function scopedBookmarks<T extends {parentId:string|null}>(bookmarks:T[],folders:Array<{id:string;parentId:string|null}>,folderId?:string):T[] {
  if (!folderId) return bookmarks;
  const ids = new Set([folderId]);
  let changed = true;
  while(changed) { changed=false; for(const f of folders) if(f.parentId && ids.has(f.parentId) && !ids.has(f.id)) {ids.add(f.id);changed=true;} }
  return bookmarks.filter(b => b.parentId && ids.has(b.parentId));
}
export function validateSettings(input:SettingsInput):void {
  if (!input || !['cn','global'].includes(input.region) || typeof input.model !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(input.model) || typeof input.consent !== 'boolean') throw new Error('模型设置无效');
  if(input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 8192)) throw new Error('密钥格式无效');
}
interface HandlerDeps {db:BookmarkDatabase;planService:PlanService;canFetch:(url:string)=>Promise<boolean>}
export function registerWorkspaceHandlers(router:BackgroundRouter,{db,planService,canFetch}:HandlerDeps):void {
  const repository=createAssistantRepository(db);
  const service=createAssistantService({repository,provider:createMiniMaxProvider()});
  const controllers=new Map<string,AbortController>();
  let settingsMutation=false;
  const readSettings=async () => ({...DEFAULT_SETTINGS,...((await db.meta.get(SETTINGS_KEY))?.value as Partial<typeof DEFAULT_SETTINGS>|undefined)});
  const readKey=async ():Promise<string> => {
    const value=await chrome.storage.session.get(SECRET_KEY);
    return typeof value[SECRET_KEY] === 'string' ? value[SECRET_KEY] : '';
  };
  router.register('ASSISTANT_SETTINGS_GET',async ():Promise<AssistantSettingsView> => ({...await readSettings(),hasKey:!!await readKey()}))
    .register('ASSISTANT_SETTINGS_SAVE',async req => {
      validateSettings(req.settings);
      if(settingsMutation) throw new Error('模型设置正在更新，请稍后重试');
      if(controllers.size) throw new Error('请先停止正在进行的 AI 对话，再修改模型设置');
      settingsMutation=true;
      try {
      const previous=await readSettings();
      if(previous.region !== req.settings.region) await chrome.storage.session.remove(SECRET_KEY);
      if(req.settings.apiKey !== undefined) {
        if(req.settings.apiKey.trim()) await chrome.storage.session.set({[SECRET_KEY]:req.settings.apiKey.trim()});
        else await chrome.storage.session.remove(SECRET_KEY);
      }
      const {region,model,consent}=req.settings;
      await db.meta.put({key:SETTINGS_KEY,value:{region,model,consent},updatedAt:Date.now()});
      } finally {settingsMutation=false;}
    })
    .register('ASSISTANT_KEY_CLEAR',async () => {
      if(settingsMutation) throw new Error('模型设置正在更新，请稍后重试');
      settingsMutation=true;
      try {
      for(const controller of controllers.values()) controller.abort();
      await chrome.storage.session.remove(SECRET_KEY);
      } finally {settingsMutation=false;}
    })
    .register('ASSISTANT_SESSIONS',async () => (await db.meta.where('key').startsWith(SESSION_PREFIX).toArray())
      .map(row=>row.value as AssistantSession).sort((a,b)=>b.updatedAt-a.updatedAt).map(s=>({id:s.id,mode:s.mode,scope:s.scope,updatedAt:s.updatedAt,title:s.messages.find(m=>m.role==='user')?.text.slice(0,80)||'新任务'})))
    .register('ASSISTANT_CREATE',async req => sessionView(await service.createSession(req.input)))
    .register('ASSISTANT_GET',async req => {const s=await repository.getSession(req.sessionId);if(!s) throw new Error('对话不存在');return sessionView(s);})
    .register('ASSISTANT_TURN',async req => {
      if(settingsMutation) throw new Error('模型设置正在更新，请稍后发送');
      if(controllers.has(req.sessionId)) throw new Error('该对话正在生成，请等待或停止');
      // Reserve before any async preflight so cancellation and settings changes
      // see the request throughout its lifetime, not only after key/permission reads.
      const controller=new AbortController();controllers.set(req.sessionId,controller);
      try {
        const settings=await readSettings();
        if(!settings.consent) throw new Error('请先在设置中确认向 MiniMax 发送候选书签及内容片段');
        const apiKey=await readKey();
        if(!apiKey) throw new Error('请填写本次浏览器会话的 MiniMax API Key');
        const endpoint=settings.region === 'cn'?'https://api.minimax.cn/v1/chat/completions':'https://api.minimax.io/v1/chat/completions';
        if(!await canFetch(endpoint)) throw new Error('尚未授予所选 MiniMax 服务的访问权限，请在设置中授权');
        if(controller.signal.aborted) throw new Error('请求已停止');
        return sessionView(await service.turn({sessionId:req.sessionId,text:req.text,settings,apiKey,signal:controller.signal}));
      } finally {if(controllers.get(req.sessionId)===controller) controllers.delete(req.sessionId);}
    })
    .register('ASSISTANT_CANCEL',async req => {controllers.get(req.sessionId)?.abort();})
    .register('ORGANIZATION_DUPLICATES',async req => {
      const rows=scopedBookmarks(await db.bookmarks.toArray(),await db.folders.toArray(),req.folderId);
      const groups=new Map<string,typeof rows>();
      for(const row of rows) if(row.url && row.kind==='bookmark') groups.set(row.url,[...(groups.get(row.url)||[]),row]);
      return {groups:[...groups].filter(([,bookmarks])=>bookmarks.length>1).map(([url,bookmarks])=>({url,bookmarks}))};
    })
    .register('ORGANIZATION_PREPARE',async req => {
      if(!req.input || !Array.isArray(req.input.steps) || !req.input.steps.length || req.input.steps.length>500) throw new Error('整理方案必须包含 1–500 项改动');
      if(req.input.steps.some(s=>!['create','move','delete'].includes(s.action))) throw new Error('不支持的整理操作');
      return planService.draftOrganization(req.input);
    })
    .register('PLAN_BACKUP_EXPORT',async req => {
      const snapshots=await planService.getPlanSnapshots(req.planId);
      if(!snapshots.length) throw new Error('没有找到备份，禁止执行');
      const snapshot=snapshots.sort((a,b)=>b.createdAt-a.createdAt)[0];
      return {formatVersion:1,exportedAt:new Date(snapshot.createdAt).toISOString(),appVersion:chrome.runtime.getManifest().version,browserTree:snapshot.tree,localIndex:snapshot.localIndex||{bookmarks:[],folders:[]},includes:{browserTree:true,localIndex:true}};
    })
    .register('CONTENT_FETCH',async req => {
      if(!Array.isArray(req.bookmarkIds)||req.bookmarkIds.length>50||req.bookmarkIds.some(id=>typeof id!=='string')) throw new Error('每批最多读取 50 条书签');
      const results=[];
      for(const id of new Set(req.bookmarkIds)) {
        const row=await db.bookmarks.get(id);
        if(!row?.url) {results.push({bookmarkId:id,status:'unavailable',reason:'书签不存在或没有地址'});continue;}
        if(!await canFetch(row.url)) {results.push({bookmarkId:id,status:'unavailable',reason:'尚未授权读取该网站'});continue;}
        const content=await fetchBookmarkContent({url:row.url,canFetch});
        // A concurrent edit must not attach old content to a different URL.
        const current=await db.bookmarks.get(id);
        if(current?.url===row.url) await db.meta.put({key:CONTENT_PREFIX+id,value:content,updatedAt:Date.now()});
        results.push({bookmarkId:id,status:content.status,reason:content.reason});
      }
      return {results};
    });
}
