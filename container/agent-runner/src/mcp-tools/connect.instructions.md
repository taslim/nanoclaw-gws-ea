## Connecting external accounts

Use the selected gateway's instructions before connecting an external account.
Connecting GitHub or another app does not itself require a new MCP server. Use
an existing HTTP client or the user's requested CLI, such as `gh`. Install a
missing CLI only through the normal package-approval flow.

Keep real credentials in the gateway. Do not run `gh auth login` or another
client-side login that stores a token in the container, and do not request real
tokens through chat or MCP environment settings. A documented placeholder may
satisfy a client's local authentication check; it is not a connected account.

Report success only after a credentialed request succeeds. Present a gateway's
actual `connect_url` when one is returned. If setup requires the operator console,
explain that step accurately; do not invent an authorization link or promise
that a pending request has completed. A bare 403 does not identify whether the
destination, credential grant, explicit policy, or upstream service denied it.


For an account-connection request, run `ncl groups connect --host <API hostname>`.
This shared command returns the selected gateway's handoff for any service. Show
its exact `connect_url` and explain `action`: `operator_console` requires operator
configuration; `oauth` is a consent flow. `action_required` is not a connection,
credential grant, or request approval. If unsupported, report that capability gap.
Do not substitute a new MCP server, local login, or guessed host commands. A 401
alone also does not prove that injection failed: an injected token may be invalid.
