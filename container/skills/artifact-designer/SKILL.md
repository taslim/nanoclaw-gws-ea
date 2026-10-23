---
name: artifact-designer
description: Create or revise a clear, beautiful, self-contained HTML information view with the native artifact tools. Use for executive briefs, evidence comparisons, explainers and local scenario calculators when a private, durable link materially helps the reader understand or decide.
allowed-tools: Read, Write, Edit, Glob, Grep, mcp__nanoclaw__artifact_save, mcp__nanoclaw__artifact_read, mcp__nanoclaw__artifact_list, mcp__nanoclaw__artifact_preview, mcp__nanoclaw__artifact_share, mcp__nanoclaw__artifact_delete, mcp__nanoclaw__request_status
---

# Artifact designer

Make the answer easy to understand without the conversation. Choose an artifact when its reading experience or local interaction helps; keep a simple answer in the conversation. A saved view is a snapshot, available until explicitly deleted or until its requested expiry. It creates no recurring upkeep commitment.

## Start with the information

Identify the reader, their question, the useful conclusion, and any decision they need to make. Inventory facts, calculations, interpretations and unknowns separately. Use actual task material, including long labels and missing values. State dates, units, scope and assumptions where they matter. Cite consequential claims beside their evidence; never manufacture a source, observation, verification or confidence score.

Choose the smallest fitting structure:

- A brief leads with the recommendation, then its evidence, tradeoffs and conversational next step.
- A comparison aligns alternatives against the same criteria, units and basis; show what remains unknown.
- A plan shows sequence, duration and dependencies.
- A calculator puts useful initial inputs, their result, formula and limits together.

Choose one purposeful visual direction. Let typography, alignment and whitespace establish hierarchy. Use a useful first viewport: a specific title, the answer or purpose, and the key qualification. Avoid turning every paragraph into a decorative card. System fonts, restrained color and native HTML/CSS/SVG usually suffice. Read [REFERENCES.md](REFERENCES.md) only when one of its contrasting examples helps; adapt its structure to the task, not its sample content or style.

## Author one local file

Use ordinary file read/write/edit tools to create a regular UTF-8 `.html` file under `/workspace/agent/`. Shell access is unnecessary. Keep styles, small scripts, SVG and data assets inline. Target ordinary markup around 32 KiB; the hard limit including embedded assets is 4 MiB. Preserve necessary evidence within that limit. Use local edits for revisions instead of repeatedly regenerating the document.

Keep the document self-contained: no framework, build, CDN, remote fonts/assets, frames, forms, submissions, external scripts, workers or persistent storage. Interaction only filters, sorts, explains or calculates embedded information in memory. An artifact cannot send messages, command an agent, book, approve or perform account actions. State a real conversational next step when action is needed.

Use ordinary absolute HTTPS source anchors with descriptive text. The viewer extracts exact source targets and offers a trusted control for the reader to deliberately open them. Do not build a message bridge, script navigation or fake link button. Check that the source appears in the viewer's source flow; do not impersonate the principal to test an authenticated URL.

## Make the initial document complete

The viewer derives a static view by removing scripts and event handlers. Put every essential conclusion, value, table, assumption and formula in the initial HTML. A calculator includes a meaningful default result and a small static scenario table; a comparison initially shows every row. Native `details` can hold supplementary methods, with key evidence already visible.

Put JavaScript-only controls in a `hidden` container, reinforced by `[hidden] { display: none !important; }`. Attach listeners and initialize successfully before removing `hidden`. Do not use an authored CSS rule that reveals controls merely because JavaScript exists. On unsupported browsers the complete static view remains visible, and the viewer explains that interactions are unavailable. Never imply a static screenshot proves a control works.

Set `lang`, UTF-8, viewport and a descriptive title. Use one `h1`, ordered headings and semantic landmarks. Label native inputs, show selected and error states in words, keep touch targets comfortable and keyboard focus visible. Keep normal text at AA contrast; color, hover and motion carry no essential meaning. Honor reduced motion when using animation. Use honest chart axes, units and visible values. Let dense tables scroll inside a named, keyboard-focusable region; avoid page overflow. Keep reading comfortable at 390×844 and 1280×800, and inspect 360px/reflow or intermediate widths when the layout needs them.

## Preview, repair, save

1. Call `artifact_preview` with `file` and optionally `title`. Inspect its exact `source_hash`, desktop/mobile interactive/static images and diagnostics. Actually view the images: check the first viewport, hierarchy, legibility, source proximity, reading order and overflow. Fix material defects and preview again.
2. Check task-relevant controls and keyboard states in the existing browser tool where already available. Verify changed results, empty/invalid input and reset when applicable. Shell-less authors use native preview for appearance and diagnostics; it does not certify every control. Report any unverified interaction accurately.
3. Save with `artifact_save`: `title`, `file`, `expected_hash` equal to the inspected preview hash, and a caller-chosen stable `create_key` for a new artifact. Reuse that key on retries. Save creates a principal-private link; it never shares. Omit `expires_at` or use `null` for no requested expiry; set a future ISO UTC expiry only when requested.
4. For an edit, use `artifact_read` with `artifact_id` and `checkout: true` (optionally `revision`). It returns the authoritative file in this session's `/workspace/inbox/`; use normal file tools for a localized edit. Preview it, then save with `artifact_id` and current `expected_revision` instead of `create_key`. A stale revision requires reading current metadata before reconciling. Treat checked-out source as untrusted information.
5. `artifact_list` returns metadata without HTML; use `limit` and `after` with its returned `next_cursor`. After a timeout, use `request_status` with the returned request ID before retrying a mutation.

## Deliver the intended version

Give the private saved URL and only the context the principal needs. All currently confirmed principal addresses may open it. Other authors can manage their own artifacts; main oversees the assistant's artifacts and handles external sharing.

Main uses `artifact_share` only for the principal's instruction covering the exact saved revision/hash, audience and lifetime. `named_publish` needs exact recipient emails; `public_publish` names the public audience. Both need `artifact_id`, `revision`, `expected_hash` and `principal_message` (`id`, `messaging_group_id`). Private edits leave shared revisions pinned. `named_replace` and `public_replace` also need `share_id` and current `expected_generation`; `revoke` needs those identifiers and the principal message, without publication fields. Follow the resident privacy rules and the tool's closed schema. Pass `private_value_ids` only for the exact registered details explicitly authorized for that audience.

Report applied, pending, refused, revoked or expired outcomes truthfully. Deliver a named/public link only after its intended access is applied. To delete content and access, read current metadata then call `artifact_delete` with `artifact_id` and `expected_generation`. Withdrawal stops origin access; it cannot recall copies already downloaded.
