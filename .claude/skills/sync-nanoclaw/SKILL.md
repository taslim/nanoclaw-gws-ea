---
name: sync-nanoclaw
description: "Maintainer only: merge the latest official NanoClaw (nanocoai/nanoclaw) into GWS-EA's integration line rebuild-v2, re-deriving every place the fork and upstream meet so GWS-EA's divergence shrinks wherever upstream now does the job. Use when the GWS-EA maintainer says 'pull in latest from nanocoai/nanoclaw', 'sync with upstream', 'merge upstream NanoClaw', or 'update our fork to the latest NanoClaw'. Not for updating an install or an assistant: in GWS-EA nobody runs /update-nanoclaw; operators run git pull, bash gws-ea.sh, then gws-ea update --all."
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
- **Live assistant data changes only on an explicit yes.**

## Workflow

### 1. Confirm the maintainer, then fetch

```bash
git remote get-url origin     # https://github.com/taslim/nanoclaw-gws-ea(.git)
git remote get-url upstream   # https://github.com/nanocoai/nanoclaw(.git)
gh repo view taslim/nanoclaw-gws-ea --json viewerPermission --jq .viewerPermission
```

Continue only when `origin` is `taslim/nanoclaw-gws-ea` and the permission is `ADMIN`, `MAINTAIN` or `WRITE`. Otherwise stop: *"This skill is for GWS-EA's maintainer. To update GWS-EA, run `git pull`, `bash gws-ea.sh`, then `gws-ea update --all`."* When the `upstream` remote is missing, the maintainer adds it with `git remote add upstream https://github.com/nanocoai/nanoclaw.git`.

```bash
git fetch upstream --tags && git fetch origin +refs/heads/rebuild-v2:refs/remotes/origin/rebuild-v2
MB=$(git merge-base origin/rebuild-v2 upstream/main)
git rev-list --count origin/rebuild-v2..upstream/main   # 0 means already current: stop
git log --oneline -1 "$MB"
```

Each command call starts a fresh shell, so set `MB`, `D` and `SCRATCH` again in every call that uses them, or substitute their values.

"Latest" means `upstream/main`. When the maintainer names a release tag (`vYYYY.MM.N` or `-rc.N`), use that ref everywhere this skill says `upstream/main`.

### 2. Create the worktree

From the operator checkout:

```bash
D=$(date +%Y-%m-%d)
git worktree add ".claude/worktrees/sync-nanoclaw-$D" -b "chore/sync-nanoclaw-$D" origin/rebuild-v2
```

Run every later command inside that worktree. Never switch, merge or reset in the operator checkout.

### 3. Map where the two sides meet

Keep lists and reports in a scratch directory outside the repo (`SCRATCH=$(mktemp -d)` once; reuse that path).

```bash
git diff --name-only "$MB" origin/rebuild-v2 | sort > "$SCRATCH/ours.txt"
git diff --name-only "$MB" upstream/main | sort > "$SCRATCH/theirs.txt"
comm -12 "$SCRATCH/ours.txt" "$SCRATCH/theirs.txt"                 # changed on both sides
git merge-tree --write-tree --name-only origin/rebuild-v2 upstream/main   # predicted conflicts; touches nothing
git log --no-merges --format='@@ %h %s' --name-only "$MB"..upstream/main  # each upstream commit and what it touches
```

Files changed on both sides are only part of it. Also read the divergence record (`docs/rebuild/upstream-divergence-2026-09-24.md`) for upstream capabilities that overlap a GWS-EA divergence in files only GWS-EA touched. Examples: a new upstream update channel next to GWS-EA's release tracks, or a new approval hook next to its gateway seams. Group everything into about five areas (see `references/area-analysis.md`).

### 4. Analyze each area in parallel

Launch one read-only agent per area, all together, each with the shared context and its area's section from `references/area-analysis.md`. While they run, do nothing that edits the repo.

When they return:

1. **Check the claims that drive decisions** yourself: pins, which tests read which files, what a deleted mechanism still guards. An agent's verdict is evidence, not a fact.
2. **Reconcile disagreements.** Two areas may reach different verdicts on one mechanism.
3. **Check pending decisions.** Look in `docs/rebuild/reviews/` and the maintainer's memory for an open decision the sync touches. Name it for the maintainer rather than settling it inside the merge.

### 5. Present options, then ask

Give the maintainer:

- what upstream now does, so GWS-EA's code shrinks (and how);
- where GWS-EA keeps its own because upstream's new feature solves something else (one line each on why);
- the mechanical work the merge forces;
- anything security-relevant or urgent for live assistants;
- live-data changes, which happen only on an explicit yes.

Ask only the genuine decisions, with a recommendation first. Decide product questions the product docs (`docs/rebuild/07-experience-principles.md`) already answer instead of asking them.

### 6. Merge and resolve

```bash
git merge --no-ff --no-commit upstream/main
git diff --name-only --diff-filter=U | tee "$SCRATCH/conflicts.txt"   # step 9 reviews every one of these
```

Resolve per the decisions, then `git add` each resolved path:

| Situation | Resolution |
|---|---|
| Upstream now owns the intent | `git checkout upstream/main -- <path>`, which restores upstream's file whether the path conflicted or merged cleanly; move what GWS-EA still needs into a GWS-EA-owned file under `src/gws-ea/` with a test. |
| GWS-EA keeps its change | Start from upstream's file (`git show upstream/main:<path> > <path>`) and re-apply GWS-EA's seam on top. |
| Upstream restructured code around a GWS-EA decision | Take upstream's structure; keep only GWS-EA's decision (for example, a failed turn is still `turn_failed` to the host, never a chat message). |
| Upstream-only files | Take them unchanged. |

Then the follow-ups the merge forces:

- **Installed skill copies:** for each `nc:copy` pair in a skill whose installed copy the fork tracks (add-onecli), `cmp` the payload source with the installed file and re-copy any that differ.
- **Skill pins:** `pnpm run skill-pins:generate`, then `pnpm run skill-pins:check`.
- **Lockfile:**
  - Keep both sides' packages in each conflict hunk.
  - Check that every `integrity:` hash comes from one side's lockfile; the next command prints any that don't.
  - Run `pnpm install --frozen-lockfile`, then `cd container/agent-runner && bun install --frozen-lockfile`.
  - Never add a `minimumReleaseAgeExclude` or `onlyBuiltDependencies` entry without the maintainer.

  ```bash
  git show origin/rebuild-v2:pnpm-lock.yaml upstream/main:pnpm-lock.yaml | grep -o 'integrity: sha512-[A-Za-z0-9+/=]*' | sort -u > "$SCRATCH/known"
  grep -o 'integrity: sha512-[A-Za-z0-9+/=]*' pnpm-lock.yaml | sort -u | comm -23 - "$SCRATCH/known"   # must print nothing
  ```
- **Upstream tests on fork-extended types:** `pnpm exec tsc --noEmit` catches an upstream fixture that lacks a field GWS-EA made required.
- **Fakes of upstream helpers:** when upstream changes a helper's semantics, rewrite GWS-EA's fakes for the new semantics, and assert the property (only the named install was touched) rather than an exact call list.

Save the merge commit only once the tree is green (step 7). Changes that shrink a divergence but are not needed for green go in separate follow-up commits, one per concern.

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

Commit the merge: `Merge upstream NanoClaw <version> into rebuild-v2`, with one bullet per area saying what was re-derived and where GWS-EA's code shrank.

### 8. Guards and the divergence record

- Every behavior change that remains in an upstream-owned file has a guard that fails if a later sync drops it. The guard lives in `src/gws-ea/divergence.test.ts` or a GWS-EA-owned test.
- Mutation-check each new guard: break the property, see it go red, restore.
- Add a dated section to `docs/rebuild/upstream-divergence-2026-09-24.md`. It names the merge and follow-up commits and has one row per changed path; its rows supersede earlier rows for the same paths.

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

Fix confirmed findings in one follow-up commit and re-run step 7.

### 10. Land

```bash
git fetch origin +refs/heads/rebuild-v2:refs/remotes/origin/rebuild-v2
git merge-base --is-ancestor origin/rebuild-v2 HEAD && echo fast-forward
git log origin/rebuild-v2..HEAD --first-parent --oneline
git diff --stat origin/rebuild-v2...HEAD | tail -1
```

Show the maintainer the commit list, the checks, and the review result, then wait for an explicit go. If `rebuild-v2` moved meanwhile, replay the branch onto it with `git rebase --rebase-merges origin/rebuild-v2`, re-resolve, and re-run step 7. Then:

```bash
git push origin HEAD:rebuild-v2    # fast-forward only; never --force, never a PR
```

### 11. Afterwards

- In the operator checkout: `git pull --ff-only`, then `pnpm install --frozen-lockfile`, since `gws-ea` runs from that checkout's source. Confirm `gws-ea --help` loads.
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
