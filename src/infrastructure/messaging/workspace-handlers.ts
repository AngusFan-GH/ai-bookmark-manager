import {findExactNativeBookmarks, serializeCaptureUrl} from './capture-lookup';
import type {RawBookmarkNode} from '../../domain/bookmarks/types';
import type { BackgroundRouter } from './background-router';
import type { BookmarkDatabase } from '../database/db';
import type { PlanService } from '../../domain/operations/plan-service';
import { createAssistantService, createMiniMaxProvider } from '../../domain/assistant';
import type { AssistantSession, AssistantRepository } from '../../domain/assistant/types';
import { expandFolderDeletes } from './workspace-plans';
import { safeForAssistant, excludedFolderSet, assertSafePromptUrls, historySafeForAssistant } from './workspace-privacy';
import { retrievalTerms } from '../../domain/assistant/service';
import { fetchBookmarkContent } from '../../domain/content';
import type { AssistantSettingsView, SettingsInput, AssistantSessionView } from '../../workspace-client';

const SESSION_PREFIX = 'assistant:session:';
const CONTENT_PREFIX = 'content:';
const SETTINGS_KEY = 'assistant:settings';
const SECRET_KEY = 'minimaxSessionKey';
const DEFAULT_SETTINGS = {region:'cn' as const,model:'MiniMax-M2.5',consent:false,keyStorage:'session' as 'session'|'local'};
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
    async saveSession(session,expectedRevision,signal) {
      if(signal?.aborted) throw new Error('请求已停止');
      let cancel = () => {};
      try { return await db.transaction('rw',db.meta,async transaction => {
        cancel = () => { try { transaction.abort(); } catch { /* A committed turn cannot be rolled back. */ } };
        signal?.addEventListener('abort',cancel,{once:true});
        if(signal?.aborted) {cancel();throw new Error('请求已停止');}
        const key = SESSION_PREFIX+session.id;
        const existing = (await db.meta.get(key))?.value as AssistantSession|undefined;
        if (expectedRevision === null ? !!existing : !existing || existing.revision !== expectedRevision) return false;
        if(signal?.aborted) throw new Error('请求已停止');
        await db.meta.put({key,value:session,updatedAt:Date.now()});
        if(signal?.aborted) throw new Error('请求已停止');
        return true;
      }); } finally {signal?.removeEventListener('abort',cancel);}
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
  for(const key of ['autoSuggestions','onboardingCompleted'] as const) if(input?.[key] !== undefined && typeof input[key] !== 'boolean') throw new Error('引导和自动建议设置无效');
  if (!input || !['cn','global'].includes(input.region) || typeof input.model !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(input.model) || typeof input.consent !== 'boolean') throw new Error('模型设置无效');
  if(input.keyStorage !== undefined && !['session','local'].includes(input.keyStorage)) throw new Error('密钥保存方式无效');
  if(input.excludedFolderIds !== undefined && (!Array.isArray(input.excludedFolderIds)||input.excludedFolderIds.length>500||input.excludedFolderIds.some(id=>typeof id!=='string'||!id||id.length>200))) throw new Error('排除目录设置无效');
  if(input.maxCompletionTokens!==undefined&&(!Number.isInteger(input.maxCompletionTokens)||input.maxCompletionTokens<1024||input.maxCompletionTokens>16384))throw new Error('输出上限必须为 1024–16384 的整数');
  if(input.contentEnhancement !== undefined && typeof input.contentEnhancement!=='boolean') throw new Error('内容增强设置无效');
  if(input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 8192)) throw new Error('密钥格式无效');
}
interface HandlerDeps {db:BookmarkDatabase;planService:PlanService;canFetch:(url:string)=>Promise<boolean>;readTree?:()=>Promise<RawBookmarkNode[]>}
export function registerWorkspaceHandlers(router:BackgroundRouter,{db,planService,canFetch,readTree=()=>chrome.bookmarks.getTree()}:HandlerDeps):void {
  const lookupCapture=async (url:string) => {
    serializeCaptureUrl(url);
    try {return {bookmarks:findExactNativeBookmarks(await readTree(),url)};}
    catch {throw new Error('无法检查当前书签，请重试；未发送 AI 分析请求');}
  };
  const validCaptureFolderId = (id:unknown):id is string => typeof id==='string' && /^[A-Za-z0-9_-]{1,200}$/.test(id);
  async function captureFolderExists(id:string):Promise<boolean> {
    const visit=(nodes:RawBookmarkNode[],hasParent=false):boolean => nodes.some(node=>
      node.id===id ? hasParent && node.id!=='0' && !node.url && node.type!=='bookmark' && node.type!=='separator' && !('unmodifiable' in node && node.unmodifiable)
        : !!node.children && visit(node.children,true));
    return visit(await readTree());
  }
  const repository=createAssistantRepository(db);
  const outboundRepository:AssistantRepository={...repository,
    async listBookmarks(){const [rows,folders,settings]=await Promise.all([repository.listBookmarks(),repository.listFolders(),readSettings()]);const excluded=excludedFolderSet(folders,settings.excludedFolderIds);return rows.filter(b=>!!b.url&&safeForAssistant(b.url)&&(!b.parentId||!excluded.has(b.parentId)));},
    async listFolders(){const [folders,settings]=await Promise.all([repository.listFolders(),readSettings()]);const excluded=excludedFolderSet(folders,settings.excludedFolderIds);return folders.filter(f=>!excluded.has(f.id));}
  };
  const provider=createMiniMaxProvider();
  const service=createAssistantService({repository:outboundRepository,provider});
  // Construct lazily so existing manual service state remains independent.
  const automaticService=() => createAssistantService({repository:{...outboundRepository,
    async listBookmarks(){return (await outboundRepository.listBookmarks()).map(({contentSnippet:_snippet,...metadata})=>metadata);}
  },provider});
  const controllers=new Map<string,AbortController>();
  const settlements=new Map<string,Promise<void>>();
  let settingsMutation=false;
  let keyAccessBlocked=false;
  const trustedAreas=new WeakMap<object,Promise<void>>();
  const storageArea=async (kind:'session'|'local') => {
    const area=chrome.storage?.[kind];
    if(!area) throw new Error('密钥存储不可用，请更新浏览器后重试');
    if(!trustedAreas.has(area)) {
      const access=typeof area.setAccessLevel === 'function'
        ? area.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}) : Promise.resolve();
      trustedAreas.set(area,access);
    }
    try { await trustedAreas.get(area); }
    catch { trustedAreas.delete(area); throw new Error('无法限制密钥存储访问权限'); }
    return area;
  };
  const readSettings=async () => {
    const stored=(await db.meta.get(SETTINGS_KEY))?.value as (Partial<AssistantSettingsView>&{configRevision?:string;testedRevision?:string})|undefined;
    return {autoSuggestions:stored?.autoSuggestions===true,onboardingCompleted:stored?.onboardingCompleted??!!stored,
      configRevision:stored?.configRevision??'',testedRevision:stored?.testedRevision??'',region:stored?.region === 'global' ? 'global' as const : 'cn' as const,
      model:stored?.model ?? DEFAULT_SETTINGS.model,consent:stored?.consent === true,
      keyStorage:stored?.keyStorage === 'local' ? 'local' as const : 'session' as const,
      excludedFolderIds:Array.isArray(stored?.excludedFolderIds)?stored.excludedFolderIds:[],contentEnhancement:stored?.contentEnhancement===true,maxCompletionTokens:stored?.maxCompletionTokens??4096};
  };
  const readKey=async (settings:Awaited<ReturnType<typeof readSettings>>):Promise<string> => {
    if(keyAccessBlocked) throw new Error('密钥存储操作失败，请清除密钥或重新保存设置后重试');
    try {
      const area=await storageArea(settings.keyStorage);
      const value=(await area.get(SECRET_KEY))[SECRET_KEY];
      // Older versions only stored a string in session storage. Never read a
      // legacy unbound value from persistent storage or fall back across areas.
      if(typeof value === 'string') return settings.keyStorage === 'session' ? value : '';
      return value?.region === settings.region && typeof value.apiKey === 'string' ? value.apiKey : '';
    } catch {throw new Error('无法读取密钥，请检查浏览器存储后重试');}
  };
  const clearKeys=async () => {
    // Attempt both removals even if one area fails; never silently report success.
    const results=await Promise.allSettled((['session','local'] as const).map(async kind => {
      if(!chrome.storage?.[kind]) return;
      await (await storageArea(kind)).remove(SECRET_KEY);
    }));
    if(results.some(result=>result.status === 'rejected')) throw new Error('无法完整清除密钥，请检查浏览器存储后重试');
  };
  const viewSettings=async ():Promise<AssistantSettingsView> => {
    const {configRevision,testedRevision,...settings}=await readSettings();
    const hasKey=!!await readKey({...settings,configRevision,testedRevision});
    return {...settings,hasKey,connectionTested:hasKey&&!!configRevision&&configRevision===testedRevision};
  };
  const assertAutomatic=(settings:Awaited<ReturnType<typeof readSettings>>) => {
    if(!settings.consent||!settings.autoSuggestions||!settings.configRevision||settings.configRevision!==settings.testedRevision)
      throw new Error('自动建议需要同意数据发送、启用自动建议并测试当前连接');
  };
  router.register('ASSISTANT_SETTINGS_GET',async ():Promise<AssistantSettingsView> => {
    if(settingsMutation) throw new Error('模型设置正在更新，请稍后重试');
    return viewSettings();
  })
    .register('ASSISTANT_ONBOARDING_COMPLETE',async () => {
      if(settingsMutation||controllers.size)throw new Error('模型设置正在更新，请稍后重试');
      settingsMutation=true;
      try {const settings=await readSettings();await db.meta.put({key:SETTINGS_KEY,value:{...settings,onboardingCompleted:true},updatedAt:Date.now()});}
      finally {settingsMutation=false;}
    })
    .register('ASSISTANT_TEST_CONNECTION',async () => {
      if(settingsMutation||controllers.size)throw new Error('请先停止正在进行的 AI 请求，再测试连接');
      const controller=new AbortController();controllers.set('connection-test',controller);
      const timeout=setTimeout(()=>controller.abort(),30000);
      try {
        const settings=await readSettings();
        const apiKey=await readKey(settings);if(!apiKey)throw new Error('请先保存 MiniMax API Key');
        const endpoint=settings.region==='cn'?'https://api.minimax.cn/v1/chat/completions':'https://api.minimax.io/v1/chat/completions';
        if(!await canFetch(endpoint))throw new Error('请先授予所选 MiniMax 服务的访问权限');
        if(controller.signal.aborted)throw new Error('连接测试已取消');
        await db.meta.put({key:SETTINGS_KEY,value:{...settings,testedRevision:''},updatedAt:Date.now()});
        if(controller.signal.aborted)throw new Error('连接测试已取消');
        // Explicit test sends only this fixed prompt. No bookmarks, URLs or history.
        await provider.complete({messages:[{role:'user',content:'Reply with OK.'}],settings:{...settings,maxCompletionTokens:256},apiKey,signal:controller.signal});
        if(controller.signal.aborted)throw new Error('连接测试已取消');
        const configRevision=settings.configRevision||crypto.randomUUID();
        await db.meta.put({key:SETTINGS_KEY,value:{...settings,configRevision,testedRevision:configRevision},updatedAt:Date.now()});
        return await viewSettings();
      } finally {clearTimeout(timeout);controllers.delete('connection-test');}
    })
    .register('ASSISTANT_SETTINGS_SAVE',async req => {
      validateSettings(req.settings);
      if(settingsMutation) throw new Error('模型设置正在更新，请稍后重试');
      if(controllers.size) throw new Error('请先停止正在进行的 AI 对话，再修改模型设置');
      settingsMutation=true;
      let changingKey=false;
      try {
        const previous=await readSettings();
        const {region,model,consent}=req.settings;
        const keyStorage=req.settings.keyStorage ?? 'session';
        changingKey=previous.region !== region || previous.keyStorage !== keyStorage || req.settings.apiKey !== undefined;
        if(changingKey) {
          const apiKey=req.settings.apiKey !== undefined ? req.settings.apiKey.trim()
            : previous.region === region ? await readKey(previous) : '';
          // Verify the destination is restricted before moving a secret into it.
          const area=await storageArea(keyStorage);
          await clearKeys();
          if(apiKey) await area.set({[SECRET_KEY]:{region,apiKey}});
        }
        const excludedFolderIds=[...new Set(req.settings.excludedFolderIds??previous.excludedFolderIds)];
        const contentEnhancement=req.settings.contentEnhancement??previous.contentEnhancement;
        const maxCompletionTokens=req.settings.maxCompletionTokens??previous.maxCompletionTokens;
        if(JSON.stringify([...excludedFolderIds].sort())!==JSON.stringify([...previous.excludedFolderIds].sort()))await db.meta.put({key:'assistant:privacyUpdatedAt',value:Date.now(),updatedAt:Date.now()});
        const configChanged=changingKey||previous.model!==model||previous.maxCompletionTokens!==maxCompletionTokens;
        const configRevision=configChanged?crypto.randomUUID():previous.configRevision;
        const testedRevision=configChanged?'':previous.testedRevision;
        const autoSuggestions=req.settings.autoSuggestions??previous.autoSuggestions;
        const onboardingCompleted=req.settings.onboardingCompleted??previous.onboardingCompleted;
        await db.meta.put({key:SETTINGS_KEY,value:{region,model,consent,keyStorage,excludedFolderIds,contentEnhancement,maxCompletionTokens,autoSuggestions,onboardingCompleted,configRevision,testedRevision},updatedAt:Date.now()});
        if(changingKey) keyAccessBlocked=false;
      } catch {
        if(changingKey) {
          keyAccessBlocked=true;
          await clearKeys().catch(()=>{});
        }
        throw new Error('模型设置保存失败，请检查浏览器存储并重新填写密钥');
      } finally {settingsMutation=false;}
    })
    .register('ASSISTANT_KEY_CLEAR',async () => {
      if(settingsMutation) throw new Error('模型设置正在更新，请稍后重试');
      settingsMutation=true;
      try {
        for(const controller of controllers.values()) controller.abort();
        await clearKeys();
        const settings=await readSettings();await db.meta.put({key:SETTINGS_KEY,value:{...settings,configRevision:crypto.randomUUID(),testedRevision:''},updatedAt:Date.now()});
        keyAccessBlocked=false;
      } catch {
        keyAccessBlocked=true;
        throw new Error('无法完整清除密钥，请检查浏览器存储后重试');
      } finally {settingsMutation=false;}
    })
    .register('ASSISTANT_SESSIONS',async () => (await db.meta.where('key').startsWith(SESSION_PREFIX).toArray())
      .map(row=>row.value as AssistantSession).sort((a,b)=>b.updatedAt-a.updatedAt).map(s=>({id:s.id,mode:s.mode,scope:s.scope,updatedAt:s.updatedAt,title:s.messages.find(m=>m.role==='user')?.text.slice(0,80)||'新任务'})))
    .register('ASSISTANT_CREATE',async req => sessionView(await service.createSession(req.input)))
    .register('ASSISTANT_GET',async req => {await settlements.get(req.sessionId);const s=await repository.getSession(req.sessionId);if(!s) throw new Error('对话不存在');return sessionView(s);})
    .register('ASSISTANT_TURN',async (req,context) => {
      if(settingsMutation) throw new Error('模型设置正在更新，请稍后发送');
      if(controllers.has(req.sessionId)) throw new Error('该对话正在生成，请等待或停止');
      // Reserve before any async preflight so cancellation and settings changes
      // see the request throughout its lifetime, not only after key/permission reads.
      const controller=new AbortController();controllers.set(req.sessionId,controller);
      let settle!:()=>void;settlements.set(req.sessionId,new Promise<void>(resolve=>{settle=resolve;}));
      const cancel = () => controller.abort();
      context?.signal?.addEventListener('abort', cancel, {once:true});
      if(context?.signal?.aborted) controller.abort();
      try {
        const settings=await readSettings();
        if(req.automatic)assertAutomatic(settings);
        if(typeof req.text!=='string'||!req.text.trim()||req.text.length>8000)throw new Error('请输入 1–8000 字的消息');
        assertSafePromptUrls(req.text);
        const currentSession=await repository.getSession(req.sessionId);
        if(req.automatic && currentSession?.providerHistory?.length)throw new Error('自动建议必须使用新的对话');
        const privacyTime=(await db.meta.get('assistant:privacyUpdatedAt'))?.value as number|undefined;
        if(currentSession && ((privacyTime&&currentSession.createdAt<=privacyTime)||currentSession.citations.some(c=>!safeForAssistant(c.url))))throw new Error('隐私排除范围已变化，请开始新任务，避免重新发送旧对话中的资料。');
        if(currentSession?.providerHistory?.length && !historySafeForAssistant(currentSession.providerHistory,await outboundRepository.listBookmarks(),await outboundRepository.listFolders()))throw new Error('部分历史资料已被排除、移动或修改。请开始新任务，避免重新发送旧资料。');
        if(!settings.consent) throw new Error('请先在设置中确认向 MiniMax 发送候选书签及内容片段');
        const apiKey=await readKey(settings);
        if(!apiKey) throw new Error('请在设置中填写 MiniMax API Key');
        const endpoint=settings.region === 'cn'?'https://api.minimax.cn/v1/chat/completions':'https://api.minimax.io/v1/chat/completions';
        if(!await canFetch(endpoint)) throw new Error('尚未授予所选 MiniMax 服务的访问权限，请在设置中授权');
        if(controller.signal.aborted) throw new Error('请求已停止');
        if(!req.automatic && settings.contentEnhancement && currentSession) {
          const [all,folders]=await Promise.all([outboundRepository.listBookmarks(),outboundRepository.listFolders()]);
          const scope=currentSession.scope;const terms=retrievalTerms(req.text);
          const candidates=scopedBookmarks(all,folders,scope.folderId)
            .filter(b=>(!scope.bookmarkIds||scope.bookmarkIds.includes(b.id))&&(!scope.query||`${b.title} ${b.url} ${b.path}`.toLocaleLowerCase().includes(scope.query.toLocaleLowerCase())))
            .map(b=>({b,score:terms.filter(t=>`${b.title} ${b.path}`.toLocaleLowerCase().includes(t)).length}))
            .filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,3);
          await Promise.all(candidates.map(async({b})=>{
            if(controller.signal.aborted||!b.url||!await canFetch(b.url))return;
            const cached=(await db.meta.get(CONTENT_PREFIX+b.id))?.value as {originalUrl?:string;fetchedAt?:number}|undefined;
            if(cached?.originalUrl===b.url&&Date.now()-(cached.fetchedAt??0)<7*86400000)return;
            const content=await fetchBookmarkContent({url:b.url,canFetch,signal:controller.signal});
            if(!controller.signal.aborted&&(await db.bookmarks.get(b.id))?.url===b.url)await db.meta.put({key:CONTENT_PREFIX+b.id,value:content,updatedAt:Date.now()});
          }));
        }
        if(controller.signal.aborted)throw new Error('请求已取消');
        return sessionView(await (req.automatic?automaticService():service).turn({sessionId:req.sessionId,text:req.text,settings,apiKey,signal:controller.signal,onText:context?.onText,requestId:req.requestId,expectedRevision:req.expectedRevision}));
      } finally {context?.signal?.removeEventListener('abort',cancel);if(controllers.get(req.sessionId)===controller) {controllers.delete(req.sessionId);settlements.delete(req.sessionId);}settle();}
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
      if(req.input.steps.some(s=>!['create','update','rename','move','delete'].includes(s.action))) throw new Error('不支持的整理操作');
      const input=req.input.steps.some(s=>s.action==='delete')?expandFolderDeletes(req.input,await db.bookmarks.toArray(),await db.folders.toArray()):req.input;
      return planService.draftOrganization(input);
    })
    .register('PLAN_RECOVERY_PREPARE',async req=>planService.draftRecovery(req.planId))
    .register('CAPTURE_LOOKUP',async req=>lookupCapture(req.url))
    .register('CAPTURE_STORE',async req=>{
      if(!req.input||typeof req.input.title!=='string'||req.input.title.length>1000||typeof req.input.url!=='string'||req.input.url.length>10000||!/^https?:$/i.test(new URL(req.input.url).protocol))throw new Error('当前页面不是可收藏的网页');
      const {title,url,parentFolderId}=req.input;
      if(parentFolderId!==undefined && (!validCaptureFolderId(parentFolderId)||!await captureFolderExists(parentFolderId)))throw new Error('原先选择的目录已不可用，请重新选择保存位置。');
      const captureId=crypto.randomUUID();await (await storageArea('session')).set({['capture:'+captureId]:{title,url,...(parentFolderId!==undefined?{parentFolderId}:{}),createdAt:Date.now()}});return {captureId};
    })
    .register('CAPTURE_GET',async req=>{
      if(typeof req.captureId!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(req.captureId))throw new Error('页面引用无效');
      const key='capture:'+req.captureId;const value=(await (await storageArea('session')).get(key))[key];
      if(!value||Date.now()-value.createdAt>3600000)return undefined;
      const draft={title:value.title,url:value.url};
      if(value.parentFolderId===undefined)return draft;
      try {if(validCaptureFolderId(value.parentFolderId)&&await captureFolderExists(value.parentFolderId))return {...draft,parentFolderId:value.parentFolderId};}
      catch { /* Recover the text draft even when native destinations cannot be checked. */ }
      return {...draft,destinationUnavailable:true};
    })
    .register('ASSISTANT_ADVISE_BOOKMARK',async req=>{
      if(settingsMutation)throw new Error('模型设置正在更新，请稍后重试');
      const key='advice:'+req.requestId;if(controllers.has(key))throw new Error('该建议正在生成');const controller=new AbortController();controllers.set(key,controller);
      try {const settings=await readSettings();if(req.automatic)assertAutomatic(settings);if(!settings.consent)throw new Error('请先确认向 MiniMax 发送页面标题和地址');
      if(!req.input||typeof req.input.url!=='string'||!safeForAssistant(req.input.url))throw new Error('此地址不适合发送给模型，请直接手动保存');
      if(req.automatic && (await lookupCapture(req.input.url)).bookmarks.length)throw new Error('此页面已收藏，请查看或编辑已有书签');
      if(controller.signal.aborted)throw new Error('请求已取消');
      const apiKey=await readKey(settings);if(!apiKey)throw new Error('请先配置 MiniMax 密钥');
      const endpoint=settings.region==='cn'?'https://api.minimax.cn/v1/chat/completions':'https://api.minimax.io/v1/chat/completions';
      if(!await canFetch(endpoint))throw new Error('请在 AI 设置中授予所选服务的访问权限');
      if(controller.signal.aborted)throw new Error('请求已取消');
      return await service.adviseBookmark({...req.input,settings,apiKey,signal:controller.signal});
      }finally{controllers.delete(key);}
    })
    .register('ASSISTANT_ADVICE_CANCEL',async req=>{controllers.get('advice:'+req.adviceRequestId)?.abort();})
    .register('CONTENT_STATUS',async req=>{
      if(!Array.isArray(req.bookmarkIds)||req.bookmarkIds.length>200)throw new Error('每次最多查询 200 项');
      const results=[];for(const id of req.bookmarkIds){const [row,cached]=await Promise.all([db.bookmarks.get(id),db.meta.get(CONTENT_PREFIX+id)]);const value=cached?.value as {originalUrl?:string;status?:string;reason?:string}|undefined;results.push({bookmarkId:id,status:!value?'unchecked':value.originalUrl!==row?.url?'outdated':value.status??'unavailable',reason:value?.reason});}return {results};
    })
    .register('CONTENT_CLEAR',async req=>{if(!Array.isArray(req.bookmarkIds)||req.bookmarkIds.length>200)throw new Error('每次最多清除 200 项');await db.meta.bulkDelete(req.bookmarkIds.map(id=>CONTENT_PREFIX+id));})
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
