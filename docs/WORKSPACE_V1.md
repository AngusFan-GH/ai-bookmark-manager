# Bookmark workspace implementation

This branch replaces the admin-first landing page with a native bookmark workspace.
The browser remains the source of truth; Dexie stores the index, content snippets,
conversations, plans, snapshots and audit records.

## Two workflows

1. **Organize**: select a scope, inspect exact-URL duplicates or ask MiniMax for grouping
   suggestions, select moves, preview the resulting plan, export its backup, explicitly
   approve, then execute. Model output never directly calls the bookmark API. Proposed
   new folders must have an existing parent and are created before dependent moves.
2. **Find references**: create a scoped conversation and ask for relevant saved material.
   Refine in subsequent turns; references map to stored bookmark IDs and original URLs.
   Citation snapshots are stable across ordering changes and versioned on URL changes.

## Running locally

```sh
npm ci
npm test
npm run typecheck
npm run lint
npm run build
```

Load `.output/chrome-mv3` as an unpacked extension in an **isolated test browser profile**
first. Do not use real bookmarks for acceptance testing. The popup opens the workspace;
backup import/export and link-health tools remain available in the secondary tools dialog.

## MiniMax and data handling

The implementation currently supports a personal, session-key connection with explicit
consent. The regional endpoints are `https://api.minimax.cn/v1/chat/completions` and
`https://api.minimax.io/v1/chat/completions`. Keys are kept in `chrome.storage.session`,
not IndexedDB, sync storage, exports or logs. No key is bundled. Changing region clears
the old key. The user grants the exact provider origin from a settings click.

Default configurable model: `MiniMax-M2.5`. This is a conservative supported default,
not a claim about the latest model. Requests are non-streaming in this iteration, with
loading/cancel/error states. Live API access and model-account compatibility require
separate verification with the owner's chosen account; automated tests use synthetic
responses only.

MiniMax recommends keeping keys out of client code. This personal-BYOK design is a
security tradeoff, not suitable for distributing a shared provider key. A multi-user
service must use a trusted server proxy and its own authentication/rate limits. The
owner's deployment choice remains to be confirmed.

A turn transmits the question, prior provider conversation, bounded candidate bookmark
metadata and optional extracted snippets. Candidate selection scans the full local
corpus then caps the request; the UI discloses how many items were included/omitted.
A broad request may need a narrower folder scope. Metadata-only results must not be
presented as verified article summaries. Provider reasoning is retained internally for
multi-turn protocol continuity and is not sent to the UI.

## Optional content extraction

Selected pages are fetched only after a user action and exact-origin permission.
Requests omit credentials and referrer, do not execute page scripts and revalidate
manual redirects. Limits: 12 seconds, 1 MiB response, 12,000 extracted characters.
Static HTML only; dynamic/login-protected/PDF pages may be unavailable. Unknown content
is not inferred. Static host guards do not provide DNS-rebinding protection; sensitive
intranet bookmarks should not be crawled. Browser-hidden redirect destinations fail
closed.

## Backup and execution guarantees

- Preview snapshots can be exported before approval.
- A fresh durable snapshot is captured before actual native writes. Failure prevents
  writes. Snapshot metadata includes the local bookmark/folder index.
- Every targeted native item is rechecked against preview state.
- Nested restores map newly assigned native IDs before child operations.
- Only one execution runs at a time; approval tokens are one-use and bound to a plan.
- Automatic compensation checks observed post-write state and refuses to overwrite
  external edits. Deletes cannot be automatically compensated; use the backup.
- A browser crash between a native write and its audit persistence is inherently
  non-transactional. Inspect the native tree before retrying; do not blindly reapply.

Restoration is exposed through backup import with preview and a new approval. Additive
restore avoids deleting new unrelated entries. Controlled merge can delete entries
created since the backup: inspect the complete diff before choosing that mode. Browser
IDs/timestamps may change on reconstruction. This is not an unconditional full-state
undo guarantee. Default exports exclude conversations, page text and secrets; no
additional tags/notes editing is shipped in this iteration.

## Tests and limitations

`npm run test:browser` runs the production extension in a temporary Chromium profile
with synthetic bookmarks and mocked MiniMax responses. It changes only a temporary
copy of the built service worker to install its network mock; the shipped build is
unchanged. Screenshots/results go to `E2E_ARTIFACT_DIR` (or an OS temporary directory).
Install test browser with `npx playwright install --with-deps chromium` first.

GitHub Actions `Verify bookmark workspace` runs unit/integration tests, typecheck,
lint, build and browser acceptance on feature pushes/PRs. Passing unit tests alone does
not establish native-browser behavior or real MiniMax quality. See CI result for the
specific commit and `docs/TESTING_WORKSPACE.md` for checkpoints.

Deferred: continuous streaming, full-page archival/dynamic rendering, semantic vector
index, autonomous write agents, scheduled full-library crawling and server-hosted keys.
