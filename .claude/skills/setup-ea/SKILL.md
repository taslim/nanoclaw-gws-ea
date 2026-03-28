---
name: setup-ea
description: Run initial NanoClaw GWS-EA setup. Handles dependencies, container runtime, Claude auth, Google Workspace OAuth, EA identity, and service configuration. Triggers on "setup", "setup ea", "install", "configure", or first-time setup requests.
---

# NanoClaw GWS-EA Setup

Run setup steps automatically. Only pause when user action is required (OAuth consent, configuration choices, pasting secrets). Setup uses `bash setup.sh` for bootstrap, then `npx tsx setup/index.ts --step <name>` for all other steps. Steps emit structured status blocks to stdout. Verbose logs go to `logs/setup.log`.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. completing OAuth consent in a browser, pasting a secret token). If a dependency is missing, install it. If a service won't start, diagnose and repair. Ask the user for permission when needed, then do the work.

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

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

## 1. Bootstrap (Node.js + Dependencies + OneCLI)

Run `bash setup.sh` and parse the status block.

- If NODE_OK=false → Node.js is missing or too old. Use `AskUserQuestion: Would you like me to install Node.js 22?` If confirmed:
  - macOS: `brew install node@22` (if brew available) or install nvm then `nvm install 22`
  - Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`, or nvm
  - After installing Node, re-run `bash setup.sh`
- If DEPS_OK=false → Read `logs/setup.log`. Try: delete `node_modules`, re-run `bash setup.sh`. If native module build fails, install build tools (`xcode-select --install` on macOS, `build-essential` on Linux), then retry.
- If NATIVE_OK=false → better-sqlite3 failed to load. Install build tools and re-run.
- Record PLATFORM and IS_WSL for later steps.

After bootstrap succeeds, install OneCLI and its CLI tool:

```bash
curl -fsSL onecli.sh/install | sh
curl -fsSL onecli.sh/cli/install | sh
```

Verify both installed: `onecli version`. If the command is not found, the CLI was likely installed to `~/.local/bin/`. Add it to PATH for the current session and persist it:

```bash
export PATH="$HOME/.local/bin:$PATH"
# Persist for future sessions (append to shell profile if not already present)
grep -q '.local/bin' ~/.bashrc 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
grep -q '.local/bin' ~/.zshrc 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

Then re-verify with `onecli version`.

Point the CLI at the local OneCLI instance (it defaults to the cloud service otherwise):
```bash
onecli config set api-host http://127.0.0.1:10254
```

Ensure `.env` has the OneCLI URL (create the file if it doesn't exist):
```bash
grep -q 'ONECLI_URL' .env 2>/dev/null || echo 'ONECLI_URL=http://127.0.0.1:10254' >> .env
```

## 2. Check Environment

Run `npx tsx setup/index.ts --step environment` and parse the status block.

- If HAS_REGISTERED_GROUPS=true → note existing config, offer to skip or reconfigure
- Record APPLE_CONTAINER and DOCKER values for step 3

## 2a. Timezone

Run `npx tsx setup/index.ts --step timezone` and parse the status block.

- If NEEDS_USER_INPUT=true → The system timezone could not be autodetected (e.g. POSIX-style TZ like `IST-2`). AskUserQuestion: "What is your timezone?" with common options (America/New_York, Europe/London, Asia/Jerusalem, Asia/Tokyo) and an "Other" escape. Then re-run: `npx tsx setup/index.ts --step timezone -- --tz <their-answer>`.
- If STATUS=success → Timezone is configured. Note RESOLVED_TZ for reference.

## 3. Container Runtime

### 3a. Choose runtime

Check the preflight results for `APPLE_CONTAINER` and `DOCKER`, and the PLATFORM from step 1.

- PLATFORM=linux → Docker (only option)
- PLATFORM=macos + APPLE_CONTAINER=installed → Use `AskUserQuestion: Docker (cross-platform) or Apple Container (native macOS)?` If Apple Container, run `/convert-to-apple-container` now, then skip to 3c.
- PLATFORM=macos + APPLE_CONTAINER=not_found → Docker

### 3a-docker. Install Docker

- DOCKER=running → continue to 3c
- DOCKER=installed_not_running → start Docker: `open -a Docker` (macOS) or `sudo systemctl start docker` (Linux). Wait 15s, re-check with `docker info`.
- DOCKER=not_found → Use `AskUserQuestion: Docker is required for running agents. Would you like me to install it?` If confirmed:
  - macOS: install via `brew install --cask docker`, then `open -a Docker` and wait for it to start. If brew not available, direct to Docker Desktop download at https://docker.com/products/docker-desktop
  - Linux: install with `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`. Note: user may need to log out/in for group membership.

### 3b. Apple Container conversion gate (if needed)

**If the chosen runtime is Apple Container**, you MUST check whether the source code has already been converted from Docker to Apple Container. Do NOT skip this step. Run:

```bash
grep -q "CONTAINER_RUNTIME_BIN = 'container'" src/container-runtime.ts && echo "ALREADY_CONVERTED" || echo "NEEDS_CONVERSION"
```

**If NEEDS_CONVERSION**, the source code still uses Docker as the runtime. You MUST run the `/convert-to-apple-container` skill NOW, before proceeding to the build step.

**If ALREADY_CONVERTED**, the code already uses Apple Container. Continue to 3c.

**If the chosen runtime is Docker**, no conversion is needed. Continue to 3c.

### 3c. Build and test

Run `npx tsx setup/index.ts --step container -- --runtime <chosen>` and parse the status block.

**If BUILD_OK=false:** Read `logs/setup.log` tail for the build error.
- Cache issue (stale layers): `docker builder prune -f` (Docker) or `container builder stop && container builder rm && container builder start` (Apple Container). Retry.
- Dockerfile syntax or missing files: diagnose from the log and fix, then retry.

**If TEST_OK=false but BUILD_OK=true:** The image built but won't run. Check logs — common cause is runtime not fully started. Wait a moment and retry the test.

## 4. Anthropic Credentials via OneCLI

NanoClaw uses OneCLI to manage credentials — API keys are never stored in `.env` or exposed to containers. The OneCLI gateway injects them at request time.

Check if a secret already exists:
```bash
onecli secrets list
```

If an Anthropic secret is listed, confirm with user: keep or reconfigure? If keeping, skip to step 5.

AskUserQuestion: Do you want to use your **Claude subscription** (Pro/Max) or an **Anthropic API key**?

1. **Claude subscription (Pro/Max)** — description: "Uses your existing Claude Pro or Max subscription. You'll run `claude setup-token` in another terminal to get your token."
2. **Anthropic API key** — description: "Pay-per-use API key from console.anthropic.com."

### Subscription path

Tell the user to run `claude setup-token` in another terminal and copy the token it outputs. Do NOT collect the token in chat.

Once they have the token, they register it with OneCLI. AskUserQuestion with two options:

1. **Dashboard** — description: "Best if you have a browser on this machine. Open http://127.0.0.1:10254 and add the secret in the UI. Use type 'anthropic' and paste your token as the value."
2. **CLI** — description: "Best for remote/headless servers. Run: `onecli secrets create --name Anthropic --type anthropic --value YOUR_TOKEN --host-pattern api.anthropic.com`"

### API key path

Tell the user to get an API key from https://console.anthropic.com/settings/keys if they don't have one.

Then AskUserQuestion with two options:

1. **Dashboard** — description: "Best if you have a browser on this machine. Open http://127.0.0.1:10254 and add the secret in the UI."
2. **CLI** — description: "Best for remote/headless servers. Run: `onecli secrets create --name Anthropic --type anthropic --value YOUR_KEY --host-pattern api.anthropic.com`"

### After either path

Ask them to let you know when done.

**If the user's response happens to contain a token or key** (starts with `sk-ant-`): handle it gracefully — run the `onecli secrets create` command with that value on their behalf.

**After user confirms:** verify with `onecli secrets list` that an Anthropic secret exists. If not, ask again.

## 5. EA Identity & Google Workspace

This step configures the EA's identity and authenticates with Google Workspace. Google Chat (the primary channel) and Gmail (the email event source) are built into this fork — no channel installation needed.

### 5a. Configure .env

Read `.env` (or `.env.example` if `.env` doesn't exist). Check for the required GWS-EA values:

- `PRINCIPAL_NAME` — the principal's full name
- `PRINCIPAL_EMAILS` — comma-separated list of the principal's email addresses
- `ASSISTANT_EMAIL` — the EA's Google Workspace email
- `ASSISTANT_NAME` — the EA's display name (also used as the trigger word: @AssistantName)

If `.env` doesn't exist, copy from `.env.example`:
```bash
cp .env.example .env
```

For each missing value, use AskUserQuestion to collect it from the user. Write values to `.env`.

**For OAuth credentials:** The user needs a GCP project with an OAuth Desktop App. Guide them:
1. Go to [GCP Console > APIs & Services > Credentials](https://console.cloud.google.com/apis/credentials)
2. Create an OAuth 2.0 Client ID (Desktop Application)
3. Enable these APIs: Google Chat, Google Drive, Google Docs, Google Sheets, Google Tasks, People API, Gmail API
4. Download the client JSON and save to `~/.workspace-mcp/gcp-oauth.keys.json`

**Optional values** — ask if the user wants to configure:
- `HEARTBEAT_SPACE_ID` — Google Chat space for proactive sweep logs
- `TZ` — timezone (defaults to system timezone)
- `EMAIL_POLL_INTERVAL` — Gmail polling interval in ms (default: 60000)
- `GCHAT_POLL_INTERVAL` — GChat polling interval in ms (default: 30000)

### 5b. Workspace OAuth

Check if credentials already exist:
```bash
ls ~/.workspace-mcp/credentials.json 2>/dev/null && echo "HAS_CREDS" || echo "NO_CREDS"
```

**If NO_CREDS:**

First verify the client JSON exists:
```bash
ls ~/.workspace-mcp/gcp-oauth.keys.json 2>/dev/null && echo "KEYS_OK" || echo "KEYS_MISSING"
```

If KEYS_MISSING: remind the user to download and save the OAuth client JSON (step 5a above). Do not proceed until the file exists.

Run the OAuth flow:
```bash
npx tsx src/workspace-auth.ts
```
This opens a browser for Google consent (31 Workspace scopes). The user must complete the consent flow in their browser. Credentials are saved to `~/.workspace-mcp/`.

Wait for the script to complete. If it fails, show the error and guide the user to fix it (common: wrong redirect URI, APIs not enabled).

**If HAS_CREDS:** AskUserQuestion: "Google Workspace credentials already exist. Re-authorize or keep existing?" If re-authorize, run the auth script above.

### 5c. Configure profile.md

Read `groups/global/profile.md`. It contains placeholder values that need to be filled with the user's concrete identity.

Using the values collected in step 5a, update `groups/global/profile.md`:

- **Identity section**: Fill in assistant name, principal name, emails
- **Email section**: Set sign-off line (e.g., "Alex Chen | EA to Jordan Park")

**Calendars:** AskUserQuestion: "What Google Calendars should the EA manage? For each, I need: the calendar name, the calendar ID (from Google Calendar settings — usually an email address), and the access mode (primary = create events here, readwrite = full access, readonly, or freebusy)."

Help the user identify their calendars. Common setup:
- Work calendar (freebusy — schedule around it, don't modify)
- Projects/scheduling calendar (primary — create and manage events here)
- Personal calendar (readwrite — protect by default)

Update the calendar table in profile.md. At least one calendar must be set to `primary`.

**Heartbeat:** If `HEARTBEAT_SPACE_ID` was set in 5a, update the Heartbeat section in profile.md. If not, AskUserQuestion: "Do you want a heartbeat space for proactive sweep logs? If yes, create a Google Chat space and provide the space ID." This is optional — skip if the user declines.

If heartbeat is enabled, create the daily plan file so the morning briefing can populate it on first run:
```bash
mkdir -p groups/heartbeat && touch groups/heartbeat/daily-plan.md
```

## 6. Additional Channels (Optional)

Google Chat is the primary channel and is already configured. The user may want additional channels for convenience.

AskUserQuestion: "Google Chat is set up as your primary channel. Want to add any additional channels?"
- WhatsApp (authenticates via QR code or pairing code)
- Telegram (authenticates via bot token from @BotFather)
- Slack (authenticates via Slack app with Socket Mode)
- Discord (authenticates via Discord bot token)
- None — skip

**Delegate to each selected channel's own skill.** Each channel skill handles its own code installation, authentication, registration, and JID resolution. This avoids duplicating channel-specific logic and ensures JIDs are always correct.

For each selected channel, invoke its skill:

- **WhatsApp:** Invoke `/add-whatsapp`
- **Telegram:** Invoke `/add-telegram`
- **Slack:** Invoke `/add-slack`
- **Discord:** Invoke `/add-discord`

Each skill will:
1. Install the channel code (via `git merge` of the skill branch)
2. Collect credentials/tokens and write to `.env`
3. Authenticate (WhatsApp QR/pairing, or verify token-based connection)
4. Register the chat with the correct JID format
5. Build and verify

**After all channel skills complete**, install dependencies and rebuild — channel merges may introduce new packages:

```bash
npm install && npm run build
```

If the build fails, read the error output and fix it (usually a missing dependency). Then continue to step 7.

## 7. Mount Allowlist

AskUserQuestion: Agent access to external directories?

**No:** `npx tsx setup/index.ts --step mounts -- --empty`
**Yes:** Collect paths/permissions. `npx tsx setup/index.ts --step mounts -- --json '{"allowedRoots":[...],"blockedPatterns":[],"nonMainReadOnly":true}'`

## 8. Start Service

If service already running: unload first.
- macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist`
- Linux: `systemctl --user stop nanoclaw` (or `systemctl stop nanoclaw` if root)

Run `npx tsx setup/index.ts --step service` and parse the status block.

**If FALLBACK=wsl_no_systemd:** WSL without systemd detected. Tell user they can either enable systemd in WSL (`echo -e "[boot]\nsystemd=true" | sudo tee /etc/wsl.conf` then restart WSL) or use the generated `start-nanoclaw.sh` wrapper.

**If DOCKER_GROUP_STALE=true:** The user was added to the docker group after their session started — the systemd service can't reach the Docker socket. Ask user to run these two commands:

1. Immediate fix: `sudo setfacl -m u:$(whoami):rw /var/run/docker.sock`
2. Persistent fix (re-applies after every Docker restart):
```bash
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/socket-acl.conf << 'EOF'
[Service]
ExecStartPost=/usr/bin/setfacl -m u:USERNAME:rw /var/run/docker.sock
EOF
sudo systemctl daemon-reload
```
Replace `USERNAME` with the actual username (from `whoami`). Run the two `sudo` commands separately — the `tee` heredoc first, then `daemon-reload`. After user confirms setfacl ran, re-run the service step.

**If SERVICE_LOADED=false:**
- Read `logs/setup.log` for the error.
- macOS: check `launchctl list | grep nanoclaw`. If PID=`-` and status non-zero, read `logs/nanoclaw.error.log`.
- Linux: check `systemctl --user status nanoclaw`.
- Re-run the service step after fixing.

## 9. Verify

Run `npx tsx setup/index.ts --step verify` and parse the status block.

**If STATUS=failed, fix each:**
- SERVICE=stopped → `npm run build`, then restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `systemctl --user restart nanoclaw` (Linux) or `bash start-nanoclaw.sh` (WSL nohup)
- SERVICE=not_found → re-run step 8
- CREDENTIALS=missing → re-run step 4 (check `onecli secrets list` for Anthropic secret)
- WORKSPACE_AUTH=missing → re-run step 5b
- CHANNEL_AUTH shows `not_found` for any additional channel → re-invoke that channel's skill (e.g. `/add-telegram`)
- REGISTERED_GROUPS=0 → The main GChat DM auto-registers when the principal messages the EA. Tell the user to send a DM to the EA in Google Chat.
- MOUNT_ALLOWLIST=missing → `npx tsx setup/index.ts --step mounts -- --empty`

Tell user to test: send a DM to the EA in Google Chat. Show: `tail -f logs/nanoclaw.log`

## Troubleshooting

**Service not starting:** Check `logs/nanoclaw.error.log`. Common: wrong Node path (re-run step 8), OneCLI not running (check `curl http://127.0.0.1:10254/api/health`), missing Workspace credentials (step 5b).

**Container agent fails ("Claude Code process exited with code 1"):** Ensure the container runtime is running — `open -a Docker` (macOS Docker), `container system start` (Apple Container), or `sudo systemctl start docker` (Linux). Check container logs in `groups/main/logs/container-*.log`.

**No response to messages:** Check trigger pattern (`@AssistantName` in groups, no trigger needed in main DM). Check DB: `npx tsx setup/index.ts --step verify`. Check `logs/nanoclaw.log`.

**GChat not connecting:** Verify `~/.workspace-mcp/credentials.json` and `~/.workspace-mcp/gcp-oauth.keys.json` exist. GChat auto-connects when credentials are present. Re-run `npx tsx src/workspace-auth.ts` if tokens expired.

**Email not processing:** Verify `PRINCIPAL_EMAILS` and `ASSISTANT_EMAIL` are set in `.env`. Check `logs/nanoclaw.log` for email polling errors.

**OAuth fails ("redirect_uri_mismatch"):** The OAuth client must be a Desktop Application type, not Web Application. Re-create it in GCP Console.

**Channel not connecting:** Verify the channel's credentials are set in `.env`. Channels auto-enable when their credentials are present. For WhatsApp: check `store/auth/creds.json` exists. For token-based channels: check token values in `.env`. Restart the service after any `.env` change.

**Unload service:** macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist` | Linux: `systemctl --user stop nanoclaw`
