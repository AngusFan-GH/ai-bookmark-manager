# AI Bookmark Manager

Local-first Chrome/Edge bookmark indexing extension. **Read-only for native bookmarks.**

## Development Stage

This project follows a 7-phase development plan. **Current stage: Phase 0 — Audit & Quality Baseline** (passed).

The contract that all subsequent agents follow is in [`docs/DEVELOPMENT_GUIDE.md`](./docs/DEVELOPMENT_GUIDE.md).
The detailed Phase 0 audit report is in [`docs/audit-phase0.md`](./docs/audit-phase0.md).

Do not start Phase 1 work until the development guide's stop conditions are reviewed and the Phase 0 audit is accepted.

## Requirements

- Node.js 20+
- npm 10+ (or pnpm)

## Quick start

```bash
npm install      # postinstall will run `wxt prepare`
npm run dev      # http://localhost:3000 with HMR
```

The dev server pre-renders the unpacked extension into `.output/chrome-mv3-dev/`. Load that directory in `chrome://extensions` (Developer mode → "Load unpacked"). Click the extension icon and open the manager.

## Quality gates

```bash
npm run typecheck   # vue-tsc with WXT-generated tsconfig
npm run test        # vitest
npm run build       # production MV3 build → .output/chrome-mv3/
npm run zip         # zip for store upload
npm run lint        # placeholder (eslint config scheduled for Phase 1)
```

All four required commands (`typecheck`, `test`, `build`, plus `dev`) are exercised by Phase 0 and must remain green.

## Iteration 1 features

- Full browser bookmark tree import (folders + leaves, ordering, IDs preserved)
- Debounced full reconciliation on bookmark change events (safe but not incremental; improved in Phase 1)
- IndexedDB local index (Dexie)
- Title, URL, folder-path search; folder filter and pagination
- JSON backup with `schemaVersion`, `browserTree`, `index` (no API keys, no page text)
- **No** native-bookmark writes or deletes from the extension

## Manual acceptance tests (Iteration 1)

1. Install the extension with 3+ folders and 10+ bookmarks. Confirm counts and hierarchy.
2. Add a bookmark in the browser; switch back to the manager and confirm it appears after a short delay.
3. Rename a folder; search by the new folder path and confirm descendants update.
4. Move a bookmark to another folder; confirm the displayed path changes.
5. Delete a bookmark in the browser; confirm the index no longer contains it.
6. Search with mixed-case title, URL fragment and folder path.
7. Export JSON and confirm `schemaVersion`, `browserTree`, `index` fields are present.
8. Restart the browser and reopen the manager; confirm the index persists.
9. Click "重新同步" and confirm no duplicate records.
10. Verify the extension never changes browser bookmarks itself.

## Constraints (Iteration 1)

- The JSON file is a backup/export; **import-and-restore UI is not implemented** in this iteration.
- Change events trigger a debounced **full reconciliation**, not true per-node incremental writes; this avoids stale descendant paths on folder rename/move.
- This build is Chrome/Edge MV3-focused; Firefox compatibility is not yet verified.
- Very large bookmark sets may require replacing in-memory filtering with indexed search.
- The browser itself may sync bookmarks via the signed-in browser profile; the extension does not implement cross-device sync.
