#!/bin/sh
# Starts the image's Chromium for agent-browser and Playwright consumers: the
# image points AGENT_BROWSER_EXECUTABLE_PATH and
# PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH here.
#
# The credential gateway injects the assistant's Google tokens by host alone,
# and Chromium trusts the gateway's CA, so a page reaching one of those hosts
# through the gateway could call Google's APIs as the assistant and read the
# answer. A URL blocklist stops navigations, not a page's own requests, so
# Chromium goes through the gateway with those hosts on its proxy-bypass list
# instead: on the internal agent-egress network a bypassed host has no route,
# and the request fails. gog does not use the browser and keeps the gateway on
# those hosts, so the bypass is Chromium's alone, never a container-wide
# NO_PROXY.
#
# The hosts are AGENT_GOOGLE_HOSTS in src/modules/gws-ea-google/grant.ts, and
# src/modules/gws-ea-google/browser-bypass.test.ts fails when they differ.
set -eu

GOOGLE_API_HOSTS='www.googleapis.com,gmail.googleapis.com,people.googleapis.com,docs.googleapis.com,sheets.googleapis.com,slides.googleapis.com,forms.googleapis.com'

# The gateway is the proxy the container's environment names. Chromium cannot
# use the credentials in it, so they are left out; agent-browser reads them
# from the same environment and answers the gateway's challenge itself. With
# no gateway named there is nothing to bypass, so Chromium is not started at
# all rather than started some other way.
proxy=${HTTPS_PROXY:-${https_proxy:-}}
case $proxy in
  *://*) scheme=${proxy%%://*}:// ;;
  *) scheme= ;;
esac
authority=${proxy#"$scheme"}
authority=${authority%%/*}
server=${authority##*@}
if [ -z "$server" ]; then
  echo 'chromium-launch: HTTPS_PROXY names no gateway, and Chromium starts only behind it' >&2
  exit 1
fi

# These are the only proxy settings Chromium gets. Every proxy switch a caller
# passes is dropped: agent-browser passes the gateway itself and NO_PROXY as a
# bypass list, and a PAC script, auto-detection or no proxy would each override
# the bypass. Every other argument passes through unchanged and in order.
for arg do
  shift
  case $arg in
    -*)
      name=${arg#-}
      name=${name#-}
      case ${name%%=*} in
        proxy-server | proxy-bypass-list | proxy-pac-url | proxy-auto-detect | no-proxy-server) continue ;;
      esac
      ;;
  esac
  set -- "$@" "$arg"
done

exec /usr/bin/chromium --proxy-server="$scheme$server" --proxy-bypass-list="$GOOGLE_API_HOSTS" "$@"
