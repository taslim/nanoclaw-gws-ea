#!/usr/bin/env bash
# Nanoclaw-GWS-EA setup entry point. Assumes Node + pnpm are installed
# (run `bash nanoclaw.sh` once on a fresh machine to bootstrap them).
# Idempotent. See `--help` for flags.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

# ─── output helpers ─────────────────────────────────────────────────────

use_ansi() { [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; }
red()  { use_ansi && printf '\033[31m%s\033[0m' "$1" || printf '%s' "$1"; }
dim()  { use_ansi && printf '\033[2m%s\033[0m'  "$1" || printf '%s' "$1"; }
bold() { use_ansi && printf '\033[1m%s\033[0m'  "$1" || printf '%s' "$1"; }

fail() {
  printf '%s %s\n' "$(red '✗')" "$1" >&2
  [ -n "${2:-}" ] && printf '  %s\n' "$(dim "$2")" >&2
  exit 1
}

# ─── prereq checks ──────────────────────────────────────────────────────

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail \
    "Required command not found: $(bold "$1")" \
    "$2"
}

require_cmd node "Install Node 20+ (e.g. \`brew install node\` or run \`bash nanoclaw.sh\` once)."
require_cmd pnpm "Install pnpm (e.g. \`brew install pnpm\` or run \`bash nanoclaw.sh\` once)."
require_cmd gcloud "Install gcloud SDK (\`brew install --cask google-cloud-sdk\`). Required by setup/provision-gcp.sh."
require_cmd jq "Install jq (\`brew install jq\`). Required by setup/provision-gcp.sh."
require_cmd docker "Install Docker (\`brew install --cask docker\`). Required by the agent container."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail \
  "Node $(node -v) is too old; require >= 20." \
  "Upgrade Node (e.g. \`brew upgrade node\` or use nvm)."

# ─── ensure deps installed ──────────────────────────────────────────────

if [ ! -d node_modules ] || [ pnpm-lock.yaml -nt node_modules ]; then
  printf '%s Installing pnpm dependencies…\n' "$(dim '·')"
  pnpm install --frozen-lockfile
fi

# ─── handoff ────────────────────────────────────────────────────────────

# Call tsx directly (not `pnpm run`) so $@ reaches the script without pnpm's
# `--` separator getting forwarded. exec so signals propagate cleanly.
exec pnpm exec tsx setup/gws-ea.ts "$@"
