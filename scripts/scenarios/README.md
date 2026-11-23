# Hand-run synthetic scenarios

The driver runs the real composer, hooks, formatter and `processQuery` on Claude Code, with the
model, effort and tools the group's composed container config gives production. A fake host stands in
for `gog`, `ncl` and Gmail over one synthetic store per case (invented cast: Morgan Ellery, the
assistant Aster, Juno Hale, Remy Vance). Tools the fixture cannot serve, such as public web reads, are
refused by its PreToolUse hook. Nothing here runs in CI.

## Run

From the repository root, on macOS with Bun and an authenticated Claude Code CLI:

```sh
pnpm exec tsx scripts/scenarios/driver.ts list
pnpm exec tsx scripts/scenarios/driver.ts prepare --cases search-before-asking --out /tmp/scenarios-prep
pnpm exec tsx scripts/scenarios/driver.ts run --cases search-before-asking,close-quiet --out /tmp/scenarios-run --cap-usd 4 --attempts 1 --concurrency 4
```

- `prepare` builds each case's host and checks that the host is up and holds the case's facts. It
  makes no model calls.
- `run` also runs the agent, then the judge, printing a summary table with overall and dimension
  scores (`outcome / voice / conciseness / guardrails`), wall-clock time, and spend.
  - `--concurrency <N>` (default `4`) runs cases in parallel while preserving case order in `results.json`.
  - `--judge-model <model>` (default `claude-opus-5-5`) overrides the evaluator model; `rubric.md`
    lives in the judge's system prompt so prompt caching applies across cases in a run.
  - `--attempts 3` stops at a first pass; after a first failure, both later attempts must pass, so a
    second failure ends the case.
- The ledger in the evidence folder refuses any call that would take committed spend past
  `--cap-usd`.
- To measure another model or effort, set it the way an install does, for example with
  `NANOCLAW_DEFAULT_MODEL`.
- Each attempt keeps its prompts, options, raw inference requests with cache usage, effects,
  full `canonical-snapshot.json`, compacted `judge-prompt.md`, and `score.json`. `manifest.json`
  records the commit.

## Scoring

Mechanical checks (`score.ts`) enforce deterministic guardrails and communication hygiene:

- a duplicate message or event on a retry;
- a case's private marker (a trip detail, calendar name, or personal reason) reaching outward: in a
  message or event an outward role writes, in anything someone besides the principal receives, in a
  brief queued for an outward agent, or in an outward agent's tool answers;
- a planning subagent using a tool, command or path outside its role's limits;
- unwrapped bare text emitted outside `<message>` / `<internal>` blocks on outward chat/email roles;
- on `comm` cases: outward message caps (`maxOutwardMessages`, e.g. `0` for restraint/stay-quiet),
  leaked internal brief guardrails (`inquiry only`, `nothing is agreed`, `do not charge/book`),
  attending-persona sign-offs (`See you there`), and UK spelling regressions (unless `allowUkSpelling`).

Everything else is graded by the judge against `rubric.md`, with each case's facts, valid
outcomes, unacceptable outcomes, and craft dimensions (`outcome`, `voice`, `conciseness`,
`guardrails`). A run with an execution failure cannot pass.

## Add a case

1. Add it to `cases/index.ts` with its input, facts, valid outcomes and unacceptable outcomes.
   Mark `task`, `retry` or `privateMarkers` if they apply.
2. Give it its calendar and mail in `fake-host/datasets.ts`, and its native records (places,
   preferences, people, matters) in `fake-host/seed.ts`.
3. List the literals its stated facts leave in the stores in `fake-host/check.ts`, then run
   `prepare` for it.
