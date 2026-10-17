# Link Health Implementation Notes — Phase 3

> Phase 3 implements the link health pipeline from dev guide § 3.4.
> This document is the implementation reference; the audit report
> (`docs/phase-3-report.md`) is the user-facing summary.

## 1. Module map

```
src/domain/health/
  types.ts       LinkStatus, LinkCheckRecord, HealthConfig
  url-guard.ts   guardUrl(), guardResolvedHost(), isPrivateLiteralAddress()
  classifier.ts  classify() — pure function from inputs to LinkStatus
  fetch-client.ts  fetchOnce(), probeUrl(), shouldRetryAsGet()
  scheduler.ts  TaskScheduler — concurrency, retries, host gating
  service.ts     HealthService — façade used by the background router

```

## 2. LinkStatus values

| Value | Meaning | When |
| --- | --- | --- |
| `unchecked` | Never scanned | Initial state |
| `checking` | In flight | `TaskScheduler` is running a probe |
| `unchecked` | Not scanned | No current result exists for this bookmark URL |
| `outdated` | Old result | Bookmark URL or sync version changed after its last check |
| `healthy` | 2xx observed | Bounded GET returned 2xx without a detected warning; this is not proof of useful content |
| `redirected` | 3xx followed | A platform adapter safely followed the redirect |
| `redirect_pending` | Redirect needs review | Browser hid the manual redirect target, so it was not followed |
| `auth_required` | 401 / 407 | Not dead; needs login |
| `forbidden` | 403 | Not dead; site gates bots |
| `rate_limited` | 429 | Server sent `Retry-After`; we honor it |
| `suspected_dead` | 404 / 410 first hit | Needs retry window before promotion |
| `repeated_not_found` | Repeated GET 404 / 410 | Observed missing twice; requires manual review, not proof of permanent loss |
| `confirmed_dead` | Legacy record only | Displayed as repeated not-found; requires fresh evidence before removal review |
| `suspected_soft_404` | 2xx error-page signals | Tentative local content heuristic, not deletion evidence |
| `suspected_login` | 2xx login-page signals | Tentative content restriction, not deletion evidence |
| `network_error` | DNS / TCP / TLS / 5xx | Retryable; classifier treats 5xx the same as a network error |
| `unsupported` | unsafe URL | Static guard rejected the URL |
| `permission_required` | Extension lacks host permission | Not auto-resolvable; needs user grant |

## 3. The classifier

`classify(inputs: HealthInputs): HealthClassification` is a pure function.

The state machine is intentionally conservative:

- 401/407/403/429/5xx **never** become "dead" on the first hit.
- A bounded GET can verify HEAD results and inspect text evidence; 429, cancellation and hidden redirects do not trigger immediate fallback requests.
- 404/410 is `suspected_dead` on the first GET hit and `repeated_not_found` after a second GET check. Short retry spacing does not establish permanent loss. Each observation retains its method, code and time.
- 429 carries `retryAfterSec` so the scheduler can sleep that host.
- Network errors have no httpCode at all; we record the stage
  (`dns` / `tcp` / `tls` / `abort` / `unknown`).

The classifier never deletes bookmarks. The workspace may prepare a removal plan only after explicit manual review and selection, with current URL/sync evidence checks. Execution still requires an approved fixed preview and a successful backup. Suspected login/soft-404 and legacy records are not removal evidence.

## 4. URL guard

`guardUrl()` is the static half. It rejects:

- Any non-`http(s)` scheme (`file:`, `javascript:`, `chrome:`, `data:`, `ftp:`)
- URLs with embedded `user:password@` credentials
- The loopback hostnames `localhost`, `broadcasthost`, `ip6-localhost`
- Local suffixes `.local`, `.internal`, `.lan`
- Literal IPv4 in: `10/8`, `172.16/12`, `192.168/16`, `127/8`, `0/8`,
  `100.64/10` (CGNAT), `169.254/16` (link-local), `192.0.0/24`,
  `192.0.2/24` (TEST-NET-1), `198.51.100/24` (TEST-NET-2),
  `203.0.113/24` (TEST-NET-3), `224/4` (multicast+)
- Literal IPv6 (we conservatively reject all hex-form hosts)

`guardResolvedHost()` remains an injectable helper for platforms that
provide a trustworthy resolver. Standard browser extension service workers
do not provide a portable DNS API, so production relies on static URL
screening, user-granted host permissions, and manual redirect handling.

## 5. The fetch client

Two policies:

1. **HEAD first.** A 2xx HEAD is a cheap positive signal.
2. **Confirm any non-2xx or failed HEAD with GET.** CDN/WAF method rules
   frequently make a HEAD-only failure misleading.

The actual HTTP is done by a `fetch: FetchLikeFn` dependency that the
background router supplies — in production it wraps the global
`fetch()` with an `AbortController`; in tests we use Node's `http`
client (to bypass happy-dom's same-origin policy).

Hard limits:

- 10 s timeout (configurable via `HealthConfig.timeoutMs`)
- 1 MB response body cap (configurable via `maxResponseBytes`)
- Production requests use `redirect: 'manual'`; an opaque redirect is marked
  `redirect_pending`, not dead or unsupported, and its target is never fetched
  automatically.
- `Retry-After` header is parsed to a number of seconds and surfaced
  to the scheduler.

## 6. The scheduler

`TaskScheduler` is a work queue with:

- **Global concurrency cap** (default 5)
- **Per-host concurrency cap** (default 1)
- **Per-host rate gate** — when a probe returns `rate_limited`, the
  host is paused for `Retry-After` seconds
- **Retry budget** — `maxRetries` (default 2) retries on `network_error`
- **Single-flight per item** — `cancel(id)` removes the item and
  aborts the in-flight probe
- **`drain()`** — async wait for everything to finish (used in tests
  and the UI's "等待扫描结束" path)

`HealthService` wraps the scheduler and:

- Reads bookmarks from Dexie, filters to those with URLs
- Requires an explicit optional host permission before any request; otherwise
  it persists `permission_required` without calling fetch
- Runs `guardUrl()` for each; rejected URLs are persisted as a single
  `unsupported` record
- The remaining items go to the scheduler
- `snapshot()` returns one result per current bookmark URL; results from an
  older URL or sync generation are marked `outdated`
- `startHealth()` accepts an optional subset of bookmark ids

## 7. The classifier in the test matrix

`tests/integration/fetch-client.test.ts` runs a real Node HTTP server
(`tests/fixtures/mock-http-server.ts`) that returns arbitrary status
codes / headers / bodies. The matrix:

| Status | Classifier says |
| --- | --- |
| 200 | healthy |
| 204 | healthy |
| 301 | redirected |
| 302 | redirected |
| 307 | redirected |
| 401 | auth_required |
| 403 | forbidden |
| 404 (first hit) | suspected_dead |
| 404 (after retry) | repeated_not_found |
| 410 (first hit) | suspected_dead |
| 410 (after retry) | repeated_not_found |
| 429 (+Retry-After) | rate_limited; surfaces retryAfterSec |
| 500 | network_error |
| 502 | network_error |
| 503 | network_error |
| 504 | network_error |
| 405 (HEAD) | classifier not invoked; client falls back to GET |

In addition the URL guard is tested against every entry in
RFC 5735 / RFC 6890.

## 8. Dev guide § 3.4 acceptance criteria

- ✅ 200 / 301-302 / 404-410 / 401 / 403 / 429 / 500 — all covered
- ✅ HEAD=405 → GET fallback — covered
- ✅ Timeout — covered
- ✅ Redirect safety — production uses manual redirects and refuses opaque targets
- ✅ Soft 404 — not implemented in Phase 3 (requires page body
  parsing; deferred to Phase 4 or later as the dev guide says it
  requires user authorization for body fetching)
- ✅ No permission / no network — handled
- ✅ Local URL — handled (URL guard)
- ✅ Task interrupted — `TaskScheduler.cancel(id)` + AbortController
- ✅ No code path deletes a bookmark — confirmed by grep on
  `chrome.bookmarks.remove` and by OperationExecutor review

## 9. Privacy checklist (dev guide § 10)

- [x] Default does nothing — health scans are user-initiated.
- [x] Host permission for fetching is optional and is requested only after the
  user clicks the health-page authorization control.
- [x] Page bodies are not stored — only status / final URL / response
  code / small evidence strings. `LinkCheckRecord.evidence` holds
  things like `['200']` or `['→ https://final.example.com']`, never
  the body.
- [x] We do not carry auth headers or cookies. Default `fetch` does
  not.
- [x] UI uses text binding; no `v-html`.

## 10. What is NOT in Phase 3 (deferred)

- **Soft 404 detection** (body fingerprinting). Requires
  user-authorized body fetch and a corpus of "real article" vs
  "404 page" signatures.
- **Auto re-scheduling / service-worker recovery**. The current UI runs one
  scan per click; in-memory queued work is not restored after a worker restart.
- **Bulk recheck selection UI** — the `selectedIds` ref is reserved.
- **Per-host export** — not requested by the dev guide.

## 0.3 content-evidence boundary

The browser adapter uses credentials `omit`, manual redirects, and at most 64 KiB of explicitly textual GET content. Raw body text is transient and is not stored or sent to AI by health classification. Soft-404/login signals are local heuristics and can miss JavaScript-rendered or localized pages. A healthy HTTP response is not a content-quality guarantee. Service-worker restarts do not transparently resume an in-memory scan; completed persisted observations remain available.
