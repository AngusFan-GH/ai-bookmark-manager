// tests/fixtures/bookmark-fixtures.ts
//
// Pure-data fixtures used by unit and integration tests. No chrome.*
// access; everything is plain objects so tests run in plain Node.

import type { RawBookmarkNode } from '../../src/domain/bookmarks/types';

/** Build a deep nested folder of `depth` levels with `width` children each. */
export function makeDeepTree(depth: number, width: number, leafUrl: (i: number) => string): RawBookmarkNode[] {
  let id = 0;
  const nextId = () => `n${++id}`;

  const buildLevel = (level: number, parentId: string | undefined, ancestors: string[]): RawBookmarkNode => {
    const myId = nextId();
    const title = `L${level}`;
    if (level >= depth) {
      return {
        id: myId, parentId, title, index: 0, children: [],
      };
    }
    const children: RawBookmarkNode[] = [];
    for (let w = 0; w < width; w++) {
      const childTitle = `${title}/${w}`;
      if (level === depth - 1) {
        // Leaf row: a bookmark with a url.
        children.push({
          id: nextId(), parentId: myId, title: childTitle, index: w,
          url: leafUrl(w),
        });
      } else {
        children.push(buildLevel(level + 1, myId, [...ancestors, childTitle]));
      }
    }
    return { id: myId, parentId, title, index: 0, children };
  };

  return [buildLevel(0, undefined, [])];
}

/**
 * Build a flat tree of `count` bookmarks at the root, useful for the
 * "10,000 条模拟书签" Phase 1 acceptance test.
 */
export function makeFlatTree(count: number, prefix = 'b'): RawBookmarkNode[] {
  const root: RawBookmarkNode = { id: 'root', title: '', children: [] };
  root.children = Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i}`,
    parentId: 'root',
    title: `Bookmark ${i}`,
    url: `https://example.com/${prefix}/${i}`,
    index: i,
  }));
  return [root];
}

/**
 * Build a tree with multiple folders containing bookmarks that share
 * titles or URLs, used to test "no duplicate records" semantics.
 */
export function makeTreeWithCollisions(): RawBookmarkNode[] {
  return [{
    id: 'root', title: '', children: [
      { id: 'f1', parentId: 'root', title: 'Work', index: 0, children: [
        { id: 'b1', parentId: 'f1', title: 'Doc', index: 0, url: 'https://docs.example.com/a' },
        { id: 'b2', parentId: 'f1', title: 'Doc', index: 1, url: 'https://docs.example.com/b' },
      ] },
      { id: 'f2', parentId: 'root', title: 'Personal', index: 1, children: [
        { id: 'b3', parentId: 'f2', title: 'Doc', index: 0, url: 'https://docs.example.com/a' },
      ] },
    ],
  }];
}

/** A minimal single-root empty tree (only the implicit root). */
export function makeEmptyTree(): RawBookmarkNode[] {
  return [{ id: '0', title: '', children: [] }];
}
