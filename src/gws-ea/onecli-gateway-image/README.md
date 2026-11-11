# GWS-EA's OneCLI gateway image

Each GWS-EA assistant runs its own OneCLI gateway from the wrapper image built
here. `src/gws-ea/onecli.ts` builds and verifies it, and `rules.sh` holds the
firewall rules and their rationale.

## Egress isolation

When several assistants run on one machine (the gws-ea deployment), each
assistant's OneCLI gateway runs a wrapper image that installs an egress firewall
in the gateway's own network namespace before the gateway starts. The gateway's
outbound traffic is allowed to the public internet and to its own instance's
Postgres, and is rejected to every private, loopback, and link-local address —
including its own OneCLI app admin API, any peer instance's containers or
host-published ports, the host loopback (`192.168.65.254` on Docker Desktop),
the LAN, and cloud metadata (`169.254.0.0/16`). This closes the path by which a
misled agent could otherwise reach its own or a peer's OneCLI control plane
through the gateway. Provisioning verifies the boundary through the gateway and
refuses to start (spawning no agent) if any probe fails.

**Operator limitation:** because private ranges are blocked, an assistant cannot
reach a local or LAN service — a local Ollama endpoint, a NAS, or another service
on the operator's machine. gws-ea assistants target cloud model providers and
cloud services reached over public egress; local/LAN reach from inside the agent
sandbox is outside gws-ea's egress identity.

## Gateway version

GWS-EA pins its own OneCLI gateway in `src/gws-ea/versions.json`, independently
of the `add-onecli` skill's pin. `1.42.0` includes the gateway-side
host-enforcement fix: never import a real credential into a `1.41.0` runtime.
GWS-EA's pin is never older than add-onecli's unless GWS-EA reviewed that pin
and recorded here why it stays behind; `onecli-gateway-image.test.ts` fails
otherwise.

add-onecli moved to `1.45.0` for OneCLI's agent grants. GWS-EA reviewed that pin
on 2026-11-10 (`REVIEWED_ADD_ONECLI_GATEWAY`) and stays on `1.42.0`:

- The move carries no fix GWS-EA's gateway needs. OneCLI 1.43's OAuth callback
  fixes reach only the app's OAuth flow, which GWS-EA leaves unconfigured on a
  loopback-only port, and its `/token` intercept fix concerns secrets on
  `oauth2.googleapis.com` and app connections, neither of which GWS-EA has.
- GWS-EA's own administration relies on what 1.43 and 1.44 remove: main's `all`
  secret mode (`src/gws-ea/identity.ts`, checked by provisioning and status) and
  each chat agent's `selective` mode holding only the model secret
  (`src/modules/gws-ea-chat-agents/gateway.ts`), set through the per-agent
  secret-mode and assignment routes.
- A 1.44 or later gateway converts every agent's mode into grants on its first
  start and migrates its database one way; a 1.42 gateway cannot run on it
  again without a restored backup.
- The add-onecli payload's model-credential grant step attaches nothing here:
  1.42 answers its grants route as an unknown route.

Moving to grants is a change of its own: the admin client on the grants routes,
main's and the chat agents' access expressed as grants, and a way for live
assistants to cross the conversion, since an update keeps the OneCLI version an
assistant runs.

GWS-EA administers OneCLI over its REST API alone (`src/gws-ea/onecli-admin.ts`),
so the pin moves only after `onecli-admin.contract.test.ts` passes against the
new version, which then becomes the test's recorded verified version.
Instance provisioning builds and starts the gateway itself. Its generated,
instance-owned runtime is re-verified by Compose's own config hash plus the
wrapper's provenance label, the owner labels and the isolated network topology,
and the isolation probe runs whenever a service is created or recreated, before
a real provider credential is accepted, so GWS-EA instances never follow the
`add-onecli` upgrade guide.
