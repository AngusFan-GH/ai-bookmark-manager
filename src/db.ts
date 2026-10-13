import Dexie, { type Table } from 'dexie';
import type { BookmarkRow, SyncMeta } from './types';

export class BookmarkDatabase extends Dexie {
  bookmarks!: Table<BookmarkRow, string>;
  meta!: Table<SyncMeta, string>;
  constructor() {
    super('ai-bookmark-manager');
    this.version(1).stores({
      bookmarks: 'id, parentId, kind, title, url, path, updatedAt',
      meta: 'key',
    });
  }
}
export const db = new BookmarkDatabase();
