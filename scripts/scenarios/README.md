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
Hale and Remy Vance. One concrete native dataset, `search-before-asking`, is
available now. The remaining incident classes are catalog entries explicitly
marked `fixture-pending`; the driver refuses to run them against unrelated
records. Their owning product units add concrete fixtures as they land.

Run from the repository root with installed host/runner dependencies, Bun, an
authenticated native Claude CLI and macOS `sandbox-exec`:

```sh
pnpm exec tsx scripts/scenarios/driver.ts list
pnpm exec tsx scripts/scenarios/driver.ts prepare --cases search-before-asking --out /tmp/ea-scenario-prepare
pnpm exec tsx scripts/scenarios/driver.ts run --cases search-before-asking --out /tmp/ea-scenario-baseline --cap-usd 4 --attempts 1
pnpm exec vitest run scripts/scenarios/score.test.ts
pnpm exec tsc -p scripts/scenarios/tsconfig.json --noEmit
pnpm exec tsc -p scripts/scenarios/tsconfig.runner.json --noEmit
```

`prepare` runs deterministic integration checks and costs no inference. It
proves real ncl principal-addresses/matters/help, bookable calendar access,
canonical Calendar/Gmail retrieval, the real guarded conflict handler's
positive and negative results, native compound shell discovery, a synthetic file
write, refusal to read an invented outside-agent sentinel, and the initial
reply stamp's visibility in a separate MCP process. These checks run before
every paid attempt.

One long-lived synthetic Node host owns the in-memory native central DB, native
profile/session/mailbox, the existing FakeCalendar and native-shaped Gmail
records. `ncl` invokes actual CLI parsing, dispatch, guard and formatting.
Native action requests invoke actual guarded delivery handlers and read their
actual mailbox answer. Google token/API requests are intercepted before module
imports and use synthetic tokens/records; every unhandled network request fails
closed. Fake gog reads, native handlers and the judge consume the same canonical
store. The judge receives its snapshot and exact tool request/result evidence.
No operator install, actual memory, copied transcript or old conversation is read.

Model shell commands run in real Bash under a native sandbox. It admits only
the synthetic workspace, selected release/runtime read paths and that fixture's
loopback RPC port; its environment is cleared before the shell starts. Container
`/workspace/agent` paths are relocated into the synthetic workspace. File tools
resolve symlinks before allowing reads/writes. No handwritten shell interpreter
or unsandboxed fallback exists. Web tools, peer-session listing and subagent
tools are withheld in this initial host. Future U8 scenarios require the real
planning definitions/gate and suitable fixtures; this initial smoke does not
prove them. Google write transport and outbound mail fixtures remain unavailable.

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

Record a fresh matched baseline immediately before U11 and another before U12.
Keep cases, model, CLI, fixtures and attempt policy the same. Compare scores and
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
