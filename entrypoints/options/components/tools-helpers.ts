import type { HealthObservation } from '../../../src/domain/health/types';
import type { BookmarkRecord } from '../../../src/domain/bookmarks/types';
export interface HealthSelection { bookmarkId: string; status: string; url?: string; syncGeneration?: number; observations?: HealthObservation[] }
/** Only explicitly selected, current records with repeated GET evidence can enter a removal preview. */
export function confirmedRemovalRecords(selected: readonly string[], health: readonly HealthSelection[], records: readonly BookmarkRecord[]): BookmarkRecord[] {
  const checks = new Map(health.map(row => [row.bookmarkId, row]));
  return records.filter(record => {
    const check = checks.get(record.id);
    return selected.includes(record.id) && record.kind === 'bookmark' && check?.status === 'repeated_not_found' && (check.observations?.filter(observation => observation.method === 'GET' && (observation.httpCode === 404 || observation.httpCode === 410) && Number.isFinite(observation.checkedAt)).length ?? 0) >= 2 && !!record.url && check.url === record.url && typeof check.syncGeneration === 'number' && check.syncGeneration === record.syncGeneration;
  });
}
export function healthEmptyText(total: number, filter: string): string {
  return total === 0 ? '当前没有可检查的书签。请先添加书签或重新同步。' : filter === 'all' ? '暂无结果，请刷新重试。' : '没有符合此状态的书签。可以选择“全部”查看其他结果。';
}
export function backupFileName(now = new Date()): string {
  return `bookmarks-backup-${now.toISOString().replace(/[:.]/g, '-')}.json`;
}
