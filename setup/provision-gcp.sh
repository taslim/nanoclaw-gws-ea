#!/bin/bash
#
# Nanoclaw GWS-EA — GCP Provisioning
#
# Provisions one GCP project per install for a single Workspace EA bot.
# Idempotent: re-run safely to repair drift or rotate keys.
#
# USAGE:
#   ./scripts/gcp-setup.sh           # default: create-or-repair
#   ./scripts/gcp-setup.sh --check   # read-only drift report
#   ./scripts/gcp-setup.sh --delete  # tear down this install's project
#   ./scripts/gcp-setup.sh --help
#
# Reads ASSISTANT_NAME and ASSISTANT_EMAIL from .env.
# Writes GCHAT_PUBSUB_TOPIC back to .env after creation.

set -euo pipefail

trap 'rc=$?; printf "\n  ✗ unexpected error on line %d (exit %d)%s\n" "${BASH_LINENO[0]}" "$rc" "${LOG_FILE:+. See log: $LOG_FILE}" >&2' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# ── Output helpers ────────────────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'

LOG_FILE=""

log_only() {
  [ -n "$LOG_FILE" ] && printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG_FILE"
}

step()  { printf '\n%b── %s ──%b\n\n' "$BOLD" "$*" "$RESET"; log_only "STEP: $*"; }
info()  { printf '  %b✓%b %s\n' "$GREEN"  "$RESET" "$*"; log_only "INFO: $*"; }
skip()  { printf '  %b·%b %s\n' "$BLUE"   "$RESET" "$*"; log_only "SKIP: $*"; }
warn()  { printf '  %b!%b %s\n' "$YELLOW" "$RESET" "$*"; log_only "WARN: $*"; }
drift() { printf '  %b⚠%b %s\n' "$YELLOW" "$RESET" "$*"; log_only "DRIFT: $*"; DRIFT_COUNT=$((DRIFT_COUNT + 1)); }
fail()  { printf '  %b✗%b %s\n' "$RED"    "$RESET" "$*" >&2; log_only "FAIL: $*"; exit 1; }

prompt() { local a; read -rp "  $1 " a; echo "$a"; }
confirm_typed_yes() { local a; read -rp "  $1 (type 'y' to confirm): " a; [ "$a" = "y" ]; }

# ── GCP constants ─────────────────────────────────────────────────────────

REQUIRED_APIS=(
  chat.googleapis.com
  gmail.googleapis.com
  calendar-json.googleapis.com
  drive.googleapis.com
  docs.googleapis.com
  sheets.googleapis.com
  tasks.googleapis.com
  people.googleapis.com
  pubsub.googleapis.com
  workspaceevents.googleapis.com
  admin.googleapis.com
  iam.googleapis.com
)
BLOCKING_POLICIES=(
  iam.disableServiceAccountCreation
  iam.disableServiceAccountKeyCreation
  iam.managed.disableServiceAccountKeyCreation
)
CHAT_PUBLISHER="chat-api-push@system.gserviceaccount.com"

slugify() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g'; }

# dd reads a fixed amount so tr/cut don't hit SIGPIPE under pipefail.
# LC_ALL=C is on tr (not dd) so BSD tr doesn't choke on non-ASCII bytes.
random_suffix() {
  dd if=/dev/urandom bs=1 count=64 2>/dev/null | LC_ALL=C tr -dc 'a-z0-9' | cut -c1-6
}

# ── Args ──────────────────────────────────────────────────────────────────

MODE="default"
DRIFT_COUNT=0
for arg in "$@"; do
  case "$arg" in
    --check)  MODE="check" ;;
    --delete) MODE="delete" ;;
    --help|-h) sed -n '3,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'Unknown arg: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

# ── Preflight ─────────────────────────────────────────────────────────────

mkdir -p logs
LOG_FILE="logs/gcp-setup-$(date +%Y%m%d-%H%M%S).log"
: >"$LOG_FILE"

install_hint() {
  local tool="$1" mac="$2" linux="$3"
  case "$(uname)" in
    Darwin) printf '%s not found. Install: %s\n' "$tool" "$mac" ;;
    Linux)  printf '%s not found. Install: %s\n' "$tool" "$linux" ;;
    *)      printf '%s not found. See: https://cloud.google.com/sdk/docs/install\n' "$tool" ;;
  esac
}

command -v gcloud >/dev/null 2>&1 \
  || fail "$(install_hint gcloud 'brew install --cask google-cloud-sdk' 'curl https://sdk.cloud.google.com | bash')"
command -v jq >/dev/null 2>&1 \
  || fail "$(install_hint jq 'brew install jq' 'apt install jq  (or yum install jq)')"

ADMIN_USER=$(gcloud config get-value account 2>/dev/null || echo "")
[ -n "$ADMIN_USER" ] || fail "gcloud is not authenticated. Run: gcloud auth login"
gcloud auth print-access-token >/dev/null 2>&1 \
  || fail "gcloud token expired or invalid for $ADMIN_USER. Re-auth: gcloud auth login"

[ -f .env ] || fail ".env not found in $REPO_ROOT"
read_env() {
  grep -m1 "^$1=" .env | sed "s/^$1=//; s/^\"\(.*\)\"\$/\1/; s/^'\(.*\)'\$/\1/" || echo ""
}
ASSISTANT_NAME=$(read_env ASSISTANT_NAME)
ASSISTANT_EMAIL=$(read_env ASSISTANT_EMAIL)
[ -n "$ASSISTANT_NAME" ] || fail "ASSISTANT_NAME missing in .env"
[ -n "$ASSISTANT_EMAIL" ] || fail "ASSISTANT_EMAIL missing in .env"

[ -f config/gws-scopes.json ] || fail "config/gws-scopes.json missing"
jq empty config/gws-scopes.json 2>/dev/null || fail "config/gws-scopes.json is not valid JSON"

BOT=$(slugify "$ASSISTANT_NAME")
[ -n "$BOT" ] || fail "ASSISTANT_NAME slugifies to empty string"

SA_NAME="${BOT}-bot"
TOPIC="${BOT}-gchat-events"
SUB="${TOPIC}-sub"
GWS_DIR="$HOME/.gws"
BOT_DIR="$GWS_DIR/$BOT"
KEY_PATH="$BOT_DIR/service-account.json"

info "Admin user:    $ADMIN_USER"
info "Bot:           $BOT  (from ASSISTANT_NAME=$ASSISTANT_NAME)"
info "Impersonates:  $ASSISTANT_EMAIL"
info "Mode:          $MODE"

# ── Project resolution ────────────────────────────────────────────────────

resolve_project() {
  local matches count
  matches=$(gcloud projects list \
    --filter="projectId ~ ^nanoclaw-${BOT}- AND lifecycleState:ACTIVE" \
    --format="value(projectId,createTime)") \
    || fail "gcloud projects list failed — see error above"

  if [ -z "$matches" ]; then
    if [ "$MODE" = "check" ]; then
      drift "would create new project nanoclaw-${BOT}-<rand6>"
      PROJECT=""
      return
    fi
    [ "$MODE" = "delete" ] && fail "No project nanoclaw-${BOT}-* found. Nothing to delete."
    PROJECT="nanoclaw-${BOT}-$(random_suffix)"
    info "Creating project: $PROJECT"
    gcloud projects create "$PROJECT" --format="value(projectId)" >/dev/null \
      || fail "gcloud projects create failed (ID may be taken; re-run to roll a new suffix)"
    return
  fi

  count=$(printf '%s\n' "$matches" | wc -l | tr -d ' ')
  if [ "$count" = "1" ]; then
    PROJECT=$(printf '%s' "$matches" | awk '{print $1}')
    info "Reusing existing project: $PROJECT  (created $(printf '%s' "$matches" | awk '{print $2}'))"
    return
  fi

  printf '\n  Multiple matching projects found:\n\n'
  local i=1
  while IFS=$'\t' read -r pid created; do
    printf '    %d) %s  (created %s)\n' "$i" "$pid" "$created"
    i=$((i + 1))
  done <<<"$matches"
  printf '    a) abort\n\n'
  local choice
  choice=$(prompt "Pick a project [1-$((i - 1)) or a]:")
  [ "$choice" = "a" ] && fail "Aborted by operator."
  PROJECT=$(printf '%s' "$matches" | sed -n "${choice}p" | awk '{print $1}')
  [ -n "$PROJECT" ] || fail "Invalid choice."
  info "Selected: $PROJECT"
}

# ── Phases ────────────────────────────────────────────────────────────────

ensure_billing() {
  local enabled
  enabled=$(gcloud billing projects describe "$PROJECT" --format="value(billingEnabled)" 2>/dev/null || echo "False")
  if [ "$enabled" = "True" ]; then
    skip "Billing already enabled"
    return
  fi
  if [ "$MODE" = "check" ]; then drift "billing not linked to $PROJECT"; return; fi

  local accounts count chosen
  accounts=$(gcloud billing accounts list --filter="open=true" --format="value(name,displayName)") \
    || fail "gcloud billing accounts list failed — see error above"
  [ -n "$accounts" ] || fail "No open billing accounts visible. Create one: https://console.cloud.google.com/billing"

  count=$(printf '%s\n' "$accounts" | wc -l | tr -d ' ')
  if [ "$count" = "1" ]; then
    chosen=$(printf '%s' "$accounts" | awk '{print $1}')
    info "Auto-detected billing account: $chosen"
  else
    printf '\n  Multiple billing accounts:\n\n'
    local i=1
    while IFS=$'\t' read -r name display; do
      printf '    %d) %s  (%s)\n' "$i" "$name" "$display"; i=$((i + 1))
    done <<<"$accounts"
    local choice; choice=$(prompt "Pick [1-$((i - 1))]:")
    chosen=$(printf '%s' "$accounts" | sed -n "${choice}p" | awk '{print $1}')
    [ -n "$chosen" ] || fail "Invalid choice."
  fi

  gcloud billing projects link "$PROJECT" --billing-account="$chosen" >/dev/null 2>&1 \
    || fail "Could not link billing account $chosen"
  info "Linked billing: $chosen"
}

ensure_apis() {
  local enabled missing=()
  enabled=$(gcloud services list --enabled --project="$PROJECT" --format="value(config.name)") \
    || fail "gcloud services list failed — see error above"
  for api in "${REQUIRED_APIS[@]}"; do
    printf '%s\n' "$enabled" | grep -qx "$api" || missing+=("$api")
  done

  if [ "${#missing[@]}" -eq 0 ]; then
    skip "All ${#REQUIRED_APIS[@]} APIs enabled"
    return
  fi
  if [ "$MODE" = "check" ]; then drift "would enable ${#missing[@]} API(s): ${missing[*]}"; return; fi

  info "Enabling ${#missing[@]} API(s): ${missing[*]}"
  gcloud services enable "${missing[@]}" --project="$PROJECT" >/dev/null \
    || fail "Failed to enable APIs"
  info "APIs enabled"
}

ensure_org_policies() {
  local enforced=()
  for policy in "${BLOCKING_POLICIES[@]}"; do
    local result
    result=$(gcloud resource-manager org-policies describe "$policy" \
      --project="$PROJECT" --effective \
      --format="value(booleanPolicy.enforced)" 2>/dev/null || echo "")
    [ "$result" = "True" ] && enforced+=("$policy")
  done

  if [ "${#enforced[@]}" -eq 0 ]; then skip "No blocking org policies"; return; fi
  if [ "$MODE" = "check" ]; then drift "would override ${#enforced[@]} org policy: ${enforced[*]}"; return; fi

  for policy in "${enforced[@]}"; do
    info "Overriding org policy: $policy"
    if ! gcloud resource-manager org-policies disable-enforce \
        "$policy" --project="$PROJECT" >/dev/null 2>&1; then
      warn "Override failed for $policy. Override manually:"
      printf '    https://console.cloud.google.com/iam-admin/orgpolicies/%s?project=%s\n' "$policy" "$PROJECT"
      printf '    → Manage Policy → Override parent → Not enforced → Save\n'
      prompt "Press Enter once done..." >/dev/null
    fi
  done
  sleep 5
}

ensure_sa() {
  SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
  if gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT" >/dev/null 2>&1; then
    skip "Service account exists: $SA_EMAIL"
    return
  fi
  if [ "$MODE" = "check" ]; then drift "would create SA $SA_EMAIL"; return; fi

  info "Creating SA: $SA_EMAIL"
  gcloud iam service-accounts create "$SA_NAME" \
    --display-name="NanoClaw EA ($BOT)" --project="$PROJECT" >/dev/null \
    || fail "SA creation failed"
}

ensure_sa_key() {
  if [ "$MODE" = "check" ] && ! gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT" >/dev/null 2>&1; then
    drift "would create key (SA does not exist yet)"
    return
  fi

  if [ -f "$KEY_PATH" ] && [ "$(jq -r '.client_email // empty' "$KEY_PATH" 2>/dev/null)" = "$SA_EMAIL" ]; then
    skip "Key already exists: $KEY_PATH"
    return
  fi

  if [ "$MODE" = "check" ]; then
    if [ -f "$KEY_PATH" ]; then drift "key at $KEY_PATH does not match $SA_EMAIL — would replace"
    else drift "would create key at $KEY_PATH"; fi
    return
  fi

  mkdir -p "$BOT_DIR"
  info "Creating SA key: $KEY_PATH"
  gcloud iam service-accounts keys create "$KEY_PATH" \
    --iam-account="$SA_EMAIL" --project="$PROJECT" >/dev/null 2>&1 \
    || fail "Key creation failed — likely an org policy still blocks key creation. See README troubleshooting."
  chmod 600 "$KEY_PATH"
}

create_topic_with_policy_override() {
  local err
  err=$(mktemp)
  trap 'rm -f "$err"' RETURN

  if gcloud pubsub topics create "$TOPIC" --project="$PROJECT" 2>"$err" >/dev/null; then
    info "Topic created: $TOPIC"
    return 0
  fi

  cat "$err" >&2

  if ! grep -q 'gcp\.resourceLocations\|does not allow message storage' "$err"; then
    fail "Topic creation failed — see error above"
  fi

  printf '\n  Org policy gcp.resourceLocations blocks Pub/Sub message storage.\n'
  printf '  We can override at the project level to allow Google-managed US locations.\n'
  printf '  Reference: https://console.cloud.google.com/iam-admin/orgpolicies/gcp-resourceLocations?project=%s\n\n' "$PROJECT"
  if ! confirm_typed_yes "Override gcp.resourceLocations for $PROJECT to allow in:us-locations?"; then
    fail "Aborted. Override manually then re-run."
  fi

  info "Overriding gcp.resourceLocations at project level"
  gcloud resource-manager org-policies allow constraints/gcp.resourceLocations \
    in:us-locations --project="$PROJECT" >/dev/null \
    || fail "Policy override failed — see error above"

  local wait
  for wait in 30 60 90; do
    info "Waiting ${wait}s for org policy propagation..."
    sleep "$wait"
    info "Retrying topic creation"
    if gcloud pubsub topics create "$TOPIC" --project="$PROJECT" 2>"$err" >/dev/null; then
      info "Topic created: $TOPIC"
      return 0
    fi
    if ! grep -q 'gcp\.resourceLocations\|does not allow message storage' "$err"; then
      cat "$err" >&2
      fail "Topic creation failed for a different reason — see error above"
    fi
  done

  cat "$err" >&2
  fail "Org policy still blocking after 3 minutes. Wait longer and re-run, or check the policy in console."
}

ensure_topic() {
  if gcloud pubsub topics describe "$TOPIC" --project="$PROJECT" >/dev/null 2>&1; then
    skip "Topic exists: $TOPIC"
  elif [ "$MODE" = "check" ]; then
    drift "would create topic $TOPIC"
  else
    info "Creating topic: $TOPIC"
    create_topic_with_policy_override
  fi

  if ! gcloud pubsub topics describe "$TOPIC" --project="$PROJECT" >/dev/null 2>&1; then
    return  # only happens in --check when topic absent
  fi

  if gcloud pubsub topics get-iam-policy "$TOPIC" --project="$PROJECT" --format=json 2>/dev/null \
      | jq -e --arg m "serviceAccount:$CHAT_PUBLISHER" \
           '.bindings[]? | select(.role=="roles/pubsub.publisher") | .members[]? | select(. == $m)' \
         >/dev/null; then
    skip "Topic publisher binding granted to $CHAT_PUBLISHER"
  elif [ "$MODE" = "check" ]; then
    drift "would grant pubsub.publisher on $TOPIC to $CHAT_PUBLISHER"
  else
    info "Granting pubsub.publisher on $TOPIC to $CHAT_PUBLISHER"
    grant_chat_publisher_with_policy_override
  fi
}

grant_chat_publisher_with_policy_override() {
  local err
  err=$(mktemp)
  trap 'rm -f "$err"' RETURN

  if gcloud pubsub topics add-iam-policy-binding "$TOPIC" \
       --member="serviceAccount:$CHAT_PUBLISHER" --role="roles/pubsub.publisher" \
       --project="$PROJECT" 2>"$err" >/dev/null; then
    return 0
  fi

  cat "$err" >&2

  if ! grep -q 'iam\.allowedPolicyMemberDomains\|not in permitted' "$err"; then
    fail "IAM binding failed — see error above"
  fi

  printf '\n  Org policy iam.allowedPolicyMemberDomains blocks granting roles to %s\n' "$CHAT_PUBLISHER"
  printf '  That SA lives in Google'"'"'s system org and is required for GChat events delivery.\n'
  printf '  Reference: https://console.cloud.google.com/iam-admin/orgpolicies/iam-allowedPolicyMemberDomains?project=%s\n\n' "$PROJECT"
  if ! confirm_typed_yes "Override iam.allowedPolicyMemberDomains for $PROJECT to allow all members?"; then
    fail "Aborted. Override manually then re-run."
  fi

  info "Overriding iam.allowedPolicyMemberDomains at project level (allow all)"
  local policy_file
  policy_file=$(mktemp)
  cat >"$policy_file" <<EOF
constraint: constraints/iam.allowedPolicyMemberDomains
listPolicy:
  allValues: ALLOW
EOF
  gcloud resource-manager org-policies set-policy "$policy_file" \
    --project="$PROJECT" >/dev/null \
    || { rm -f "$policy_file"; fail "Policy override failed — see error above"; }
  rm -f "$policy_file"

  local wait
  for wait in 30 60 90; do
    info "Waiting ${wait}s for org policy propagation..."
    sleep "$wait"
    info "Retrying IAM binding"
    if gcloud pubsub topics add-iam-policy-binding "$TOPIC" \
         --member="serviceAccount:$CHAT_PUBLISHER" --role="roles/pubsub.publisher" \
         --project="$PROJECT" 2>"$err" >/dev/null; then
      return 0
    fi
    if ! grep -q 'iam\.allowedPolicyMemberDomains\|not in permitted' "$err"; then
      cat "$err" >&2
      fail "IAM binding failed for a different reason — see error above"
    fi
  done

  cat "$err" >&2
  fail "Org policy still blocking after 3 minutes. Wait longer and re-run."
}

ensure_subscription() {
  if gcloud pubsub subscriptions describe "$SUB" --project="$PROJECT" >/dev/null 2>&1; then
    skip "Subscription exists: $SUB"
    return
  fi
  if [ "$MODE" = "check" ]; then drift "would create subscription $SUB"; return; fi
  info "Creating subscription: $SUB"
  gcloud pubsub subscriptions create "$SUB" --topic="$TOPIC" --project="$PROJECT" >/dev/null \
    || fail "Subscription creation failed"
}

ensure_sa_iam_roles() {
  local role="roles/pubsub.admin"
  local member="serviceAccount:$SA_EMAIL"
  if gcloud projects get-iam-policy "$PROJECT" --format=json 2>/dev/null \
      | jq -e --arg r "$role" --arg m "$member" \
           '.bindings[]? | select(.role == $r) | .members[]? | select(. == $m)' \
         >/dev/null; then
    skip "$role already granted to $SA_EMAIL"
    return
  fi
  if [ "$MODE" = "check" ]; then drift "would grant $role to $SA_EMAIL on $PROJECT"; return; fi

  info "Granting $role to $SA_EMAIL"
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="$member" --role="$role" --condition=None --quiet >/dev/null \
    || fail "IAM role grant failed"
}

ensure_env_topic() {
  local current
  current=$(grep -m1 '^GCHAT_PUBSUB_TOPIC=' .env | sed 's/^GCHAT_PUBSUB_TOPIC=//' || echo "")
  current=${current%\"}; current=${current#\"}; current=${current%\'}; current=${current#\'}

  if [ "$current" = "$TOPIC" ]; then
    skip ".env GCHAT_PUBSUB_TOPIC already set to $TOPIC"
    return
  fi
  if [ "$MODE" = "check" ]; then
    if [ -z "$current" ]; then drift "would add GCHAT_PUBSUB_TOPIC=$TOPIC to .env"
    else drift ".env GCHAT_PUBSUB_TOPIC=$current does not match — would replace with $TOPIC"; fi
    return
  fi

  if [ -z "$current" ]; then
    [ -s .env ] && [ "$(tail -c1 .env)" != $'\n' ] && printf '\n' >>.env
    printf 'GCHAT_PUBSUB_TOPIC=%s\n' "$TOPIC" >>.env
    info "Wrote GCHAT_PUBSUB_TOPIC=$TOPIC to .env"
  else
    local tmp; tmp=$(mktemp)
    sed "s|^GCHAT_PUBSUB_TOPIC=.*|GCHAT_PUBSUB_TOPIC=$TOPIC|" .env >"$tmp" && mv "$tmp" .env
    info "Updated GCHAT_PUBSUB_TOPIC: $current → $TOPIC"
  fi
}

print_dwd_instructions() {
  local client_id scopes
  client_id=$(gcloud iam service-accounts describe "$SA_EMAIL" \
    --project="$PROJECT" --format="value(uniqueId)" 2>/dev/null || echo "")
  scopes=$(jq -r '.dwd_grant_superset | join(",")' config/gws-scopes.json)

  printf '\n%b── Manual step 1/2: Domain-Wide Delegation ──%b\n\n' "$BOLD" "$RESET"
  printf '  Open: %bhttps://admin.google.com/ac/owl/domainwidedelegation%b\n\n' "$BLUE" "$RESET"
  printf '  Click "Add new", then enter:\n\n'
  printf '    Client ID:  %s\n\n' "$client_id"
  printf '    OAuth scopes (paste the line below):\n\n'
  printf '%s\n\n' "$scopes"
  printf '  Click "Authorize". Propagation usually takes minutes (up to 24h).\n\n'
}

print_chat_app_instructions() {
  local config_url="https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat?project=$PROJECT"

  printf '\n%b── Manual step 2/2: Configure the Chat app ──%b\n\n' "$BOLD" "$RESET"
  printf '  Google does not expose a programmatic API for Chat-app config.\n'
  printf '  Open: %b%s%b\n\n' "$BLUE" "$config_url" "$RESET"
  printf '  Fill in:\n\n'
  printf '    App name:           %s\n'                                "$ASSISTANT_NAME"
  printf '    Avatar URL:         https://ui-avatars.com/api/?name=%s&background=4285F4&color=fff&size=256&format=png\n' "$BOT"
  printf '    Description:        Personal Workspace EA\n'
  printf '    Functionality:      ✓ Receive 1:1 messages\n'
  printf '                        ✓ Join spaces and group conversations\n'
  printf '    Connection:         Cloud Pub/Sub\n'
  printf '    Pub/Sub topic:      projects/%s/topics/%s\n'              "$PROJECT" "$TOPIC"
  printf '    Permissions:        Specific people — include: %s\n' "$ASSISTANT_EMAIL"
  printf '  Click "Save". Without this step, GChat events will not reach NanoClaw.\n\n'
}

# ── Modes ─────────────────────────────────────────────────────────────────

case "$MODE" in
  default)
    step "Resolving project"; resolve_project
    step "Billing";           ensure_billing
    step "APIs";              ensure_apis
    step "Org policies";      ensure_org_policies
    step "Service account";   ensure_sa; ensure_sa_key
    step "Pub/Sub";           ensure_topic; ensure_subscription
    step "SA IAM roles";      ensure_sa_iam_roles
    step "Updating .env";     ensure_env_topic
    print_dwd_instructions
    print_chat_app_instructions
    printf '%b── Done ──%b\n\n' "$BOLD" "$RESET"
    printf '  Next: complete the two manual steps above, then restart NanoClaw.\n\n'
    ;;
  check)
    step "Resolving project"; resolve_project
    if [ -n "${PROJECT:-}" ]; then
      step "Billing";         ensure_billing
      step "APIs";            ensure_apis
      step "Org policies";    ensure_org_policies
      step "Service account"; ensure_sa; ensure_sa_key
      step "Pub/Sub";         ensure_topic; ensure_subscription
      step "SA IAM roles";    ensure_sa_iam_roles
      step ".env";            ensure_env_topic
    fi
    printf '\n%b── Drift summary: %d item(s) ──%b\n\n' "$BOLD" "$DRIFT_COUNT" "$RESET"
    exit "$DRIFT_COUNT"
    ;;
  delete)
    step "Resolving project"; resolve_project
    SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
    printf '\n  About to delete:\n'
    printf '    Project:  %s\n'  "$PROJECT"
    printf '    SA:       %s\n'  "$SA_EMAIL"
    printf '    Key file: %s  (left on disk; delete manually if you want)\n\n' "$KEY_PATH"
    printf '  Recoverable for 30 days via: gcloud projects undelete %s\n\n' "$PROJECT"
    confirm_typed_yes "Delete project $PROJECT?" || fail "Aborted."
    gcloud projects delete "$PROJECT" --quiet >/dev/null || fail "gcloud projects delete failed"
    info "Project $PROJECT scheduled for deletion"
    ;;
esac
