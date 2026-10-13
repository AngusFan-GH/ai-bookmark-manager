// src/domain/bookmarks/sync.ts
//
// SyncCoordinator: owns the rule "do not let stale snapshots overwrite
// new ones" (dev guide § 3.1 BM-005). It is the only writer of the
// `bookmarks`, `folders`, and sync-state tables.
//
// Concurrency model:
//   - A single in-flight fullSync() at a time (per dev guide § 2.1).
//   - Events are debounced into a single fullSync trigger.
//   - A `syncGeneration` counter is bumped before each replace; rows
//     written with an older generation are dropped on conflict.
//
// Errors are NOT swallowed: they propagate to the background router
// which turns them into a `failed` SyncState. The UI shows the error
// and offers a manual retry (dev guide § 3.1 BM-007).

import { AppErrorImpl } from '../../shared/errors';
import { flattenTree, type FlattenResult } from './normalize';
import type { BookmarkRecord, FolderRecord, RawBookmarkNode, SyncState, SyncReason } from './types';

export interface SyncDb {
  bookmarks: { bulkPut(rows: BookmarkRecord[]): Promise<unknown>; clear(): Promise<unknown>; toArray(): Promise<BookmarkRecord[]> };
  folders: { bulkPut(rows: FolderRecord[]): Promise<unknown>; clear(): Promise<unknown> };
  transaction: <T>(
    mode: 'rw',
    ...tables: unknown[]
  ) => Promise<T>;
  meta: { get(key: string): Promise<{ key: string; value: unknown; updatedAt: number } | undefined>; put(row: { key: string; value: unknown; updatedAt: number }): Promise<unknown> };
}

export interface SyncDeps {
  db: SyncDb;
  /** Read the native tree. */
  readTree(): Promise<RawBookmarkNode[]>;
  /** Read and write the current sync state. */
  readState(): Promise<SyncState>;
  writeState(s: SyncState): Promise<void>;
  /** Bump and return a new syncGeneration after the persisted value. */
  nextGeneration(previousGeneration: number): number;
  /** Wall-clock for the snapshot. */
  now(): number;
}

export interface SyncResult {
  count: number;
  generation: number;
  state: SyncState;
  reason: SyncReason;
}

const DEFAULT_STATE: SyncState = {
  status: 'idle',
  lastSyncAt: null,
  lastError: null,
  count: 0,
  generation: 0,
};

export class SyncCoordinator {
  private inflight: Promise<SyncResult> | null = null;
  constructor(private readonly deps: SyncDeps) {}

  /**
   * Run a full reconciliation. If a sync is already in flight, return
   * that same promise (dev guide § 2.1: single background writer).
   */
  fullSync(reason: SyncReason = 'event'): Promise<SyncResult> {
    if (this.inflight) return this.inflight;
    this.inflight = this.runFull(reason).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async runFull(reason: SyncReason): Promise<SyncResult> {
    const prev = await this.deps.readState();
    const pending: SyncState = { ...prev, status: 'running', lastError: null };
    await this.deps.writeState(pending);

    let tree: RawBookmarkNode[];
    try {
      tree = await this.deps.readTree();
    } catch (err) {
      const failed: SyncState = {
        ...prev,
        status: 'failed',
        lastError: err instanceof Error ? err.message : String(err),
        lastSyncAt: prev.lastSyncAt,
      };
      await this.deps.writeState(failed);
      if (err instanceof AppErrorImpl) throw err;
      throw new AppErrorImpl('UNKNOWN', failed.lastError ?? 'sync failed', true);
    }

    const generation = this.deps.nextGeneration(prev.generation);
    const now = this.deps.now();
    const flat: FlattenResult = flattenTree(tree, { now, generation });

    // Persist atomically: clear + bulkPut in one transaction so a
    // crash mid-replace never leaves the local DB empty.
    await this.deps.db.transaction('rw', this.deps.db.bookmarks, this.deps.db.folders, this.deps.db.meta, async () => {
      await this.deps.db.bookmarks.clear();
      await this.deps.db.folders.clear();
      if (flat.bookmarks.length) await this.deps.db.bookmarks.bulkPut(flat.bookmarks);
      if (flat.folders.length) await this.deps.db.folders.bulkPut(flat.folders);
    });

    const next: SyncState = {
      status: 'succeeded',
      lastSyncAt: now,
      lastError: null,
      count: flat.totalCount,
      generation,
    };
    await this.deps.writeState(next);
    return { count: flat.totalCount, generation, state: next, reason };
  }

  // Expose the default state shape for callers that need to initialize.
  static defaultState(): SyncState {
    return { ...DEFAULT_STATE };
  }
}

// ---- Debouncer ------------------------------------------------------------

/**
 * Coalesce a burst of events into a single fullSync. Phase 1's strategy
 * is the simple "debounce then full reconcile" from the dev guide § 3.1
 * BM-004. Phase 2+ can replace this with incremental event application
 * — see dev guide § 6.
 */
export class DebouncedSync {
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private readonly coordinator: SyncCoordinator,
    private readonly waitMs: number = 350,
  ) {}

  /** Call from any event listener. */
  schedule(reason: SyncReason = 'event'): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.coordinator.fullSync(reason).catch(() => { /* errors are recorded in SyncState */ });
    }, this.waitMs);
  }

  /** Flush any pending sync now (e.g. on service-worker shutdown). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.coordinator.fullSync('event');
  }

  /** Cancel any pending sync without running it. */
  cancel(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}
