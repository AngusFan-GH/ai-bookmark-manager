// src/domain/bookmarks/normalize.ts
//
// Conservative URL normalization for the purpose of comparison and
// duplicate detection (dev guide § 3.5 DED-002).
//
// IMPORTANT: This is NOT a full URL canonicalizer. We follow the guide's
// guidance "URL 规范化不能一律删除查询参数：签名、资源 ID、分页和语言
// 参数可能改变语义" — we only remove a tight, documented allowlist of
// tracking-style parameters.

import type { RawBookmarkNode } from './types';

/**
 * Tracking-style query parameters that are safe to strip when comparing
 * two URLs for "is this the same resource?" purposes. This list is
 * deliberately small; any new entries must be reviewed against the
 * "might change semantics" rule from the dev guide.
 */
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'mc_cid', 'mc_eid', 'igshid', 'yclid', '_hsenc',
  '_hsmi', 'ref', 'ref_src', 'ref_url', 'source',
]);

/**
 * Lowercase the host of a URL. We do not touch path or query case because
 * some servers are case-sensitive in path segments (e.g. GitHub
 * usernames, file paths on case-sensitive volumes).
 */
export function normalizeHost(url: string): string {
  try {
    const u = new URL(url);
    return u.host.toLowerCase();
  } catch {
    return url;
  }
}

/**
 * Return a URL string suitable for equality comparison only.
 * - lowercases the scheme and host
 * - drops the default port
 * - removes a small allowlist of tracking query params
 * - keeps path, fragment, and other query params untouched
 *
 * Throws if the input is not a valid absolute URL. Caller should treat
 * non-http(s) URLs as a separate case.
 */
export function normalizeUrlForCompare(raw: string): string {
  const u = new URL(raw);
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'http:' && u.port === '80') ||
      (u.protocol === 'https:' && u.port === '443')) {
    u.port = '';
  }
  // Drop tracking params only.
  const params = u.searchParams;
  for (const key of Array.from(params.keys())) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) params.delete(key);
  }
  u.search = params.toString();
  return u.toString();
}

/**
 * True when the URL is safe to fetch (http/https). Other schemes
 * (file://, javascript:, data:, chrome://, etc.) are not safe to scan.
 * Dev guide § 3.4 step 1.
 */
export function isScannableUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Build a display path for a node given the chain of ancestor titles.
 * Roots contribute an empty ancestor chain so they have an empty path.
 */
export function buildPath(ancestors: string[], fallback = ''): string {
  return ancestors.filter(Boolean).join(' / ') || fallback;
}

// ---- Tree flattening ------------------------------------------------------

export interface FlattenResult {
  bookmarks: import('./types').BookmarkRecord[];
  folders: import('./types').FolderRecord[];
  totalCount: number;
  now: number;
}

/**
 * Flatten a chrome.bookmarks tree into BookmarkRecord / FolderRecord
 * lists. Pure function: no I/O, no globals, safe to unit test with
 * arbitrary nested objects.
 */
export function flattenTree(
  roots: readonly RawBookmarkNode[],
  options: { now: number; generation: number },
): FlattenResult {
  const bookmarks: import('./types').BookmarkRecord[] = [];
  const folders: import('./types').FolderRecord[] = [];
  const { now, generation } = options;

  const visit = (node: RawBookmarkNode, ancestors: string[]): void => {
    const hasChildren = Array.isArray(node.children) && node.children.length > 0;
    const hasUrl = typeof node.url === 'string' && node.url.length > 0;
    const kind: import('./types').BookmarkKind = hasChildren
      ? 'folder'
      : hasUrl
        ? 'bookmark'
        : 'separator';
    const title = node.title ?? '';
    const browserId = String(node.id);
    const parentId = node.parentId != null ? String(node.parentId) : null;
    const index = typeof node.index === 'number' ? node.index : 0;

    if (kind === 'folder') {
      folders.push({
        id: browserId,
        browserId,
        parentId,
        title,
        dateAdded: node.dateAdded,
        dateGroupModified: node.dateGroupModified,
        index,
        updatedAt: now,
        syncGeneration: generation,
        path: '', // filled in the post-pass below
      });
    } else if (kind === 'bookmark' && hasUrl) {
      bookmarks.push({
        id: browserId,
        browserId,
        kind,
        parentId,
        index,
        title,
        url: node.url,
        dateAdded: node.dateAdded,
        dateGroupModified: node.dateGroupModified,
        updatedAt: now,
        syncGeneration: generation,
        path: buildPath(ancestors),
      });
    }

    if (hasChildren) {
      const next = title ? [...ancestors, title] : ancestors;
      for (const child of node.children!) visit(child, next);
    }
  };

  for (const root of roots) visit(root, []);

  // Compute bookmark paths by walking the folder map. (Folder rows are
  // emitted in DFS pre-order so each folder's ancestors are already
  // visible in the array.)
  const folderById = new Map(folders.map((f) => [f.id, f] as const));
  for (const f of folders) f.path = computePathFor(f.id, folderById);

  return { bookmarks, folders, totalCount: bookmarks.length + folders.length, now };
}

function computePathFor(id: string, byId: Map<string, import('./types').FolderRecord>): string {
  const parts: string[] = [];
  let cur: import('./types').FolderRecord | undefined = byId.get(id);
  // Guard against pathological cycles (defensive; chrome.bookmarks does
  // not produce them but a malicious JSON import might).
  const seen = new Set<string>();
  while (cur) {
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    parts.unshift(cur.title);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return parts.filter(Boolean).join(' / ');
}

// ---- Search ---------------------------------------------------------------

/**
 * Case-insensitive substring search over title, url, and path. Used by
 * the UI list (Dev guide § 3.2 — "大小写不敏感，中文可用基础子串匹配").
 * Deliberately simple; future phases can add an inverted index.
 */
export function matchesSearch(
  row: { title: string; url?: string; path?: string },
  raw: string,
): boolean {
  const q = raw.trim().toLocaleLowerCase();
  if (!q) return true;
  return [row.title, row.url ?? '', row.path ?? '']
    .some((v) => v.toLocaleLowerCase().includes(q));
}
