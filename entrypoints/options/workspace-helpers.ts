import type { FolderRecord } from '../../src/domain/bookmarks/types';
export interface FolderNode { id: string; label: string; children: FolderNode[] }
/** Native parent IDs determine hierarchy; cached paths are labels only. */
export function buildFolderTree(folders: FolderRecord[]): FolderNode[] {
  const nodes = new Map(folders.map(f => [f.id, { id: f.id, label: f.title || '未命名目录', children: [] as FolderNode[] }]));
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
  const steps: OrganizationInput['steps'] = usedFolders.map(folder => ({
    action: 'create', parentBrowserId: folder.parentFolderId,
    desiredAfter: { title: folder.title }, reason: '创建建议中的目标目录',
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
    targetPath:step.action==='create'?[parentPath,text(step.desiredAfter.title)].filter(Boolean).join(' / '):parentPath};
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
