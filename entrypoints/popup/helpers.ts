import type { FolderRecord } from '../../src/domain/bookmarks/types';

/** Never rewrite an existing bookmark URL when opening it. */
export function isWebUrl(url: string | undefined): url is string {
  if (!url) return false;
  try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; }
}
export function writableFolders(folders: FolderRecord[]): FolderRecord[] {
  return folders.filter(folder => folder.parentId !== null && folder.browserId !== '0');
}
export function workspacePath(query = '', captureId?: string): string {
  const params = new URLSearchParams();
  if (query.trim()) params.set('q', query.trim());
  if (captureId) params.set('capture', captureId);
  return `options.html${params.size ? `?${params}` : ''}`;
}
export function expandedWorkspacePath(search: string, hash: string): string {
  return `options.html${search}${hash}`;
}
