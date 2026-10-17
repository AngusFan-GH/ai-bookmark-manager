import type { AssistantMessage } from '../assistant/types';
import type { BookmarkRecord, FolderRecord } from '../bookmarks/types';

export interface TopicView { id: string; title: string; bookmarkIds: string[]; reason: string; sourceMessageId: string }
const normalized = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
/** Local virtual views derived only from validated, snapshot-backed suggestions.
 * Older conversations without evidence are deliberately not upgraded into trusted topics.
 * IDs include source evidence so dismissal survives reload but never hides revised advice.
 */
export function buildTopicViews(messages: AssistantMessage[], bookmarks: BookmarkRecord[], folders: FolderRecord[]): TopicView[] {
  const records = new Map(bookmarks.filter(b => b.kind === 'bookmark' && b.url).map(b => [b.id, b]));
  const folderMap = new Map(folders.map(f => [f.id, f]));
  const result: TopicView[] = [];
  for (const message of messages.filter(m => m.role === 'assistant').slice(-12).reverse()) {
    const groups = new Map<string, TopicView>();
    for (const move of message.moves ?? []) {
      const record = records.get(move.bookmarkId);
      const evidence = message.suggestionEvidence?.find(item => item.bookmarkId === move.bookmarkId);
      if (!record || !evidence || record.url !== evidence.url || record.title !== evidence.title || record.path !== evidence.path || record.parentId !== evidence.parentId) continue;
      const proposal = message.folders?.find(f => f.proposalId === move.targetFolderId);
      const target = folderMap.get(move.targetFolderId);
      if (proposal ? !folderMap.has(proposal.parentFolderId) : !target) continue;
      const title = proposal?.title ?? target!.title;
      if (!title.trim()) continue;
      const key = normalized(title);
      let group = groups.get(key);
      if (!group) {
        group = { id: `topic:${message.id}:${move.targetFolderId}`, title, bookmarkIds: [], reason: move.reason, sourceMessageId: message.id };
        groups.set(key, group);
      }
      if (!group.bookmarkIds.includes(record.id)) group.bookmarkIds.push(record.id);
    }
    for (const view of groups.values()) {
      if (view.bookmarkIds.length < 2) continue;
      // Synonyms are merged only with strong membership evidence, never speculative model aliases.
      const equivalent = result.find(existing => normalized(existing.title) === normalized(view.title)
        || view.bookmarkIds.filter(id => existing.bookmarkIds.includes(id)).length / new Set([...view.bookmarkIds, ...existing.bookmarkIds]).size >= 0.8);
      if (equivalent) {
        equivalent.bookmarkIds = [...new Set([...equivalent.bookmarkIds, ...view.bookmarkIds])].slice(0, 60);
      } else if (result.length < 10) result.push(view);
    }
  }
  return result;
}

export interface RelatedBookmarkGroup { id: string; bookmarkIds: string[]; reason: string }
/** Conservative metadata-only candidates. Exact duplicates remain a separate workflow.
 * No URL normalization for deletion, no destructive action, no claim of equivalent content.
 */
export function relatedBookmarkGroups(bookmarks: BookmarkRecord[]): RelatedBookmarkGroup[] {
  const groups = new Map<string, BookmarkRecord[]>();
  for (const bookmark of bookmarks.slice(0, 10000)) {
    if (bookmark.kind !== 'bookmark' || !bookmark.url) continue;
    try {
      const url = new URL(bookmark.url);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      const title = normalized(bookmark.title);
      if (title.length < 6) continue;
      const key = `${url.hostname}:${title}`;
      const group = groups.get(key) ?? [];
      if (group.length < 20) group.push(bookmark);
      groups.set(key, group);
    } catch { /* Invalid addresses are not evidence of similarity. */ }
  }
  return [...groups.entries()].filter(([, rows]) => rows.length > 1 && new Set(rows.map(row => row.url)).size > 1)
    .slice(0, 20).map(([key, rows]) => ({id: `related:${key}`, bookmarkIds:rows.map(row => row.id), reason:'同一网站且标题相同，地址不同。仅为元数据相似候选，请打开原始页面比较；不会自动删除。'}));
}
