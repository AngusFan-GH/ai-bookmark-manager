import type { BookmarkApiNode } from './executor';
import type { OperationPlan, OperationStep, TreeSnapshot } from './types';
import { AppErrorImpl } from '../../shared/errors';

const conflict = (message: string): never => { throw new AppErrorImpl('PLAN_STALE', `Recovery blocked: ${message}`, false); };
function flatten(tree: BookmarkApiNode[]): Map<string, BookmarkApiNode> {
  const result = new Map<string, BookmarkApiNode>();
  const visit = (nodes: BookmarkApiNode[]) => { for (const node of nodes) { result.set(node.id, structuredClone(node)); visit(node.children ?? []); } };
  visit(tree);
  return result;
}
function scalar(node: BookmarkApiNode): Record<string, unknown> {
  return { id: node.id, title: node.title ?? null, url: node.url ?? null,
    parentId: node.parentId ?? null, index: node.index ?? null, dateAdded: node.dateAdded ?? null };
}

/**
 * Only invert successful, uncompensated writes with durable evidence.
 * Never replace a tree or delete a newly encountered descendant.
 * Native IDs and timestamps of deleted nodes cannot be restored.
 */
export function buildRecoverySteps(source: OperationPlan, snapshot: TreeSnapshot, tree: BookmarkApiNode[], planId: string, newId: () => string): OperationStep[] {
  const live = flatten(tree);
  const backup = flatten(snapshot.tree as BookmarkApiNode[]);
  const restoredParents = new Map<string, OperationStep>();
  const steps: OperationStep[] = [];
  const originals = [...source.steps].sort((a, b) => b.order - a.order);
  if (originals.some(s => s.status === 'running' || (s.status === 'failed' && s.recoveryBefore))) conflict('an interrupted write has an uncertain outcome; inspect the audit and backup first');
  for (const original of originals) {
    if (original.status !== 'succeeded' || original.errorMessage === 'dry-run: not applied') continue;
    const before = original.recoveryBefore;
    const after = original.recoveryAfter;
    const targetId = original.action === 'create' ? original.desiredAfter.createdBrowserId : original.targetBrowserId;
    if (typeof targetId !== 'string') conflict('written native ID is unavailable');
    const id = targetId as string;
    const step: OperationStep = {
      id: newId(), planId, order: steps.length, action: 'update', targetBrowserId: id,
      parentBrowserId: null, expectedBefore: {}, desiredAfter: {}, reason: `Recover ${original.action} from “${source.title}”`,
      riskLevel: 'medium', dependsOn: [], status: 'pending', inverseOfId: original.id, errorMessage: null,
      evidence: [`execution snapshot ${snapshot.id}; successful step ${original.id}`],
    };
    if (original.action === 'delete') {
      if (!before || !backup.has(id)) conflict('deletion has no durable before-state and execution backup');
      if (live.has(id)) conflict('a deleted native ID is present again');
      step.action = 'create'; step.targetBrowserId = null;
      step.parentBrowserId = String(before!.parentId ?? '');
      step.desiredAfter = { title: before!.title ?? '' };
      if (typeof before!.url === 'string') step.desiredAfter.url = before!.url;
      if (typeof before!.index === 'number') step.desiredAfter.index = before!.index;
      const parentStep = restoredParents.get(step.parentBrowserId);
      if (parentStep) {
        step.parentStepId = parentStep.id;
        step.dependsOn = [parentStep.id];
      } else {
        const parent = live.get(step.parentBrowserId);
        if (!parent || parent.url !== undefined || parent.id === '0') conflict('original parent is missing or no longer writable');
      }
      restoredParents.set(id, step);
    } else {
      if (!after) conflict('post-write evidence is unavailable; automatic recovery cannot be verified');
      const current = live.get(id);
      if (!current) conflict('a written target no longer exists');
      const state = scalar(current!);
      // Sibling inserts/deletes can legitimately renumber indices. Moves require
      // exact order evidence; content changes still preserve the live position.
      for (const [key, value] of Object.entries(after!)) {
        if (key === 'index' && original.action !== 'move') continue;
        if (state[key] !== value) conflict(`target ${id} changed after the operation (${key})`);
      }
      step.expectedBefore = { ...state };
      if (original.action !== 'move') delete step.expectedBefore.index;
      if (original.action === 'create') {
        if ([...live.values()].some(n => n.parentId === id)) conflict('created folder contains later or unrecovered children');
        step.action = 'delete'; step.riskLevel = 'high';
        live.delete(id);
      } else {
        if (!before) conflict('pre-write evidence is unavailable');
        if (original.action === 'move') {
          step.action = 'move';
          step.parentBrowserId = String(before!.parentId ?? '');
          const parentStep = restoredParents.get(step.parentBrowserId);
          if (parentStep) { step.parentStepId = parentStep.id; step.dependsOn = [parentStep.id]; }
          else if (!live.has(step.parentBrowserId)) conflict('original move destination is missing');
          step.desiredAfter = { parentId: step.parentBrowserId };
          if (typeof before!.index === 'number') step.desiredAfter.index = before!.index;
        } else {
          step.action = 'update';
          for (const key of ['title', 'url']) {
            if (original.desiredAfter[key] !== undefined && typeof before![key] === 'string') step.desiredAfter[key] = before![key];
          }
          if (!Object.keys(step.desiredAfter).length) conflict('original changed fields cannot be restored');
        }
        // Simulate earlier inverses for plans that updated and moved one node.
        live.set(id, { ...current!, ...before!, url: typeof before!.url === 'string' ? before!.url : undefined } as BookmarkApiNode);
      }
    }
    steps.push(step);
  }
  if (!steps.length) conflict('there are no successful, uncompensated writes to recover');
  return steps;
}
