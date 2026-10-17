# Bookmark workspace: feature decisions

## Two user outcomes

1. Keep a trustworthy collection: save, correct, organize, remove duplicates and delete unwanted bookmarks.
2. Use that collection: find the original URL, choose useful sources, and ask follow-up questions with traceable references.

A control earns its place when it advances one of these outcomes, prevents an expensive mistake, or enables recovery. Fewer buttons alone is not the goal: hiding delete confirmation or AI data scope would reduce visible controls while increasing risk. Local work must remain usable without an AI key.

## Inventory and decisions

| Capability | Decision | Reason and placement |
| --- | --- | --- |
| Capture current page / manually add URL | Keep | Core input. Popup checks saved status before suggesting a new bookmark; main workspace handles arbitrary URLs. These are different contexts, not duplicate flows. |
| Edit title/URL, rename folder, move, create folder, delete | Keep | Core collection maintenance; direct controls remain available without AI. All mutations retain preview and approval. |
| Browse tree, local search, open/copy original URL | Keep | Fast retrieval with no network dependency. One directory selector in browse; remove duplicate header directory shortcut. |
| Search submission and automatic AI advice | Keep, clarify priority | Local search is the primary action in browse/organize; configured automatic suggestions still follow deliberate search. No extra mode choice. Manual questions remain adjacent. |
| Multi-turn conversation / citations | Keep | Converts bookmarks into useful answers, with original URLs and stable session scope. Conversation makes continuing the question the primary action. |
| Canned “pick something worth reading” shortcut | Remove | The same goal is already expressible in the shared prompt; it creates another start-task path and may replace a draft without offering a distinct capability. |
| AI scope, selected-bookmark questions, history | Keep | Scope controls prevent unintentional disclosure and irrelevant answers; history preserves continuing work. Current conversation entry appears only when one exists. |
| AI organize / manual organize / exact-URL duplicates | Keep | Different evidence and intent: AI gives semantic advice; duplicates are deterministic; users still need direct edits. Suggestions never execute themselves. |
| Preview, review checkbox, typed deletion confirmation, automatic snapshot | Keep | The cost of silent bookmark damage exceeds the cost of explicit review. No compulsory file download for ordinary edits. |
| Operation history / recovery | Group under More tools | Low-frequency but necessary escape route. Existing restore preview remains intact. |
| Full JSON backup / import | Group under More tools | Independent portability and recovery after extension data loss; not equivalent to an internal snapshot. Import keeps its existing review flow. |
| Link health, manual refresh | Group under More tools | Maintenance rather than everyday retrieval. Explicitly labelled, reachable without AI, and #health deep links remain valid. No automatic scan introduced. |
| Read page content / content status and clearing | Disclose under “Page content (optional)” | Most retrieval works with metadata. Reading pages has extra network/privacy costs. Preserve explicit extraction and clearing, but stop competing with move/delete/AI organization in selection actions. |
| API region/key, consent, automatic suggestions | Keep in settings | Essential setup and meaningful data-sharing choice. Skipping onboarding still provides all local capabilities. |
| Model name, token budget, privacy exclusions, content enhancement | Advanced settings | Useful configuration, not an everyday task. Move model name alongside existing advanced controls; do not delete settings or stored values. |
| English section eyebrows | Remove | Restate adjacent Chinese headings and consume vertical space without adding state or guidance. |
| Side panel | Keep | A distinct alongside-the-page context; removing it would break an existing route rather than simplify a redundant control. |

## Boundaries

No backend capability, bookmark data, stored settings, import format, deep link, or safety requirement is deleted in this pass. This is deliberate: the redundancy is in navigation and competing action presentation, not evidence that stored data or recovery services are obsolete. Existing native-sync listeners remain the normal refresh path; manual refresh is retained as troubleshooting.

Verification includes no-key local search/creation, one primary prompt action per context, configured automatic search advice, discoverable collapsed tools/content controls, and unchanged mutation/snapshot guards. Browser testing must expand More tools before invoking maintenance actions and check that returning from a tool preserves workspace state.
