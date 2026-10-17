import type { AssistantBookmark, AssistantMode, ProposedMove, ProposedFolder, ProposedEdit, ProposedDeletion, BookmarkAdvice } from './types';
import { AssistantError } from './types';

/** Plain text only. URLs come solely from citation snapshots, never generated prose. */
export function sanitizeModelText(value: string): string {
  // Depth-aware suppression prevents nested or unterminated thought blocks
  // from exposing their tail after an inner closing tag.
  let plain = ''; let depth = 0; let cursor = 0;
  for (const tag of value.matchAll(/<\/?think\b[^>]*>/gi)) {
    const index = tag.index!;
    if (depth === 0) plain += value.slice(cursor, index);
    if (/^<\//.test(tag[0])) depth = Math.max(0, depth - 1); else depth++;
    cursor = index + tag[0].length;
  }
  if (depth === 0) plain += value.slice(cursor);
  return plain.replace(/<think\b[\s\S]*$/gi, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(?:[a-z][a-z\d+.-]*:\/\/|(?:javascript|data|mailto):|www\.)[^\s<>]*/gi, '[link omitted]')
    .replace(/\b(?:[a-z\d-]+\.)+(?:com|org|net|io|cn|dev|ai|edu|gov|co)(?:\/[^\s<>]*)?/gi, '[link omitted]')
    .replace(/<[^>]*>/g, '').trim();
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function keys(value: Record<string, unknown>, expected: string[]): boolean { return Object.keys(value).every(k => expected.includes(k)) && expected.every(k => k in value); }
function fail(message = '模型建议未通过安全校验（字段、书签或文件夹 ID 不符合要求）。请缩小范围后重试；未保存或执行任何建议。'): never { throw new AssistantError('validation', message); }
/** Null means an outer reasoning wrapper is incomplete. Nested wrappers must
 * close at depth zero before any following JSON may be treated as an answer. */
export function stripLeadingThinking(content: string): string | null {
  let text = content.trimStart();
  while (/^<think\b/i.test(text)) {
    let depth = 0; let end = -1;
    for (const tag of text.matchAll(/<\/?think\b[^>]*>/gi)) {
      depth += /^<\//.test(tag[0]) ? -1 : 1;
      if (depth === 0) {end = tag.index! + tag[0].length;break;}
    }
    if (end < 0) return null;
    text = text.slice(end).trimStart();
  }
  return text;
}
/** Unwrap only complete outer wrappers. Never extract arbitrary JSON from prose or repair partial actions. */
function unwrapResponse(content: string): string {
  const text = stripLeadingThinking(content.trim());
  if (text === null) fail('模型只返回了未完成的思考内容。请提高输出 token 上限或缩小范围后重试；未保存或执行任何建议。');
  const fence = text.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/i)
    ?? text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1].trim() : text;
}
export function parseSuggestion(content: string, mode: AssistantMode, bookmarkIds: Set<string>, folderIds: Set<string>): { text: string; references: { bookmarkId: string; reason: string }[]; moves: ProposedMove[]; folders: ProposedFolder[]; edits: ProposedEdit[]; deletions: ProposedDeletion[] } {
  if (!['assist', 'recommend', 'organize'].includes(mode)) fail();
  if (content.length > 100_000) fail();
  let parsed: unknown;
  const json = unwrapResponse(content);
  try { parsed = JSON.parse(json); } catch { fail('模型没有返回完整、有效的 JSON。请重试；若反复出现，请缩小书签范围或提高输出 token 上限。未保存或执行任何建议。'); }
  // Missing unused lists mean no proposals, never inferred IDs or actions. Explicit null/wrong types still fail.
  if (object(parsed)) {
    for (const field of ['references', 'moves', 'folders', 'edits', 'deletions']) if (!(field in parsed)) parsed[field] = [];
  }
  if (!object(parsed) || !keys(parsed, ['text', 'references', 'moves', 'folders', 'edits', 'deletions']) || typeof parsed.text !== 'string' || parsed.text.length > 12000 || !Array.isArray(parsed.references) || !Array.isArray(parsed.moves) || parsed.references.length > 30 || parsed.moves.length > 60) fail();
  const references: { bookmarkId: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const ref of parsed.references) {
    if (!object(ref) || !keys(ref, ['bookmarkId', 'reason']) || typeof ref.bookmarkId !== 'string' || !bookmarkIds.has(ref.bookmarkId) || seen.has(ref.bookmarkId) || typeof ref.reason !== 'string' || ref.reason.length > 2000) fail();
    seen.add(ref.bookmarkId); references.push({ bookmarkId: ref.bookmarkId, reason: sanitizeModelText(ref.reason) });
  }
  const proposed = parsed.folders === undefined ? [] : parsed.folders;
  if (!Array.isArray(proposed) || proposed.length > 10 || (mode === 'recommend' && proposed.length)) fail();
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
    if (mode === 'recommend' || !object(move) || !keys(move, ['bookmarkId', 'targetFolderId', 'reason']) || typeof move.bookmarkId !== 'string' || !bookmarkIds.has(move.bookmarkId) || seen.has(move.bookmarkId) || typeof move.targetFolderId !== 'string' || (!folderIds.has(move.targetFolderId) && !proposalIds.has(move.targetFolderId)) || typeof move.reason !== 'string' || !move.reason.trim() || move.reason.length > 2000) fail();
    seen.add(move.bookmarkId); moves.push({ bookmarkId: move.bookmarkId, targetFolderId: move.targetFolderId, reason: sanitizeModelText(move.reason) });
  }
  const edits: ProposedEdit[] = [];
  const deletions: ProposedDeletion[] = [];
  if (!Array.isArray(parsed.edits) || !Array.isArray(parsed.deletions) || parsed.edits.length > 60 || parsed.deletions.length > 60 || (mode === 'recommend' && (parsed.edits.length || parsed.deletions.length))) fail();
  // The same bookmark cannot be moved, renamed, or deleted twice in one response.
  for (const edit of parsed.edits) {
    if (!object(edit) || !keys(edit, ['bookmarkId', 'title', 'reason']) || typeof edit.bookmarkId !== 'string' || !bookmarkIds.has(edit.bookmarkId) || seen.has(edit.bookmarkId) || typeof edit.title !== 'string' || !edit.title.trim() || edit.title.length > 300 || /[\p{Cc}\p{Cf}]/u.test(edit.title) || typeof edit.reason !== 'string' || !edit.reason.trim() || edit.reason.length > 2000) fail();
    const title = sanitizeModelText(edit.title); const reason = sanitizeModelText(edit.reason);
    if (!title || !reason) fail();
    seen.add(edit.bookmarkId); edits.push({ bookmarkId: edit.bookmarkId, title, reason });
  }
  for (const deletion of parsed.deletions) {
    if (!object(deletion) || !keys(deletion, ['bookmarkId', 'reason']) || typeof deletion.bookmarkId !== 'string' || !bookmarkIds.has(deletion.bookmarkId) || seen.has(deletion.bookmarkId) || typeof deletion.reason !== 'string' || !deletion.reason.trim() || deletion.reason.length > 2000) fail();
    const reason = sanitizeModelText(deletion.reason);
    if (!reason) fail();
    seen.add(deletion.bookmarkId); deletions.push({ bookmarkId: deletion.bookmarkId, reason });
  }
  const text = sanitizeModelText(parsed.text);
  if (!text && !references.length && !moves.length && !folders.length && !edits.length && !deletions.length) fail();
  return { text, references, moves, folders, edits, deletions };
}
/** Search expansion is data for local ranking, never IDs, URLs, scope or executable suggestions. */
export function parseSearchTerms(content: string): string[] {
  if (content.length > 10_000) fail();
  let parsed: unknown;
  try { parsed = JSON.parse(unwrapResponse(content)); } catch { fail(); }
  if (!object(parsed) || !keys(parsed, ['searchTerms']) || !Array.isArray(parsed.searchTerms) || parsed.searchTerms.length > 8) fail();
  const terms: string[] = [];
  for (const value of parsed.searchTerms) {
    if (typeof value !== 'string' || value.trim().length < 2 || value.length > 64 || !/^[\p{L}\p{N}][\p{L}\p{N} +_-]*$/u.test(value) || sanitizeModelText(value) !== value.trim()) fail();
    const term = value.trim().toLocaleLowerCase();
    if (!terms.includes(term)) terms.push(term);
  }
  return terms;
}
/** A one-page suggestion has no URL field and cannot write or create folders. */
export function parseBookmarkAdvice(content: string, folderIds: Set<string>): BookmarkAdvice {
  if (content.length > 100_000) fail();
  let parsed: unknown;
  try { parsed = JSON.parse(unwrapResponse(content)); } catch (error) {
    if (error instanceof AssistantError) throw error;
    fail('模型没有返回完整、有效的保存建议，请重试。书签尚未保存。');
  }
  if (!object(parsed) || !keys(parsed, ['title', 'targetFolderId', 'reason']) || typeof parsed.title !== 'string' || !parsed.title.trim() || parsed.title.length > 300 || /[\p{Cc}\p{Cf}]/u.test(parsed.title) || typeof parsed.targetFolderId !== 'string' || !folderIds.has(parsed.targetFolderId) || typeof parsed.reason !== 'string' || !parsed.reason.trim() || parsed.reason.length > 2000) fail();
  const title = sanitizeModelText(parsed.title); const reason = sanitizeModelText(parsed.reason);
  if (!title || !reason) fail();
  return { title, targetFolderId: parsed.targetFolderId, reason };
}
/** Exact original URL equality only: no lowercasing, normalization, or tracking-parameter stripping. */
export function groupExactDuplicates(bookmarks: AssistantBookmark[]): { url: string; bookmarkIds: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const b of bookmarks) if (b.kind === 'bookmark' && b.url) groups.set(b.url, [...(groups.get(b.url) ?? []), b.id]);
  return [...groups.entries()].filter(([, ids]) => ids.length > 1).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([url, ids]) => ({ url, bookmarkIds: ids.sort() }));
}
