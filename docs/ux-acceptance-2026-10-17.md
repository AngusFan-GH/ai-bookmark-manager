# Practical interaction audit — 2026-10-17

## Improvements and regression evidence

| Journey | Observed friction | Change | Evidence |
| --- | --- | --- | --- |
| First install / AI setup | Save, skip and validation feedback fell below the viewport in the previous desktop/narrow screenshots. | Bounded dialog with independently scrolling content, persistent actions/feedback, concise three-step guide; missing-key validation happens before permission or provider calls. | Component tests; new browser geometry and hit-target assertions at 390×600, 768×720 and 1440×1000. |
| Connection recovery | Errors could claim settings were retained when saving failed, or mislabel completion failure as failed connectivity. | Separate saving, readback, testing and onboarding-completion feedback; preserve entered key on failed save; disable repeat submission until completion. | Main-workspace tests cover failed save, failed test, successful test followed by completion failure, duplicate click and wrong-region key. |
| Tools / narrow workspace | Health dialog actions were below the initial viewport; narrow action groups could clip controls despite no document overflow. | Persistent return action, scrolling tool content, wrapping composer buttons. | Browser assertions now check actual control bounds and hit targets, not just document scroll width. |
| Capture initialization | Failed tab/tree reads required closing and reopening the popup. | Explicit in-place retry. | Popup component recovery test. |
| Keyboard capture | Title entry did not provide a keyboard save path. | Enter saves once; composing IME input does not submit. | Popup component tests for keyboard and duplicate-submit handling. |
| Capture handoff | Repeated “more editing” could open multiple drafts; selected destination was lost. | One pending handoff, validated destination preserved with title/raw URL in opaque session storage; no automatic advice restart during handoff. | Popup, editor and messaging integration tests. |
| Stale destination | A chosen folder can disappear between popup and workspace. | Retain draft text, omit invalid destination and explain that the destination needs confirmation. Reject root/bookmark/deleted destinations before storage. | Native-tree integration and workspace recovery tests. |
| Saved/uncertain capture | A new-draft action remained available after saving or an uncertain execution. | Hide new-draft handoff; successful state directs to workspace, uncertain state explicitly asks for result verification. | Popup component tests and native-popup browser checks. |
| Editor pending state | Existing-bookmark/settings/recheck actions remained active while preparation was pending. | Disable conflicting actions and wrap long suggestions/location text. | Editor component tests. |

## Test scope

The aggregate suite covers native synchronization, search, bounded AI scopes, multi-turn history, manual and AI plan preparation, review/approval, execution/recovery, deletion safeguards, duplicate detection, backup/import, health classification, privacy and capture. Browser acceptance uses a temporary profile, synthetic bookmarks and mocked MiniMax responses.

The browser harness also covers actual extension action-popup operation in CI, all major workspace flows, original URL preservation, cancel/retry, repeated import, stale context, and narrow layouts. See `tests/e2e/README.md` for the detailed coverage and evidence contract.

## Evidence limits

Local lint, type checking, tests and production build are run against the integrated change. Exact final test totals and CI status belong in the delivery summary. The local cloud shell cannot launch Chromium because socket creation is denied; this restriction was not bypassed. New rendered geometry and native-popup assertions require the exact-commit isolated GitHub Actions run before they can be called passed.

No user profile, real bookmarks, credentials or live provider calls are used in this regression suite. It does not establish real MiniMax availability/quality, acceptance of native permission prompts, live website-health outcomes, full accessibility conformance or the browser's native sidepanel shell.
