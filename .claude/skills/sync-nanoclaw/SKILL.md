---
name: sync-nanoclaw
description: "Maintainer only: merge the latest official NanoClaw (nanocoai/nanoclaw, the upstream remote) into GWS-EA's integration line rebuild-v2, re-deriving every place the fork and upstream meet so GWS-EA's divergence shrinks wherever upstream now does the job. Use it whenever the GWS-EA maintainer wants upstream NanoClaw's newer work, even without naming the skill: 'pull in latest from nanocoai/nanoclaw', 'sync with upstream', 'upstream is 70 commits ahead, bring it in', 'merge NanoClaw v2026.10.0 into rebuild-v2', 'update our fork to the latest NanoClaw'. Not for updating a GWS-EA install or its assistants, and in GWS-EA nobody runs /update-nanoclaw: operators run git pull, bash gws-ea.sh, then gws-ea update --all."
---

# Sync NanoClaw into GWS-EA

Merges official NanoClaw (remote `upstream`, `nanocoai/nanoclaw`) into `rebuild-v2`, the GWS-EA integration line that assistants deploy from. Every place GWS-EA and upstream's new work meet is re-derived from GWS-EA's original intent: where upstream now provides the mechanism, GWS-EA's copy goes; where it does not, GWS-EA's change is re-applied on upstream's code. The sync lands as a real merge commit, fast-forwarded onto `rebuild-v2`.

## When to use

- The GWS-EA maintainer wants upstream NanoClaw's newest work in `rebuild-v2`.
- Not for an operator updating their tool checkout or assistants: they run `git pull`, `bash gws-ea.sh`, then `gws-ea update --all`.
- Not `/update-nanoclaw`: that updates a plain NanoClaw install in place. A GWS-EA tool checkout is not an install, and assistants are deployed at exact commits by `gws-ea update`.

## Principles

- **Rethink each overlap from intent.** Never re-fit GWS-EA's old hunk onto upstream's new code. Ask what outcome GWS-EA wanted, and whether upstream now achieves it. GWS-EA owns a mechanism only until NanoClaw ships an equivalent. No adapters or migration layers.
- **The maintainer decides.** Bring options and a recommendation per area before resolving anything. A sync does not quietly settle a pending product question; surface it.
- **Never in the operator checkout.** `bin/gws-ea` runs `setup/gws-ea.ts` from the operator checkout's source, so a half-done merge there is live tool code. All work happens in a worktree.
- **A real merge, never squashed.** Keep upstream's commit as a parent so the next sync starts from it. Never open the sync as a PR; the repo squash-merges PRs.
- **Live assistant data changes only on an explicit yes.** A sync changes code; an assistant's settings, vault or OneCLI state belong to its operator, and a sync cannot take such a change back.

## Workflow

### 1. Confirm the maintainer, then fetch

Start in the operator checkout: the main worktree, the first path `git worktree list` prints, which `gws-ea` runs from. The local `docs/rebuild/` tree (the divergence record, reviews and product docs) is gitignored, so it exists only there: read and update it there, never in the sync worktree.

```bash
git remote get-url origin     # taslim/nanoclaw-gws-ea, in HTTPS or SSH form
git remote get-url upstream   # nanocoai/nanoclaw
gh repo view taslim/nanoclaw-gws-ea --json viewerPermission --jq .viewerPermission
```

Continue only when `origin` points at `taslim/nanoclaw-gws-ea`, `upstream` at `nanocoai/nanoclaw` (each as `https://github.com/<owner>/<repo>` or `git@github.com:<owner>/<repo>`, with or without `.git`), and the permission is `ADMIN`, `MAINTAIN` or `WRITE`. An `upstream` that points anywhere else would merge someone else's code into `rebuild-v2` as NanoClaw: stop and show the maintainer the URL. Otherwise stop: *"This skill is for GWS-EA's maintainer. To update GWS-EA, run `git pull`, `bash gws-ea.sh`, then `gws-ea update --all`."* When the `upstream` remote is missing, the maintainer adds it with `git remote add upstream https://github.com/nanocoai/nanoclaw.git`.

"Latest" means `upstream/main`. When the maintainer names a release tag (`vYYYY.MM.N` or `-rc.N`), use that ref everywhere this skill says `upstream/main`.

```bash
git fetch upstream --tags && git fetch origin +refs/heads/rebuild-v2:refs/remotes/origin/rebuild-v2
git rev-list --count origin/rebuild-v2..upstream/main                      # 0 means already current: stop
git log --oneline -1 "$(git merge-base origin/rebuild-v2 upstream/main)"   # the upstream commit the last sync merged
git show upstream/main:package.json | grep '"version"'                     # the version this sync brings in
```

Each command call starts a fresh shell, so variables do not carry over. Start every later command block with these lines, with today's date and the operator checkout's path written literally:

```bash
D='<YYYY-MM-DD>'; OPERATOR='<operator checkout path>'
SCRATCH="${TMPDIR:-/tmp}/sync-nanoclaw-$D"; mkdir -p "$SCRATCH/analysis"   # lists, reports and diffs, outside the repo
MB=$(git merge-base origin/rebuild-v2 upstream/main)
```

When the harness names a session scratch directory, use it in place of `${TMPDIR:-/tmp}`.

### 2. Create the worktree

From the operator checkout (`$OPERATOR`):

```bash
git worktree add ".claude/worktrees/sync-nanoclaw-$D" -b "chore/sync-nanoclaw-$D" origin/rebuild-v2
```

Run every later command inside that worktree. Never switch, merge or reset in the operator checkout.

### 3. Map where the two sides meet

```bash
git diff --name-only "$MB" origin/rebuild-v2 | sort > "$SCRATCH/ours.txt"
git diff --name-only "$MB" upstream/main | sort > "$SCRATCH/theirs.txt"
comm -12 "$SCRATCH/ours.txt" "$SCRATCH/theirs.txt"                 # changed on both sides
git merge-tree --write-tree --name-only origin/rebuild-v2 upstream/main   # first line: a tree id; then the predicted conflicts; touches nothing
git log --no-merges --format='@@ %h %s' --name-only "$MB"..upstream/main  # each upstream commit and what it touches
```

Files changed on both sides are only part of it. Also read the divergence record (`$OPERATOR/docs/rebuild/upstream-divergence-2026-09-24.md`) for upstream capabilities that overlap a GWS-EA divergence in files only GWS-EA touched. Examples: a new upstream update channel next to GWS-EA's release tracks, or a new approval hook next to its gateway seams. Read upstream's `CHANGELOG.md` entries since the merge base too: each `[BREAKING]` entry is an item for the maintainer even when it touches no file the fork changed. Group everything into areas (see `references/area-analysis.md`), then tell the maintainer the sync's size before analyzing: commits ahead, files changed on both sides, predicted conflicts, and the areas.

### 4. Analyze each area in parallel

Launch one read-only agent per area, all together. Each gets the shared context from `references/area-analysis.md`, with its placeholders filled from steps 1 and 3, plus an area section you write from step 3's map: that area's files changed on both sides, its upstream commits (short SHA and subject), GWS-EA's commits on those paths, and the area's key questions (the reference's table gives the usual ones). Agents write their reports to `$SCRATCH/analysis/`. While they run, do nothing that edits the repo. For a small window (under about 15 upstream commits and 5 files changed on both sides), do the same analysis inline instead; the rethink from intent still applies to every overlap.

When they return:

1. **Check the claims that drive decisions** yourself: pins, which tests read which files, what a deleted mechanism still guards. An agent's verdict is evidence, not a fact.
2. **Reconcile disagreements.** Two areas may reach different verdicts on one mechanism.
3. **Check pending decisions.** Look in `$OPERATOR/docs/rebuild/reviews/` and in what you remember of the maintainer's decisions for an open decision the sync touches. Name it for the maintainer rather than settling it inside the merge.

### 5. Present options, then ask

Give the maintainer:

- what upstream now does, so GWS-EA's code shrinks (and how);
- where GWS-EA keeps its own because upstream's new feature solves something else (one line each on why);
- the mechanical work the merge forces;
- anything security-relevant or urgent for live assistants;
- live-data changes, which happen only on an explicit yes.

Ask only the genuine decisions, with a recommendation first. Decide product questions the product docs (`$OPERATOR/docs/rebuild/07-experience-principles.md`) already answer instead of asking them.

### 6. Merge and resolve

```bash
git config rerere.enabled true   # repo-wide; records each resolution so step 10 can replay it if rebuild-v2 moves
git merge --no-ff --no-commit upstream/main
git diff --name-only --diff-filter=U | tee "$SCRATCH/conflicts.txt"   # step 9 reviews every one of these
```

Resolve per the decisions, then `git add` each resolved path:

| Situation | Resolution |
|---|---|
| Upstream now owns the intent | The path ends exactly as upstream has it: upstream's file (`git checkout upstream/main -- <path>`), or gone where upstream deleted it (`git rm <path>`). Done when `git diff upstream/main -- <path>` prints nothing. Move what GWS-EA still needs into a GWS-EA-owned file under `src/gws-ea/` with a test. |
| GWS-EA keeps its change | Start from upstream's file (`git show upstream/main:<path> > <path>`) and re-apply GWS-EA's seam on top. |
| Upstream restructured code around a GWS-EA decision | Take upstream's structure; keep only GWS-EA's decision (for example, a failed turn is still `turn_failed` to the host, never a chat message). |
| Upstream-only files | Take them unchanged. |

Then the follow-ups the merge forces:

- **Installed skill copies:** the fork commits the files the add-onecli skill installs. Its `SKILL.md` lists them in an `nc:copy` fence (see `docs/skill-directives.md`), one `payload/<source> -> <installed path>` line each. `cmp` each pair and re-copy any installed file that differs from its payload source.
- **Skill pins:** `pnpm run skill-pins:generate`, then `pnpm run skill-pins:check`.
- **Lockfile:** `pnpm-lock.yaml` must describe the merged `package.json` exactly.
  - In each conflict hunk, take upstream's versions where upstream bumped a package, keep the fork's own packages, and drop entries that nothing resolves to any more.
  - Every `integrity:` hash must come from one side's lockfile; the command below prints any that don't. A new hash means pnpm resolved something neither side tested.
  - `pnpm install --frozen-lockfile` must pass, and `pnpm install --lockfile-only` must leave `pnpm-lock.yaml` unchanged. Then run `cd container/agent-runner && bun install --frozen-lockfile`.
  - Adding a `minimumReleaseAgeExclude` or `onlyBuiltDependencies` entry is the maintainer's call; ask first.

  ```bash
  git show origin/rebuild-v2:pnpm-lock.yaml upstream/main:pnpm-lock.yaml | grep -o 'integrity: sha512-[A-Za-z0-9+/=]*' | sort -u > "$SCRATCH/known"
  grep -o 'integrity: sha512-[A-Za-z0-9+/=]*' pnpm-lock.yaml | sort -u | comm -23 - "$SCRATCH/known"   # must print nothing
  ```
- **Central migrations:** the fork adds its own numbered migrations under `src/db/migrations/`. When upstream adds one, keep both in `src/db/migrations/index.ts`. A migration's `name` is its applied identity, so never rename either one; a shared number is harmless. Check that a fresh install still runs the whole list in order.
- **Upstream tests on fork-extended types:** `pnpm exec tsc --noEmit` catches an upstream fixture that lacks a field GWS-EA made required.
- **Fakes of upstream helpers:** when upstream changes a helper's semantics, rewrite GWS-EA's fakes for the new semantics, and assert the property (only the named install was touched) rather than an exact call list.

Save the merge commit only once the tree is green (step 7). Anything not needed for green goes in separate follow-up commits after it, one per concern: a divergence that upstream made redundant, or a change the maintainer decided in step 5.

### 7. Verify

| Check | Command |
|---|---|
| Frozen installs | `pnpm install --frozen-lockfile`; `cd container/agent-runner && bun install --frozen-lockfile` |
| Format | `pnpm run format:check` |
| Types | `pnpm exec tsc --noEmit`; `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` |
| Lint | `pnpm run lint` (0 errors) |
| Host tests | `pnpm exec vitest run` |
| Container tests | `cd container/agent-runner && bun run test` |
| Skill pins | `pnpm run skill-pins:check` |

A full local `vitest run` times out in a few heavy suites under load (often upstream's `scripts/update/transaction.e2e.test.ts`). Re-run each failing file alone. A timeout that passes when its file runs alone is load; an assertion failure, or any failure CI reproduces, is a regression to fix. Report it either way, and let CI decide. After every behavior change, re-run the whole suite, not just the files you touched.

Commit the merge: `Merge upstream NanoClaw <version> into rebuild-v2`, with the version from step 1 (or the tag named), with one bullet per area saying what was re-derived and where GWS-EA's code shrank.

### 8. Guards and the divergence record

- Every behavior change that remains in an upstream-owned file has a guard that fails if a later sync drops it. The guard lives in `src/gws-ea/divergence.test.ts` or a GWS-EA-owned test.
- Mutation-check each new guard: break the property, see it go red, restore.
- Add a dated section to `$OPERATOR/docs/rebuild/upstream-divergence-2026-09-24.md`. It names the merge and follow-up commits and has one row per changed path; its rows supersede earlier rows for the same paths.

### 9. Review gate

Run `/ce-code-review` over GWS-EA's part only: the follow-up commits (base: the merge commit) plus the merge's own resolutions. The resolutions are every path that conflicted (step 6's `conflicts.txt`, which includes a conflict resolved wholly to GWS-EA's side) and every file that differs from both of the merge's parents. Review each against both parents:

```bash
M=<merge commit>
{ cat "$SCRATCH/conflicts.txt"; git diff --name-only "$M^1" "$M" | while read -r f; do
  [ "$(git rev-parse -q --verify "$M:$f")" != "$(git rev-parse -q --verify "$M^2:$f")" ] && echo "$f"
done; } | sort -u > "$SCRATCH/resolution-files.txt"
git diff "$M^1" "$M" -- $(cat "$SCRATCH/resolution-files.txt") > "$SCRATCH/resolution-vs-ours.diff"
git diff "$M^2" "$M" -- $(cat "$SCRATCH/resolution-files.txt") > "$SCRATCH/resolution-vs-upstream.diff"
```

Invoke the Compound Engineering review skill (`compound-engineering:ce-code-review`, typed `/ce-code-review`) with `base:<merge commit>`, and say in the request that the merge's resolutions are in scope too, naming the two diff files and `resolution-files.txt`. Fix confirmed findings in one follow-up commit and re-run step 7.

### 10. Land

```bash
git fetch origin +refs/heads/rebuild-v2:refs/remotes/origin/rebuild-v2
git merge-base --is-ancestor origin/rebuild-v2 HEAD && echo fast-forward
git log origin/rebuild-v2..HEAD --first-parent --oneline
git diff --stat origin/rebuild-v2...HEAD | tail -1
```

Show the maintainer the commit list, the checks, and the review result, then wait for an explicit go. If `rebuild-v2` moved meanwhile, replay the branch onto it with `git rebase --rebase-merges origin/rebuild-v2`; `rerere` reapplies the recorded resolutions, so resolve only conflicts that are new, then re-run step 7. Then:

```bash
git push origin HEAD:rebuild-v2    # fast-forward only; never --force, never a PR
```

### 11. Afterwards

- Watch CI on the push, since a sync never had a PR to run it: `gh run list --repo taslim/nanoclaw-gws-ea --branch rebuild-v2 --limit 3`. A red run is fixed forward in an ordinary PR.
- Bring the operator checkout (`$OPERATOR`) to the new `rebuild-v2`, since `gws-ea` runs from its source. When `git branch --show-current` there prints `rebuild-v2`, run `git pull --ff-only`, then `pnpm install --frozen-lockfile`, and confirm `gws-ea --help` loads. On any other branch, leave it: that is the maintainer's work in progress; tell them `rebuild-v2` moved.
- `git worktree remove .claude/worktrees/sync-nanoclaw-$D` and `git branch -d chore/sync-nanoclaw-$D`.
- Tell the maintainer that assistants get the sync through `gws-ea update`, their call. Say when the update rebuilds the agent image (a `container/` change).

## Gotchas

| Symptom | Cause | Fix |
|---|---|---|
| A file list passed as one path; a diff comes out empty | zsh does not split an unquoted `$VAR` into words | `$(cat "$file")` or `${=VAR}` |
| `git merge --abort` fails: "Entry … not uptodate" | A cleanly merged file was edited after the merge | Copy the resolved files to scratch, `git reset --hard HEAD`, redo the merge, copy them back |
| `CLAUDE.md`'s STOP banner says to halt on merge conflicts | It guards v1 installs pulling v2, not this sync | `rebuild-v2` already contains a v2 upstream merge; continue |
| `scripts/update/controller-archive.test.ts` fails with `ERR_MODULE_NOT_FOUND` | Upstream's update controller runs from `git archive … scripts src/install-slug.ts`, so `scripts/update/*` may import nothing else from `src/` | Keep upstream's file; put what GWS-EA needs in its own file with a guard |
| `gh` acts on nanocoai/nanoclaw | The repo has no default `gh` repo | Pass `--repo taslim/nanoclaw-gws-ea` |
| A commit prints pages of prettier output | Husky's pre-commit runs `format:fix` on `src/` | Check `git log -1` and `git status`; the commit landed |
| Prettier flags container files | `format:check` covers `src/**/*.ts` only, and many upstream container files are unformatted | Format only the files you wrote |
| `.claude/scheduled_tasks.lock` blocks a pull in the operator checkout | Upstream tracks it; the operator checkout hides it with `skip-worktree` | `git update-index --no-skip-worktree` it, `git checkout --` it, pull, then set `--skip-worktree` again |
| The `skill-pins` CI job fails | The fork pins Chat SDK adapters above upstream's mirror | `pnpm run skill-pins:generate` and commit `.github/skill-pins` |
| A stash vanishes | The stash stack is shared with every worktree | Never bare `git stash`; make a WIP commit instead |
