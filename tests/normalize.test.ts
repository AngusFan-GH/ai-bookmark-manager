// tests/normalize.test.ts
//
// Re-exported from the old location to keep backward compatibility.
// New tests live in `tests/integration/`.

import { describe, expect, it } from 'vitest';
import { flattenTree, matchesSearch } from '../src/domain/bookmarks/normalize';
import type { RawBookmarkNode } from '../src/domain/bookmarks/types';

const tree: RawBookmarkNode[] = [
  {
    id: '0', title: '', children: [
      {
        id: '1', parentId: '0', title: '开发', children: [
          { id: '2', parentId: '1', title: 'Vue', url: 'https://vuejs.org', dateAdded: 100, index: 0 },
        ],
      },
    ],
  },
];

describe('bookmark normalization (legacy smoke)', () => {
  it('preserves ancestry and ids', () => {
    const flat = flattenTree(tree, { now: 123, generation: 1 });
    // The synthetic root + "开发" folder = 2 folder rows.
    expect(flat.folders.length).toBeGreaterThanOrEqual(1);
    const dev = flat.folders.find((f) => f.title === '开发');
    expect(dev).toBeTruthy();
    expect(flat.bookmarks).toHaveLength(1);
    const b = flat.bookmarks[0];
    expect(b).toMatchObject({
      id: '2',
      browserId: '2',
      parentId: '1',
      kind: 'bookmark',
      title: 'Vue',
      url: 'https://vuejs.org',
      dateAdded: 100,
      syncGeneration: 1,
    });
  });

  it('matches by title/url/path case-insensitively', () => {
    const flat = flattenTree(tree, { now: 0, generation: 1 });
    const row = flat.bookmarks[0];
    expect(matchesSearch(row, 'VUE')).toBe(true);
    expect(matchesSearch(row, '开发')).toBe(true);
    expect(matchesSearch(row, 'vuejs.org')).toBe(true);
    expect(matchesSearch(row, 'quantum')).toBe(false);
  });
});
