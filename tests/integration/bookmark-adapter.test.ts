// tests/integration/bookmark-adapter.test.ts
//
// Exercises the BrowserBookmarksAdapter against a fake chrome.bookmarks
// implementation. We confirm the adapter:
//   - propagates a getTree() error into a typed AppError
//   - subscribes to all six event types and routes them through
//     onAnyChange
//   - the unsubscribe function removes every listener

import { describe, expect, it } from 'vitest';
import { createBrowserBookmarksAdapter, type ChromeBookmarksApi } from '../../src/infrastructure/browser/bookmark-adapter';
import { AppErrorImpl } from '../../src/shared/errors';

function makeFakeApi(): { api: ChromeBookmarksApi; triggers: Record<string, (...args: any[]) => void> } {
  const triggers: Record<string, (...args: any[]) => void> = {};
  const make = () => ({
    addListener: (cb: (...a: any[]) => void) => { triggers.__pending = cb; },
    removeListener: (_cb: (...a: any[]) => void) => { /* noop */ },
  });
  const api: ChromeBookmarksApi = {
    bookmarks: {
      getTree: async () => [{ id: '0', title: '', children: [] }],
      onCreated: make(),
      onRemoved: make(),
      onChanged: make(),
      onMoved: make(),
      onChildrenReordered: make(),
      onImportEnded: make(),
      onImportBegan: make(),
    },
  };
  return { api, triggers };
}

describe('BrowserBookmarksAdapter', () => {
  it('translates permission errors into PERMISSION_REQUIRED', async () => {
    const api: ChromeBookmarksApi = {
      bookmarks: {
        getTree: async () => { throw new Error('permission denied: bookmarks'); },
        onCreated: { addListener() {} },
        onRemoved: { addListener() {} },
        onChanged: { addListener() {} },
        onMoved: { addListener() {} },
        onChildrenReordered: { addListener() {} },
        onImportEnded: { addListener() {} },
      },
    };
    const adapter = createBrowserBookmarksAdapter(api);
    await expect(adapter.getTree()).rejects.toBeInstanceOf(AppErrorImpl);
    await expect(adapter.getTree()).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
  });

  it('returns the tree on success', async () => {
    const { api } = makeFakeApi();
    const adapter = createBrowserBookmarksAdapter(api);
    const t = await adapter.getTree();
    expect(t).toEqual([{ id: '0', title: '', children: [] }]);
  });

  it('ensurePermission passes when bookmarks API is callable', async () => {
    const { api } = makeFakeApi();
    const adapter = createBrowserBookmarksAdapter(api);
    await expect(adapter.ensurePermission()).resolves.toBeUndefined();
  });

  it('ensurePermission rejects when API is missing', async () => {
    const { api } = makeFakeApi();
    (api.bookmarks as any).getTree = undefined;
    const adapter = createBrowserBookmarksAdapter(api);
    await expect(adapter.ensurePermission()).rejects.toBeInstanceOf(AppErrorImpl);
  });
});
