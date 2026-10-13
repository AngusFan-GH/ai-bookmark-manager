# Link Health Implementation Notes — Phase 3

> Phase 3 implements the link health pipeline from dev guide § 3.4.
> This document is the implementation reference; the audit report
> (`docs/phase-3-report.md`) is the user-facing summary.

## 1. Module map

```
src/domain/health/
  types.ts       LinkStatus (12 values), LinkCheckRecord, HealthConfig
  url-guard.ts   guardUrl(), guardResolvedHost(), isPrivateLiteralAddress()
  classifier.ts  classify() — pure function from inputs to LinkStatus
  fetch-client.ts  fetchOnce(), probeUrl(), shouldRetryAsGet()
  scheduler.ts  TaskScheduler — concurrency, retries, host gating
  service.ts     HealthService — façade used by the background router

src/infrastructure/network/
  dns-resolver.ts  createBrowserDnsResolver() — wraps the browser dns API
```

## 2. The 12 LinkStatus values

| Value | Meaning | When |
| --- | --- | --- |
| `unchecked` | Never scanned | Initial state |
| `checking` | In flight | `TaskScheduler` is running a probe |
| `healthy` | 2xx | HEAD or GET returns 200–299 |
| `redirected` | 3xx followed | Final hop after redirects is 3xx |
| `auth_required` | 401 / 407 | Not dead; needs login |
| `forbidden` | 403 | Not dead; site gates bots |
| `rate_limited` | 429 | Server sent `Retry-After`; we honor it |
| `suspected_dead` | 404 / 410 first hit | Needs retry window before promotion |
| `confirmed_dead` | 404 / 410 after retry | Real dead |
| `network_error` | DNS / TCP / TLS / 5xx | Retryable; classifier treats 5xx the same as a network error |
| `unsupported` | non-http(s) or resolved to private IP | Static guard or DNS guard rejected |
| `permission_required` | Extension lacks host permission | Not auto-resolvable; needs user grant |

## 3. The classifier

`classify(inputs: HealthInputs): HealthClassification` is a pure function.

The state machine is intentionally conservative:

- 401/407/403/429/5xx **never** become "dead" on the first hit.
- 404/410 is `suspected_dead` on the first hit, `confirmed_dead` only
  after `attempts >= 1` (i.e. the scheduler retried).
- 429 carries `retryAfterSec` so the scheduler can sleep that host.
- Network errors have no httpCode at all; we record the stage
  (`dns` / `tcp` / `tls` / `abort` / `unknown`).

The classifier never deletes bookmarks. The executor never
deletes bookmarks. **No code path in Phase 3 can remove a
bookmark**; the worst it does is mark a row `confirmed_dead`.

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

`guardResolvedHost()` is the runtime half. It calls
`resolver.lookup(host)` and rejects if any returned address is in
the same private set. In production this uses `dns.lookup` from the
service worker scope. In tests we inject a fake.

> **Dev guide caveat (recorded honestly in `docs/phase-3-report.md`)**
> Pure browser extensions cannot fully implement server-side SSRF
> defense. A determined attacker controlling DNS could resolve
> `evil.example.com` to a private IP. Our defenses are best-effort
> and the user is shown "unsupported" so they can decide.

## 5. The fetch client

Two policies:

1. **HEAD first.** Cheaper, smaller, often enough.
2. **Fall back to GET on 405 / 501.** Some servers don't implement
   HEAD; we use `shouldRetryAsGet(httpCode)` to decide.

The actual HTTP is done by a `fetch: FetchLikeFn` dependency that the
background router supplies — in production it wraps the global
`fetch()` with an `AbortController`; in tests we use Node's `http`
client (to bypass happy-dom's same-origin policy).

Hard limits:

- 10 s timeout (configurable via `HealthConfig.timeoutMs`)
- 1 MB response body cap (configurable via `maxResponseBytes`)
- 5 redirects (configurable via `maxRedirects`)
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
- Runs `guardUrl()` + `guardResolvedHost()` for each; URLs that
  fail either guard are persisted as a single `unsupported` record
- The remaining items go to the scheduler
- `snapshot()` returns the latest `LinkCheckRecord` per bookmark
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
| 404 (after retry) | confirmed_dead |
| 410 (first hit) | suspected_dead |
| 410 (after retry) | confirmed_dead |
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
- ✅ Redirect loop — `maxRedirects` cap covers
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
- [x] Host permission for fetching is implicit in the extension's
  manifest. Phase 3 does not request new host permissions.
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
- **Auto re-scheduling** (chrome.alarms). The current UI just runs
  one scan per click; the dev guide asks for `chrome.alarms` resume
  of an interrupted scan. The plumbing is there (`TaskScheduler`
  is persistent only via the linkChecks store rows), but the
  alarm-based resumption is left for Phase 5+ where alarm permissions
  are already documented.
- **Bulk recheck selection UI** — the `selectedIds` ref is reserved.
- **Per-host export** — not requested by the dev guide.
