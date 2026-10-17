import { streamAssistantTurn, type StreamTurnOptions } from './assistant-stream-client';
import type { TopicView } from './domain/organization/topics';
import { request } from './client';
import type { AssistantSession, AssistantMode, AssistantScope } from './domain/assistant/types';
import type { BookmarkRecord } from './domain/bookmarks/types';
import type { OperationPlan } from './domain/operations/types';
import type { PlanSummary } from './infrastructure/messaging/contracts';

export type AssistantSessionView = Omit<AssistantSession, 'providerHistory'>;
export interface SessionSummary { id: string; mode: AssistantMode; updatedAt: number; title: string; scope: AssistantScope }
export type KeyStorage = 'session' | 'local';
export interface AssistantSettingsView { keyStorage: KeyStorage; region: 'cn' | 'global'; model: string; hasKey: boolean; consent: boolean; autoSuggestions?:boolean; onboardingCompleted?:boolean; connectionTested?:boolean; excludedFolderIds?:string[]; contentEnhancement?:boolean; maxCompletionTokens?:number }
export interface SettingsInput { keyStorage?: KeyStorage; region: 'cn' | 'global'; model: string; apiKey?: string; consent: boolean; autoSuggestions?:boolean; onboardingCompleted?:boolean; excludedFolderIds?:string[]; contentEnhancement?:boolean; maxCompletionTokens?:number }
export interface OrganizationInput { evidence?: import('./domain/operations/plan-service').OrganizationEvidence; title: string; steps: Array<{action: 'create' | 'update' | 'rename' | 'move' | 'delete'; targetBrowserId?: string; parentBrowserId?: string; parentStepIndex?: number; desiredAfter?: {title?:string;url?:string;index?:number}; reason?: string}> }
export interface DuplicateResult { groups: Array<{url: string; bookmarks: BookmarkRecord[]}> }
export interface ContentResult { results: Array<{bookmarkId: string; status: string; reason?: string}> }
export type WorkspaceRequest = { requestId: string } & (
  | {type:'ASSISTANT_SETTINGS_GET'} | {type:'ASSISTANT_SETTINGS_SAVE';settings:SettingsInput}
  | {type:'ASSISTANT_TEST_CONNECTION'} | {type:'ASSISTANT_ONBOARDING_COMPLETE'} | {type:'ASSISTANT_ADVICE_CANCEL';adviceRequestId:string}
  | {type:'ORGANIZATION_TOPICS'}
  | {type:'ASSISTANT_KEY_CLEAR'} | {type:'ASSISTANT_SESSIONS'}
  | {type:'ASSISTANT_CREATE';input:{mode:AssistantMode;scope?:AssistantScope}}
  | {type:'ASSISTANT_GET';sessionId:string} | {type:'ASSISTANT_TURN';sessionId:string;text:string;automatic?:boolean;expectedRevision?:number}
  | {type:'ASSISTANT_CANCEL';sessionId:string} | {type:'ORGANIZATION_DUPLICATES';folderId?:string}
  | {type:'ORGANIZATION_PREPARE';input:OrganizationInput} | {type:'PLAN_BACKUP_EXPORT';planId:string}
  | {type:'CONTENT_FETCH';bookmarkIds:string[]}
  | {type:'CONTENT_CLEAR';bookmarkIds:string[]}
  | {type:'CONTENT_STATUS';bookmarkIds:string[]}
  | {type:'PLAN_RECOVERY_PREPARE';planId:string}
  | {type:'ASSISTANT_ADVISE_BOOKMARK';automatic?:boolean;input:{title:string;url:string;parentFolderId?:string}}
  | {type:'CAPTURE_LOOKUP';url:string}
  | {type:'CAPTURE_STORE';input:CaptureDraft}
  | {type:'CAPTURE_GET';captureId:string} );
const id = () => crypto.randomUUID();
export const getAssistantSettings = () => request<AssistantSettingsView>({type:'ASSISTANT_SETTINGS_GET',requestId:id()});
export const saveAssistantSettings = (settings:SettingsInput) => request<void>({type:'ASSISTANT_SETTINGS_SAVE',settings,requestId:id()});
export const testAssistantConnection = () => request<AssistantSettingsView>({type:'ASSISTANT_TEST_CONNECTION',requestId:id()});
export const completeOnboarding = () => request<void>({type:'ASSISTANT_ONBOARDING_COMPLETE',requestId:id()});
export const cancelAdvice = (adviceRequestId:string) => request<void>({type:'ASSISTANT_ADVICE_CANCEL',adviceRequestId,requestId:id()});
export const clearAssistantKey = () => request<void>({type:'ASSISTANT_KEY_CLEAR',requestId:id()});
export const listSessions = () => request<SessionSummary[]>({type:'ASSISTANT_SESSIONS',requestId:id()});
export const createSession = (input:{mode:AssistantMode;scope?:AssistantScope}) => request<AssistantSessionView>({type:'ASSISTANT_CREATE',input,requestId:id()});
export const getSession = (sessionId:string) => request<AssistantSessionView>({type:'ASSISTANT_GET',sessionId,requestId:id()});
export const sendTurn = (sessionId:string,text:string,options:StreamTurnOptions={}) => options.onText || options.signal
  ? streamAssistantTurn(sessionId,text,id(),options)
  : request<AssistantSessionView>({type:'ASSISTANT_TURN',sessionId,text,automatic:options.automatic,expectedRevision:options.expectedRevision,requestId:id()});
export const cancelTurn = (sessionId:string) => request<void>({type:'ASSISTANT_CANCEL',sessionId,requestId:id()});
export const analyzeDuplicates = (folderId?:string) => request<DuplicateResult>({type:'ORGANIZATION_DUPLICATES',folderId,requestId:id()});
export const prepareOrganization = (input:OrganizationInput) => request<OperationPlan>({type:'ORGANIZATION_PREPARE',input,requestId:id()});
export const exportPlanBackup = (planId:string) => request<unknown>({type:'PLAN_BACKUP_EXPORT',planId,requestId:id()});
export const listHistory = () => request<PlanSummary[]>({type:'PLAN_LIST',requestId:id()});
export const fetchContent = (bookmarkIds:string[]) => request<ContentResult>({type:'CONTENT_FETCH',bookmarkIds,requestId:id()});

export interface CaptureDraft { title:string; url:string; parentFolderId?:string }
export interface CaptureDraftView extends CaptureDraft { destinationUnavailable?:boolean }
export interface BookmarkAdvice {title:string;targetFolderId:string;reason:string}
export const adviseBookmark = (input:{title:string;url:string;parentFolderId?:string},options:{automatic?:boolean;requestId?:string}={}) => request<BookmarkAdvice>({type:'ASSISTANT_ADVISE_BOOKMARK',input,...options,requestId:options.requestId??id()});
export const prepareRecovery = (planId:string) => request<OperationPlan>({type:'PLAN_RECOVERY_PREPARE',planId,requestId:id()});
export const findExistingBookmarks = (url:string) => request<{bookmarks:BookmarkRecord[]}>({type:'CAPTURE_LOOKUP',url,requestId:id()});
export const storeCapture = (input:CaptureDraft) => request<{captureId:string}>({type:'CAPTURE_STORE',input,requestId:id()});
export const getCapture = (captureId:string) => request<CaptureDraftView|undefined>({type:'CAPTURE_GET',captureId,requestId:id()});
export const clearContent = (bookmarkIds:string[]) => request<void>({type:'CONTENT_CLEAR',bookmarkIds,requestId:id()});
export const getContentStatus = (bookmarkIds:string[]) => request<ContentResult>({type:'CONTENT_STATUS',bookmarkIds,requestId:id()});

export const listTopicViews = () => request<Array<TopicView & {bookmarks: BookmarkRecord[]}>>({type:'ORGANIZATION_TOPICS',requestId:id()});
