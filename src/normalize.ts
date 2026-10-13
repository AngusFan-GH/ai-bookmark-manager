import type { BookmarkRow } from './types';

export type BookmarkNode = chrome.bookmarks.BookmarkTreeNode;
export function flattenTree(roots: BookmarkNode[], now = Date.now()): BookmarkRow[] {
  const rows: BookmarkRow[] = [];
  const visit = (node: BookmarkNode, ancestors: string[]) => {
    const kind: BookmarkRow['kind'] = node.url ? 'bookmark' : 'folder';
    const path = ancestors.join(' / ');
    rows.push({
      id: node.id, parentId: node.parentId, title: node.title,
      url: node.url, dateAdded: node.dateAdded,
      dateGroupModified: node.dateGroupModified, index: node.index,
      kind, path, updatedAt: now,
    });
    const next = kind === 'folder' && node.title ? [...ancestors, node.title] : ancestors;
    for (const child of node.children ?? []) visit(child, next);
  };
  for (const root of roots) visit(root, []);
  return rows;
}
export function matchesSearch(row: BookmarkRow, raw: string): boolean {
  const q = raw.trim().toLocaleLowerCase();
  if (!q) return true;
  return [row.title, row.url ?? '', row.path].some(v => v.toLocaleLowerCase().includes(q));
}
