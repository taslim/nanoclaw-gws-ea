# Area analysis brief

Each area of a sync gets one read-only analysis agent, launched together. Fill the placeholders and send the shared context plus that area's section as the agent's prompt. The agents decide nothing; they bring the maintainer options.

## Shared context (every agent)

```
Repo: <operator checkout path> — GWS-EA, an opinionated Google Workspace
executive-assistant product built as a downstream fork of NanoClaw. Branch
`rebuild-v2` (<sha>) is our integration line. `upstream/<ref>` (<sha>,
nanocoai/nanoclaw, <version>) is <N> commits ahead. Merge base: <sha> (the
upstream commit our last sync merged). We are about to merge upstream into
rebuild-v2.

Wherever our fork's change and upstream's new work meet, do NOT adapt our
change onto upstream. Restate our original intention from scratch, then decide
whether a new upstream capability achieves it better (so our divergence shrinks
or disappears), whether our approach is still best, or whether a new design
beats both. Principles: production-ready only; no adapters or migration layers;
root cause over band-aids; hard guarantees outside the model, judgment for the
rest; no mechanism for hypothetical cases; a generic mechanism upstream supplies
is inherited unchanged, and GWS-EA owns one only until NanoClaw ships an
equivalent.

Where our intent is recorded:
- docs/rebuild/upstream-divergence-2026-09-24.md: a row per upstream-owned file
  our fork changes (local, gitignored; later dated sections supersede earlier rows).
- src/gws-ea/divergence.test.ts: the guard for each recorded divergence.
- docs/rebuild/01-development-model.md, 02-divergence-inventory.md,
  05-multi-assistant-deployment-architecture.md, 07-experience-principles.md,
  docs/rebuild/reviews/ (pending decisions), docs/rebuild/solutions/.
- Our commits: `git log <merge-base>..origin/rebuild-v2 -- <path>`, `git show <sha>`.
Upstream's intent: `git show <sha>` and CHANGELOG.md on upstream/<ref>.

Rules: READ-ONLY. Do not edit, stage, checkout, switch, merge, stash, or reset
anything in the repo. Do not run pnpm install/dev/build, container builds,
gws-ea, launchctl, docker or onecli commands that change state. Use
`git show <ref>:<path>`, `git diff <merge-base> <ref> -- <path>`,
`git merge-tree`, grep and file reads. A three-way simulation goes in your
scratch directory (`git merge-file`). Write files only under <scratch>/analysis/.
The shell is zsh: quote globs, and an unquoted $VAR is one word.

Output: write a full report to <scratch>/analysis/<area>.md. For each place the
two sides meet: (1) our intent from first principles, with cited commits and
divergence rows; (2) what upstream changed, why, and the capability it offers;
(3) options — adopt upstream and drop ours / keep ours re-applied on upstream's
code / a new design — with trade-offs; (4) recommendation and confidence;
(5) the concrete resolution per file, plus the tests, divergence guards and
divergence-record rows that change; (6) only the genuine decisions for the
maintainer. Also flag upstream changes our side never touched textually that
still change GWS-EA's behavior, and anything that touches live assistants or is
a security fix. Return a compact summary (about 700 words) with a decision table.
```

## Typical areas

Shape the areas around what this window actually touches; five was the right number for a 76-commit window. Each section names the files changed on both sides, the upstream commits (short SHA and subject), and our commits, then asks the area's key questions.

| Area | Usually covers | Key questions to ask |
|---|---|---|
| Agent runner | `container/agent-runner/src/` (poll loop, providers, formatter), `container/CLAUDE.md`, `bun.lock` | Does an upstream change write anything to a conversation route that GWS-EA reports to the host instead (`turn_failed`)? Does a provider change reach our tool policy, sealed sessions or instruction composition? |
| Gateway seam and container runner | `src/container-runner.ts`, `src/gateway-providers/`, `src/provider-contracts/`, `docs/gateway-seam.md`, approvals, host sweep | Can a new provider- or gateway-declared capability express one of our seams (session admission, sealed sessions)? Does a new hook share a name with ours? |
| Gateway skills | `.claude/skills/add-onecli/**`, `.claude/skills/add-iron-proxy/**`, installed `src/gateway-providers/onecli*`, `src/gws-ea/versions.json` | Has upstream moved the OneCLI pin for a security fix, and do the live assistants run at least that version? Is every installed copy still equal to its payload? |
| Update, service and release | `scripts/update/`, `setup/service.ts`, `src/upgrade-state.ts`, `src/gws-ea/` lifecycle (cutover, service control, release directories, release tracks) | Does upstream's hardening reach gws-ea through the helpers it reuses, and does it make a gws-ea mechanism redundant? Does anything break the update controller archive contract? Read every related PR before proposing a lifecycle change. |
| Channels, CLI, dependencies and CI | `src/channels/`, `src/cli/resources/`, `src/log.ts`, `package.json`, `pnpm-lock.yaml`, `.github/`, `container/Dockerfile` | Does a new upstream check overlap our Google Chat or webhook divergences? Do new CI jobs or skill pins fail on our pins? What is the safe lockfile state under the release-age rule? |
