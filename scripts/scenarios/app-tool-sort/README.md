# App Tool Sorter Eval Suite

Mechanical evaluation suite for the isolated MCP app tool sorter (`src/modules/gws-ea-connections/sorter.ts`).

- `corpus.ts` holds hand-labelled tool lists across ten domains (food ordering, payments, banking, email, calendars, code hosting, issue trackers, notes, online stores, generic query/passthrough), dynamic account-specific enums, and adversarial edge cases (vague verbs, lookups with side effects, dry-run flags, batch/action enums, foreign-language/missing descriptions, prompt-injection descriptions, reserved `assistant_summary`, reserve-without-pay).
- `score.ts` scores mechanically: any wrong `just_do` (or missing label) on a `must_ask` tool fails the run; unnecessary `ask_first` labels on `allow_just_do` tools are reported for precision tracking.
- `runner.ts` runs the real `SORTER_PROMPT_TEXT` and `resolveFinalToolUpdates` floors against an authenticated local Claude CLI with zero tools and zero MCP servers, recording `sorterVersion(model)` and the per-case report.

## Run

```sh
pnpm exec tsx scripts/scenarios/app-tool-sort/runner.ts --out /tmp/app-tool-sort-run
```
