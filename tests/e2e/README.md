# Synthetic browser acceptance

Run from repository root with Node 20+:

```sh
npm run build
npx playwright install --with-deps chromium
E2E_HEADED=1 PW_CHROMIUM_ATTACH_TO_OTHER=1 xvfb-run -a npm run test:browser
```

CI uses headed Chromium under Xvfb, Openbox and a D-Bus session so native extension chrome has window-manager support. It installs distro `openbox`, `xdotool` and `dbus-x11`, then sets `E2E_NATIVE_POPUP=shortcut` to invoke a test-only `_execute_action` shortcut (Ctrl+Shift+Y) in the copied manifest. The production manifest is unchanged; the actual browser action gesture supplies active-tab access. This replaces a programmatic `chrome.action.openPopup` path that crashed Chromium in the previous CI environment. The pinned Playwright implementation requires `PW_CHROMIUM_ATTACH_TO_OTHER=1` to attach extension action popup targets classified as CDP `other`; this is a runner-only setting, not an application modification. Target discovery is retained in `popup-targets.json`. The persistent context uses `viewport: null`; only ordinary workspace pages receive explicit viewport emulation, so the native popup retains its browser-managed dimensions. Set `E2E_HEADED=1` on a desktop with a display, or use the Xvfb command above on Linux. Omit it for headless diagnostic runs; native action popup support is not assumed there.

Use `CHROMIUM_PATH` for a specific Chromium binary, never an existing browser profile. Artifacts default to `/tmp/bookmark-e2e-artifacts`; override with `E2E_ARTIFACT_DIR`.

## Isolation

The harness creates and removes its own temporary profile and a copy of the production extension. Only that copy receives a service-worker fetch mock and pregranted MiniMax hosts. All worker requests are mocked or rejected; page requests are blocked except a locally fulfilled `https://example.test/` fixture. No real API key, website account, paid model call or user bookmarks are used.

Pregranting avoids the native permissions dialog; the suite does **not** prove that dialog's interactive flow. Provider responses are synthetic, not evidence of live MiniMax model availability or quality.

## Assertions

- Built MV3 workspace and native nested/empty folders synchronize to actual IndexedDB.
- Fresh-profile onboarding can be skipped and stays dismissed after reload without provider requests. Settings can be reopened; connectivity testing sends a fixed prompt with no bookmark data.
- Visible settings reject an empty model inline; cancel does not save; explicit remember-key choice is persisted.
- Explicit local search can show automatic references without replacing its local result table; organization suggests only the bounded visible scope and does not write bookmarks. Automatic requests can be canceled or invalidated by changed search, and a tested key without consent does not transmit data.
- Two visible composer turns retain provider context, exact URL and stable citation; history is reopened after reload.
- AI folder creation/dependent move requires readable plan, automatic snapshot and explicit review; repeated execution is unavailable. Backup export works before and after execution, without the synthetic key.
- Visible recovery generates and executes a separately reviewed inverse plan.
- Duplicate selection leaves one copy, requires exact typed delete confirmation, reports zero results and invalidates results after changing folder scope.
- Visible manual add validation, edit and move preserve original URL.
- Tools preserve the main local search/table.
- Import uses the visible file chooser twice for the same backup, resets to additive mode on reopening, requires explicit review, and restores deleted synthetic nested folders and original leaf URL.
- Health renders unsafe schemes as nonclickable text. It does not run a live website scan.
- Mocked 429 and aborted provider requests retain the draft; retry succeeds.
- AI selection scope transmits exactly one explicitly selected bookmark.
- Workspace/import/health/sidepanel screenshots at 390, 768, 1024 and 1440 px assert no document-level horizontal overflow. Keyboard local search is exercised.
- Opted-in popup advice appears inline after a native unsaved-page lookup, without overwriting title/folder fields or saving. Each field has a separate apply action. Reopening a saved URL shows all current locations, including a newly added native copy without explicit sync, and offers view/edit with no automatic AI calls. A synthetic native-tree failure pauses advice and exposes a retry action.
- The actual extension action popup is opened with a browser action keyboard shortcut under CI; active synthetic page quick-save and local popup search are exercised.
- Uncaught workspace/popup errors fail the run.

A PASS line is emitted only after its assertions run. `report.json` records completed checks and any failure; a build or syntax check alone is never browser acceptance. Popup native-window behavior, layout and selector compatibility must be established by a full Chromium run. Sidepanel screenshots load its real extension document, not the browser's native sidepanel shell.

## Environment history

The earlier nine-check suite passed in GitHub Actions on 2026-10-16. Local Chromium launch in the assistant execution sandbox was blocked by process socket restrictions, so runtime validation uses isolated CI. The expanded suite must pass against the redesigned build before its new assertions can be called verified.

## Human-use regression matrix

| Journey | Rendered browser evidence | Negative / boundary coverage |
| --- | --- | --- |
| First install | Local-only exit and save/test actions are hit-testable at 390×600, 768×720 and 1440×1000 | Missing key stays inline, makes no provider call, and leaves onboarding incomplete |
| AI setup | Save/cancel controls stay in the viewport; advanced form scrolls independently | Empty model validation; cancel preserves settings; fixed connectivity prompt excludes bookmarks |
| Search and scope | Local result table, two-turn conversation, historical session and selected-only scope | Canceled/stale suggestions; missing consent; stale history rejected before transmission; 429 retains draft |
| Native popup | Before-save inline advice, quick save and multiple current native locations | Applying one suggestion leaves other fields intact; failed authoritative lookup pauses advice; retry recovers without saving |
| Review and recovery | Readable native add/edit/move and AI dependent folder/move plans | Approval gate, exact typed deletion, repeat-execution block, separate inverse-plan review |
| Import | File chooser, additive preview and nested native recovery | Same-file reopening resets advanced merge; explicit review required; original URL preserved |
| Health and tools | Unsafe URLs remain plain text; return action stays hit-testable | No real external scan; opening tools preserves search state |
| Responsive / keyboard | Workspace, dialogs and sidepanel document at four widths | Document overflow plus actual local-search control bounds; keyboard search and focus movement |

Settings and popup evidence includes new short-viewport and pre-save screenshots. A screenshot's existence does not prove its assertion passed: use the matching run's report. The suite does not claim complete WCAG conformance, screen-reader testing, live health classification, permission-dialog acceptance, or live provider quality.

On 2026-10-17 the baseline 28-check run (38992898370, commit e9f8c661) was visually audited. First-run/settings and health dialogs had actions below the initial viewport, which motivates the new footer geometry checks. A fresh temporary-profile cloud-shell Chromium launch again failed before rendering with `socket() failed: Operation not permitted`; no permission bypass or existing profile was used. The expanded checks require a subsequent isolated CI run before being considered verified.
