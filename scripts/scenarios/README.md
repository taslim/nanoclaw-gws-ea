# Hand-run synthetic scenarios

The driver uses the real host composer, release guidance, memory SessionStart
implementation, compaction instructions, inbound formatter, MCP descriptors and
handlers, and unchanged production `processQuery`, including delivery and wrap
nudges. Claude Code runs through the installed Claude Agent SDK. An independent
Opus 5.5 call judges valid alternatives against `rubric.md`, a privacy-safe
distillation of Experience Principles 07 and the accepted origin. Mechanical
checks cover only retry duplicates, scoped privacy markers and declared planner
role/path/verb limits.

The invented principal is Morgan Ellery, the assistant Aster, and contacts Juno
Hale and Remy Vance. Twenty-four cases are available, including travel chains,
deadlines, weekend preferences, impossible transfers, commitments, all three
booking kinds, relationship-based lengths, invitation authority and outward
privacy. Ten cases remain pending. The two role probes read a conversation-only brief and produce an
internal native task log; their scores cannot establish email or chat delivery.
The role probes and the people/reminder-only cases have empty Calendar/Gmail stores. The remaining incident classes are catalog entries explicitly
marked `fixture-pending`; the driver refuses to run them against unrelated
records. `prepare` also admits the three location datasets while their web paths
remain pending; `run` refuses them. [Case readiness](cases/readiness.md) lists every remaining case's exact
fixture/transport dependency and the path to testing real public web reads with
synthetic task data.

Run from the repository root with installed host/runner dependencies, Bun, an
authenticated native Claude CLI and macOS `sandbox-exec`:

```sh
pnpm exec tsx scripts/scenarios/driver.ts list
pnpm exec tsx scripts/scenarios/driver.ts prepare --cases search-before-asking,external-email-identity-read,external-chat-identity-read --out /tmp/ea-scenario-prepare
pnpm exec tsx scripts/scenarios/driver.ts run --cases search-before-asking --out /tmp/ea-scenario-baseline --cap-usd 4 --attempts 1
pnpm exec vitest run scripts/scenarios/score.test.ts
pnpm exec vitest run scripts/scenarios/fake-host/google-transport.test.ts
pnpm exec node --import tsx scripts/scenarios/fake-host/transport-check.ts /tmp/ea-native-google-proof
pnpm exec tsc -p scripts/scenarios/tsconfig.json --noEmit
pnpm exec tsc -p scripts/scenarios/tsconfig.runner.json --noEmit
```

`prepare` runs deterministic integration checks and costs no inference. It
proves real ncl principal-addresses/matters/help, bookable calendar access,
canonical Calendar/Gmail retrieval, the real guarded conflict handler's
positive and negative results, native compound shell discovery, a synthetic file
write, refusal to read an invented outside-agent sentinel, and the initial
reply stamp's visibility in a separate MCP process. These checks run before
every paid attempt. The role probes also prove native CLI refusal, their own
release skill selection, and an internal `task_log` from real `processQuery`
with no outward effect. The newer native-store cases prove person lookup and
linked conversation memory, normal Gmail search/thread/message reads, exact
invitation/guest facts, a native London stay and time conversion, and actual
reminder creation/readback/deletion. Preflight removes its task before any model
run; `preflight-canonical-snapshot.json` preserves the clean initial state. Native
people, whereabouts, Manual, memory and task records also reach the judge's
canonical snapshot; no parallel empty task array claims to represent native
writes. Snapshot memory traversal refuses symlinks, including the memory root.

The newer concrete cases use native home, rhythm, dated stays, learned travel,
scheduling preferences, people and matters. Their Calendar/Gmail datasets carry
the actual purpose, attendance agreement, length, organizer and conversation.
Native `email_handoff` creates main's brief in the real email session; its saved
message reaches the real formatter separately from the correspondent's message.
An organizer request may end with an actual queued delegation, explicitly
pending; that does not establish counterpart contact or delivery. The native
unowned-event proof refuses a conversation booking change, records its report
to main, and proves main's version-conditioned patch without making it an owned
booking. Calendar's wire fixture refuses guest edits with HTTP 403 while allowing
the guest's own response. The native handler's refused-change message is kept.

`preflight-case-proof.json` retains actual native writes and their readback.
The isolated proof rolls back its native central transaction and restores the
invented Google records and mailbox rows before measurement; it checks the
restored records against the snapshot taken immediately before mutation. It
does not replace any tool result. Fixed-date requests name their dates; the
"today" exception instead uses captured real `referenceAt` in the install zone,
including that day's regular workplace and one-day stay. Evidence includes both
reference and actual host timestamps. There is no altered runtime clock.

Main's real `createWeekRefresher` publishes its view using those same stores and
the native HTTP Calendar client. The runner registers the actual Bun
`week-view/hook.ts` command for SessionStart and UserPromptSubmit with its
synthetic view path and receipt directory as the CLI's two arguments.
`preflight-week-hook.json` proves full startup injection, quiet identical resume
and a real current-time prompt submission through that exact CLI. The host
timeline and runner clock parser remain separate. Outward roles receive neither
the coming-days hook nor group memory. The hook is not simulated in PreToolUse.

The two write cases have their own venue, length, organizer, guest and agreed-time
facts. Their preparation reads those facts and checks the destination interval
without consuming the model's write. `transport-check.ts` separately drives real
guarded `create_event`, `change_event`, `cancel_event`, `change_guests`,
`respond_to_event`, `book`, `change_booking`, `cancel_booking` and `email_send`.
Ordinary email replies use the native outbound SQLite database,
`deliverSessionMessages`, registered inbox adapter, delivery receipts and
post-delivery hooks. Calendar writes, invitation updates and MIME email sends
reach the single canonical stores at the HTTP boundary. Snapshot evidence includes
native booking requests, calendar write journals, send ledgers and thread messages;
`google-http.jsonl` records methods, paths, versions and outcomes without tokens.

The transport proof checks version-conditioned writes, stale rejection, retained
guests, native IDs, cancellation tombstones, all three booking kinds, Meet
request/status/readback, reply audiences/headers and retry duplicates. It loses
selected HTTP responses after storing the write to exercise native recovery.
Each product recovery proof saves its actual first/replayed mailbox answer,
confirmed event and journal; any failing proof makes the command exit nonzero
after the independent booking/Gmail checks finish. Such a failure is a product
defect to repair in the native handler, never a fixture success. These checks
cost no inference and do not establish a behavioral model pass.

Preparation uses native `materializeContainerJson`, including
`grantCapabilities` overlays, rather than treating stored keys as spawn grants.
`composeContainerEnv` runs in the synthetic host with the resolved group and
core/fixture contribution keys reserved. `composition.json` saves stored and
resolved capabilities, selected skills, session identity and only the module's
nonsecret contribution. The runner calls production
`resolveClaudeCapabilityPolicy`, `resolveClaudeMcpServers`,
`resolveClaudeToolOptions` and `resolveClaudeExecutionPolicy`. It preserves the
whole inherited environment for native CLI authentication, then applies module
contributions, native tool policy and fixture isolation. It records inherited
variable names only. A future module-contributed prompt switch reaches the
actual SDK environment automatically. `applied-configuration.json` proves this
merge and the tool derivation without inference; each paid call's `options.json`
records the actual production and applied tool options.

One long-lived synthetic Node host owns the in-memory native central DB, native
profile/session/mailbox, the existing FakeCalendar and native-shaped Gmail
records. External chat is created by native `ensureExternalChatGroup`, including
its gateway reconciliation against an invented, closed metadata transport. Its
conversation context comes from native chat/roster stores. External email uses
the native host-created group and a dedicated synthetic mail thread. `ncl` invokes actual CLI parsing, dispatch, guard and formatting.
Native action requests invoke actual guarded delivery handlers and read their
actual mailbox answer. Google token/API requests are intercepted before module
imports and use synthetic tokens/records; every unhandled network request fails
closed. Fake gog reads, native handlers and the judge consume the same canonical
store. The judge receives its snapshot and exact tool request/result evidence.
No operator install, actual memory, copied transcript or old conversation is read.

Main's synthetic memory index comes from the current shipped template; it
contains no retired Core Memory seed or unrelated location/commute facts. The
runner follows native `sessionsSealed` / `prepareSessionMemory`, so main receives
the memory hook while the sealed outward roles receive neither group memory nor
a compaction hook.

Model shell commands run in real Bash under a native sandbox. It admits only
the synthetic workspace, selected release/runtime read paths and that fixture's
loopback RPC port; its environment is cleared before the shell starts. Container
`/workspace/agent` paths are relocated into the synthetic workspace. File tools
resolve symlinks before allowing reads/writes. No handwritten shell interpreter
or unsandboxed fallback exists. Production-disallowed tools remain disallowed.
Web tools, peer-session listing, subagent tools and external MCP servers are
additionally withheld by this initial fixture boundary; these restrictions are
recorded separately from production tool policy. Future U8 scenarios require the real
planning definitions/gate and suitable fixtures; this initial smoke does not
prove them. Google Calendar create/patch/delete/free-busy and Gmail send/read
transports are available. Google operations outside the implemented fixture
boundary fail closed, including arbitrary Gmail search queries, attachments,
history polling and calendar subscriptions. Gmail supports the production
send-reconciliation queries and SENT label reads; gog's existing read views use
the same messages. Booking and privacy cases have their specific conversations,
consent and private facts. Public web, browser delegation, actual planning agents
and the close path remain outside this checkpoint's fixture boundary.

`--claude` selects an existing authenticated native CLI (default
`~/.local/bin/claude`); no auth files are inspected or copied. The default models
are `claude-sonnet-5` and `claude-opus-5-5`. The default $4 ledger follows the prior
synthetic harness's roughly $4.24 evidence. Each agent query reserves $0.75 and
each judge $0.25 before starting. Interrupted queries keep their reservation.
Use `--ledger` with the same path/cap across evidence folders. SDK costs are
list-price estimates. Its `maxBudgetUsd` stops between model requests, so one
in-flight request may exceed its reservation; the ledger preserves every raw
request and reported actual cost, including failures.

`--attempts 1` characterizes a tree. `--attempts 3` stops at an initial pass; a
first failure requires both remaining attempts to pass. Attempts are never
repeated until a lucky result. A future retry case reuses its synthetic host and
continuation with a separately reserved query; independent confirmations start
fresh hosts. Resumed SDK cumulative costs are recorded as deltas. There is no
CI wiring or package-script change.

U11 adoption stays queued until every required R33 case has a concrete native
fixture and its product dependencies exist. The initial search smoke and role
probes alone cannot satisfy that gate. Record the full fresh matched baseline
immediately before U11 product prompt/tool changes and another before U12. Keep
cases, model, CLI, fixtures and attempt policy the same. Compare scores and
raw cache-read usage, not only aggregate cost. `manifest.json` saves source
hashes; each run retains actual composed docs, prompts, options, effects,
canonical records and native tool results. The model relay records only
Anthropic inference bodies/raw SSE, never request headers or credentials.
`usage.json` retains raw cache reads/creation and SDK per-model cumulative usage.

Authenticated Claude Code also injects its signed-in account's user-email
identity sentence into model context. The initial native smoke observed a
misdirected lookup to that account before the agent listed and used Morgan's
synthetic calendar. The fake host returned no real data and made no Google
request. This is an account-metadata isolation limitation, also present in the
prior replay evidence. Keep raw evidence local; sanitized summaries must not
reproduce the account address. Small cases register compaction hooks but do not
force compaction; a saved hook body is not evidence that the model compacted.
