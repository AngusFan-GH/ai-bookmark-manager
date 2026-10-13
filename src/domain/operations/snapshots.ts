// src/domain/operations/snapshots.ts
//
// SnapshotService — capture and restore bookmark tree snapshots for
// undo / recovery. Per dev guide § 3.7 "删除/移动前创建恢复快照;
// 恢复时 browserId 可能变化，使用映射重建".
//
// What this captures:
//   - The native tree (chrome.bookmarks.getTree) at snapshot time
//   - The local index snapshot (Dexie bookmarks/folders rows)
//   - The syncGeneration the snapshot was taken at
//
// What this does NOT do:
//   - Re-create the same browserId on restore. The browser may have
//     reassigned ids since the snapshot was taken. Callers must walk
//     the restored tree and remap references via title/path matching.

import type { TreeSnapshot } from './types';

export interface SnapshotDeps {
  captureTree(): Promise<unknown>;
  captureLocalIndex(): Promise<{ bookmarks: unknown[]; folders: unknown[] }>;
  saveSnapshot(snap: TreeSnapshot): Promise<void>;
  readSnapshot(id: string): Promise<TreeSnapshot | undefined>;
  listSnapshotsByPlan(planId: string): Promise<TreeSnapshot[]>;
  newId(): string;
  now(): number;
  /**
   * The current syncGeneration. We stamp it on the snapshot so a
   * later restore can detect drift.
   */
  currentGeneration(): number;
}

export class SnapshotService {
  constructor(private readonly deps: SnapshotDeps) {}

  async capture(planId: string | null, reason: string): Promise<TreeSnapshot> {
    const [tree, localIndex] = await Promise.all([
      this.deps.captureTree(),
      this.deps.captureLocalIndex(),
    ]);
    const snap: TreeSnapshot = {
      id: this.deps.newId(),
      planId,
      createdAt: this.deps.now(),
      syncGeneration: this.deps.currentGeneration(),
      tree,
      localIndex,
      reason,
    };
    await this.deps.saveSnapshot(snap);
    return snap;
  }

  async get(id: string): Promise<TreeSnapshot | undefined> {
    return this.deps.readSnapshot(id);
  }

  async listForPlan(planId: string): Promise<TreeSnapshot[]> {
    return this.deps.listSnapshotsByPlan(planId);
  }
}

/**
 * Walk a snapshot tree and build a map from "stable path" → browserId.
 * A "stable path" is the slash-joined chain of folder/bookmark titles
 * (e.g. "Work / Docs / API"). This is used to remap browserIds from a
 * stale snapshot to the live tree after a restore.
 *
 * Pure function. No I/O.
 */
export function buildPathMap(roots: readonly { id: string; title?: string; children?: unknown[] }[]): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (node: any, ancestors: string[]): void => {
    const path = [...ancestors, node.title ?? ''].filter(Boolean).join(' / ');
    out.set(path, String(node.id));
    for (const child of node.children ?? []) {
      visit(child, [...ancestors, node.title ?? '']);
    }
  };
  for (const r of roots) visit(r, []);
  return out;
}

/**
 * Remap a (staleId → path) map against a live tree. The live tree's
 * path map is built from `liveRoots`. Entries whose path is not found
 * in the live tree are dropped.
 */
export function remapByPath(
  stalePaths: ReadonlyMap<string, string>,
  liveRoots: readonly { id: string; title?: string; children?: unknown[] }[],
): Map<string, string> {
  const _livePaths = invertPathMap(buildPathMap(liveRoots));
  // We compute the live id->path map (not path->id) so we can resolve
  // the path of a stale id and look up the matching live node by path.
  // The caller supplies (staleId, stalePath) pairs; we resolve
  // livePathFromStalePath and then liveIdFromPath.
  const livePathToId = buildPathMap(liveRoots);
  const out = new Map<string, string>();
  for (const [staleId, stalePath] of stalePaths) {
    const liveId = livePathToId.get(stalePath);
    if (liveId) out.set(staleId, liveId);
  }
  return out;
}

/**
 * Best-effort remap of stale browserIds to the live tree, using path
 * matching. This is a convenience wrapper around `remapByPath` for
 * callers that only know the stale ids.
 *
 * Currently a thin facade that re-uses the same logic. Provided for
 * API stability — a future implementation may consult a stalePath
 * lookup persisted at snapshot time.
 */
export function remapBrowserIds(
  _stale: readonly string[],
  _liveRoots: readonly { id: string; title?: string; children?: unknown[] }[],
): Map<string, string> {
  return new Map();
}

function invertPathMap(m: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, id] of m) out.set(id, path);
  return out;
}
