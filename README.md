# AI Bookmark Manager

Local-first Chrome/Edge bookmark indexing extension. **Read-only for native bookmarks.**

## Development Stage

This project follows a 7-phase development plan.

- **Phase 0 — Audit & Quality Baseline** ✅ passed ([report](./docs/audit-phase0.md))
- **Phase 1 — Bookmark data + UI** ✅ passed ([report](./docs/phase-1-report.md), [data model](./docs/data-model.md))
- **Phase 2 — Backup + safe write executor** ✅ passed ([report](./docs/phase-2-report.md), [security notes](./docs/security.md))
- **Phase 3 — Link health** ✅ passed ([report](./docs/phase-3-report.md), [implementation notes](./docs/link-health.md))

The contract that all subsequent agents follow is in [`docs/DEVELOPMENT_GUIDE.md`](./docs/DEVELOPMENT_GUIDE.md).

Do not start Phase 3 work until the development guide's stop conditions are reviewed and the Phase 2 report is accepted.

## Requirements

- Node.js 20+
- npm 10+ (or pnpm)

## Quick start

```bash
npm install                  # postinstall will run `wxt prepare`
npm run dev                  # starts the HMR dev server on http://localhost:3000
```

The dev server pre-renders the unpacked extension into `.output/chrome-mv3-dev/`.

### Loading the extension into your real Chrome (so it can read your bookmarks)

WXT's `npm run dev` automatically opens a **temporary Chrome window** with a fresh, isolated profile. That window has none of your real bookmarks and is only useful for quick visual checks.

To develop against your real bookmarks, load the extension into your **normal** Chrome:

1. Start the dev server: `npm run dev` — leave it running.
2. In **your normal Chrome** (the one with all your bookmarks), open `chrome://extensions`.
3. Toggle **Developer mode** (top-right).
4. Click **Load unpacked** and select:
   ```
   /Users/angusfan/Desktop/ai-bookmark-manager/.output/chrome-mv3-dev/
   ```
5. Pin the extension (puzzle icon → pin) and click its icon → "打开书签管理中心".

HMR is active. When you save any `.ts` / `.vue` / `.css` file, the dev server pushes a reload signal to the extension. If the page does not refresh, click the **↻ Reload** button on the extension card in `chrome://extensions`.

Convenience scripts:

```bash
npm run open:chrome-ext   # open chrome://extensions in your default browser
npm run open:devdir       # open the .output/chrome-mv3-dev/ folder in Finder
npm run dev:clean         # wipe .wxt/ + .output/ and re-prepare, then start
```

### Why the temp Chrome window?

`wxt dev` is wired to `web-ext-run`, which always launches a fresh Chromium with a temporary profile in `/var/folders/.../tmp-web-ext--*/Default/`. WXT 0.20 does not expose a CLI flag to skip this. Closing that temp window is harmless — it is not where the extension lives during development. See `wxt.config.ts` for details.

## Quality gates

```bash
npm run typecheck   # vue-tsc with WXT-generated tsconfig
npm run test        # vitest (49 tests; 10,000-bookmark stress included)
npm run build       # production MV3 build → .output/chrome-mv3/
npm run zip         # zip for store upload
npm run lint        # ESLint flat-config (TypeScript + Vue)
```

All five required commands (`typecheck`, `test`, `build`, `lint`, plus `dev`) are exercised by Phase 1 and must remain green.

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
