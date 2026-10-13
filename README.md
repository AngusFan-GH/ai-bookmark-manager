# AI Bookmark Manager — Iteration 1

Local-first Chrome/Edge bookmark indexing extension. **Read-only for native bookmarks.**

## Requirements
- Node.js 20+
- npm 10+ (or pnpm)

## Start
```bash
npm install
npm run dev
```
Load `.output/chrome-mv3` as an unpacked extension in `chrome://extensions` (Developer mode), or follow the terminal instructions from WXT. Click the extension icon and open the manager.

## Production build
```bash
npm run build
npm run zip
npm run test
npm run typecheck
```
The output is under `.output/chrome-mv3` and `.output/*.zip`.

## Features
- Full browser bookmark tree import, including folder nodes
- Debounced full reconciliation on bookmark change events (safe but not incremental O(1); improve in iteration 2)
- IndexedDB persistent local index
- Title, URL, folder-path search; folder filter and pagination
- Full JSON backup containing browser tree and local index
- No browser bookmark writes or deletion

## Manual acceptance tests
1. Install extension with 3+ folders and 10+ bookmarks. Confirm total and hierarchy.
2. Add bookmark in browser; switch back to manager and confirm after a short delay.
3. Rename folder; search by new folder path and confirm descendants update.
4. Move bookmark to another folder; confirm displayed path changes.
5. Delete bookmark in browser; confirm index no longer contains it.
6. Search mixed-case title, URL fragment and folder path.
7. Export JSON and confirm `schemaVersion`, `browserTree`, `index` fields.
8. Restart browser and reopen manager; confirm index persists.
9. Click '重新同步' and confirm no duplicate records.
10. Verify extension never changes browser bookmarks itself.

## Constraints
- The JSON file is a backup/export; **import-and-restore UI is not implemented** in this iteration.
- Change events trigger a debounced **full reconciliation**, not true per-node incremental writes; this avoids stale descendant paths on folder rename/move. Event bursts or service-worker termination may require manual sync; a full sync runs at startup.
- This version is Chrome/Edge MV3-focused; Firefox compatibility is not yet verified.
- Very large bookmark sets may require replacing in-memory filtering with indexed search.
- The browser itself may sync bookmarks via the signed-in browser profile; the extension does not implement cross-device sync.
