#!/bin/sh
# Egress firewall for the OneCLI gateway's network namespace (KTD2).
#
# Applied to the filter-table OUTPUT chain ONLY -- never the nat table, so
# Docker's embedded DNS at 127.0.0.11 keeps resolving (name resolution is
# load-bearing: the gateway resolves `postgres` and every public host through
# it). Fail closed: any error aborts before the gateway starts (R9).
#
# Allows: loopback, established/related replies, this instance's OWN backend
# subnet on tcp/5432 (its Postgres) only. Rejects: every other private/reserved
# IPv4 range (own app admin API, peer instances, Docker Desktop's host loopback
# at 192.168.65.254, LAN, link-local/metadata). Accepts the rest (public
# internet). Drops all IPv6 except loopback/established.
set -eu

PG_IP=$(getent hosts postgres | awk '{print $1; exit}')
[ -n "$PG_IP" ] || { echo "FATAL egress-rules: cannot resolve 'postgres' -- refusing to start gateway with open egress" >&2; exit 1; }

BACKEND_IF=$(ip -4 route get "$PG_IP" | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -1)
[ -n "$BACKEND_IF" ] || { echo "FATAL egress-rules: no backend interface routes to postgres ($PG_IP)" >&2; exit 1; }

# The on-link subnet (CIDR) of that interface scopes the DB allowance to THIS
# instance's containers, not any private 5432 elsewhere.
BACKEND_CIDR=$(ip -4 route show dev "$BACKEND_IF" scope link | awk '/src/{print $1; exit}')
[ -n "$BACKEND_CIDR" ] || { echo "FATAL egress-rules: cannot derive backend subnet on $BACKEND_IF" >&2; exit 1; }

command -v iptables >/dev/null 2>&1 || { echo "FATAL egress-rules: iptables not available" >&2; exit 1; }

# --- IPv4 filter/OUTPUT (append only; do not touch nat) ---
iptables -F OUTPUT
iptables -P OUTPUT ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -d "$BACKEND_CIDR" -p tcp --dport 5432 -j ACCEPT
for net in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 \
           192.0.0.0/24 192.0.2.0/24 192.88.99.0/24 192.168.0.0/16 198.18.0.0/15 \
           198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4; do
  iptables -A OUTPUT -d "$net" -p tcp -j REJECT --reject-with tcp-reset
  iptables -A OUTPUT -d "$net" -j REJECT
done
iptables -A OUTPUT -j ACCEPT

# --- IPv6 filter/OUTPUT: drop everything except loopback/established ---
command -v ip6tables >/dev/null 2>&1 || { echo "FATAL egress-rules: ip6tables not available" >&2; exit 1; }
ip6tables -F OUTPUT
ip6tables -A OUTPUT -o lo -j ACCEPT
ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -P OUTPUT DROP

echo "egress-rules applied: backend_if=$BACKEND_IF subnet=$BACKEND_CIDR (db 5432 only), ipv4 public allowed, ipv6 drop"
