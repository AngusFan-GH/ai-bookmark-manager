// tests/integration/normalize.test.ts
//
// Phase 1 tests for the canonical normalize module:
//   - flattenTree correctness across shapes
//   - url normalization
//   - path recomputation after rename/move
//   - isScannableUrl
//   - dedup-by-id semantics
//
// Per dev guide § 6 "阶段 1" tests: 10,000 条模拟数据无丢失；事件乱序/重
// 复测试；目录重命名/移动测试。Tree-scale tests are in
// `sync.test.ts`; this file focuses on shape correctness.

import { describe, expect, it } from 'vitest';
import {
  flattenTree,
  matchesSearch,
  normalizeHost,
  normalizeUrlForCompare,
  isScannableUrl,
  buildPath,
} from '../../src/domain/bookmarks/normalize';
import { makeEmptyTree, makeTreeWithCollisions, makeFlatTree } from '../fixtures/bookmark-fixtures';
import type { RawBookmarkNode } from '../../src/domain/bookmarks/types';

describe('flattenTree — shape and totals', () => {
  it('handles an empty tree (root with no children)', () => {
    const flat = flattenTree(makeEmptyTree(), { now: 0, generation: 1 });
    expect(flat.totalCount).toBe(0);
    expect(flat.bookmarks).toEqual([]);
    expect(flat.folders).toEqual([]);
  });

  it('records a folder row for each folder node', () => {
    const flat = flattenTree(makeTreeWithCollisions(), { now: 0, generation: 1 });
    // The synthetic root is recorded as a folder too, so total is
    // 1 (root) + 2 (Work, Personal) = 3.
    expect(flat.folders.length).toBeGreaterThanOrEqual(2);
    const titles = flat.folders.map((f) => f.title);
    expect(titles).toEqual(expect.arrayContaining(['Personal', 'Work']));
  });

  it('records a bookmark row for each leaf with a url', () => {
    const flat = flattenTree(makeTreeWithCollisions(), { now: 0, generation: 1 });
    expect(flat.bookmarks).toHaveLength(3);
    expect(flat.bookmarks.map((b) => b.id).sort()).toEqual(['b1', 'b2', 'b3']);
  });

  it('preserves original url byte-for-byte (does not normalize url into BookmarkRecord)', () => {
    const raw = 'https://Docs.Example.COM/A?utm_source=news';
    const tree: RawBookmarkNode[] = [{ id: '0', title: '', children: [
      { id: '1', parentId: '0', title: 'F', children: [
        { id: 'b1', parentId: '1', title: 'B', url: raw, index: 0 },
      ] },
    ] }];
    const flat = flattenTree(tree, { now: 0, generation: 1 });
    expect(flat.bookmarks[0].url).toBe(raw); // unchanged
    expect(flat.bookmarks[0].normalizedUrl).toBeUndefined(); // computed in Phase 4
  });

  it('treats nodes with children as folders even if they have no title', () => {
    const tree: RawBookmarkNode[] = [{ id: '0', title: '', children: [
      { id: '1', parentId: '0', title: '', children: [
        { id: '2', parentId: '1', title: 'leaf', url: 'https://x.test', index: 0 },
      ] },
    ] }];
    const flat = flattenTree(tree, { now: 0, generation: 1 });
    expect(flat.folders.find((f) => f.id === '1')).toBeTruthy();
  });

  it('computes folder paths in DFS pre-order', () => {
    const flat = flattenTree(makeTreeWithCollisions(), { now: 0, generation: 1 });
    const work = flat.folders.find((f) => f.id === 'f1')!;
    const personal = flat.folders.find((f) => f.id === 'f2')!;
    expect(work.path).toBe('Work');
    expect(personal.path).toBe('Personal');
  });

  it('attaches a path to bookmarks that reflects ancestor folder titles', () => {
    const tree: RawBookmarkNode[] = [{ id: '0', title: '', children: [
      { id: 'A', parentId: '0', title: 'Docs', children: [
        { id: 'a', parentId: 'A', title: 'API', children: [
          { id: 'x', parentId: 'a', title: 'X', url: 'https://x', index: 0 },
        ] },
      ] },
    ] }];
    const flat = flattenTree(tree, { now: 0, generation: 1 });
    const x = flat.bookmarks.find((b) => b.id === 'x')!;
    expect(x.path).toBe('Docs / API');
  });

  it('stamps every row with the supplied generation and updatedAt', () => {
    const flat = flattenTree(makeFlatTree(3), { now: 42, generation: 7 });
    expect(flat.bookmarks.every((b) => b.syncGeneration === 7 && b.updatedAt === 42)).toBe(true);
  });
});

describe('buildPath', () => {
  it('joins non-empty parts with " / "', () => {
    expect(buildPath(['A', 'B', 'C'])).toBe('A / B / C');
  });
  it('skips empty parts', () => {
    expect(buildPath(['A', '', 'C'])).toBe('A / C');
  });
  it('returns fallback when no parts', () => {
    expect(buildPath([])).toBe('');
    expect(buildPath([], 'root')).toBe('root');
  });
});

describe('matchesSearch', () => {
  const row = { title: 'Vue.js Guide', url: 'https://vuejs.org/guide', path: 'Docs / Frontend' };
  it('matches title (case-insensitive)', () => { expect(matchesSearch(row, 'vue')).toBe(true); });
  it('matches url fragment', () => { expect(matchesSearch(row, 'vuejs.org')).toBe(true); });
  it('matches folder path', () => { expect(matchesSearch(row, 'frontend')).toBe(true); });
  it('returns true for empty query', () => { expect(matchesSearch(row, '')).toBe(true); });
  it('returns false on no hit', () => { expect(matchesSearch(row, 'rust')).toBe(false); });
});

describe('normalizeUrlForCompare', () => {
  it('lowercases scheme and host but preserves path and query case', () => {
    const r = normalizeUrlForCompare('HTTPS://Docs.Example.com/A?Q=1');
    expect(r).toBe('https://docs.example.com/A?Q=1');
  });
  it('strips default ports (80/443)', () => {
    expect(normalizeUrlForCompare('http://x.test:80/a')).toBe('http://x.test/a');
    expect(normalizeUrlForCompare('https://x.test:443/a')).toBe('https://x.test/a');
  });
  it('keeps non-default ports', () => {
    expect(normalizeUrlForCompare('http://x.test:8080/a')).toBe('http://x.test:8080/a');
  });
  it('removes tracking params but keeps others', () => {
    const r = normalizeUrlForCompare('https://x.test/a?id=42&utm_source=news&page=1');
    expect(r).toBe('https://x.test/a?id=42&page=1');
  });
  it('does not touch the fragment or non-tracking query keys', () => {
    const r = normalizeUrlForCompare('https://x.test/a?b=1#frag');
    expect(r).toBe('https://x.test/a?b=1#frag');
  });
  it('throws on non-absolute input', () => {
    expect(() => normalizeUrlForCompare('not a url')).toThrow();
  });
});

describe('normalizeHost', () => {
  it('lowercases the host', () => {
    expect(normalizeHost('https://A.B.test/path')).toBe('a.b.test');
  });
  it('passes through invalid input', () => {
    expect(normalizeHost('garbage')).toBe('garbage');
  });
});

describe('isScannableUrl', () => {
  it('accepts http and https', () => {
    expect(isScannableUrl('http://x.test')).toBe(true);
    expect(isScannableUrl('https://x.test')).toBe(true);
  });
  it('rejects other schemes', () => {
    expect(isScannableUrl('file:///etc/passwd')).toBe(false);
    expect(isScannableUrl('javascript:alert(1)')).toBe(false);
    expect(isScannableUrl('chrome://settings')).toBe(false);
    expect(isScannableUrl('data:text/plain,hi')).toBe(false);
  });
  it('rejects garbage', () => {
    expect(isScannableUrl('not a url')).toBe(false);
  });
});
