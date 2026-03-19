---
name: update-ea
description: Pull nanoclaw-gws-ea updates into your fork, with preview, selective cherry-pick, and EA-aware conflict resolution. Triggers on "update", "update ea", "sync upstream", "pull upstream".
---

# About

Your nanoclaw-gws-ea fork drifts as you customize it (profile.md, procedures, additional channels). This skill pulls updates from nanoclaw-gws-ea into your install without losing your modifications.

The update chain is: `qwibitai/nanoclaw` → `nanoclaw-gws-ea` → **your fork**. This skill handles the last arrow. The nanoclaw-gws-ea maintainer curates upstream core changes before they reach you.

Run `/update-ea` in Claude Code.

## How it works

**Preflight**: checks for clean working tree (`git status --porcelain`). If `upstream` remote is missing, adds `https://github.com/taslim/nanoclaw-gws-ea.git`. Detects the upstream branch name (`main` or `master`).

**Backup**: creates a timestamped backup branch and tag (`backup/pre-update-<hash>-<timestamp>`, `pre-update-<hash>-<timestamp>`) before touching anything. Safe to run multiple times.

**Preview**: runs `git log` and `git diff` against the merge base to show upstream changes since your last sync. Groups changed files into categories and **flags EA-modified core files** that are likely conflict points:

| File | What GWS-EA modifies |
|------|---------------------|
| `src/config.ts` | EA config vars, `validateEaConfig()`, `isPrincipalEmail()` |
| `src/types.ts` | `allowedTools` on ContainerConfig, `sendReaction` on Channel |
| `src/db.ts` | `processed_emails`, `email_routes`, `matters`, `reactions` tables |
| `src/index.ts` | Synthetic groups, email routing, GChat DM registration, status indicators |
| `src/ipc.ts` | `sendReaction` handler, `create_matter`/`update_matter` IPC |
| `src/container-runner.ts` | Conditional Workspace/Calendar mounts, `allowedTools` passthrough |

**Update paths** (you pick one):
- `merge` (default): `git merge upstream/<branch>`. Resolves all conflicts in one pass.
- `cherry-pick`: `git cherry-pick <hashes>`. Pull in only the commits you want.
- `rebase`: `git rebase upstream/<branch>`. Linear history, but conflicts resolve per-commit.
- `abort`: just view the changelog, change nothing.

**Conflict preview**: before merging, runs a dry-run (`git merge --no-commit --no-ff`) to show which files would conflict. You can still abort at this point.

**Conflict resolution**: opens only conflicted files, resolves the conflict markers, keeps your local customizations intact.

**Validation**: runs `npm run build` and `npm test`.

**Container rebuild**: if `container/Dockerfile` or `container/agent-runner/` changed, prompts to rebuild.

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
Help a user with a customized nanoclaw-gws-ea fork safely incorporate updates without a fresh reinstall and without blowing tokens.

# Operating principles
- Never proceed with a dirty working tree.
- Always create a rollback point (backup branch + tag) before touching anything.
- Prefer git-native operations (fetch, merge, cherry-pick). Do not manually rewrite files except conflict markers.
- Default to MERGE (one-pass conflict resolution). Offer REBASE as an explicit option.
- Keep token usage low: rely on `git status`, `git log`, `git diff`, and open only conflicted files.
- **When resolving conflicts in EA-modified core files, preserve the user's local additions.** Upstream (gws-ea) adds EA code; user adds their customizations. Both should coexist.

# Step 0: Preflight (stop early if unsafe)
Run:
- `git status --porcelain`
If output is non-empty:
- Tell the user to commit or stash first, then stop.

Confirm remotes:
- `git remote -v`
If `upstream` is missing:
- Add it: `git remote add upstream https://github.com/taslim/nanoclaw-gws-ea.git`
- Then: `git fetch upstream --prune`

Determine the upstream branch name:
- `git branch -r | grep upstream/`
- If `upstream/main` exists, use `main`.
- If only `upstream/master` exists, use `master`.
- Otherwise, ask the user which branch to use.
- Store this as UPSTREAM_BRANCH for all subsequent commands. Every command below that references `upstream/main` should use `upstream/$UPSTREAM_BRANCH` instead.

Fetch:
- `git fetch upstream --prune`

# Step 1: Create a safety net
Capture current state:
- `HASH=$(git rev-parse --short HEAD)`
- `TIMESTAMP=$(date +%Y%m%d-%H%M%S)`

Create backup branch and tag (using timestamp to avoid collisions on retry):
- `git branch backup/pre-update-$HASH-$TIMESTAMP`
- `git tag pre-update-$HASH-$TIMESTAMP`

Save the tag name for later reference in the summary and rollback instructions.

# Step 2: Preview what upstream changed (no edits yet)
Compute common base:
- `BASE=$(git merge-base HEAD upstream/$UPSTREAM_BRANCH)`

Show upstream commits since BASE:
- `git log --oneline $BASE..upstream/$UPSTREAM_BRANCH`

Show local commits since BASE (custom drift):
- `git log --oneline $BASE..HEAD`

Show file-level impact from upstream:
- `git diff --name-only $BASE..upstream/$UPSTREAM_BRANCH`

Bucket the upstream changed files:
- **EA core files** (`src/config.ts`, `src/types.ts`, `src/db.ts`, `src/index.ts`, `src/ipc.ts`, `src/container-runner.ts`): likely conflict points — flag these prominently
- **EA additions** (`src/channels/gchat.ts`, `src/email.ts`, `src/workspace-auth.ts`): conflict only if user also modified them
- **Skills** (`.claude/skills/`): unlikely to conflict unless the user edited an upstream skill
- **Procedures/groups** (`groups/`): may conflict if user customized the same procedure files
- **Build/config** (`package.json`, `package-lock.json`, `tsconfig*.json`, `container/`, `launchd/`): review needed
- **Other**: docs, tests, misc

If any EA core files appear in the upstream diff, warn: "These files have EA modifications and upstream changes — merge conflicts are likely. I'll preserve your customizations during resolution."

If container files changed (`container/Dockerfile`, `container/agent-runner/`), note that a rebuild will be needed after the update.

Present these buckets to the user and ask them to choose one path using AskUserQuestion:
- A) **Full update**: merge all upstream changes
- B) **Selective update**: cherry-pick specific upstream commits
- C) **Abort**: they only wanted the preview
- D) **Rebase mode**: advanced, linear history (warn: resolves conflicts per-commit)

If Abort: stop here.

# Step 3: Conflict preview (before committing anything)
If Full update or Rebase:
- Dry-run merge to preview conflicts. Run these as a single chained command so the abort always executes:
  ```
  git merge --no-commit --no-ff upstream/$UPSTREAM_BRANCH; git diff --name-only --diff-filter=U; git merge --abort
  ```
- If conflicts were listed: show them and ask user if they want to proceed.
- If no conflicts: tell user it is clean and proceed.

# Step 4A: Full update (MERGE, default)
Run:
- `git merge upstream/$UPSTREAM_BRANCH --no-edit`

If conflicts occur:
- Run `git status` and identify conflicted files.
- For each conflicted file:
  - Open the file.
  - Resolve only conflict markers.
  - Preserve intentional local customizations.
  - Incorporate upstream fixes/improvements.
  - Do not refactor surrounding code.
  - `git add <file>`
- When all resolved:
  - If merge did not auto-commit: `git commit --no-edit`

# Step 4B: Selective update (CHERRY-PICK)
If user chose Selective:
- Recompute BASE if needed: `BASE=$(git merge-base HEAD upstream/$UPSTREAM_BRANCH)`
- Show commit list again: `git log --oneline $BASE..upstream/$UPSTREAM_BRANCH`
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
- `git rebase upstream/$UPSTREAM_BRANCH`

If conflicts:
- Resolve conflict markers only, then:
  - `git add <file>`
  - `git rebase --continue`
If it gets messy (more than 3 rounds of conflicts):
  - `git rebase --abort`
  - Recommend merge instead.

# Step 5: Validation
Run:
- `npm run build`
- `npm test` (do not fail the flow if tests are not configured)

If build fails:
- Show the error.
- Only fix issues clearly caused by the merge (missing imports, type mismatches from merged code).
- Do not refactor unrelated code.
- If unclear, ask the user before making changes.

# Step 6: Container rebuild check
If container files changed in the update (`container/Dockerfile`, `container/agent-runner/`):
- AskUserQuestion: "Container files changed. Rebuild the container now?"
- If yes: `./container/build.sh`

# Step 7: Breaking changes check
After validation succeeds, check if the update introduced any breaking changes.

Determine which CHANGELOG entries are new by diffing against the backup tag:
- `git diff <backup-tag-from-step-1>..HEAD -- CHANGELOG.md`

Parse the diff output for lines starting with `+[BREAKING]`. Each such line is one breaking change entry. The format is:
```
[BREAKING] <description>. Run `/<skill-name>` to <action>.
```

If no `[BREAKING]` lines are found:
- Skip this step silently. Proceed to Step 8 (skill updates check).

If one or more `[BREAKING]` lines are found:
- Display a warning header to the user: "This update includes breaking changes that may require action:"
- For each breaking change, display the full description.
- Collect all skill names referenced in the breaking change entries (the `/<skill-name>` part).
- Use AskUserQuestion to ask the user which migration skills they want to run now. Options:
  - One option per referenced skill
  - "Skip — I'll handle these manually"
- Set `multiSelect: true` so the user can pick multiple skills if there are several breaking changes.
- For each skill the user selects, invoke it using the Skill tool.
- After all selected skills complete (or if user chose Skip), proceed to Step 8 (skill updates check).

# Step 8: Check for skill updates
After the summary, check if skills are distributed as branches in this repo:
- `git branch -r --list 'upstream/skill/*'`

If any `upstream/skill/*` branches exist:
- Use AskUserQuestion to ask: "Upstream has skill branches. Would you like to check for skill updates?"
  - Option 1: "Yes, check for updates" (description: "Runs /update-skills to check for and apply skill branch updates")
  - Option 2: "No, skip" (description: "You can run /update-skills later any time")
- If user selects yes, invoke `/update-skills` using the Skill tool.
- After the skill completes (or if user selected no), proceed to Step 9.

# Step 9: Summary + rollback instructions
Show:
- Backup tag: the tag name created in Step 1
- New HEAD: `git rev-parse --short HEAD`
- Upstream HEAD: `git rev-parse --short upstream/$UPSTREAM_BRANCH`
- Conflicts resolved (list files, if any)
- Container rebuild status (rebuilt or skipped)
- Breaking changes applied (list skills run, if any)
- Remaining local diff vs upstream: `git diff --name-only upstream/$UPSTREAM_BRANCH..HEAD`

Tell the user:
- To rollback: `git reset --hard <backup-tag-from-step-1>`
- Backup branch also exists: `backup/pre-update-<HASH>-<TIMESTAMP>`
- Restart the service to apply changes:
  - If using launchd: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist && launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist`
  - If running manually: restart `npm run dev`
