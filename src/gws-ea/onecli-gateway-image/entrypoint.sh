#!/bin/sh
# Wrapper entrypoint (KTD1/KTD4). Runs as root: apply the egress firewall, then
# drop to the non-root `node` user with all capability sets emptied and exec the
# gateway. The gateway process therefore holds no capabilities (running non-root
# guarantees no effective NET_ADMIN even though the container was granted it) and
# cannot alter the rules. Rules apply before the gateway accepts any connection,
# so there is no rules-before-traffic race.
set -eu

/usr/local/bin/egress-rules.sh

# DSN shape and secret filenames mirror the app service's command in
# src/gws-ea/onecli-compose.ts (renderOnecliCompose); keep the two in sync.
export DATABASE_URL="postgresql://onecli:$(cat /run/secrets/postgres_password)@postgres:5432/onecli"
export SECRET_ENCRYPTION_KEY="$(cat /run/secrets/secret_encryption_key)"
export GATEWAY_INTERNAL_SECRET="$(cat /run/secrets/gateway_internal_secret)"

exec setpriv --reuid node --regid node --init-groups --bounding-set -all --inh-caps -all \
  onecli-gateway --port 10255 --data-dir /app/data
