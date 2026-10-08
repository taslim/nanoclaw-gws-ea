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
of the `add-onecli` skill's pin and never older than it: NanoClaw moves that pin
for security fixes, and `onecli-gateway-image.test.ts` fails if GWS-EA's falls
behind. Both are `1.42.0`, which includes the gateway-side host-enforcement fix:
never import a real credential into a `1.41.0` runtime. NanoClaw supports no
OneCLI from 1.43 on, which removes the agent secret-assignment API; GWS-EA also
sets main's agent secret mode, so check that API before moving past 1.42.
Instance provisioning upgrades the gateway itself. Its generated, instance-owned
runtime verifies the exact image, the health endpoints, the CLI and SDK cohort,
and the isolated network topology before it accepts a real provider credential,
so GWS-EA instances never follow the `add-onecli` upgrade guide.
