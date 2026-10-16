import type { BookmarkRecord, FolderRecord } from '../bookmarks/types';

export type AssistantMode = 'recommend' | 'organize' | 'assist';
export interface AssistantScope { folderId?: string; query?: string; bookmarkIds?: string[] }
export interface AssistantSettings { region: 'global' | 'cn'; model?: string; maxCompletionTokens?: number }
export interface Citation { citationId: string; bookmarkId: string; title: string; url: string; path: string }
export interface AssistantReference extends Citation { reason: string }
export interface ProposedFolder { proposalId: string; title: string; parentFolderId: string }
export interface ProposedEdit { bookmarkId: string; title: string; reason: string }
export interface ProposedDeletion { bookmarkId: string; reason: string }
export interface BookmarkAdvice { title: string; targetFolderId: string; reason: string }
export interface BookmarkAdviceRequest { title: string; url: string; parentFolderId?: string; settings: AssistantSettings; apiKey: string; signal?: AbortSignal }
export interface ProposedMove { bookmarkId: string; targetFolderId: string; reason: string }
export interface AssistantDisclosure { totalInScope: number; transmitted: number; omitted: number; metadataOnly: boolean; snippetLimit: number; transmittedFolders?: number; totalFoldersInScope?: number; queryExpansionUsed?: boolean }
export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  references?: AssistantReference[];
  moves?: ProposedMove[];
  folders?: ProposedFolder[];
  edits?: ProposedEdit[];
  deletions?: ProposedDeletion[];
  disclosure?: AssistantDisclosure;
}
/** Internal model messages, including reasoning, must never be rendered by the UI. */
export interface ProviderMessage { role: 'system' | 'user' | 'assistant'; content: string; [key: string]: unknown }
export interface AssistantSession {
  id: string; mode: AssistantMode; revision: number; scope: AssistantScope;
  messages: AssistantMessage[]; citations: Citation[]; providerHistory: ProviderMessage[];
  createdAt: number; updatedAt: number;
}
export type AssistantBookmark = BookmarkRecord & { contentSnippet?: string };
export interface AssistantRepository {
  /** Return the whole indexed corpus, not the current UI page. */
  listBookmarks(): Promise<AssistantBookmark[]>;
  listFolders(): Promise<FolderRecord[]>;
  getSession(id: string): Promise<AssistantSession | undefined>;
  /** Atomic compare-and-set. null means insert only; false means revision conflict. */
  saveSession(session: AssistantSession, expectedRevision: number | null): Promise<boolean>;
}
export interface ProviderRequest { messages: ProviderMessage[]; settings: AssistantSettings; apiKey: string; signal?: AbortSignal }
export interface ProviderResult { message: ProviderMessage; finishReason: string }
export interface AssistantProvider { complete(request: ProviderRequest): Promise<ProviderResult> }
export class AssistantError extends Error {
  constructor(public code: 'validation' | 'provider' | 'canceled' | 'timeout' | 'busy' | 'conflict' | 'not-found' | 'limit', message: string) { super(message); this.name = 'AssistantError'; }
}
