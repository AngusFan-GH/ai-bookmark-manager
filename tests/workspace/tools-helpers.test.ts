import { describe, expect, it } from 'vitest';
import { backupFileName, confirmedRemovalRecords, healthEmptyText } from '../../entrypoints/options/components/tools-helpers';
import type { BookmarkRecord } from '../../src/domain/bookmarks/types';
const record = (id: string, url = 'https://saved.test') => ({ id, url, kind:'bookmark', syncGeneration:3 }) as BookmarkRecord;
describe('safe health cleanup selection', () => {
  it('only includes explicitly selected current confirmed dead records', () => {
    const records = [record('dead'), record('suspected'), record('other')];
    expect(confirmedRemovalRecords(['dead','suspected'], [{bookmarkId:'dead',status:'confirmed_dead',url:'https://saved.test',syncGeneration:3},{bookmarkId:'suspected',status:'suspected_dead',url:'https://saved.test',syncGeneration:3},{bookmarkId:'other',status:'confirmed_dead',url:'https://saved.test',syncGeneration:3}],records).map(r=>r.id)).toEqual(['dead']);
  });
  it('rejects old URL and generation evidence', () => {
    expect(confirmedRemovalRecords(['a','b'],[{bookmarkId:'a',status:'confirmed_dead',url:'https://old.test',syncGeneration:3},{bookmarkId:'b',status:'confirmed_dead',url:'https://saved.test',syncGeneration:2}],[record('a'),record('b')])).toEqual([]);
  });
  it('rejects missing evidence versions and missing URLs', () => {
    expect(confirmedRemovalRecords(['a'],[{bookmarkId:'a',status:'confirmed_dead',url:'https://saved.test'}],[{...record('a'),syncGeneration:undefined} as unknown as BookmarkRecord])).toEqual([]);
  });
  it('distinguishes an empty library from an empty filter', () => {
    expect(healthEmptyText(0,'all')).toContain('添加书签');
    expect(healthEmptyText(10,'confirmed_dead')).toContain('没有符合');
  });
  it('uses a timestamped safe backup filename', () => {
    expect(backupFileName(new Date('2026-10-16T16:00:00.000Z'))).toBe('bookmarks-backup-2026-10-16T16-00-00-000Z.json');
  });
});
