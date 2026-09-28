# Credentials & External Services

Your HTTP requests go through the OneCLI proxy, which injects real credentials automatically. Just call any API directly (Gmail, GitHub, Slack, etc.) — the proxy adds auth before it reaches the service.

Use any method: curl, Python, a CLI tool, whatever fits. If a tool checks for credentials locally, pass any placeholder value — the proxy replaces it with real credentials at request time.

If you get a `401`/`403`/`app_not_connected`, the error response contains a `connect_url` — you MUST show it to the user as a bare URL on its own line (no angle brackets, no markdown link syntax) so they can click to connect. Run `/onecli-gateway` for the full error-handling flow. Never ask the user for API keys or tokens.

## Local and LAN services are unreachable

Your egress goes only to the public internet through the gateway. Private,
loopback, and link-local addresses are blocked, so you cannot reach a service
on the host or LAN — a local Ollama endpoint, a NAS, a database on the
operator's machine, or a cloud metadata address. This is deliberate: it keeps
each assistant’s credentials and control plane isolated from every other
assistant on the same machine. Use public, cloud-hosted services instead; do
not ask the operator to expose a local service to reach it.
