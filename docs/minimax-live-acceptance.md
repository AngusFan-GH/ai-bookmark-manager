# Bounded MiniMax CN streaming live acceptance

This opt-in check calls the real application MiniMax provider and assistant service, including their structured-output parsers. It uses only two synthetic `example.com` bookmarks and two synthetic folders in memory. It never accesses a browser profile, IndexedDB, native bookmarks, or real user content.

## What it checks

Five sequential requests, stopping at the first failure with no retries:

1. Connection/authentication and provider response validation.
2. Genuine SSE streamed read-only structured recommendation with the expected known bookmark ID.
3. An SSE streamed follow-up that recalls a synthetic preference from the previous turn and preserves the citation ID.
4. An SSE streamed structured organization proposal with the expected existing bookmark/folder IDs; nothing is applied.
5. Nonstreaming save-bookmark advice parsed against existing folders.

The three chat turns use the actual service `onText` callback, provider SSE decoder and final domain parser. Each must deliver nonempty plain-text previews through the genuine SSE callback before provider and service completion. A short answer may arrive as one content delta: multiple callbacks and shorter-than-final previews are reported as observations, not required on every live response. Deterministic split-stream tests still require multiple progressive updates. Streaming does not guarantee character-by-character delivery. Every preview must be a prefix of validated final text, without raw schema/SSE/thinking markup. The provider must validate an explicit `stop` followed by either `[DONE]` or clean reader EOF with no incomplete trailing SSE record. Missing stop, a read error after stop, incomplete trailing data, a JSON fallback, invalid final JSON, invented IDs or absent/previews-only-after-completion output fails. Mock streams include a private reasoning sentinel to verify it never reaches presentation text or reports.

The model is the application's default `MiniMax-M2.5`; the endpoint is the application's fixed CN endpoint `https://api.minimax.cn/v1/chat/completions`. Each request allows at most 4,096 completion tokens and 90 seconds; the complete secret-bearing step is limited to eight minutes. Five calls is a hard ceiling (20,480 requested completion tokens across the run, plus input tokens); numeric token usage is reported for nonstreaming responses when available. SSE bodies are never cloned or buffered for metrics; SSE token usage is intentionally omitted. Small fixtures deliberately do not exercise query expansion, real browser rendering, or native bookmark writes. Passing does not guarantee all future model responses will be valid.

## GitHub Actions opt-in

Repository: `AngusFan-GH/ai-bookmark-manager`; branch: `chloe/bookmark-workspace` only. Ordinary verification must succeed before the isolated live job starts. Pull requests, forks, main, ordinary pushes and reruns cannot execute the live job.

- Preferred: dispatch **Verify bookmark workspace** on this branch with `live_minimax=true`, where workflow dispatch is available.
- Bootstrap alternative, if the workflow is not yet on the default branch: push a reviewed commit whose **entire** message is exactly `test: run bounded MiniMax streaming acceptance [live-20261017-v2]`. This unique one-shot gate runs only on attempt 1. Do not reuse that message for routine changes.

The existing repository Actions secret `MINIMAX_API_KEY` is referenced only by the live step. It is absent from checkout, dependency installation, ordinary tests, builds (including harness compilation) and browser jobs. The runner validates the event gate before reading its environment value, then removes the environment entry. It uses the value transiently for the provider's Authorization header only, never logs it, and never persists it. Do not add debug tracing, environment dumps, HTTP logging, raw error messages or raw model responses to this job. There are no artifacts uploaded by the live job.

Results in the job log and step summary contain only fixed phase/status identifiers, the fixed public model/region, HTTP status, full-call latency, optional bounded numeric token counts, and boolean/count/timing evidence of SSE, clean stop and incremental callbacks. No preview text is included. Failures expose a category only. Investigate provider categories with HTTP status and the existing offline provider tests, rather than dumping credentials or response bodies.

## Offline checks

`npm test` includes the harness tests, but never runs a live request. Tests verify gate denials, the five-call bound, real SSE decoding, incremental service callbacks, history wiring and ID parsing, rejection of truncated/JSON-fallback responses, successful coalesced short responses before completion, stop-on-failure behavior, no SSE metric buffering, and allowlisted reporting. The old v1 push marker is no longer accepted. `node tests/live/run-minimax.mjs` is the dedicated Actions entry point; outside the explicit gate it fails closed without contacting MiniMax. No local key is needed or should be requested.

## Safe protocol diagnosis

The live-only transport tap forwards original SSE byte chunks without cloning, buffering the complete response, or changing production acceptance. Reports retain counts and at most eight frame-shape records with fixed enum values: choice-list size category, zero/missing/other index, delta shape, message/usage/error presence, stop/length/other finish, DONE and EOF/cancellation. Unknown values map to `other`; content, reasoning, arbitrary field names and error text are never retained. Diagnostic parsing is capped at 256,000 pending characters and 10,000 frames, without relaxing provider validation. Cancellation after a clean DONE is normal; counters describe what was observed before cancellation.

## Observed MiniMax M2.5 termination compatibility

The bounded diagnostic run observed eight valid SSE frames, one explicit `stop`, clean reader EOF, zero `[DONE]` markers, and no trailing data or read errors. This is protocol evidence for accepting explicit-stop plus clean-EOF termination; it is not a completed five-phase live acceptance result. Offline coverage exercises both termination forms through all five phases, and rejects missing-stop, read-error and incomplete-record variants. A new bounded live run is still required to validate the full recommendation, multi-turn, organization and advice flow after the compatibility change.

## Structured-validation diagnostics

When the actual domain validator rejects a suggestion, the phase report may include `validationReason`, restricted to the validator’s exported fixed enum whitelist. It identifies a failing guard such as an unknown move target or malformed action schema, without exposing the model response, arbitrary property names, IDs, titles, reasons or exception messages. Unknown or forged values are omitted. This adds diagnosis only: final ID/schema validation remains mandatory and unchanged.

## Assertion diagnosis and chunking evidence

Every live assertion has a fixed allowlisted `assertionReason`, separating wrong recommendations, context recall, organization proposals, preview mismatch and transport failures without logging model output. A measured short-response run had nine valid SSE frames, one safe preview at 3,361 ms, and provider completion at 3,572 ms; its entire display text arrived in that single preview. This satisfies pre-completion streaming, although no shorter-than-final preview was observable. The previous proper-prefix requirement incorrectly treated provider chunk granularity as an application failure. Semantic, safe-text, termination, scope and ID checks remain mandatory.
