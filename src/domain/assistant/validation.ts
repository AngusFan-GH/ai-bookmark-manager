import type { AssistantBookmark, AssistantMode, ProposedMove, ProposedFolder } from './types';
import { AssistantError } from './types';

/** Plain text only. URLs come solely from citation snapshots, never generated prose. */
export function sanitizeModelText(value: string): string {
  return value.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(?:[a-z][a-z\d+.-]*:\/\/|(?:javascript|data|mailto):|www\.)[^\s<>]*/gi, '[link omitted]')
    .replace(/\b(?:[a-z\d-]+\.)+(?:com|org|net|io|cn|dev|ai|edu|gov|co)(?:\/[^\s<>]*)?/gi, '[link omitted]')
    .replace(/<[^>]*>/g, '').trim();
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function keys(value: Record<string, unknown>, expected: string[]): boolean { return Object.keys(value).every(k => expected.includes(k)) && expected.every(k => k in value); }
function fail(): never { throw new AssistantError('validation', 'The model response was invalid. No suggestions were saved or applied.'); }
export function parseSuggestion(content: string, mode: AssistantMode, bookmarkIds: Set<string>, folderIds: Set<string>): { text: string; references: { bookmarkId: string; reason: string }[]; moves: ProposedMove[]; folders: ProposedFolder[] } {
  if (content.length > 100_000) fail();
  let parsed: unknown;
  try { parsed = JSON.parse(content.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '').trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1')); } catch { fail(); }
  if (!object(parsed) || !keys(parsed, 'folders' in parsed ? ['text', 'references', 'moves', 'folders'] : ['text', 'references', 'moves']) || typeof parsed.text !== 'string' || parsed.text.length > 12000 || !Array.isArray(parsed.references) || !Array.isArray(parsed.moves) || parsed.references.length > 30 || parsed.moves.length > 60) fail();
  const references: { bookmarkId: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const ref of parsed.references) {
    if (!object(ref) || !keys(ref, ['bookmarkId', 'reason']) || typeof ref.bookmarkId !== 'string' || !bookmarkIds.has(ref.bookmarkId) || seen.has(ref.bookmarkId) || typeof ref.reason !== 'string' || ref.reason.length > 2000) fail();
    seen.add(ref.bookmarkId); references.push({ bookmarkId: ref.bookmarkId, reason: sanitizeModelText(ref.reason) });
  }
  const proposed = parsed.folders === undefined ? [] : parsed.folders;
  if (!Array.isArray(proposed) || proposed.length > 10 || (mode !== 'organize' && proposed.length)) fail();
  const folders: ProposedFolder[] = [];
  const proposalIds = new Set<string>();
  const folderNames = new Set<string>();
  for (const f of proposed) {
    if (!object(f) || !keys(f, ['proposalId', 'title', 'parentFolderId']) || typeof f.proposalId !== 'string' || !/^new:[a-zA-Z0-9_-]{1,64}$/.test(f.proposalId) || proposalIds.has(f.proposalId) || folderIds.has(f.proposalId) || typeof f.title !== 'string' || !f.title.trim() || f.title.length > 80 || /[\/\\\p{Cc}\p{Cf}]/u.test(f.title) || typeof f.parentFolderId !== 'string' || !folderIds.has(f.parentFolderId)) fail();
    const title = f.title.trim();
    const nameKey = JSON.stringify([f.parentFolderId, title.normalize('NFKC').toLocaleLowerCase()]);
    if (folderNames.has(nameKey)) fail();
    proposalIds.add(f.proposalId); folderNames.add(nameKey);
    folders.push({ proposalId: f.proposalId, title, parentFolderId: f.parentFolderId });
  }
  const moves: ProposedMove[] = []; seen.clear();
  for (const move of parsed.moves) {
    if (mode !== 'organize' || !object(move) || !keys(move, ['bookmarkId', 'targetFolderId', 'reason']) || typeof move.bookmarkId !== 'string' || !bookmarkIds.has(move.bookmarkId) || seen.has(move.bookmarkId) || typeof move.targetFolderId !== 'string' || (!folderIds.has(move.targetFolderId) && !proposalIds.has(move.targetFolderId)) || typeof move.reason !== 'string' || !move.reason.trim() || move.reason.length > 2000) fail();
    seen.add(move.bookmarkId); moves.push({ bookmarkId: move.bookmarkId, targetFolderId: move.targetFolderId, reason: sanitizeModelText(move.reason) });
  }
  const text = sanitizeModelText(parsed.text);
  if (!text && !references.length && !moves.length && !folders.length) fail();
  return { text, references, moves, folders };
}
/** Exact original URL equality only: no lowercasing, normalization, or tracking-parameter stripping. */
export function groupExactDuplicates(bookmarks: AssistantBookmark[]): { url: string; bookmarkIds: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const b of bookmarks) if (b.kind === 'bookmark' && b.url) groups.set(b.url, [...(groups.get(b.url) ?? []), b.id]);
  return [...groups.entries()].filter(([, ids]) => ids.length > 1).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([url, ids]) => ({ url, bookmarkIds: ids.sort() }));
}
