# NanoClaw GWS-EA

A [NanoClaw](https://github.com/qwibitai/nanoclaw) flavor that turns Claude into a Google Workspace executive assistant. Communicates via Google Chat, triages Gmail, manages calendars, creates Docs — all running in isolated containers.

Built on NanoClaw's single-process orchestrator with container isolation.

## What It Adds

On top of upstream NanoClaw:

- **Google Chat channel** — polls DMs, thread tracking, emoji status indicators
- **Gmail event source** — polls inbox, routes to isolated groups by sender (principal vs. external)
- **Google Workspace tools** — Calendar, Drive, Docs, Sheets, Tasks, Contacts (via MCP servers in containers)
- **EA procedures** — morning briefings, weekly reviews, email triage, scheduling, proactive sweeps
- **Identity via profile.md** — single file for all concrete identity, calendars, and integrations

## Quick Start

```bash
gh repo fork taslim/nanoclaw-gws-ea --clone
cd nanoclaw-gws-ea
claude
```

<details>
<summary>Without GitHub CLI</summary>

1. Fork [taslim/nanoclaw-gws-ea](https://github.com/taslim/nanoclaw-gws-ea) on GitHub (click the Fork button)
2. `git clone https://github.com/<your-username>/nanoclaw-gws-ea.git`
3. `cd nanoclaw-gws-ea`
4. `claude`

</details>

Then run `/setup-ea`. Claude Code handles everything: dependencies, container runtime, Google Workspace authentication, EA identity configuration, and service setup.

> **Note:** Commands prefixed with `/` (like `/setup-ea`) are [Claude Code skills](https://code.claude.com/docs/en/skills). Type them inside the `claude` CLI prompt, not in your regular terminal. If you don't have Claude Code installed, get it at [claude.com/product/claude-code](https://claude.com/product/claude-code).

### Prerequisites

Before running `/setup-ea`, you'll need:

- macOS, Linux, or Windows (via WSL2)
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- [Apple Container](https://github.com/apple/container) (macOS) or [Docker](https://docker.com/products/docker-desktop) (macOS/Linux)
- A Google Workspace account for the EA
- A GCP project with OAuth Desktop App credentials ([instructions](https://console.cloud.google.com/apis/credentials))

## Configuration

All identity and behavior is configured through files, not code:

| File | Purpose |
|------|---------|
| `.env` | API keys, emails, polling intervals |
| `groups/global/profile.md` | EA identity, calendar table, integrations |
| `groups/global/CLAUDE.md` | EA personality and behavior |
| `groups/global/procedures/*.md` | Scheduling, email triage, Google Docs |
| `groups/main/procedures/*.md` | Morning briefing, weekly review |

## Architecture

```
Channels --> SQLite --> Polling loop --> Container (Claude Agent SDK) --> Response
```

Gmail messages route to synthetic groups by sender identity:
- **email-principal** — emails from your principal, full Workspace tool access
- **email-external** — third-party emails, restricted tools (no messaging, calendar free/busy only)
- **heartbeat** — proactive sweeps, logs to a dedicated Chat space

For the full architecture details, see the [documentation site](https://docs.nanoclaw.dev/concepts/architecture).

### Key Files (GWS-EA additions)

| File | Purpose |
|------|---------|
| `src/channels/gchat.ts` | Google Chat channel (self-registering) |
| `src/email.ts` | Gmail event source and routing |
| `src/workspace-auth.ts` | One-time OAuth setup for 31 Workspace scopes |

See upstream [NanoClaw](https://github.com/qwibitai/nanoclaw) for core architecture docs.

## Staying Updated

Run `/update-ea` in Claude Code to pull the latest from nanoclaw-gws-ea into your fork. It previews what changed, highlights conflict-prone files, and handles merge resolution.

## FAQ

**Why Docker?**

Docker provides cross-platform support (macOS, Linux and even Windows via WSL2) and a mature ecosystem. On macOS, you can optionally switch to Apple Container via `/convert-to-apple-container` for a lighter-weight native runtime. For additional isolation, [Docker Sandboxes](docs/docker-sandboxes.md) run each container inside a micro VM.

**Can I run this on Linux or Windows?**

Yes. Docker is the default runtime and works on macOS, Linux, and Windows (via WSL2). Just run `/setup`.

**Is this secure?**

Agents run in containers, not behind application-level permission checks. They can only access explicitly mounted directories. You should still review what you're running, but the codebase is small enough that you actually can. See the [security documentation](https://docs.nanoclaw.dev/concepts/security) for the full security model.

**Why no configuration files?**

We don't want configuration sprawl. Every user should customize NanoClaw so that the code does exactly what they want, rather than configuring a generic system. If you prefer having config files, you can tell Claude to add them.

**Can I use third-party or open-source models?**

Yes. NanoClaw supports any Claude API-compatible model endpoint. Set these environment variables in your `.env` file:

```bash
ANTHROPIC_BASE_URL=https://your-api-endpoint.com
ANTHROPIC_AUTH_TOKEN=your-token-here
```

This allows you to use:
- Local models via [Ollama](https://ollama.ai) with an API proxy
- Open-source models hosted on [Together AI](https://together.ai), [Fireworks](https://fireworks.ai), etc.
- Custom model deployments with Anthropic-compatible APIs

Note: The model must support the Anthropic API format for best compatibility.

**How do I debug issues?**

Ask Claude Code. "Why isn't the scheduler running?" "What's in the recent logs?" "Why did this message not get a response?" That's the AI-native approach that underlies NanoClaw.

**Why isn't the setup working for me?**

If you have issues, during setup, Claude will try to dynamically fix them. If that doesn't work, run `claude`, then run `/debug`. If Claude finds an issue that is likely affecting other users, open a PR to modify the setup SKILL.md.

**What changes will be accepted into the codebase?**

Only security fixes, bug fixes, and clear improvements will be accepted to the base configuration. That's all.

Everything else (new capabilities, OS compatibility, hardware support, enhancements) should be contributed as skills.

This keeps the base system minimal and lets every user customize their installation without inheriting features they don't want.

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VDdww8qS42).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for breaking changes, or the [full release history](https://docs.nanoclaw.dev/changelog) on the documentation site.

## License

MIT
