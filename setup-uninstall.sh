#!/usr/bin/env bash
# Uninstall a Nanoclaw-GWS-EA install on this machine. Confirmation-gated.
# See `--help` for flags. Local-only by default; use --gcp to also tear
# down the GCP project (separate confirmation).

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

command -v node >/dev/null 2>&1 || { echo "node required"; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "pnpm required"; exit 1; }

if [ ! -d node_modules ] || [ pnpm-lock.yaml -nt node_modules ]; then
  pnpm install --frozen-lockfile
fi

exec pnpm exec tsx setup/uninstall.ts "$@"
