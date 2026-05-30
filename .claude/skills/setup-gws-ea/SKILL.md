---
name: setup-gws-ea
description: Run Nanoclaw GWS-EA setup. Use when the user wants to install, re-run setup, or import v1 data. Triggers on "setup", "setup gws-ea", "install gws-ea", "import v1", or first-time setup requests on this fork.
---

# Nanoclaw GWS-EA Setup

Tell the user to run `bash setup-gws-ea.sh` from the project root. That script handles the full end-to-end setup — `.env` config, GCP provisioning (project, SA, DWD), deps, container image, OneCLI vault, Claude auth, service, first agent (GChat DM), email channel, heartbeat — and **then** offers to import data from a v1 install if one is detected. It's idempotent: the bootstrap and init steps re-run safely, and the v1-import prompt is asked every run (decline to skip).

The fork ships v2 on `main`, so a fresh install is just:

```bash
git clone https://github.com/taslim/nanoclaw-gws-ea.git
cd nanoclaw-gws-ea
bash setup-gws-ea.sh
```

## Importing from v1

Existing v1 users keep their old checkout running and build v2 in a **sibling worktree**. Don't `git pull` v2 onto the v1 checkout — that mixes v1 data with v2 code (the script detects this and refuses).

```bash
cd ~/Projects/nanoclaw-gws-ea
git fetch origin
git worktree add ../nanoclaw-gws-ea-v2 origin/main
cd ../nanoclaw-gws-ea-v2
bash setup-gws-ea.sh
```

The script bootstraps v2, runs the canonical init scripts (main, email, heartbeat), then — once v2 is wired end-to-end — asks whether to import v1's custom agents and active scheduled tasks on top. Answer yes to copy them over, lift matters, and swap launchd from v1 to v2. Answer no to leave v1 alone and keep both running independently.

Override the v1 location with `--v1-path PATH` or `NANOCLAW_V1_PATH=PATH` if your layout differs.

## Non-interactive flags

- `--migrate` — auto-yes to the v1-import prompt (CI / scripted use)
- `--no-migrate` — auto-no (keep v1 alone, just bootstrap + init v2)

There is no separate "fresh" / "reconfigure" mode — re-running is always safe. If init partially completed in a prior failed run, the next run picks up where it left off.

## Reinstall and uninstall

For a destructive reset, use these instead of running setup-gws-ea repeatedly:

```bash
bash setup-gws-ea.sh --reinstall    # wipe v2 state, then re-run setup. Preserves .env, plist, GCP.
bash setup-uninstall.sh             # tear down v2 entirely. GCP resources retained.
bash setup-uninstall.sh --gcp       # also delete GCP project (separate confirmation).
```

Both call into `setup/teardown.ts` which builds a plan and shows it before deleting anything. Add `--yes` to skip the confirmation in either command.

`reinstall` is the right tool when a setup attempt failed mid-flow and left partial state behind — instead of manually wiping `data/`, killing the service, and removing OneCLI agents, run `--reinstall` and it does all of that, then re-runs setup. Preserves `.env` so init prompts mostly skip.

`uninstall` returns the install to clone-equivalent state on this machine. To set up again afterwards: `bash setup-gws-ea.sh`. Use `--gcp` to additionally tear down the GCP project (immutable IDs — only do this if you really want to start over from new resource names).

## If something fails

The script halts at the failing step with a clear message and is re-runnable from there. Common causes: expired `gcloud auth login`, DWD scopes not yet authorized in the admin console.

Run `bash setup-gws-ea.sh --help` for the full flag list.
