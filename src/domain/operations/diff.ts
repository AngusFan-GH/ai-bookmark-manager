// src/domain/operations/diff.ts
//
// Diff between an import browserTree and the live tree. Produces a
// preview that the UI shows before any write happens. Per dev guide
// § 3.3: "支持恢复模式：仅本地标签/元信息、仅创建缺失书签、受控合并；
//          首版不做一键覆盖."
//
// Identity model: a node's `id` is the primary key. A path is just
// `/`-joined titles for display. Two nodes match when their ids are
// the same. This handles the case where a folder was renamed in
// either tree: the id stays the same, but the path differs.
//
// Mode meaning (passed to `diffImport`):
//   - 'additive'  : only create nodes whose ids are absent in live
//   - 'additive-with-meta' : additive + apply local-only tags/meta
//   - 'controlled-merge'  : also update / move existing nodes when
//                            the user opts in

export type ImportMode = 'additive' | 'additive-with-meta' | 'controlled-merge';

export type DiffOp =
  | { kind: 'add'; id: string; path: string; title: string; url?: string; parentId: string | null }
  | { kind: 'update'; id: string; path: string; fromTitle: string; toTitle: string; fromUrl?: string; toUrl?: string }
  | { kind: 'move'; id: string; path: string; fromParentId: string | null; toParentId: string | null }
  | { kind: 'delete'; id: string; path: string }
  | { kind: 'noop'; id: string; path: string; reason: 'unchanged' | 'skipped-conflict' };

export interface DiffSummary {
  totalInImport: number;
  totalInLive: number;
  adds: number;
  updates: number;
  moves: number;
  deletes: number;
  noops: number;
}

export interface DiffResult {
  ops: DiffOp[];
  summary: DiffSummary;
  conflicts: string[];
  mode: ImportMode;
}

export interface FlatNode {
  id: string;
  title: string;
  url?: string;
  parentId: string | null;
  children: FlatNode[];
}

/**
 * Walk a tree and produce id → node, id → display path, id → parentId
 * maps. Pure function.
 */
export function indexByPath(roots: readonly FlatNode[]): {
  byId: Map<string, FlatNode>;
  pathById: Map<string, string>;
  parentById: Map<string, string | null>;
} {
  const byId = new Map<string, FlatNode>();
  const pathById = new Map<string, string>();
  const parentById = new Map<string, string | null>();
  const visit = (node: FlatNode, parentId: string | null, ancestors: string[]): void => {
    const path = ancestors.length === 0
      ? (node.title || '(root)')
      : [...ancestors, node.title].filter(Boolean).join(' / ');
    byId.set(node.id, node);
    pathById.set(node.id, path);
    parentById.set(node.id, parentId);
    for (const child of node.children ?? []) visit(child, node.id, [...ancestors, node.title]);
  };
  for (const r of roots) visit(r, null, []);
  return { byId, pathById, parentById };
}

/**
 * Compare an import tree to the live tree and return a list of
 * proposed operations under the given mode. The function never
 * touches the browser; it only computes a preview.
 */
export function diffImport(
  importRoots: readonly FlatNode[],
  liveRoots: readonly FlatNode[],
  mode: ImportMode,
): DiffResult {
  const imp = indexByPath(importRoots);
  const live = indexByPath(liveRoots);
  const ops: DiffOp[] = [];
  const conflicts: string[] = [];

  // 1. For every node in the import:
  //    - same id in live, same content → noop
  //    - same id in live, different content → update (controlled-merge only)
  //    - id missing in live → add (always safe)
  for (const [id, impNode] of imp.byId) {
    const path = imp.pathById.get(id) ?? impNode.title;
    const liveNode = live.byId.get(id);
    if (liveNode) {
      const sameTitle = impNode.title === liveNode.title;
      const sameUrl = (impNode.url ?? '') === (liveNode.url ?? '');
      const sameParent = impNode.parentId === liveNode.parentId;
      if (sameTitle && sameUrl && sameParent) {
        ops.push({ kind: 'noop', id, path, reason: 'unchanged' });
      } else if (mode === 'additive' || mode === 'additive-with-meta') {
        // Additive modes do not touch existing live nodes.
        ops.push({ kind: 'noop', id, path, reason: 'skipped-conflict' });
        conflicts.push(path);
      } else {
        if (!sameTitle || !sameUrl) {
          ops.push({
            kind: 'update',
            id,
            path,
            fromTitle: liveNode.title,
            toTitle: impNode.title,
            fromUrl: liveNode.url,
            toUrl: impNode.url,
          });
        }
        if (!sameParent) {
          ops.push({
            kind: 'move',
            id,
            path,
            fromParentId: liveNode.parentId,
            toParentId: impNode.parentId,
          });
        }
      }
    } else {
      // id missing in live. Add it.
      // The parent must exist in live (either as a real node, or be
      // scheduled for addition in the same plan).
      const parentId = impNode.parentId;
      const liveParent = parentId !== null ? live.byId.get(parentId) : null;
      const parentWillBeAdded = parentId !== null && !liveParent && imp.byId.has(parentId);
      if (parentId !== null && !liveParent && !parentWillBeAdded) {
        ops.push({ kind: 'noop', id, path, reason: 'skipped-conflict' });
        conflicts.push(path);
        continue;
      }
      ops.push({
        kind: 'add',
        id,
        path,
        title: impNode.title,
        url: impNode.url,
        parentId,
      });
    }
  }

  // 2. controlled-merge: detect live nodes missing from import and
  //    surface them as delete candidates. Additive modes do not delete.
  if (mode === 'controlled-merge') {
    for (const [id, liveNode] of live.byId) {
      if (!imp.byId.has(id)) {
        const path = live.pathById.get(id) ?? liveNode.title;
        ops.push({ kind: 'delete', id, path });
      }
    }
  }

  const summary: DiffSummary = {
    totalInImport: imp.byId.size,
    totalInLive: live.byId.size,
    adds: ops.filter((o) => o.kind === 'add').length,
    updates: ops.filter((o) => o.kind === 'update').length,
    moves: ops.filter((o) => o.kind === 'move').length,
    deletes: ops.filter((o) => o.kind === 'delete').length,
    noops: ops.filter((o) => o.kind === 'noop').length,
  };

  return { ops, summary, conflicts, mode };
}
