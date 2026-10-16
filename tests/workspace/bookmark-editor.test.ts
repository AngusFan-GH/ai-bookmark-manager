import { describe, expect, it } from 'vitest';
import { buildBookmarkEditorInput, editorDestinationFolders, initialBookmarkEditorDraft, isEditorWebUrl, isProtectedEditorRecord } from '../../entrypoints/options/components/bookmark-editor-helpers';
import type { BookmarkRecord, FolderRecord } from '../../src/domain/bookmarks/types';

const folder = (id: string, parentId: string | null, title = id): FolderRecord => ({ id, browserId: id, parentId, title, path: title, index: 0, updatedAt: 0, syncGeneration: 1 });
const bookmark = (id = 'b', parentId = 'work', url = 'https://example.com/a?b=1#original'): BookmarkRecord => ({ ...folder(id, parentId, 'Original'), kind: 'bookmark', url });
const folderRecord = (id: string, parentId: string | null): BookmarkRecord => ({ ...folder(id, parentId), kind: 'folder' });
const folders = [folder('0', null), folder('1', '0', '书签栏'), folder('work', '1', '工作'), folder('child', 'work'), folder('grandchild', 'child'), folder('other', '1')];
const draft = { title: 'My page', url: 'https://example.com/a?b=1#original', parentId: 'work' };

describe('manual bookmark editor destinations', () => {
  it('excludes the invisible root but keeps writable native containers', () => {
    expect(editorDestinationFolders(folders).map(value => value.id)).not.toContain('0');
    expect(editorDestinationFolders(folders).map(value => value.id)).toContain('1');
  });
  it('excludes a moving folder and all descendants using parent IDs', () => {
    const available = editorDestinationFolders(folders, [folderRecord('work', '1')]).map(value => value.id);
    expect(available).toEqual(expect.arrayContaining(['1', 'other']));
    for (const id of ['work', 'child', 'grandchild']) expect(available).not.toContain(id);
  });
  it('excludes malformed cyclic destinations without recursing forever', () => {
    expect(editorDestinationFolders([...folders, folder('a', 'c'), folder('c', 'a')]).map(value => value.id)).not.toEqual(expect.arrayContaining(['a', 'c']));
  });
  it('prefills the current parent for edit and move, and leaves invalid/root create defaults empty', () => {
    expect(initialBookmarkEditorDraft('edit', [bookmark()], folders, 'other')).toEqual({ title: 'Original', url: draft.url, parentId: 'work' });
    expect(initialBookmarkEditorDraft('move', [bookmark()], folders, 'other').parentId).toBe('work');
    expect(initialBookmarkEditorDraft('bookmark', [], folders, 'other').parentId).toBe('other');
    for (const parent of ['', '0', 'missing']) expect(initialBookmarkEditorDraft('folder', [], folders, parent).parentId).toBe('');
  });
  it('requires the user to choose a valid destination and never falls back to an arbitrary folder', () => {
    for (const parentId of ['', '0', 'missing']) expect(buildBookmarkEditorInput('folder', { ...draft, parentId }, [], folders).errors.parentId).toBeTruthy();
    expect(buildBookmarkEditorInput('move', { ...draft, parentId: 'grandchild' }, [folderRecord('work', '1')], folders).input).toBeUndefined();
  });
  it('recognizes protected native root and top-level containers', () => {
    expect(isProtectedEditorRecord(folderRecord('0', null))).toBe(true);
    expect(isProtectedEditorRecord(folderRecord('1', '0'))).toBe(true);
    expect(isProtectedEditorRecord(folderRecord('work', '1'))).toBe(false);
  });
});

describe('manual bookmark editor preview payloads', () => {
  it('creates a bookmark preserving its path and query string without external writes', () => {
    const result = buildBookmarkEditorInput('bookmark', { ...draft, title: '  My page  ', url: `  ${draft.url}  ` }, [], folders);
    expect(result.errors).toEqual({});
    expect(result.input?.steps).toEqual([{ action: 'create', parentBrowserId: 'work', desiredAfter: { title: 'My page', url: draft.url }, reason: expect.any(String) }]);
  });
  it('creates folders without a URL field', () => {
    expect(buildBookmarkEditorInput('folder', draft, [], folders).input?.steps[0].desiredAfter).toEqual({ title: 'My page' });
  });
  it('requires titles and full HTTP(S) URLs for new bookmarks', () => {
    expect(buildBookmarkEditorInput('bookmark', { ...draft, title: '  ' }, [], folders).errors.title).toBeTruthy();
    for (const url of ['', 'example.com', 'javascript:alert(1)', 'file:///x', 'chrome://bookmarks', 'https:example.com', 'https://', 'https://example.com/\nfoo']) {
      expect(isEditorWebUrl(url)).toBe(false);
      expect(buildBookmarkEditorInput('bookmark', { ...draft, url }, [], folders).input).toBeUndefined();
    }
    expect(isEditorWebUrl('HTTPS://example.com/a?q=中文')).toBe(true);
  });
  it('emits only changed bookmark fields and folder rename actions', () => {
    expect(buildBookmarkEditorInput('edit', draft, [bookmark()], folders).input?.steps[0]).toMatchObject({ action: 'update', targetBrowserId: 'b', desiredAfter: { title: 'My page' } });
    expect(buildBookmarkEditorInput('edit', draft, [folderRecord('work', '1')], folders).input?.steps[0]).toMatchObject({ action: 'rename', desiredAfter: { title: 'My page' } });
    expect(buildBookmarkEditorInput('edit', { ...draft, title: 'Original', url: 'https://changed.example/a' }, [bookmark()], folders).input?.steps[0].desiredAfter).toEqual({ url: 'https://changed.example/a' });
  });
  it('preserves an unchanged special URL for title-only edits without re-emitting it', () => {
    const url = 'javascript:alert("hi")';
    const original = bookmark('b', 'work', url);
    expect(buildBookmarkEditorInput('edit', { ...draft, url }, [original], folders).input?.steps[0].desiredAfter).toEqual({ title: 'My page' });
    expect(buildBookmarkEditorInput('edit', { ...draft, url: 'javascript:alert("changed")' }, [original], folders).errors.url).toBeTruthy();
  });
  it('blocks empty edits, protected folders, and invalid record selection', () => {
    expect(buildBookmarkEditorInput('edit', { ...draft, title: 'Original' }, [bookmark()], folders).errors.form).toBeTruthy();
    for (const kind of ['edit', 'move'] as const) {
      for (const records of [[], [folderRecord('0', null)], [folderRecord('1', '0')]]) expect(buildBookmarkEditorInput(kind, draft, records, folders).errors.form).toBeTruthy();
    }
    expect(buildBookmarkEditorInput('edit', draft, [bookmark('a'), bookmark('b')], folders).input).toBeUndefined();
  });
  it('deduplicates batch selections and skips records already in destination', () => {
    const records = [bookmark('a'), bookmark('a'), bookmark('b', 'other')];
    const result = buildBookmarkEditorInput('move', { ...draft, parentId: 'other' }, records, folders);
    expect(result.input?.title).toBe('移动 1 个条目');
    expect(result.input?.steps).toEqual([{ action: 'move', targetBrowserId: 'a', parentBrowserId: 'other', reason: expect.any(String) }]);
    expect(buildBookmarkEditorInput('move', draft, [bookmark()], folders).errors.form).toBeTruthy();
  });
  it('rejects batches beyond the review limit', () => {
    const records = Array.from({ length: 501 }, (_, index) => bookmark(`b${index}`));
    expect(buildBookmarkEditorInput('move', { ...draft, parentId: 'other' }, records, folders).errors.form).toContain('500');
  });
  it('uses browser IDs in operations when local IDs differ', () => {
    const destination = { ...folder('local-folder', '1'), browserId: 'native-folder' };
    const record = { ...bookmark(), id: 'local-bookmark', browserId: 'native-bookmark' };
    expect(buildBookmarkEditorInput('move', { ...draft, parentId: 'local-folder' }, [record], [destination]).input?.steps[0]).toMatchObject({ targetBrowserId: 'native-bookmark', parentBrowserId: 'native-folder' });
  });
});
