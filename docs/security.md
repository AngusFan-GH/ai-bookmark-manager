# Security & Privacy Implementation Notes — Phase 2

> Source of truth for the Phase 2 (backup + safe write) implementation
> security model. Mirrors dev guide § 0.1 (red lines) and § 10
> (privacy checklist).

## 1. Red lines enforced

| Red line | Where enforced |
| --- | --- |
| No silent deletion / move / rename of native bookmarks | `OperationExecutor` is the ONLY file that calls `chrome.bookmarks.create/update/move/remove`. The UI never calls these directly. |
| No unapproved write | Every plan requires an `Approval` token to run. The executor rejects empty/missing/expired/mismatched tokens. |
| No reuse of approval tokens | Tokens are single-use. The store's `take()` returns and invalidates in one call. |
| No surprises on user data | The executor re-queries live state per step (`assertStillValid`) and halts the plan on any mismatch. |
| No remote code | The extension ships only built JS; no eval, no remote imports. |

## 2. JSON import safety

`validateImport()` (`src/domain/operations/import.ts`) enforces:

- **Size cap**: `MAX_IMPORT_BYTES = 50 MB` (callers may lower it).
- **Schema**: must be a JSON object with a positive integer
  `formatVersion` we know about (currently `[1]`).
- **Required fields**: `formatVersion`, `browserTree` (array).
- **Optional but validated**: `localIndex` shape.

`hasForbiddenKeys()` walks the entire payload and rejects:

```
apiKey, api_key, apikey, token, auth, authorization,
password, passwd, secret, session, cookie,
pageText, page_text, html, body, content,
chat, history, messages
```

These would never be expected in a bookmark backup. Their presence
in a payload indicates either a malicious JSON or a backup tool
leaking credentials. The UI surfaces a clear error and refuses the
import.

## 3. Plan safety

`PlanValidator` (`src/domain/operations/validator.ts`) checks:

- Plan and step ids are non-empty and unique.
- Every step's `action` is one of `create / rename / update / move / delete`.
- `delete` steps have a `targetBrowserId`; `create` steps have a `parentBrowserId`.
- Dependencies reference steps in the same plan.
- The dependency graph is acyclic (DFS-based cycle detection).
- `order` values are unique within a plan.
- High-risk steps (`riskLevel: 'high'`) carry a non-empty `reason`.

`OperationExecutor.run()` (`src/domain/operations/executor.ts`) further enforces:

- **Approval token required** for any non-empty plan.
- **Single in-flight** plan at a time (per dev guide § 2.1 single writer).
- **Re-validate live state** before every step via `assertStillValid`.
- **Halt on first failure**: subsequent steps are marked `skipped`,
  not failed, so the UI can show "we tried, here's where we stopped".
- **Compensation**: already-succeeded steps are rolled back in
  reverse order. Best-effort: failures here are recorded in the
  audit log, not raised.
- **Dry-run mode**: `execute({ dryRun: true })` runs every step except
  the actual `chrome.bookmarks.*` calls. Used by the UI for the
  "Preview" button and by tests.

## 4. Approval token semantics

`Approval` (`src/domain/operations/types.ts`):

```ts
{
  token: string;          // uuid v4
  planId: string;
  issuedAt: number;
  ttlMs: number;          // default 5 minutes
  confirmationHash: string | null;  // reserved for high-risk double-confirm
  issuedBy: string;       // 'options-ui' for now
}
```

Properties guaranteed by the executor and the store:

- **Single-use**: `take()` deletes the token after read.
- **Bound to a plan**: a token issued for plan X cannot execute plan Y.
- **Bounded lifetime**: the executor compares `Date.now() - issuedAt`
  against `ttlMs` and rejects expired tokens.
- **Issued by user action**: tokens are minted only inside
  `PlanService.approve(planId)`, which is called by the background
  router in response to a typed `APPROVE` request from the UI —
  never from a model or a third-party message.

## 5. Audit log

`audit` Dexie store (`src/infrastructure/database/db.ts`) records:

```ts
{
  id, planId, stepId, action, targetBrowserId, status, message, recordedAt
}
```

Per dev guide § 4.2: "操作日志不可被普通同步清理". The audit store is
**not** touched by `SyncCoordinator.fullSync()`; it is only appended
to by the executor. The audit is the user's record of what actually
happened, regardless of how the local bookmark index evolves.

## 6. Snapshot / undo

`SnapshotService` (`src/domain/operations/snapshots.ts`) captures a
tree + local index + syncGeneration at a moment in time. The plan
service takes a snapshot before any execution starts; this is the
data a future undo action would replay.

Snapshots are bounded by:

- The plan that triggered them (a `planId` foreign key).
- The syncGeneration at the time of capture (lets a future restore
  detect drift).

## 7. UI flow (Phase 2 only — Phase 3+ extends)

```
user selects JSON file
  → IMPORT_PREVIEW (rawJson, mode)
       → diff is computed; preview shown
  → user clicks "Create Plan"
  → PLAN_DRAFT (rawJson, mode)
       → plan + steps + snapshot persisted; status='draft'
  → user reviews steps
  → user clicks "Approve"
  → APPROVE (planId, ttlMs?)
       → token issued; plan.status='approved'
  → user clicks "Execute"
  → EXECUTE (planId, token, dryRun?)
       → executor runs; status='completed' or 'partially_completed'
       → audit log appended for every step
```

There is no path that lets the UI write to the browser without
explicitly walking this chain. Dev guide red line #1 is satisfied.

## 8. Privacy checklist (dev guide § 10)

- [x] Default read-only. The only writes happen through the chain above.
- [x] Host permissions declared in manifest; no expansion without a
  release (Phase 3 will add per-site `<all_urls>`-style requests for
  link scanning, with explicit UI consent).
- [x] JSON export omits API keys, auth, page text, chat history
  (`exportBackup` in `entrypoints/background.ts`).
- [x] Import rejects forbidden keys via `hasForbiddenKeys()`.
- [x] UI uses Vue's `{{ }}` text binding; no `v-html` is used in
  `entrypoints/options/App.vue` or `entrypoints/popup/App.vue`.
- [x] CSP set by WXT; no `unsafe-eval` for extension pages.
- [x] AI caching, embeddings, chat history: not in MVP. Phase 5+ will
  add explicit user controls.
- [x] Telemetry: not enabled.

## 9. What is NOT in Phase 2

These are listed so the next-phase agent can confirm whether they
need to be added:

- **Per-step UI confirmation** for high-risk steps (delete, etc.).
  Phase 2 currently surfaces `riskLevel` on each step; the UI is
  expected to require a second click for `riskLevel: 'high'`. The
  executor does not enforce a separate high-risk check; that is a
  UI-side concern. Tests for the UI flow are out of Phase 2 scope.
- **Undo UI**: snapshots are captured, but a `rollbackPlan(planId)`
  message is not yet wired. Phase 3 or later.
- **Re-execute a failed plan**: requires a new approval token. The
  executor's "single-use" guarantee means replaying a plan needs a
  fresh `APPROVE` request from the UI.
- **CSRF / cross-extension validation**: the message handler already
  checks `sender.id === chrome.runtime.id`, but a thorough review of
  MessageChannel / port.postMessage is left for Phase 3+ when
  long-lived connections are introduced.
