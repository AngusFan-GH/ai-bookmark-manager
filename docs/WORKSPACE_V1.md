# Task-oriented bookmark workspace (0.2)

## Product and source of truth

Two goals drive the UI: manage native bookmarks completely, and use saved material to solve real tasks. The browser owns bookmark titles, original URLs, folders and order. IndexedDB holds the searchable mirror, extracted snippets, conversations, plans, snapshots and audit evidence.

The goal box provides local search and an explicit AI conversation action. After setup and separate automatic-suggestion opt-in, submitting a local search also offers bounded related-reference guidance; entering organization offers a plan suggestion for selected or visible bookmarks (at most 20). Ordinary typing does not send workspace search data. A conversation uses unified `assist` mode; users need not select a model task mode. Legacy recommend/organize sessions remain readable. Fixed scope includes folder descendants, an optional literal query, and optionally 1–60 selected bookmark IDs. The UI shows the scope; proposals never expand it silently.

## Entry points and actions

- Popup: editable current-page save, existing-URL detection, up to five local results, optional title/folder advice, full-workspace capture handoff. Captures are stored under opaque session IDs and expire after an hour.
- Workspace: dynamic browse/conversation/change-review surface; directory and history drawers. Direct CRUD works without MiniMax.
- Sidepanel: same workspace document, with expansion to a full tab. Browser shell behavior is distinct from document rendering tests.
- Tools: backup/import and link health, not another full manager. Tool query state is isolated from the main workspace.

Explicit folder deletions expand to child-first reviewed steps, capped at 500 steps. Prepared operations are checked again against native browser state. Multi-step editing projects expected state so an update followed by a move does not become stale because of its own update.

## AI and trust

MiniMax returns structured references and proposals: existing-ID moves, title edits, deletion proposals and new folders. Unknown fields/IDs, generated action URLs, unsupported shapes and conflicting action targets fail validation. Safe complete JSON wrappers and omitted empty proposal lists are accepted. No partial JSON repair is used to invent operations.

All cited URLs are mapped from stored records. Limited metadata/text is evidence, not proof that the whole original article was read. Fresh-query relevance takes priority over a bounded set of recent references. Large scopes may use a small query-expansion call before the final response; folder catalogs and candidate lists are bounded. Invalid expansion falls back to ordinary retrieval and does not broaden scope.

New-bookmark advice is ephemeral and returns only a title, an existing folder and a reason, never a generated URL or a browser write. When automatic suggestions are enabled, the popup debounces draft changes and cancels stale requests. Capture first performs an exact-URL lookup against the current native bookmark tree rather than the search index. Existing pages show every saved location and view/edit actions, with no automatic AI request. Pending or failed membership checks do not authorize AI. For confirmed-unsaved pages, compact suggestions appear beside their corresponding fields; “采用标题” and “采用位置” independently change only that draft field, and “确认收藏” is still required to save. Local capture remains available if setup is skipped or AI fails. Workspace guidance remains separate from the local result table and requires the existing preview and approval flow for native writes.

## Credentials, privacy and content

Regional endpoints: `https://api.minimax.cn/v1/chat/completions` and `https://api.minimax.io/v1/chat/completions`. Exact provider permission and data-sharing consent are required. Personal BYOK is supported; a shared commercial provider key requires a server-side design and is not bundled here.

Session-only key storage is default. Optional local persistence is explicit, region-bound, restricted to trusted extension contexts where supported, not additionally encrypted, not synced, and excluded from exports/history/logs. Clearing or changing region removes both copies; storage failures block further use until resolved. Saving settings alone is not a connectivity test. The first-run guide offers a persistent local-only skip path and can be reopened through AI settings. “保存并测试连接” sends only a fixed test prompt, with no bookmark metadata, URLs or conversation history. Automatic suggestions require a successful test for the current region/model/key, metadata consent and a separate opt-in; changing connection details invalidates that test.

Excluded folders apply recursively to outbound AI data. Known private hosts, credential-bearing URLs and recognizable secret/signature parameters are conservatively excluded. This is not a universal secret detector. Historical transmitted candidate records, including uncited ones, are revalidated against current policy; moved/excluded/changed resources require a fresh task rather than resending stale history.

Content enhancement defaults off. When explicitly enabled, a turn can read at most three relevant pages only if their host access is already granted; no new permission dialog is silently triggered. Matching cached text is reused for seven days. User-selected extraction supports up to 50 items. Fetches omit credentials/referrer, do not execute scripts, revalidate redirect targets, and are bounded to 12 seconds/1 MiB/12,000 characters. Only a limited snippet is sent to the model. Content can be inspected by status and cleared; dynamic/login/PDF content may not be readable.

## Backup, approval and recovery

Draft creation persists an exportable preview snapshot. Execution captures a second fresh durable snapshot before native writes. Both include available local index metadata, but default exports exclude secrets, conversations and page text. The UI requires explicit review; manual external download is optional. Deletions need typed confirmation.

Historical backup export remains available after execution. Targeted recovery prepares a new plan using verified before/after evidence, preserves unrelated additions, maps recreated folder IDs, and blocks conflicts or ambiguous histories. It is not a blanket rollback guarantee; see `src/domain/operations/RECOVERY.md`.

External import defaults to additive mode. Controlled merge is advanced and matches browser IDs, not title similarity; it can modify/delete entries absent from the backup. Cross-profile identity is not interchangeable. Unsupported metadata-merge promises are removed. Reopening resets the mode, repeated file selection works, and going back after approval creates a fresh draft/review cycle rather than reusing a consumed token.

## Verification and remaining limits

Vitest covers domain, persistence, router races, privacy, popup, editor and mounted tool/workspace interactions. Playwright loads the built extension in an isolated Chromium profile with synthetic bookmark data and mocked MiniMax. The test-only fetch bootstrap is added only to a temporary build copy, not the distributed artifact. Native permission dialogs are pregranted in tests; live model quality is not mocked coverage.

CI artifacts include screenshots/report and a production unpacked extension only when all gates succeed. Check exact commit CI rather than relying on an earlier test count. No real user bookmarks or account keys are used by automated acceptance.

Not included: a shared hosted-key service, Firefox validation, full archival/dynamic-page rendering, an independent tag system, notes editor, reading streaks, automatic whole-library reorganization, or silent deletion. Browser service-worker suspension/crashes remain non-transactional; uncertain outcomes must be inspected rather than blindly retried.
