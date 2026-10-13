# Data Model — Phase 1

> Source of truth for the bookmark data model as of Phase 1. Mirrors
> dev guide § 4.1 + § 4.2 with the practical additions Phase 1 makes
> (the canonical `bookmarks` + `folders` stores, the `meta.syncState`
> row, and the `syncGeneration` per-row counter).

## 1. Stores (Dexie schema v1)

| store      | primary key | indexes                                                                                              | contents              |
| ---------- | ----------- | ---------------------------------------------------------------------------------------------------- | --------------------- |
| `bookmarks` | `id`        | `browserId, parentId, kind, title, url, [parentId+index], updatedAt, syncGeneration`               | bookmark row mirror   |
| `folders`   | `id`        | `browserId, parentId, title, [parentId+index], updatedAt, syncGeneration`                          | folder row mirror     |
| `meta`      | `key`       | `updatedAt`                                                                                          | misc singleton rows   |

Future stores (linkChecks, contents, classifications, plans, snapshots,
tasks, settings, chatSessions, chatMessages) are added in their
respective phases via `migrations.ts` and bump the schema version.

## 2. Types

### `BookmarkRecord` (`src/domain/bookmarks/types.ts`)

```ts
export type BookmarkKind = 'bookmark' | 'folder' | 'separator';

export interface BookmarkRecord {
  id: string;                  // app-scoped stable id; == browserId in MVP
  browserId: string;           // original chrome.bookmarks id
  kind: BookmarkKind;
  parentId: string | null;
  index: number;               // child order under parentId
  title: string;
  url?: string;                // PRESERVED EXACTLY (dev guide § 4.2)
  normalizedUrl?: string;      // comparison only (Phase 4 fills this)
  dateAdded?: number;
  dateGroupModified?: number;
  updatedAt: number;           // local wall-clock
  syncGeneration: number;      // bumped per full sync; reject stale writes
  path: string;                // presentation cache "A / B / C"
}
```

### `FolderRecord`

Same shape but `kind: 'folder'`, no `url`, no `normalizedUrl`. `path`
behaves the same way.

### `SyncState` (`src/domain/bookmarks/types.ts`)

```ts
export type SyncStatus = 'idle' | 'running' | 'succeeded' | 'failed';
export interface SyncState {
  status: SyncStatus;          // dev guide BM-008
  lastSyncAt: number | null;
  lastError: string | null;
  count: number;               // last successful total
  generation: number;          // monotonic counter
}
```

Persisted in the `meta` store under key `syncState`. Read/written via
`readSyncState()` / `writeSyncState()` in
`src/infrastructure/database/db.ts`.

## 3. Design constraints (dev guide § 4.2)

1. **`url` is preserved exactly** — never overwritten by normalization
   or any other pipeline. The `normalizeUrlForCompare` helper is for
   comparison only.
2. **`path` is a presentation cache.** It is recomputed on every full
   sync from `parentId` chain. Source of truth is `parentId`. Stale
   `path` is acceptable for one cycle; the next full sync fixes it.
3. **`syncGeneration` prevents stale writes from winning.** A late-
   arriving snapshot from an older generation is dropped on conflict.
4. **Operation log is NOT in this schema.** Phase 2 introduces
   `operationSteps`; do not purge it via ordinary sync.
5. **API keys and chat history MUST NOT enter the meta / bookmarks /
   folders stores** in any future schema change (dev guide § 10).

## 4. Where the data comes from

```
chrome.bookmarks.getTree()
   │   (single read on startup + on import events)
   ▼
flattenTree(tree, { now, generation })   [pure, in src/domain/bookmarks/normalize.ts]
   │
   ▼
SyncCoordinator.fullSync()
   │   transaction { clear → bulkPut }  [in domain/bookmarks/sync.ts]
   ▼
db.bookmarks / db.folders  [in infrastructure/database/db.ts]
   │
   ▼
read via store / message router
```

The `BrowserBookmarksAdapter`
(`src/infrastructure/browser/bookmark-adapter.ts`) is the only file
that calls `chrome.bookmarks.*`. The Dexie database is the only
writer of `bookmarks` / `folders` / `meta` (single-writer rule, dev
guide § 2.1).

## 5. Why `syncGeneration` instead of "last sync wins"

Phase 1 keeps the dev guide's § 3.1 BM-004 strategy: events are
debounced into a full reconcile. There is still a window in which:

- a) sync A starts at t0 with generation 5
- b) sync B is scheduled by an event at t0+10ms, would land at generation 6
- c) sync A finishes at t0+2000ms writing 5

Without a generation guard, sync B starting later would write
"generation 6" rows but if it loses the race the on-disk rows say 5.
Phase 1 resolves this by:

- The in-memory `currentGeneration` is monotonically incremented before
  the new full sync starts.
- All rows in the new tree are stamped with the new generation.
- The single transaction (clear + bulkPut) is atomic, so a partial
  write can never be observed.

Phase 2 may add a per-tab generation header so a UI that started
loading rows right before the swap can detect the change and reload.

## 6. Migration policy

Dexie migrations are managed in
`src/infrastructure/database/migrations.ts`. Each future change adds
`db.version(N).stores(...).upgrade(tx => ...)` AND a test in
`tests/integration/migrations.test.ts` that simulates a v(N-1) DB and
verifies the upgrade.

Phase 1's contribution:

- `migrations.ts` exports `SCHEMA_V1` (the index strings) and
  `createTestDatabase(name)` for tests.
- `migrations.test.ts` round-trips 50 rows through v1 to lock in the
  schema and the per-row fields.
