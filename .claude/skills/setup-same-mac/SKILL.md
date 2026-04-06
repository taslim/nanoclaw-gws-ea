---
name: setup-same-mac
description: Set up an additional NanoClaw GWS-EA instance on the same Mac. Handles fake HOME isolation, OneCLI agent creation, Workspace OAuth, code patches, and a uniquely-labeled LaunchAgent. Triggers on "setup same mac", "second instance", "add another ea", "multi-instance", or "fleet setup".
---

# NanoClaw Multi-Instance Setup (Same Mac)

Set up a second (or third, etc.) NanoClaw GWS-EA instance on the same machine. Each instance gets its own EA identity, isolated credentials, and LaunchAgent — sharing the same container image and OneCLI gateway.

Run setup steps automatically. Only pause when user action is required (OAuth consent, configuration choices, pasting secrets).

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. completing OAuth consent in a browser, pasting a secret token). If a dependency is missing, install it. If a service won't start, diagnose and repair. Ask the user for permission when needed, then do the work.

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

**Assumption:** This skill is run from inside the NEW instance's project directory (already cloned from `taslim/nanoclaw-gws-ea`). The primary instance is already running on this machine.

**Naming convention:** Throughout this skill, `PROJECT_NAME` refers to the basename of the current project directory (e.g. if `pwd` is `/Users/alice/Projects/nanaclaw`, then `PROJECT_NAME` is `nanaclaw`). Derive it once at the start:

```bash
PROJECT_NAME=$(basename "$(pwd)")
```

All instance-specific names (fake HOME, LaunchAgent label, OneCLI agent) are derived from `PROJECT_NAME`.

## 0. Git & Fork Setup

Check the git remote configuration to ensure the user has a fork and upstream is configured.

Run:
- `git remote -v`

**Case A — `origin` points to `taslim/nanoclaw-gws-ea` (user cloned directly):**

The user cloned instead of forking. AskUserQuestion: "You cloned nanoclaw-gws-ea directly. We recommend forking so you can push your customizations. Would you like to set up a fork?"
- Fork now (recommended) — walk them through it
- Continue without fork — they'll only have local changes

If fork: instruct the user to fork `taslim/nanoclaw-gws-ea` on GitHub (they need to do this in their browser), then ask them for their GitHub username. Run:
```bash
git remote rename origin upstream
git remote add origin https://github.com/<their-username>/nanoclaw-gws-ea.git
git push origin main
```
Verify with `git remote -v`.

If continue without fork: add upstream so they can still pull updates:
```bash
git remote rename origin upstream
```

**Case B — `origin` points to user's fork, no `upstream` remote:**

Add upstream:
```bash
git remote add upstream https://github.com/taslim/nanoclaw-gws-ea.git
```

**Case C — both `origin` (user's fork) and `upstream` (nanoclaw-gws-ea) exist:**

Already configured. Continue.

**Verify:** `git remote -v` should show `origin` → user's repo, `upstream` → `taslim/nanoclaw-gws-ea.git`.

## 1. Prerequisites

Verify the machine is ready for a multi-instance setup. Check all of these:

```bash
# Docker running
docker info > /dev/null 2>&1 && echo "DOCKER_OK" || echo "DOCKER_MISSING"

# OneCLI gateway healthy
curl -s http://127.0.0.1:10254/api/health > /dev/null 2>&1 && echo "ONECLI_OK" || echo "ONECLI_MISSING"

# OneCLI CLI available
command -v onecli > /dev/null 2>&1 && echo "CLI_OK" || echo "CLI_MISSING"

# Node.js available
node --version > /dev/null 2>&1 && echo "NODE_OK" || echo "NODE_MISSING"

# Container image exists (shared across instances)
docker image inspect nanoclaw-agent:latest > /dev/null 2>&1 && echo "IMAGE_OK" || echo "IMAGE_MISSING"
```

**If any are missing:** These should have been set up by the primary instance. Do NOT reinstall — diagnose why they're unavailable. Common: Docker not started (`open -a Docker`), OneCLI not running, `~/.local/bin` not in PATH.

**If IMAGE_MISSING:** The primary instance's container image hasn't been built, or uses a custom `CONTAINER_IMAGE` in its `.env`. Check with `docker images | grep nanoclaw`. If no image exists at all, run `./container/build.sh` — the image is shared across instances.

## 2. Bootstrap (Dependencies)

Run `bash setup.sh` and parse the status block.

- If DEPS_OK=false → `rm -rf node_modules && bash setup.sh`
- If NATIVE_OK=false → Install build tools (`xcode-select --install`), retry.

## 3. Fake HOME Setup

Each instance needs its own HOME directory to isolate credentials from other instances. The fake HOME lives in the user's real home directory, named after the project, to keep it outside the project tree (avoiding unnecessary container mounts).

```bash
FAKE_HOME="$HOME/.${PROJECT_NAME}-home"
mkdir -p "${FAKE_HOME}/.workspace-mcp"
mkdir -p "${FAKE_HOME}/.config/nanoclaw"
```

## 4. Environment (.env)

Collect the EA identity from the user. Use AskUserQuestion for each required value:

1. **Assistant name** — the EA's display name (also used as the trigger word)
2. **Assistant email** — the EA's Google Workspace email
3. **Principal name** — the principal's full name
4. **Principal emails** — comma-separated list of the principal's email addresses

Derive the OneCLI agent slug from the assistant name: lowercase, replace spaces with hyphens, strip non-alphanumeric (e.g., "Nana" → `nana`, "Alex Chen" → `alex-chen`).

Detect the next available Chrome debugging port:

```bash
for port in 9222 9223 9224 9225; do
  lsof -i :$port > /dev/null 2>&1 && echo "PORT $port IN_USE" || echo "PORT $port AVAILABLE"
done
```

Pick the first available port.

Write `.env`:

```bash
cat > .env << 'ENVEOF'
# NanoClaw GWS-EA Configuration
# Multi-instance setup — uses fake HOME for credential isolation.

# --- Instance Config ---
ONECLI_DEFAULT_AGENT=<agent-slug>
HOST_BROWSER_PORT=<next-available-port>

# --- OneCLI (credential gateway) ---
ONECLI_URL=http://127.0.0.1:10254

# --- Required: EA Identity ---
PRINCIPAL_NAME="<principal-name>"
PRINCIPAL_EMAILS="<principal-emails>"
ASSISTANT_EMAIL="<assistant-email>"
ASSISTANT_NAME="<assistant-name>"

# --- Optional: Polling intervals (ms) ---
EMAIL_POLL_INTERVAL=60000
GCHAT_POLL_INTERVAL=30000

# --- Optional: Heartbeat ---
# HEARTBEAT_SPACE_ID=

# --- Optional: Timezone ---
# TZ=America/Los_Angeles
ENVEOF
```

AskUserQuestion: "Do you want to configure a heartbeat space or custom timezone now, or skip for later?"

## 5. Code Patches

Apply patches so the instance can coexist with others on the same machine. For each patch, check if it's already applied before making changes.

### 5a. ONECLI_DEFAULT_AGENT support

This lets each instance use a named OneCLI agent instead of the default. Two files need changes: `config.ts` (to read the value from `.env`) and `container-runner.ts` (to use it).

**NanoClaw's `.env` loader does NOT populate `process.env`** — values must be explicitly read via `readEnvFile()` in `config.ts` and exported. Without the `config.ts` change, the `.env` value is silently ignored.

#### config.ts

First, check if `ONECLI_DEFAULT_AGENT` is already in the `readEnvFile` keys list:

```bash
grep -q 'ONECLI_DEFAULT_AGENT' src/config.ts && echo "ALREADY_PATCHED" || echo "NEEDS_PATCH"
```

If NEEDS_PATCH, make two edits:

**Edit 1 — Add to readEnvFile keys.** In `src/config.ts`, find the `readEnvFile([...])` call and add `'ONECLI_DEFAULT_AGENT'` to the keys array:

```typescript
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'EMAIL_EXTERNAL_DELAY',
  'EMAIL_POLL_INTERVAL',
  'GCHAT_POLL_INTERVAL',
  'ONECLI_DEFAULT_AGENT',
  'PRINCIPAL_NAME',
  ...
```

**Edit 2 — Export the value.** Add this export near the other GWS-EA config exports (after `HEARTBEAT_SPACE_ID`):

```typescript
export const ONECLI_DEFAULT_AGENT: string | undefined =
  process.env.ONECLI_DEFAULT_AGENT || envConfig.ONECLI_DEFAULT_AGENT || undefined;
```

#### container-runner.ts

Check if already patched:

```bash
grep -q 'ONECLI_DEFAULT_AGENT' src/container-runner.ts && echo "ALREADY_PATCHED" || echo "NEEDS_PATCH"
```

If NEEDS_PATCH:

**Edit 1 — Add import.** Find the imports from `./config.js` and add `ONECLI_DEFAULT_AGENT`:

```typescript
import {
  CONTAINER_IMAGE,
  ONECLI_DEFAULT_AGENT,
  ...
} from './config.js';
```

**Edit 2 — Use in agent identifier.** Find the `runContainerAgent` function and replace the agent identifier logic:

**Find:**
```typescript
  // Main group uses the default OneCLI agent; others use their own agent.
  const agentIdentifier = input.isMain
    ? undefined
    : group.folder.toLowerCase().replace(/_/g, '-');
```

**Replace with:**
```typescript
  // When ONECLI_DEFAULT_AGENT is set, ALL groups use that agent (e.g. "nana").
  // Otherwise, main uses no agent (OneCLI default) and others use their folder name.
  const agentIdentifier = ONECLI_DEFAULT_AGENT
    ? ONECLI_DEFAULT_AGENT
    : input.isMain
      ? undefined
      : group.folder.toLowerCase().replace(/_/g, '-');
```

### 5b. Chrome mock keychain

Under a fake HOME, Chrome can't access the real macOS keychain. The `--use-mock-keychain` flag prevents keychain prompts.

Check if already patched:

```bash
grep -q 'use-mock-keychain' src/host-browser.ts && echo "ALREADY_PATCHED" || echo "NEEDS_PATCH"
```

If NEEDS_PATCH, in `src/host-browser.ts`, find the Chrome launch arguments array and add `'--use-mock-keychain'`:

**Find:**
```typescript
    '--disable-renderer-backgrounding',
  ];
```

**Replace with:**
```typescript
    '--disable-renderer-backgrounding',
    '--use-mock-keychain',
  ];
```

## 6. OneCLI Agent

Create a named OneCLI agent for this instance. The agent slug was derived in step 4.

```bash
onecli agent create <agent-slug>
```

Assign the Anthropic secret to this agent. First check what secrets exist:

```bash
onecli secrets list
```

If an Anthropic secret exists, assign it to the new agent:

```bash
onecli agent assign-secret <agent-slug> <secret-id>
```

If no Anthropic secret exists, follow the same credential flow as `/setup-ea` step 4 — ask whether subscription (Pro/Max) or API key, collect it, create the secret, then assign to this agent.

**Verify:** `onecli agent list` should show the new agent with the Anthropic secret assigned.

## 7. Workspace OAuth

The new EA needs its own Google Workspace credentials. These are stored under the fake HOME so they don't conflict with the primary instance.

### 7a. GCP OAuth Client

The new EA needs its own OAuth client credentials if it uses a different Google Workspace domain. If it's in the same domain as the primary EA, they can share the same GCP OAuth client.

AskUserQuestion: "Does this EA use the same Google Workspace domain as your primary EA? If yes, we can copy the OAuth client credentials. If no, you'll need to create a new OAuth Desktop App in GCP Console."

**Same domain:** Copy the OAuth client JSON from the primary instance:

```bash
ls ~/.workspace-mcp/gcp-oauth.keys.json 2>/dev/null && echo "FOUND" || echo "NOT_FOUND"
```

If FOUND:
```bash
cp ~/.workspace-mcp/gcp-oauth.keys.json "${FAKE_HOME}/.workspace-mcp/gcp-oauth.keys.json"
```

**Different domain:** Guide the user through GCP OAuth setup:
1. Go to [GCP Console > APIs & Services > Credentials](https://console.cloud.google.com/apis/credentials)
2. Create an OAuth 2.0 Client ID (Desktop Application)
3. Enable these APIs: Google Chat, Google Drive, Google Docs, Google Sheets, Google Tasks, People API, Gmail API
4. Download the client JSON and save to `${FAKE_HOME}/.workspace-mcp/gcp-oauth.keys.json`

### 7b. Run OAuth Flow

```bash
HOME="${FAKE_HOME}" npx tsx src/workspace-auth.ts
```

This opens a browser for Google consent. The user must sign in as the **new EA's Google account** (not the primary EA). Credentials are saved to `${FAKE_HOME}/.workspace-mcp/`.

Wait for the script to complete. If it fails:
- "redirect_uri_mismatch" → OAuth client must be Desktop Application type
- Token errors → APIs may not be enabled in the GCP project

**Verify:**
```bash
ls "${FAKE_HOME}/.workspace-mcp/credentials.json" && echo "OAUTH_OK" || echo "OAUTH_MISSING"
```

## 8. Profile & Groups

### 8a. Configure profile.md

Read `groups/global/profile.md`. Update with the new EA's identity using the values from step 4:

- **Identity section**: Fill in assistant name, principal name, emails
- **Email section**: Set sign-off line (e.g., "Nana | EA to Sandra")

**Calendars:** AskUserQuestion: "What Google Calendars should this EA manage? For each, I need: the calendar name, the calendar ID (from Google Calendar settings), and the access mode (primary, readwrite, readonly, or freebusy)."

Update the calendar table in profile.md. At least one calendar must be set to `primary`.

### 8b. Configure group CLAUDE.md files

Update `groups/main/CLAUDE.md` to reflect the new EA's identity and communication style. The primary instance's main CLAUDE.md can serve as a template — adjust names, pronouns, and personality to match.

## 9. Channels (Optional)

Google Chat is the primary channel and is built in. The user may want additional channels.

AskUserQuestion: "Google Chat is set up as your primary channel. Want to add any additional channels?"
- WhatsApp
- Telegram
- Slack
- Discord
- None — skip

For each selected channel, invoke its skill: `/add-whatsapp`, `/add-telegram`, `/add-slack`, `/add-discord`.

**After all channel skills complete:**
```bash
npm install && npm run build
```

## 10. Mount Allowlist

Create an allowlist for this instance in the fake HOME:

AskUserQuestion: "Should the agent have access to any external directories?"

**No:**
```bash
echo '{"allowedRoots":[],"blockedPatterns":[],"nonMainReadOnly":true}' > "${FAKE_HOME}/.config/nanoclaw/mount-allowlist.json"
```

**Yes:** Collect paths/permissions and write the allowlist JSON to `${FAKE_HOME}/.config/nanoclaw/mount-allowlist.json`.

Also create an empty sender allowlist:
```bash
echo '[]' > "${FAKE_HOME}/.config/nanoclaw/sender-allowlist.json"
```

## 11. Build

```bash
npm install && npm run build
```

If the build fails, read the error output and fix it (usually a missing dependency or TypeScript error from the patches). Then retry.

## 12. CLAUDE.md Update

Append a multi-instance section to the project's root `CLAUDE.md`. This tells future Claude sessions how to handle credentials and service commands for this instance.

Add the following section to `CLAUDE.md` (before any existing trailing sections like "Container Build Cache"), replacing `PROJECT_NAME` with the actual value:

```markdown
## Multi-Instance Setup

This instance runs under a fake HOME directory (`~/.PROJECT_NAME-home/`) to isolate credentials from other NanoClaw instances on this machine.

### What this means
- Google Workspace OAuth tokens live in `~/.PROJECT_NAME-home/.workspace-mcp/`
- Mount and sender allowlists live in `~/.PROJECT_NAME-home/.config/nanoclaw/`
- The LaunchAgent sets `HOME` to the fake path — the running service resolves all `~` paths correctly
- Container mounts (`os.homedir()`) also resolve to the fake HOME automatically
- `ONECLI_DEFAULT_AGENT` in `.env` routes API calls to this instance's OneCLI agent

### Credential commands
All commands that touch `~/.workspace-mcp/` or other HOME-relative paths must use the fake HOME:

\`\`\`sh
# Re-authenticate Workspace
HOME=~/.PROJECT_NAME-home npx tsx src/workspace-auth.ts

# Edit allowlists
$EDITOR ~/.PROJECT_NAME-home/.config/nanoclaw/mount-allowlist.json
$EDITOR ~/.PROJECT_NAME-home/.config/nanoclaw/sender-allowlist.json
\`\`\`

### Service commands
\`\`\`sh
launchctl load ~/Library/LaunchAgents/com.PROJECT_NAME.plist
launchctl unload ~/Library/LaunchAgents/com.PROJECT_NAME.plist
launchctl kickstart -k gui/$(id -u)/com.PROJECT_NAME
\`\`\`

### Caution
Do NOT run `npx tsx setup/index.ts --step service` — it generates a `com.nanoclaw` plist that would conflict with the primary instance. Always use the commands above for this instance's service.
```

## 13. LaunchAgent

Generate a uniquely-labeled LaunchAgent plist. Do NOT use `npx tsx setup/index.ts --step service` — it would overwrite the primary instance's plist.

Determine the values:
```bash
NODE_PATH=$(which node)
PROJECT_ROOT=$(pwd)
FAKE_HOME="$HOME/.${PROJECT_NAME}-home"
```

Write the plist:

```bash
cat > ~/Library/LaunchAgents/com.${PROJECT_NAME}.plist << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.${PROJECT_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${PROJECT_ROOT}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_ROOT}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${HOME}/.local/bin</string>
        <key>HOME</key>
        <string>${FAKE_HOME}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${PROJECT_ROOT}/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${PROJECT_ROOT}/logs/nanoclaw.error.log</string>
</dict>
</plist>
PLISTEOF
```

Load the service:
```bash
launchctl load ~/Library/LaunchAgents/com.${PROJECT_NAME}.plist
```

Verify:
```bash
launchctl list | grep "${PROJECT_NAME}" && echo "SERVICE_OK" || echo "SERVICE_MISSING"
```

## 14. Verify

Run through these checks:

```bash
# Service running
launchctl list | grep "${PROJECT_NAME}"

# OneCLI agent exists with secret assigned
onecli agent list

# Workspace credentials present
ls "${FAKE_HOME}/.workspace-mcp/credentials.json"

# Logs flowing
tail -5 logs/nanoclaw.log

# No port conflicts with other instances
lsof -i :$(grep HOST_BROWSER_PORT .env | cut -d= -f2) | head -3
```

**If service not starting:** Check `logs/nanoclaw.error.log`. Common issues:
- Wrong Node path → verify `which node` matches the plist
- OneCLI not reachable → check `curl http://127.0.0.1:10254/api/health`
- Port conflict → check `HOST_BROWSER_PORT` isn't used by another instance

Tell user to test: send a DM to the new EA in Google Chat. Show: `tail -f logs/nanoclaw.log`

## Troubleshooting

**OAuth fails under fake HOME:** Ensure you're using `HOME=~/.${PROJECT_NAME}-home` prefix. The `gcp-oauth.keys.json` must be in the fake HOME's `.workspace-mcp/`, not `~/.workspace-mcp/`.

**Container agent uses wrong API key:** Check that `ONECLI_DEFAULT_AGENT` in `.env` matches the agent name in `onecli agent list`, and that the Anthropic secret is assigned to that agent. When `ONECLI_DEFAULT_AGENT` is set, ALL groups (main, heartbeat, email, etc.) use that single agent — no per-folder agents are created. Also verify that `src/config.ts` exports `ONECLI_DEFAULT_AGENT` — without the config.ts patch, the `.env` value is silently ignored.

**Chrome won't start (keychain errors):** Verify `--use-mock-keychain` is in `src/host-browser.ts`. If it was already patched by the primary instance, this is fine.

**Both instances responding to same message:** Each instance connects to its own EA's Google Chat account. If both EAs are in the same Google Chat space, both will see the message. Use `ASSISTANT_NAME` trigger to address each one specifically.

**Service conflicts:** Each instance must have a unique LaunchAgent label (`com.${PROJECT_NAME}`), unique `HOST_BROWSER_PORT`, and unique `ONECLI_DEFAULT_AGENT`. Check all three in `.env`.

**Unload this instance:** `launchctl unload ~/Library/LaunchAgents/com.${PROJECT_NAME}.plist`
