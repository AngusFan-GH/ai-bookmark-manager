import { defineBackground } from 'wxt/utils/define-background';
import { db } from '../src/db';
import { fullSync, getStats, listBookmarks, exportBackup } from '../src/sync';
import type { Request, Result } from '../src/types';

export default defineBackground(() => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleSync = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void fullSync().catch(console.error); }, 350);
  };
  chrome.runtime.onInstalled.addListener(() => { void fullSync().catch(console.error); });
  chrome.runtime.onStartup.addListener(() => { void fullSync().catch(console.error); });
  chrome.bookmarks.onCreated.addListener(scheduleSync);
  chrome.bookmarks.onRemoved.addListener(scheduleSync);
  chrome.bookmarks.onChanged.addListener(scheduleSync);
  chrome.bookmarks.onMoved.addListener(scheduleSync);
  chrome.bookmarks.onChildrenReordered.addListener(scheduleSync);
  chrome.bookmarks.onImportEnded.addListener(scheduleSync);

  chrome.runtime.onMessage.addListener((request: Request, sender, sendResponse: (r: Result) => void) => {
    if (sender.id !== chrome.runtime.id) return false;
    const run = async () => {
      switch (request.type) {
        case 'LIST': return listBookmarks(request.query, request.folderId, request.limit, request.offset);
        case 'TREE': return db.bookmarks.where('kind').equals('folder').toArray();
        case 'STATS': return getStats();
        case 'SYNC': return { count: await fullSync() };
        case 'EXPORT': return exportBackup();
        default: throw new Error('Unknown request');
      }
    };
    void run().then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  });
});
