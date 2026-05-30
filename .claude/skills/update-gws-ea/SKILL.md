---
name: update-gws-ea
description: Pull community contributions from the nanoclaw-gws-ea public fork back into this private fork, with preview, selective cherry-pick, and low token usage.
---

# About

When community contributors open PRs against your public fork (`nanoclaw-gws-ea`) and you merge them there, those changes need to flow back into this private fork. This skill pulls them in without losing your local modifications.

Run `/update-gws-ea` in Claude Code.

## How it works

**Preflight**: checks for clean working tree (`git status --porcelain`). If `gws-ea` remote is missing, asks you for the URL (defaults to `https://github.com/taslim/nanoclaw-gws-ea.git`) and adds it. Detects the gws-ea branch name (`main` or `master`).

**Backup**: creates a timestamped backup branch and tag (`backup/pre-update-<hash>-<timestamp>`, `pre-update-<hash>-<timestamp>`) before touching anything. Safe to run multiple times.

**Preview**: runs `git log` and `git diff` against the merge base to show gws-ea changes since your last sync. Groups changed files into categories:
- **Skills** (`.claude/skills/`): unlikely to conflict unless you edited an gws-ea skill
- **Host source** (`src/`): may conflict if you modified the same files
- **Container** (`container/`): triggers container rebuild
- **Build/config** (`package.json`, `pnpm-lock.yaml`, `tsconfig*.json`): lockfile changes trigger dep install

**Update paths** (you pick one):
- `merge` (default): `git merge gws-ea/<branch>`. Resolves all conflicts in one pass.
- `cherry-pick`: `git cherry-pick <hashes>`. Pull in only the commits you want.
- `rebase`: `git rebase gws-ea/<branch>`. Linear history, but conflicts resolve per-commit.
- `abort`: just view the changelog, change nothing.

**Conflict preview**: before merging, runs a dry-run (`git merge --no-commit --no-ff`) to show which files would conflict. You can still abort at this point.

**Conflict resolution**: opens only conflicted files, resolves the conflict markers, keeps your local customizations intact.

**Validation**: runs `pnpm run build` and `pnpm test`. If container files changed, also runs the container typecheck and `./container/build.sh`.

**Breaking changes check**: after validation, reads CHANGELOG.md for any `[BREAKING]` entries introduced by the update. If found, shows each breaking change and offers to run the recommended skill to migrate.

## Rollback

The backup tag is printed at the end of each run:
```
git reset --hard pre-update-<hash>-<timestamp>
```

Backup branch `backup/pre-update-<hash>-<timestamp>` also exists.

## Token usage

Only opens files with actual conflicts. Uses `git log`, `git diff`, and `git status` for everything else. Does not scan or refactor unrelated code.

---

# Goal
Help a user with a customized NanoClaw install safely incorporate gws-ea changes without a fresh reinstall and without blowing tokens.

# Operating principles
- Never proceed with a dirty working tree.
- Always create a rollback point (backup branch + tag) before touching anything.
- Prefer git-native operations (fetch, merge, cherry-pick). Do not manually rewrite files except conflict markers.
- Default to MERGE (one-pass conflict resolution). Offer REBASE as an explicit option.
- Keep token usage low: rely on `git status`, `git log`, `git diff`, and open only conflicted files.

# Step 0: Preflight (stop early if unsafe)
Run:
- `git status --porcelain`
If output is non-empty:
- Tell the user to commit or stash first, then stop.

Confirm remotes:
- `git remote -v`
If `gws-ea` is missing:
- Ask the user for the gws-ea repo URL (default: `https://github.com/taslim/nanoclaw-gws-ea.git`).
- Add it: `git remote add gws-ea <user-provided-url>`
- Then: `git fetch gws-ea --prune`

Determine the gws-ea branch name:
- `git branch -r | grep gws-ea/`
- If `gws-ea/main` exists, use `main`.
- If only `gws-ea/master` exists, use `master`.
- Otherwise, ask the user which branch to use.
- Store this as GWS_EA_BRANCH for all subsequent commands. Every command below that references `gws-ea/main` should use `gws-ea/$GWS_EA_BRANCH` instead.

Fetch:
- `git fetch gws-ea --prune`

# Step 1: Create a safety net
Capture current state:
- `HASH=$(git rev-parse --short HEAD)`
- `TIMESTAMP=$(date +%Y%m%d-%H%M%S)`

Create backup branch and tag (using timestamp to avoid collisions on retry):
- `git branch backup/pre-update-$HASH-$TIMESTAMP`
- `git tag pre-update-$HASH-$TIMESTAMP`

Save the tag name for later reference in the summary and rollback instructions.

# Step 2: Preview what gws-ea changed (no edits yet)
Compute common base:
- `BASE=$(git merge-base HEAD gws-ea/$GWS_EA_BRANCH)`

Show gws-ea commits since BASE:
- `git log --oneline $BASE..gws-ea/$GWS_EA_BRANCH`

Show local commits since BASE (custom drift):
- `git log --oneline $BASE..HEAD`

Show file-level impact from gws-ea:
- `git diff --name-only $BASE..gws-ea/$GWS_EA_BRANCH`

Bucket the gws-ea changed files:
- **Skills** (`.claude/skills/`): unlikely to conflict unless the user edited a gws-ea skill
- **Host source** (`src/`): may conflict if user modified the same files
- **Container** (`container/`): triggers container rebuild (+ typecheck if `agent-runner/src/` changed)
- **Build/config** (`package.json`, `pnpm-lock.yaml`, `tsconfig*.json`): lockfile changes trigger dep install
- **Other**: docs, tests, setup scripts, misc

Present these buckets to the user and ask them to choose one path using AskUserQuestion:
- A) **Full update**: merge all gws-ea changes
- B) **Selective update**: cherry-pick specific gws-ea commits
- C) **Abort**: they only wanted the preview
- D) **Rebase mode**: advanced, linear history (warn: resolves conflicts per-commit)

If Abort: stop here.

# Step 3: Conflict preview (before committing anything)
If Full update or Rebase:
- Dry-run merge to preview conflicts. Run these as a single chained command so the abort always executes:
  ```
  git merge --no-commit --no-ff gws-ea/$GWS_EA_BRANCH; git diff --name-only --diff-filter=U; git merge --abort
  ```
- If conflicts were listed: show them and ask user if they want to proceed.
- If no conflicts: tell user it is clean and proceed.

# Step 4A: Full update (MERGE, default)
Run:
- `git merge gws-ea/$GWS_EA_BRANCH --no-edit`

If conflicts occur:
- Run `git status` and identify conflicted files.
- For each conflicted file:
  - Open the file.
  - Resolve only conflict markers.
  - Preserve intentional local customizations.
  - Incorporate gws-ea fixes/improvements.
  - Do not refactor surrounding code.
  - `git add <file>`
- When all resolved:
  - If merge did not auto-commit: `git commit --no-edit`

# Step 4B: Selective update (CHERRY-PICK)
If user chose Selective:
- Recompute BASE if needed: `BASE=$(git merge-base HEAD gws-ea/$GWS_EA_BRANCH)`
- Show commit list again: `git log --oneline $BASE..gws-ea/$GWS_EA_BRANCH`
- Ask user which commit hashes they want.
- Apply: `git cherry-pick <hash1> <hash2> ...`

If conflicts during cherry-pick:
- Resolve only conflict markers, then:
  - `git add <file>`
  - `git cherry-pick --continue`
If user wants to stop:
  - `git cherry-pick --abort`

# Step 4C: Rebase (only if user explicitly chose option D)
Run:
- `git rebase gws-ea/$GWS_EA_BRANCH`

If conflicts:
- Resolve conflict markers only, then:
  - `git add <file>`
  - `git rebase --continue`
If it gets messy (more than 3 rounds of conflicts):
  - `git rebase --abort`
  - Recommend merge instead.

# Step 4.5: Install dependencies (if lockfiles changed)
Check if the merge changed any lockfiles or package manifests:
- `git diff <backup-tag-from-step-1>..HEAD --name-only | grep -E '^(pnpm-lock\.yaml|package\.json)$'`
  - If matched: `pnpm install`
- `git diff <backup-tag-from-step-1>..HEAD --name-only | grep -E '^container/agent-runner/(bun\.lock|package\.json)$'`
  - If matched AND `command -v bun` succeeds: `cd container/agent-runner && bun install`
  - If bun is not installed on the host, skip — container deps will be installed during `./container/build.sh`

Skip this step if neither lockfile changed.

# Step 5: Validation
Check which areas changed to determine what to validate:
- `CHANGED_FILES=$(git diff --name-only <backup-tag-from-step-1>..HEAD)`

**Host build** (always):
- `pnpm run build`
- `pnpm test` (do not fail the flow if tests are not configured)

**Container typecheck** (only if `container/agent-runner/src/` files are in CHANGED_FILES AND bun types are available):
- Check: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
- If this fails because bun types are missing (`Cannot find type definition file for 'bun'`), skip with a note — type errors will surface at container runtime instead

**Container image rebuild** (only if any `container/` files are in CHANGED_FILES):
- `./container/build.sh`

If build fails:
- Show the error.
- Only fix issues clearly caused by the merge (missing imports, type mismatches from merged code).
- Do not refactor unrelated code.
- If unclear, ask the user before making changes.

# Step 6: Breaking changes check
After validation succeeds, check if the update introduced any breaking changes.

Determine which CHANGELOG entries are new by diffing against the backup tag:
- `git diff <backup-tag-from-step-1>..HEAD -- CHANGELOG.md`

Parse the diff output for lines that contain `[BREAKING]` anywhere in the line. Each such line is one breaking change entry. The format is:
```
[BREAKING] <description>. Run `/<skill-name>` to <action>.
```

If no `[BREAKING]` lines are found:
- Skip this step silently. Proceed to Step 7 (summary).

If one or more `[BREAKING]` lines are found:
- Display a warning header to the user: "This update includes breaking changes that may require action:"
- For each breaking change, display the full description.
- Collect all skill names referenced in the breaking change entries (the `/<skill-name>` part).
- Use AskUserQuestion to ask the user which migration skills they want to run now. Options:
  - One option per referenced skill (e.g., "Run /add-whatsapp to re-add WhatsApp channel")
  - "Skip — I'll handle these manually"
- Set `multiSelect: true` so the user can pick multiple skills if there are several breaking changes.
- For each skill the user selects, invoke it using the Skill tool.
- After all selected skills complete (or if user chose Skip), proceed to Step 7 (summary).

# Step 7: Summary + rollback instructions
Show:
- Backup tag: the tag name created in Step 1
- New HEAD: `git rev-parse --short HEAD`
- gws-ea HEAD: `git rev-parse --short gws-ea/$GWS_EA_BRANCH`
- Conflicts resolved (list files, if any)
- Breaking changes applied (list skills run, if any)
- Remaining local diff vs gws-ea: `git diff --name-only gws-ea/$GWS_EA_BRANCH..HEAD`

Tell the user:
- To rollback: `git reset --hard <backup-tag-from-step-1>`
- Backup branch also exists: `backup/pre-update-<HASH>-<TIMESTAMP>`
- Restart the service to apply changes. The unit/label names are per-install — derive them with `setup/lib/install-slug.sh`. Run from your NanoClaw project root:
  - **macOS (Darwin)**: `source setup/lib/install-slug.sh && launchctl kickstart -k gui/$(id -u)/$(launchd_label)`
  - **Linux**: `source setup/lib/install-slug.sh && systemctl --user restart $(systemd_unit)` (or, if you want to confirm the unit name first: `systemctl --user list-units --type=service | grep "$(. setup/lib/install-slug.sh && systemd_unit)"`)
  - **Manual** (no service found): restart `pnpm run dev`
