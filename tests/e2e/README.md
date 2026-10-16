# Isolated browser acceptance

Run from the repository root:

```sh
npm run build
node tests/e2e/browser-smoke.mjs
```

The script requires Node 20+, the repository's Playwright development dependency, and Playwright Chromium (`npx playwright install --with-deps chromium`). It defaults to the bundled Chromium channel, which supports headless extensions. Set `CHROMIUM_PATH` to test a specific local Chromium binary. Do not point it at an existing browser profile.

## Isolation and mocked network

- Creates a fresh `mkdtemp` profile; never connects to an existing browser, CDP port, user profile, or logged-in account.
- Copies the built extension into that temporary directory. The production `.output` files and implementation are unchanged.
- Adds a **test-only** fetch mock before the copied background bundle executes. Every service-worker fetch is either answered locally by the mock or rejected. The mock provider does not make HTTP requests.
- Adds global MiniMax host permission to the **temporary manifest only**, and supplies a synthetic key. This avoids an interactive permission dialog during synthetic acceptance. It does not test live MiniMax credentials, service availability, or the permission prompt.
- Seeds native Chromium bookmarks exclusively with `example.test` URLs. Recovery deletes only the synthetic source folder created during this run.
- Closes the browser and removes only its own temporary directory in `finally`.

## Coverage

1. Built MV3 extension loads and options workspace renders.
2. Real native nested bookmark tree synchronizes to actual IndexedDB and renders.
3. Exact-URL duplicate preview identifies a pair without mutation.
4. Two-turn mocked provider conversation retains full context, stable citation and original URL; history survives options-page reload.
5. Visible AI new-folder and dependent move flow requires preview, downloaded backup, explicit checkbox approval, then native execution. Repeated execution is disabled.
6. Selected duplicate deletion requires a second, exact typed confirmation in addition to backup and approval.
7. Real exported backup passes preview and additive recovery through production messaging/executor. Newly created nested folders retain the original leaf URL.
8. No uncaught options-page errors.

The AI turn setup and recovery use runtime messages from the extension page; move review/backup/approval/execution use visible UI controls. This distinction is deliberate: the test exercises actual extension storage and native bookmark API while isolating paid/external AI calls.

Artifacts default to `/tmp/bookmark-e2e-artifacts` (override `E2E_ARTIFACT_DIR`), including JSON report, downloaded synthetic backup, and success/failure screenshot. A PASS line means the assertion was executed. A successful build or syntax check does **not** mean browser acceptance passed.

## Current environment blocker (2026-10-16)

Initial execution was blocked before the extension launched. Chromium failed creating its process socket under the execution sandbox (`socket() failed: Operation not permitted`). The approved-escalation route also failed before running Node because the environment launcher could not create its session mount (`Read-only file system`). No browser acceptance assertions have passed in this environment yet. Re-run in an environment permitting an isolated Chromium process; do not substitute a logged-in browser profile.
