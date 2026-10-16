import { describe, expect, it } from 'vitest';
import { expandedWorkspacePath, isWebUrl, workspacePath, writableFolders } from '../../entrypoints/popup/helpers';
import type { FolderRecord } from '../../src/domain/bookmarks/types';

describe('popup entrypoint safety and navigation', () => {
  it('accepts web URLs without modifying exact spelling, fragments or query strings', () => {
    const url = 'https://Example.com/a%2Fb?token=x%2By#part';
    expect(isWebUrl(url)).toBe(true);
    expect(url).toBe('https://Example.com/a%2Fb?token=x%2By#part');
    for (const unsafe of ['javascript:alert(1)', 'chrome://settings', 'file:///private', 'data:text/html,x', undefined, 'not a URL']) expect(isWebUrl(unsafe)).toBe(false);
  });
  it('excludes the unwriteable browser root from destination selection', () => {
    const folders = [{ browserId: '0', parentId: null }, { browserId: '1', parentId: '0' }, { browserId: '9', parentId: '1' }] as FolderRecord[];
    expect(writableFolders(folders).map(f => f.browserId)).toEqual(['1', '9']);
  });
  it('passes only an opaque capture ID, never the raw captured URL, in navigation', () => {
    expect(workspacePath('  中文 & query ', 'capture-123')).toBe('options.html?q=%E4%B8%AD%E6%96%87+%26+query&capture=capture-123');
    expect(workspacePath()).toBe('options.html');
  });
  it('expands sidepanel with all query, capture and session state intact', () => {
    expect(expandedWorkspacePath('?q=design&capture=c123&session=s123', '#health')).toBe('options.html?q=design&capture=c123&session=s123#health');
  });
});
