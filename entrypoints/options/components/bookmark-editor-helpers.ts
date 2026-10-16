import type { BookmarkRecord, FolderRecord } from '../../../src/domain/bookmarks/types';
import type { OrganizationInput } from '../../../src/workspace-client';

export type BookmarkEditorKind = 'bookmark' | 'folder' | 'edit' | 'move';
export interface BookmarkEditorDraft { title: string; url: string; parentId: string }
export interface BookmarkEditorErrors { title?: string; url?: string; parentId?: string; form?: string }

/** A preview form never assumes Chrome's invisible root is writable. */
export function isProtectedEditorRecord(record: BookmarkRecord): boolean {
  return record.parentId === null || record.browserId === '0' || record.parentId === '0';
}

export function isEditorWebUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value) || [...value].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname;
  } catch { return false; }
}

function selectedRecords(records: BookmarkRecord[]): BookmarkRecord[] {
  return [...new Map(records.map(record => [record.browserId, record])).values()];
}

/** Parent IDs, rather than cached display paths, define cycle protection. */
export function editorDestinationFolders(folders: FolderRecord[], records: BookmarkRecord[] = []): FolderRecord[] {
  const folderById = new Map<string, FolderRecord>();
  for (const folder of folders) {
    folderById.set(folder.id, folder);
    folderById.set(folder.browserId, folder);
  }
  const movingFolders = new Set(records.filter(record => record.kind === 'folder').flatMap(record => [record.id, record.browserId]));
  return folders.filter(folder => {
    if (folder.parentId === null || folder.browserId === '0') return false;
    let current: FolderRecord | undefined = folder;
    const seen = new Set<string>();
    while (current) {
      if (movingFolders.has(current.id) || movingFolders.has(current.browserId) || seen.has(current.browserId)) return false;
      seen.add(current.browserId);
      current = current.parentId ? folderById.get(current.parentId) : undefined;
    }
    return true;
  }).sort((a, b) => (a.path || a.title).localeCompare(b.path || b.title, 'zh-CN') || a.index - b.index);
}

export function initialBookmarkEditorDraft(kind: BookmarkEditorKind, records: BookmarkRecord[], folders: FolderRecord[], defaultParentId: string): BookmarkEditorDraft {
  const targets = selectedRecords(records);
  const single = targets.length === 1 ? targets[0] : undefined;
  const available = editorDestinationFolders(folders, kind === 'move' ? targets : []);
  const commonParent = targets.length && targets.every(record => record.parentId === targets[0].parentId) ? targets[0].parentId : '';
  const candidate = kind === 'edit' ? single?.parentId : kind === 'move' ? commonParent || defaultParentId : defaultParentId;
  const parent = available.find(folder => folder.id === candidate || folder.browserId === candidate);
  return { title: kind === 'edit' ? single?.title ?? '' : '', url: kind === 'edit' ? single?.url ?? '' : '', parentId: parent?.id ?? '' };
}

/** Translate only explicitly entered changes into the parent's review flow. No writes or I/O. */
export function buildBookmarkEditorInput(kind: BookmarkEditorKind, draft: BookmarkEditorDraft, records: BookmarkRecord[], folders: FolderRecord[]): { errors: BookmarkEditorErrors; input?: OrganizationInput } {
  const errors: BookmarkEditorErrors = {};
  const targets = selectedRecords(records);
  const record = targets[0];
  const title = draft.title.trim();
  const url = draft.url.trim();
  const isCreating = kind === 'bookmark' || kind === 'folder';
  if (!isCreating) {
    if (!targets.length || (kind === 'edit' && targets.length !== 1)) errors.form = kind === 'edit' ? '请先选择一个书签或目录进行编辑。' : '请先选择要移动的书签或目录。';
    else if (targets.some(isProtectedEditorRecord)) errors.form = '浏览器内置目录受到保护，不能编辑或移动。请选择其中的书签或子目录。';
    else if (targets.some(target => !['bookmark', 'folder'].includes(target.kind))) errors.form = '所选条目不支持此操作，请重新选择书签或目录。';
    else if (targets.length > 500) errors.form = '每次最多预览 500 项更改，请减少选择后重试。';
  }
  if (kind !== 'move' && !title) errors.title = kind === 'folder' || record?.kind === 'folder' ? '请输入目录名称。' : '请输入书签标题。';
  const isBookmark = kind === 'bookmark' || (kind === 'edit' && record?.kind === 'bookmark');
  // Existing chrome:, file: or bookmarklet URLs remain byte-for-byte unchanged
  // when a user edits only the title. They are never emitted as URL updates.
  const unchangedUrl = kind === 'edit' && draft.url === record?.url;
  if (isBookmark && !unchangedUrl && !isEditorWebUrl(url)) errors.url = '请输入完整的 http:// 或 https:// 网页地址。';

  const destinations = editorDestinationFolders(folders, kind === 'move' ? targets : []);
  const destination = destinations.find(folder => folder.id === draft.parentId || folder.browserId === draft.parentId);
  if (kind !== 'edit' && !destination) errors.parentId = destinations.length ? '请选择保存到的目录。' : '没有可用的目标目录，请先在浏览器中创建一个可写入的书签目录。';
  if (Object.keys(errors).length) return { errors };

  const steps: OrganizationInput['steps'] = [];
  if (isCreating) {
    steps.push({ action: 'create', parentBrowserId: destination!.browserId, desiredAfter: { title, ...(kind === 'bookmark' ? { url } : {}) }, reason: kind === 'bookmark' ? '用户手动添加书签，等待预览确认' : '用户手动新建目录，等待预览确认' });
  } else if (kind === 'edit') {
    const changes: { title?: string; url?: string } = {};
    if (title !== record.title) changes.title = title;
    if (record.kind === 'bookmark' && !unchangedUrl && url !== record.url) changes.url = url;
    if (Object.keys(changes).length) steps.push({ action: record.kind === 'folder' ? 'rename' : 'update', targetBrowserId: record.browserId, desiredAfter: changes, reason: record.kind === 'folder' ? '用户手动修改目录名称，等待预览确认' : '用户手动编辑书签，等待预览确认' });
  } else {
    for (const target of targets) {
      if (target.parentId === destination!.id || target.parentId === destination!.browserId) continue;
      steps.push({ action: 'move', targetBrowserId: target.browserId, parentBrowserId: destination!.browserId, reason: '用户手动选择目标目录，等待预览确认' });
    }
  }
  if (!steps.length) return { errors: { form: kind === 'move' ? '所选条目已在此目录中，请选择其他目录。' : '尚未修改内容。更改标题或地址后即可预览。' } };
  return { errors, input: { title: kind === 'bookmark' ? `添加书签：${title}` : kind === 'folder' ? `新建目录：${title}` : kind === 'edit' ? `${record.kind === 'folder' ? '重命名目录' : '编辑书签'}：${title}` : `移动 ${steps.length} 个条目`, steps } };
}
