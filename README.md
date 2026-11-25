# NanoClaw GWS-EA

An opinionated Google Workspace executive assistant built on [NanoClaw](https://github.com/nanocoai/nanoclaw) v2.

Each assistant runs as its own isolated deployment — its own Workspace account, checkout, background service, Docker containers, OneCLI credential gateway, databases, and state — managed from a single `gws-ea` control plane.

## What It Does

- **Google Workspace as its own account** — talks to you in Google Chat as itself (Pub/Sub events, reactions, DMs, and group spaces), handles Gmail with an isolated `external-email` compartment for third-party mail, manages Calendar, and works across Drive, Docs, Sheets, Slides, and Forms.
- **Day planning and follow-through** — maintains a Manual of the principal, whereabouts and principal-local timezones, a coming-days calendar view, a daily evening close, and durable matters tracking so open loops do not drop.
- **Built-in host browser** — runs web errands in a dedicated per-assistant Chrome via host Playwright over a private loopback proxy, with macOS Keychain-encrypted saved logins, site consent handling, page-change watches, and principal-approved purchases.
- **WhatsApp and optional voice notes** — connects WhatsApp as a principal channel and supports an optional host-wide `voice` connector for local voice-note transcription.
- **Assistant web and connected apps (`web` connector)** — gives each assistant a Cloudflare Access-protected hostname (`<name>.<zone>`) serving HTML artifacts (`/artifacts`), saved logins (`/logins`), and principal-connected remote MCP apps (`/connections`) with per-tool approval controls.
- **Isolated credentials and containers** — agents run in Linux Docker containers and never hold raw API keys or OAuth tokens. Model and Google credentials stay in each assistant's OneCLI gateway; saved website logins and principal-app OAuth tokens stay encrypted on the host.
- **Multi-assistant operator CLI (`gws-ea`)** — exact-commit deploys, database migration dry-runs, staged updates (`gws-ea update --id` / `--all`), rollback (`gws-ea rollback`), read-only health/status probes, and clean teardown (`gws-ea remove`).

## Quick Start

```bash
git clone https://github.com/taslim/nanoclaw-gws-ea.git
cd nanoclaw-gws-ea
bash gws-ea.sh
gws-ea create --track prod
```

`bash gws-ea.sh` installs Node.js, pnpm, and dependencies through NanoClaw's bootstrap and links `gws-ea` into `~/.local/bin`. `gws-ea create --track prod` then provisions a dedicated assistant deployment from this checkout's committed release.

> **Important:** Do not run `nanoclaw.sh`, `pnpm run dev`, `./container/build.sh`, or `/update-nanoclaw` inside your `gws-ea` tool checkout. `gws-ea` deploys each assistant into its own isolated release directory and cleans stray NanoClaw installs in the tool checkout automatically.

### Prerequisites

- **OS:** macOS (required for built-in Keychain saved logins, connected-app token encryption, and the host Chrome browser at `/Applications/Google Chrome.app`; base assistant services also run on Linux)
- **Runtime:** Node.js 22+ (`.nvmrc` pins Node 24), pnpm 10+, and [Docker Desktop](https://docker.com/products/docker-desktop) / Docker Engine
- **Google accounts:** an operator Google Cloud account (`gcloud`) and a dedicated Google Workspace account for each assistant
- **Model credentials:** Anthropic (default) or another installed NanoClaw provider, stored in the assistant's credential gateway

## Updating

Update the tool checkout, refresh dependencies, then roll eligible assistants forward:

```bash
git pull
bash gws-ea.sh
gws-ea update --all
```

Each update stages the new release beside the running assistant, dry-runs central database migrations against a copy of live state, previews changes before cutover, and supports rollback with `gws-ea rollback --id <instance_id>`.

## Release Tracks

Track-to-branch mapping lives in [`src/gws-ea/release-tracks.json`](src/gws-ea/release-tracks.json):

| Track | Branch | Purpose |
| --- | --- | --- |
| `prod` | `main` | Promoted releases for operators (`gws-ea create --track prod`) |
| `dogfood` | `dogfood` | Integration and canary branch where PRs and upstream NanoClaw syncs land first |

Use `--source-remote <url>` to deploy a track from another repository or private downstream fork.

## Documentation

- [docs/gws-ea-cli.md](docs/gws-ea-cli.md) — full `gws-ea` operator, connector, browser, and automation guide
- [docs/gws-ea-artifacts.md](docs/gws-ea-artifacts.md) — HTML artifacts lifecycle and sharing
- [docs/gws-ea-voice.md](docs/gws-ea-voice.md) — optional `voice` connector setup
- [docs/gws-ea-whatsapp.md](docs/gws-ea-whatsapp.md) — WhatsApp channel setup
- [CLAUDE.md](CLAUDE.md) — architecture overview, invariants, and maintainer release workflow
- [docs/architecture.md](docs/architecture.md) — underlying NanoClaw v2 architecture

## Legacy Branches

Earlier generations are preserved read-only on [`v2-legacy`](https://github.com/taslim/nanoclaw-gws-ea/tree/v2-legacy) (pre-rebuild v2) and [`v1`](https://github.com/taslim/nanoclaw-gws-ea/tree/v1).

## License

MIT — built on [NanoClaw](https://github.com/nanocoai/nanoclaw).
