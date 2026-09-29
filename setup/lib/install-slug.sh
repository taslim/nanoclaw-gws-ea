# install-slug.sh — shell mirror of src/install-slug.ts.
#
# Source this file after $PROJECT_ROOT is set:
#
#   source "$PROJECT_ROOT/setup/lib/install-slug.sh"
#   label=$(launchd_label)        # com.nanoclaw-v2-<slug>
#   unit=$(systemd_unit)          # nanoclaw-v2-<slug>
#   image=$(container_image_base) # nanoclaw-agent-v2-<slug>
#
# Slug is NANOCLAW_INSTALL_ID when set, else sha1(PROJECT_ROOT)[:8] — must
# match the TS helper exactly so both halves of setup name things
# consistently. An override the TS helper refuses is refused here too: each
# helper then prints nothing and fails.

_nanoclaw_install_slug() {
  if [ -n "${NANOCLAW_INSTALL_ID:-}" ]; then
    # The TS helper's /^[a-z0-9][a-z0-9_-]{0,31}$/, spelled out so no locale
    # widens a range and no embedded newline passes as a second line.
    case "$NANOCLAW_INSTALL_ID" in
      [!abcdefghijklmnopqrstuvwxyz0123456789]* | *[!abcdefghijklmnopqrstuvwxyz0123456789_-]*)
        ;;
      *)
        if [ "${#NANOCLAW_INSTALL_ID}" -le 32 ]; then
          printf '%s' "$NANOCLAW_INSTALL_ID"
          return 0
        fi
        ;;
    esac
    printf "NANOCLAW_INSTALL_ID must be 1-32 chars of [a-z0-9_-] starting alphanumeric (got '%s')\n" \
      "$NANOCLAW_INSTALL_ID" >&2
    return 1
  fi
  local root="${NANOCLAW_PROJECT_ROOT:-${PROJECT_ROOT:-$PWD}}"
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$root" | shasum | cut -c 1-8
  elif command -v sha1sum >/dev/null 2>&1; then
    printf '%s' "$root" | sha1sum | cut -c 1-8
  else
    # Fallback: hash the path with something deterministic-ish. Not ideal —
    # but shasum is present on every modern macOS/Linux, so this is just
    # belt-and-braces against a truly minimal system.
    printf '%s' "$root" | od -An -tx1 | tr -d ' \n' | cut -c 1-8
  fi
}

launchd_label() {
  local slug
  slug="$(_nanoclaw_install_slug)" || return 1
  printf 'com.nanoclaw-v2-%s' "$slug"
}

systemd_unit() {
  local slug
  slug="$(_nanoclaw_install_slug)" || return 1
  printf 'nanoclaw-v2-%s' "$slug"
}

container_image_base() {
  local slug
  slug="$(_nanoclaw_install_slug)" || return 1
  printf 'nanoclaw-agent-v2-%s' "$slug"
}
