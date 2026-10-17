# Verification checkpoints

Baseline reviewed: `666363b8ea424b5ed6559bd084f89c96663d1d64`.
Baseline before implementation: 16 test files / 196 passing tests; typecheck and build
passed. Tests use fixtures, fake IndexedDB and mocked browser/network APIs unless a
suite explicitly starts its own loopback test server.

## Regression-first checkpoints

- Operation/sync: reproduced stale deletion, missing parent-ID mapping, disconnected
  plan steps and lost in-flight sync events before fixes. Added backup failure,
  protected-root/cycle, organization dependency and compensation conflict cases.
- Link health: added cancellation, already-aborted signal, HEAD-to-GET cancellation,
  trailing-dot hostname, DNS-result validation and independent 404 evidence cases.
- Assistant: multi-turn, stable/versioned citation URLs, unknown IDs, schema validation,
  scoped candidates, Chinese retrieval beyond 200 rows, new-folder proposals,
  cancellation/timeouts and revision conflict coverage. No live model requests.
- Content: inert HTML fixtures, permission checks per hop, bounded streams, timeout,
  private-host/redirect rejection, auth-page exclusion; no user pages fetched.
- Integration: actual Dexie compare-and-set persistence and content invalidation;
  cancellation/settings/key-clear preflight race tests.
- UI: folder trees, safe original URLs, permissions, dependent folder plans,
  selection and write gates. A separate browser suite covers the rendered extension.

## Automatic-guidance acceptance

The synthetic Chromium harness includes persistent first-run skip/reopen, a fixed
bookmark-free connection-test prompt, automatic search/organization suggestions,
consent and configuration gates, cancellation/stale-search invalidation, and popup
advice that requires explicit application before capture. These assertions must run
successfully for the exact build before being reported as browser-verified.

## Environment limits

The local cloud executor could not launch isolated Chromium because sandbox socket
creation was denied; an approved launch also failed in the environment wrapper. No
existing logged-in browser or real bookmark profile was used instead. Real-browser
acceptance is therefore run on an isolated CI runner. Do not describe the local unit
run as end-to-end browser verification.

## Reproducible gates

```sh
npm ci
npm test
npm run typecheck
npm run lint
npm run build
npx playwright install --with-deps chromium
npm run test:browser
```

A release candidate requires all gates green for its exact commit. Live MiniMax
account configuration, response quality and end-user extension installation remain
separate manual acceptance items. Never commit a real provider key or user bookmarks.
