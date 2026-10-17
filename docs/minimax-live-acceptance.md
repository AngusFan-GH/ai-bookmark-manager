# Bounded MiniMax CN live acceptance

This opt-in check calls the real application MiniMax provider and assistant service, including their structured-output parsers. It uses only two synthetic `example.com` bookmarks and two synthetic folders in memory. It never accesses a browser profile, IndexedDB, native bookmarks, or real user content.

## What it checks

Five sequential requests, stopping at the first failure with no retries:

1. Connection/authentication and provider response validation.
2. Read-only structured recommendation with the expected known bookmark ID.
3. A follow-up that recalls a synthetic preference from the previous turn and preserves the citation ID.
4. A structured organization proposal with the expected existing bookmark/folder IDs; nothing is applied.
5. Save-bookmark advice parsed against existing folders.

The model is the application's default `MiniMax-M2.5`; the endpoint is the application's fixed CN endpoint `https://api.minimax.cn/v1/chat/completions`. Each request allows at most 4,096 completion tokens and 90 seconds; the complete secret-bearing step is limited to eight minutes. Five calls is a hard ceiling (20,480 requested completion tokens across the run, plus input tokens); actual usage is reported when available. Small fixtures deliberately do not exercise query expansion, real browser rendering, or native bookmark writes. Passing does not guarantee all future model responses will be valid.

## GitHub Actions opt-in

Repository: `AngusFan-GH/ai-bookmark-manager`; branch: `chloe/bookmark-workspace` only. Ordinary verification must succeed before the isolated live job starts. Pull requests, forks, main, ordinary pushes and reruns cannot execute the live job.

- Preferred: dispatch **Verify bookmark workspace** on this branch with `live_minimax=true`, where workflow dispatch is available.
- Bootstrap alternative, if the workflow is not yet on the default branch: push a reviewed commit whose **entire** message is exactly `test: run bounded MiniMax acceptance [live-20261017-v1]`. This unique one-shot gate runs only on attempt 1. Do not reuse that message for routine changes.

The existing repository Actions secret `MINIMAX_API_KEY` is referenced only by the live step. It is absent from checkout, dependency installation, ordinary tests, builds (including harness compilation) and browser jobs. The runner validates the event gate before reading its environment value, then removes the environment entry. It uses the value transiently for the provider's Authorization header only, never logs it, and never persists it. Do not add debug tracing, environment dumps, HTTP logging, raw error messages or raw model responses to this job. There are no artifacts uploaded by the live job.

Results in the job log and step summary contain only fixed phase/status identifiers, the fixed public model/region, HTTP status, latency and optional bounded numeric token counts. Failures expose a category only. Investigate provider categories with HTTP status and the existing offline provider tests, rather than dumping credentials or response bodies.

## Offline checks

`npm test` includes the harness tests, but never runs a live request. Tests verify gate denials, the five-call bound, real service history wiring and ID parsing, stop-on-failure behavior, and allowlisted reporting. `node tests/live/run-minimax.mjs` is the dedicated Actions entry point; outside the explicit gate it fails closed without contacting MiniMax. No local key is needed or should be requested.
