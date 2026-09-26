#!/bin/bash
#
# GWS-EA machine setup. Run it once per machine from this checkout, and again
# after pulling updates:
#
#   bash gws-ea.sh
#
# It installs Node.js, pnpm, and the dependencies through NanoClaw's own
# bootstrap (setup.sh, used unchanged), then links the gws-ea launcher into
# ~/.local/bin, as NanoClaw's setup links ncl. Creating an assistant is a
# separate step: gws-ea create. Offering to create the first assistant from
# here waits until the prod track has a release, so create can default to it.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

LAUNCHER="$PROJECT_ROOT/bin/gws-ea"
NEXT='gws-ea create --track dogfood'

case "${1:-}" in
  '') ;;
  --help | -h)
    printf '%s\n' 'Usage: bash gws-ea.sh' '' \
      'Sets this machine up for GWS-EA: Node.js, pnpm, the dependencies, and the gws-ea' \
      'command in ~/.local/bin. It takes no options. Afterwards:' "  $NEXT"
    exit 0
    ;;
  *)
    printf '%s\n' "gws-ea.sh takes no options; it only sets this machine up. Afterwards run: $NEXT" >&2
    exit 2
    ;;
esac

BIN_DIR="$HOME/.local/bin"
case ":${PATH:-}:" in
  *":$BIN_DIR:"*) BIN_DIR_ON_PATH=true ;;
  *) BIN_DIR_ON_PATH=false ;;
esac

LOG="$PROJECT_ROOT/logs/gws-ea-setup.log"
mkdir -p "$(dirname "$LOG")"
: >"$LOG"
printf '%s' 'Installing Node.js, pnpm, and dependencies… '
# NanoClaw's bootstrap reports to NanoClaw's own setup analytics; GWS-EA's setup is not part of that.
if NANOCLAW_BOOTSTRAP_LOG="$LOG" NANOCLAW_NO_DIAGNOSTICS=1 bash setup.sh >>"$LOG" 2>&1; then
  printf '%s\n' 'done'
else
  printf '%s\n' 'failed'
  printf '%s\n' "$(grep -m 1 '^STATUS:' "$LOG" || printf 'STATUS: unknown')" "See $LOG" >&2
  exit 1
fi

# The launcher follows the link back to this checkout. An existing link is
# re-pointed; a file this setup did not make is left alone.
LINK="$BIN_DIR/gws-ea"
mkdir -p "$BIN_DIR"
if [ -L "$LINK" ]; then
  PREVIOUS="$(readlink "$LINK")"
  if [ "$PREVIOUS" != "$LAUNCHER" ]; then
    # -n replaces the link itself, even one that points at a directory, on macOS and Linux alike.
    ln -sfn "$LAUNCHER" "$LINK"
    printf '%s\n' "Pointed $LINK at this checkout (it pointed at $PREVIOUS)."
  fi
elif [ -e "$LINK" ]; then
  printf '%s\n' "Left $LINK alone: it is not a link. Remove it and rerun to get the gws-ea command." >&2
  NEXT="$LAUNCHER create --track dogfood"
else
  ln -s "$LAUNCHER" "$LINK"
  printf '%s\n' "Linked $LINK."
fi

printf '\n%s\n' 'This machine is set up for GWS-EA.'
if [ "$BIN_DIR_ON_PATH" = false ]; then
  case "$(basename "${SHELL:-}")" in
    bash) STARTUP='~/.bashrc' ;;
    zsh) STARTUP='~/.zshrc' ;;
    *) STARTUP="your shell's startup file" ;;
  esac
  printf '%s\n' "Add ~/.local/bin to your PATH in $STARTUP, then open a new terminal:" \
    "  export PATH=\"\$HOME/.local/bin:\$PATH\""
fi
printf '%s\n' "Next: $NEXT"
