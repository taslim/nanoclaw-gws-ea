# NanoClaw GWS-EA

A [NanoClaw](https://github.com/nanocoai/nanoclaw) flavor that turns Claude into a Google Workspace executive assistant. Talks to you over Google Chat, triages Gmail, runs your calendar, writes Docs — each agent sandboxed in its own container.

Built on NanoClaw v2's single-process orchestrator with per-session container isolation. Every message — chat, email, scheduled sweep — flows through the same entity model and the same two-DB session split. This fork adds the Workspace surface on top.

## What It Adds

On top of upstream NanoClaw v2:

- **Google Chat channel** — DMs and spaces via Workspace Events (Pub/Sub), thread tracking, 👀/❌ emoji status indicators.
- **Gmail event source** — polls the EA's inbox and routes each message to an isolated agent group **by sender**, not by thread.
- **Google Workspace MCP tools** — Calendar, Drive, Docs, Sheets, Tasks, Contacts, injected into containers as MCP servers. Credentials never touch the agent.
- **EA procedures** — morning briefings, weekly reviews, email triage, scheduling, and hourly proactive sweeps, all as editable playbooks.
- **Sender-scoped trust** — the principal's agent gets full tools; external senders get a restricted set (calendar free/busy + RSVP only, no messaging).

## Quick Start

```bash
git clone https://github.com/taslim/nanoclaw-gws-ea.git
cd nanoclaw-gws-ea
bash setup-gws-ea.sh
```

`setup-gws-ea.sh` runs the whole path end to end: `.env` config, GCP provisioning (project, service account, domain-wide delegation), dependencies, the agent container image, the OneCLI credential vault, Claude auth, the system service, and your first agent (a Google Chat DM) plus the email channel and heartbeat sweep. It's idempotent — re-run it any time; it picks up where it left off.

If a step fails, it halts with a clear message and is re-runnable from there. Common causes: an expired `gcloud auth login` or DWD scopes not yet authorized in the Workspace admin console.

> Commands prefixed with `/` (like `/setup-gws-ea`, `/update-gws-ea`) are [Claude Code skills](https://code.claude.com/docs/en/skills) — type them inside the `claude` prompt, not your shell. Get Claude Code at [claude.com/product/claude-code](https://claude.com/product/claude-code).

### Prerequisites

- macOS or Linux (Windows via WSL2)
- Node.js 20+ and pnpm 10+ (the installer adds both if missing)
- [Docker](https://docker.com/products/docker-desktop) — or Apple Container on macOS via `/convert-to-apple-container`
- [Claude Code](https://claude.ai/download)
- A Google Workspace account for the EA + a GCP project with [OAuth credentials](https://console.cloud.google.com/apis/credentials) (the setup script provisions the rest)

<details>
<summary><strong>Coming from v1?</strong></summary>

Keep your v1 checkout running and build v2 in a sibling worktree — don't `git pull` v2 onto a v1 install (the script detects and refuses that).

```bash
cd ~/Projects/nanoclaw-gws-ea
git fetch origin
git worktree add ../nanoclaw-gws-ea-v2 origin/main
cd ../nanoclaw-gws-ea-v2
bash setup-gws-ea.sh
```

It bootstraps v2, runs the init scripts (main, email, heartbeat), then offers to import your v1 custom agents and active scheduled tasks and swap the service over. Decline to leave v1 alone and run both side by side. Override the v1 location with `--v1-path PATH`.

</details>

## Configuration

Wiring (who can reach which agent, which channels, isolation) lives in the central DB and is managed with the `ncl` CLI or by asking Claude. Identity and behavior live in files:

| Location | Purpose |
|----------|---------|
| `.env` | Principal/assistant names + emails, GChat topic, sweep space, polling intervals (non-secret only — secrets live in the OneCLI vault) |
| `~/.gws/<assistant>/` | Workspace service-account key + `calendars.json` (mounted read-only into containers) |
| `groups/<group>/CLAUDE.md` + `CLAUDE.local.md` | Per-group EA personality, identity, and behavior overrides |
| `groups/global/` | Shared, read-only knowledge and procedures available to every agent group |
| `container/skills/` | EA playbooks loaded inside containers — `email-triage`, `scheduling`, `google-docs`, … |

Everything else is a conversation: *"change my morning briefing to 7am,"* *"give the external agent calendar access,"* *"add a procedure for expense reports."*

## How It Works

```
GChat / Gmail / scheduled sweep
        │
   host (router) ──▶ inbound.db ──▶ container (Bun · Claude Agent SDK + Workspace MCP)
                                              │
   host (delivery) ◀── outbound.db ◀──────────┘
        │
   GChat / Gmail reply
```

A single host process routes every inbound message through the entity model (**user → messaging group → agent group → session**), writes it to that session's `inbound.db`, and wakes the container. The agent-runner polls `inbound.db`, runs Claude with the Workspace tools its trust level allows, and writes to `outbound.db`. The host polls `outbound.db` and delivers back through the channel. Two SQLite files per session, exactly one writer each — no IPC, no lock contention.

**Email routes by sender identity** into separate, isolated agent groups:

| Synthetic group | Who | Tools |
|-----------------|-----|-------|
| `email:principal` | mail from the principal | full Workspace tool set |
| `email:external` | third-party mail (human-paced reply delay) | restricted — calendar free/busy + RSVP only, no messaging |
| heartbeat | hourly proactive sweep | logs to a dedicated Chat space |

Workspace credentials are never handed to the agent. Outbound API calls route through [OneCLI's Agent Vault](https://github.com/onecli/onecli), which injects the service-account token at request time and enforces per-agent policies.

### Key Files (GWS-EA additions)

| File | Purpose |
|------|---------|
| `src/channels/gchat.ts` | Google Chat channel (self-registering adapter) |
| `src/channels/email.ts` | Gmail event source + per-sender routing to synthetic groups |
| `src/gws-paths.ts` | Single source of truth for Workspace SA + calendar paths (host + container) |
| `src/modules/gchat-events/` | Workspace Events (Pub/Sub) subscription + inbound handling |
| `container/agent-runner/src/gws-capability.ts` | Trust-scoped Workspace tool gating (principal vs external) |
| `container/skills/` | Container skills: `email-triage`, `google-docs`, `scheduling`, `status`, `relationships`, … |

For the core v2 architecture, see [CLAUDE.md](CLAUDE.md) and [docs/architecture.md](docs/architecture.md). The entity/isolation model is in [docs/isolation-model.md](docs/isolation-model.md).

## Managing It

The `ncl` CLI queries and edits the central DB — agent groups, channel wirings, users, roles, scheduled tasks, sessions:

```bash
ncl groups list
ncl wirings list
ncl sessions list
ncl help
```

Or just ask in chat: *"list scheduled tasks," "pause the Friday review," "who can DM you?"*

## Staying Updated

- `/update-gws-ea` — pull the latest from the public `nanoclaw-gws-ea` fork into your install, with preview and selective cherry-pick.
- `/update-nanoclaw` — bring upstream NanoClaw core updates into this customized fork.

## FAQ

**Is this secure?** Agents run in containers, not behind permission checks. They see only what's mounted, and they never hold raw credentials — Workspace and Anthropic tokens are injected by the OneCLI vault at request time. The codebase is small enough to actually read.

**Can I run it on Linux/Windows?** Yes. Docker works on macOS, Linux, and Windows (WSL2). On macOS you can switch to the native Apple Container runtime with `/convert-to-apple-container`.

**How do I debug?** Ask Claude Code — *"why didn't that email get a reply?"*, *"what's in the recent logs?"* — or run `/debug`. Host logs are in `logs/`; per-session DBs in `data/v2-sessions/<group>/<session>/`.

**Can I use other models?** Per agent group: `/add-opencode` (OpenRouter, Google, DeepSeek…), `/add-ollama-provider` (local open-weight), or `/add-codex`. Default is Claude via the Anthropic Agent SDK.

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VDdww8qS42).

## License

MIT

<img referrerpolicy="no-referrer-when-downgrade" src="https://static.scarf.sh/a.png?x-pxid=47894bd5-353b-42fe-bb97-74144e6df0bf" />
