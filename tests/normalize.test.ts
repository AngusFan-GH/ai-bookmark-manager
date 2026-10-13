import { describe, expect, it } from 'vitest';
import { flattenTree, matchesSearch } from '../src/normalize';
import type { BookmarkNode } from '../src/normalize';
const tree = [{ id: '0', title: '', children: [{ id: '1', parentId: '0', title: '开发', children: [{ id: '2', parentId: '1', title: 'Vue', url: 'https://vuejs.org', dateAdded: 100 }] }] }] as BookmarkNode[];
describe('bookmark normalization', () => {
  it('preserves ancestry and ids', () => {
    const rows = flattenTree(tree, 123);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ id: '2', parentId: '1', kind: 'bookmark', path: '开发', dateAdded: 100 });
  });
  it('searches title, url and path', () => {
    const row = flattenTree(tree)[2];
    expect(matchesSearch(row, 'VUE')).toBe(true);
    expect(matchesSearch(row, '开发')).toBe(true);
    expect(matchesSearch(row, 'vuejs.org')).toBe(true);
    expect(matchesSearch(row, 'quantum')).toBe(false);
  });
});
