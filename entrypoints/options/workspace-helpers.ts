import type { FolderRecord } from '../../src/domain/bookmarks/types';
export interface FolderNode { id: string; label: string; children: FolderNode[] }
/** Native parent IDs determine hierarchy; cached paths are labels only. */
export function buildFolderTree(folders: FolderRecord[]): FolderNode[] {
  const nodes = new Map(folders.map(f => [f.id, { id: f.id, label: f.title || (f.parentId===null?'书签根目录':'未命名目录'), children: [] as FolderNode[] }]));
  const parents = new Map(folders.map(f => [f.id, f.parentId]));
  const roots: FolderNode[] = [];
  for (const f of [...folders].sort((a,b) => a.index - b.index || a.id.localeCompare(b.id))) {
    const node = nodes.get(f.id)!;
    const visited = new Set([f.id]); let ancestor = f.parentId; let cycle = false;
    while (ancestor && parents.has(ancestor)) { if (visited.has(ancestor)) { cycle = true; break; } visited.add(ancestor); ancestor = parents.get(ancestor) ?? null; }
    const parent = !cycle && f.parentId ? nodes.get(f.parentId) : undefined;
    if (parent) parent.children.push(node); else roots.push(node);
  }
  return roots;
}
export function safeBookmarkHref(url?: string): string | undefined {
  if (!url) return undefined;
  try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol) ? url : undefined; } catch { return undefined; }
}
export function initialSearch(search: string): string { return new URLSearchParams(search).get('q') ?? ''; }
export function downloadableJson(data: unknown): Blob { return new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); }
export function canExecuteReviewedPlan(input: {
  status?: string; stepCount: number; applied: boolean; backedUp: boolean;
  reviewed: boolean; hasDeletes: boolean; deleteConfirmation: string; busy: boolean;
}): boolean {
  return ['draft', 'validated'].includes(input.status ?? '') && input.stepCount > 0 && !input.applied &&
    input.backedUp && input.reviewed && (!input.hasDeletes || input.deleteConfirmation === '删除') && !input.busy;
}
/** Chrome optional permissions must be exact origins, never an all-host shortcut. */
export function selectedOrigins(urls: Array<string | undefined>): string[] {
  return [...new Set(urls.filter(url => !!safeBookmarkHref(url)).map(url => `${new URL(url!).origin}/*`))];
}

import type { ProposedMove, ProposedFolder } from '../../src/domain/assistant/types';
import type { OrganizationInput } from '../../src/workspace-client';
export function organizationSteps(moves: ProposedMove[], folders: ProposedFolder[], selectedIds: string[]): OrganizationInput['steps'] {
  const chosen = moves.filter(move => selectedIds.includes(move.bookmarkId));
  const usedFolders = folders.filter(folder => chosen.some(move => move.targetFolderId === folder.proposalId));
  if(usedFolders.some(folder=>!folder.title.trim()))throw new Error('建议新目录名称不能为空，请填写后重新预览。');
  const steps: OrganizationInput['steps'] = usedFolders.map(folder => ({
    action: 'create', parentBrowserId: folder.parentFolderId,
    desiredAfter: { title: folder.title.trim() }, reason: '创建建议中的目标目录',
  }));
  for (const move of chosen) {
    const index = usedFolders.findIndex(folder => folder.proposalId === move.targetFolderId);
    if (move.targetFolderId.startsWith('new:') && index < 0) throw new Error('建议中的新目录不存在，请重新生成整理建议。');
    steps.push({ action: 'move', targetBrowserId: move.bookmarkId,
      ...(index >= 0 ? { parentStepIndex: index } : { parentBrowserId: move.targetFolderId }), reason: move.reason });
  }
  return steps;
}

import type { OperationStep, OperationAction, RiskLevel } from '../../src/domain/operations/types';
export const actionLabel = (action: OperationAction): string => ({create:'新建',move:'移动',delete:'删除',rename:'重命名',update:'更新'}[action]);
export const riskLabel = (risk: RiskLevel): string => ({low:'低风险',medium:'中风险',high:'高风险'}[risk]);
export const planStatusLabel = (status: string): string => ({draft:'待审核',validated:'已验证',approved:'已批准',executing:'执行中',completed:'已完成',partially_completed:'部分完成',failed:'执行失败',cancelled:'已取消'}[status] ?? status);
/** Normalized folder paths already include the folder's own title. */
export function folderDisplayPath(folder: Pick<FolderRecord,'path'|'title'> | undefined): string {
  return folder ? folder.path || folder.title || '根目录' : '目录名称不可用';
}
export function describePlanStep(step: OperationStep, steps: OperationStep[], folders: FolderRecord[], bookmarks: Array<{id:string;title:string;url?:string;path:string}>) {
  const text = (value:unknown) => typeof value === 'string' ? value : '';
  const folderPath = (id:string) => folderDisplayPath(folders.find(item=>item.id===id));
  const record=bookmarks.find(item=>item.id===step.targetBrowserId);
  const sourceTitle=text(step.expectedBefore.title)||record?.title||'未命名书签';
  const sourceUrl=text(step.expectedBefore.url)||record?.url||'';
  const sourceParent=text(step.expectedBefore.parentId);
  const sourcePath=text(step.expectedBefore.path)||record?.path||(sourceParent?folderPath(sourceParent):'根目录');
  const createdParent=step.parentStepId?steps.find(item=>item.id===step.parentStepId):undefined;
  const parentPath=createdParent ? `${folderPath(createdParent.parentBrowserId||'')} / ${text(createdParent.desiredAfter.title)}（新建）` : step.parentBrowserId?folderPath(step.parentBrowserId):sourcePath;
  return {action:actionLabel(step.action),risk:riskLabel(step.riskLevel),sourceTitle,sourceUrl,sourcePath,
    targetTitle:text(step.desiredAfter.title)||sourceTitle,targetUrl:text(step.desiredAfter.url)||sourceUrl,
    targetPath:step.action==='create'&&!text(step.desiredAfter.url)?[parentPath,text(step.desiredAfter.title)].filter(Boolean).join(' / '):parentPath};
}
export const stepStatusLabel = (status: string): string => ({pending:'待执行',running:'执行中',succeeded:'成功',failed:'失败',compensated:'已补偿',skipped:'已跳过'}[status] ?? '状态未知');
/** Never render raw executor/provider errors: they may contain arbitrary URLs or credentials. */
export function stepErrorLabel(error: string | null): string {
  if (!error) return '';
  if (/compensation failed/i.test(error)) return '执行失败，自动补偿也未完成。请核对原生书签，并使用备份人工恢复。';
  if (/skipped due to earlier failure/i.test(error)) return '前面的步骤失败，因此未执行此步骤。';
  if (/unmet dependencies/i.test(error)) return '依赖步骤尚未成功，已停止此步骤。';
  if (/stale|changed|mismatch|expected|generation/i.test(error)) return '原生书签已变化，与审核时的状态不一致。请刷新后重新生成计划。';
  if (/not found|no bookmark|does not exist/i.test(error)) return '目标书签或目录已不存在。请刷新后重新生成计划。';
  if (/permission|denied/i.test(error)) return '缺少操作权限。请检查浏览器权限后重新审核计划。';
  if (/dry-run/i.test(error)) return '仅模拟检查，未应用更改。';
  return '此步骤未完成。请核对原生书签与恢复备份；需要重试时请重新生成并审核计划。';
}

/** Completion belongs to a plan ID, not to the last object loaded into the review pane. */
export function hasPlanExecutionResult(plan: {id:string;status:string} | undefined, executedPlanIds: ReadonlySet<string>): boolean {
  return !!plan && (executedPlanIds.has(plan.id) || ['completed','partially_completed','failed'].includes(plan.status));
}

/** A duplicate cleanup must preserve at least one original in every exact-URL group. */
export function duplicateDeleteSteps(groups: Array<{bookmarks:Array<{id:string;browserId:string}>}>, selected: string[]): OrganizationInput['steps'] {
  const chosen=new Set(selected);
  const known=new Set(groups.flatMap(group=>group.bookmarks.map(bookmark=>bookmark.id)));
  if (!chosen.size) throw new Error('请先选择要移除的重复书签。');
  if ([...chosen].some(id=>!known.has(id))) throw new Error('重复检查结果已变化，请重新检查。');
  if (groups.some(group=>group.bookmarks.every(bookmark=>chosen.has(bookmark.id)))) throw new Error('每组至少需要保留一个书签。');
  return groups.flatMap(group=>group.bookmarks.filter(bookmark=>chosen.has(bookmark.id)).map(bookmark=>({action:'delete' as const,targetBrowserId:bookmark.browserId,reason:'用户在重复组中明确选择移除此条，保留同组其他条目'})));
}
export function contentResultLabel(status:string, reason=''):string {
  if(status==='ready')return '已提取有限文本，可用于后续对话';
  if(status==='login_required')return '需要登录或访问受限，未读取内容';
  if(/permission/i.test(reason))return '缺少此网站的访问权限，未读取内容';
  if(/timeout|timed out/i.test(reason))return '读取超时，可稍后重试';
  if(/cancel/i.test(reason))return '读取已取消';
  if(status==='unsupported')return '不支持读取此地址或页面格式';
  return '未能读取内容，可打开原始网页检查';
}
export function workspaceErrorLabel(error:unknown):string {
  const message=error instanceof Error?error.message:String(error);
  if(message==='建议新目录名称不能为空，请填写后重新预览。')return message;
  if(message==='建议中的新目录不存在，请重新生成整理建议。')return message;
  if(/截断|truncat|token.*上限/i.test(message))return '模型输出被截断。可缩小书签范围，或在 AI 设置的高级设置中提高输出 token 上限后重试。';
  if(/请求受限|429|rate.?limit|quota/i.test(message))return 'AI 请求暂时受限，请稍后重试，并检查服务账户的额度与调用频率。';
  if(/取消|cancel/i.test(message))return '操作已取消，未完成的请求可以重试。';
  if(/密钥|api.?key|credential|401/i.test(message))return '密钥缺失、已过期或无效，请在 AI 设置中重新配置。';
  if(/权限|permission|denied/i.test(message))return '未获得所需访问权限。请检查浏览器权限后重试。';
  if(/timeout|timed out|超时/i.test(message))return '请求超时，请稍后重试。';
  if(/generation|stale|changed|变化/i.test(message))return '书签或会话已变化，请刷新后重新生成并审核。';
  if(/busy|正在|进行中/i.test(message))return '已有操作正在进行，请等待完成。';
  if(/至少.*保留/i.test(message))return '每组至少需要保留一个书签。';
  return '操作未完成。请刷新后重试；AI 请求请检查密钥、区域和网络设置。';
}
