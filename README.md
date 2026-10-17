# AI Bookmark Manager

A local-first, task-oriented bookmark assistant for Chrome. Native browser bookmarks remain the source of truth. MiniMax helps find useful saved material, explain recommendations, suggest titles and folders, and prepare changes. AI never directly writes bookmarks.

## Current experience (0.2)

- One goal/search surface; optional directory and history drawers rather than a permanent three-column admin screen.
- Direct bookmark/folder creation, editing, movement and reviewed deletion. Changing a title and moving the same bookmark is supported as an ordered operation.
- Popup current-page save, exact-URL local search and opt-in automatic AI advice; a sidepanel reuses the workspace.
- Unified multi-turn AI tasks with explicit folder, query or selected-bookmark scope. Original URLs come from stored records, not model prose.
- Exact-URL duplicate review, selected link rechecks, and safe removal previews.
- Durable automatic snapshots before writes, optional external export, and separately reviewed targeted recovery with conflict checks.
- Opt-in local API-key persistence, exclusions and bounded content enhancement. Core local search and manual management work without AI.

See [current behavior and limitations](docs/WORKSPACE_V1.md), [verification](docs/TESTING_WORKSPACE.md), [browser acceptance](tests/e2e/README.md), and [recovery rules](src/domain/operations/RECOVERY.md).

## Run and test

Node 20+ is required; CI uses Node 22.

```sh
npm ci
npm test
npm run typecheck
npm run lint
npm run build
npx playwright install --with-deps chromium
npm run test:browser
```

Load `.output/chrome-mv3` as an unpacked extension in an **isolated test profile first**. Successful GitHub Actions runs provide a `bookmark-workspace-chrome` ZIP: extract it and select the directory containing `manifest.json` in Chrome's Load unpacked dialog. Export an external backup before using any new build with important bookmarks.

Chrome 116+ is the declared minimum because the extension uses the sidepanel API. Automated browser acceptance currently runs Chromium, not a separate Edge or Firefox compatibility matrix. The popup itself is used for quick save/search; "打开侧栏" opens the wider task surface and "展开到完整工作区" opens a normal extension tab.

For development use `npm run dev`. WXT starts a temporary profile; keep that isolation during testing. macOS has convenience scripts `open:chrome-ext` and `open:devdir`; on Windows/Linux open the extensions page/output directory manually.

## MiniMax configuration

Choose China (`api.minimax.cn`) or global (`api.minimax.io`), a model supported by your account, and enter your own key **in the extension**, never in source, issue text or chat. First-run setup can be skipped to keep using local features. “保存并测试连接” checks the chosen account/model with a fixed prompt containing no bookmarks. Automatic suggestions require a successful test, metadata-sharing consent and the separate “自动提供 AI 建议” opt-in. Changing the key, region or model requires a new test. The default is `MiniMax-M2.5`; output budget is configurable from 1024 to 16384 tokens.

Keys default to browser-session storage. Explicit "在此设备记住密钥" uses extension-local storage, not sync storage; it is not an encrypted credential vault. Region changes or clearing remove both copies. No shared service key is bundled.

With automatic suggestions enabled, capture first checks the current native bookmark tree for the exact URL. Existing pages show their saved locations with view/edit actions and do not trigger automatic AI; failed or pending checks also block advice. For confirmed-unsaved pages, the popup offers small title/folder suggestions beside the respective fields after the draft settles, explicit local search can show related references, and entering organization can suggest changes for a bounded current selection or visible set. Typing alone does not send workspace searches. Suggestions never overwrite the capture draft or write bookmarks automatically: apply “采用标题” and “采用位置” independently, then confirm capture, or review a workspace change plan. Requests may consume provider credits; switching off automatic suggestions leaves local features available.

Tests use synthetic bookmarks and mocked provider responses. Live model availability, real response quality, account billing and native permission-dialog UX remain separate manual acceptance items.

## Safety and scope

Preview → automatic snapshot → explicit review → execution → verified result. Deletion adds typed confirmation. A successful snapshot is mandatory; exporting it outside the extension is optional but important because clearing/uninstalling the extension may remove local data.

Recovery is not a promise of an atomic browser transaction. External edits, uncertain outcomes, missing evidence or repeated recovery attempts can be blocked for inspection. Recovery creates a new reviewed plan and avoids resetting the whole library.

Background page requests omit credentials. Static host checks cannot guarantee DNS-rebinding prevention. Sensitive/private bookmarks should remain excluded from AI and crawling. This extension does not provide full-page archival or bypass login requirements.

## Historical development records

Earlier phase reports remain in `docs/` for provenance. They describe earlier snapshots, not the current feature inventory or test coverage. The old phased guide must not be interpreted as a claim that all present UI/user journeys have passed acceptance; always check the exact commit's CI results.
