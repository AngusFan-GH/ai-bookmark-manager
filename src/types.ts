export type BookmarkRow = {
  id: string;
  parentId?: string;
  title: string;
  url?: string;
  dateAdded?: number;
  dateGroupModified?: number;
  index?: number;
  kind: 'folder' | 'bookmark';
  path: string;
  updatedAt: number;
};
export type SyncMeta = { key: string; value: string | number };
export type Request =
  | { type: 'LIST'; query?: string; folderId?: string; limit?: number; offset?: number }
  | { type: 'TREE' }
  | { type: 'STATS' }
  | { type: 'SYNC' }
  | { type: 'EXPORT' };
export type Result<T = unknown> = { ok: true; data: T } | { ok: false; error: string };
