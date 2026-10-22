# GWS-EA operator and automation guide

`gws-ea` manages Google Workspace assistants from this tool checkout. Each
assistant has a separate full ID, owned resources, creation journal, release,
service, and recovery records. Optional capabilities have host scope.

Start with `gws-ea --help`. Use `gws-ea help update` or `gws-ea update --help`
for a command's flags, scope, effects, prerequisites, recovery, and examples.
`gws-ea help capabilities install` and `gws-ea capabilities install --help`
print identical help. Invalid paths remain errors even with `--help`.
See [the voice guide](gws-ea-voice.md) for optional voice installation,
activation, and health checks, [1Password vaults](#1password-vaults) for
assistants' saved logins, [web alias](#web-alias) for the address an
assistant's browser uses, and [browser access](#browser-access) for which of
its agents may use the browser.

## Find and inspect an assistant

```sh
gws-ea list
gws-ea status --id 01234567-89ab-4def-8123-456789abcdef
gws-ea status --id 01234567-89ab-4def-8123-456789abcdef --details
gws-ea logs --id 01234567-89ab-4def-8123-456789abcdef --errors
```

Copy the full ID from `list`; IDs are never selected implicitly or abbreviated.
Narrow output uses stacked records, preserving full IDs. Default status shows
identity, service and conversation condition, active operation, observation time,
and useful next actions. `--details` adds probe facts and technical diagnostics.
Status observes without repair, credentials, a run log, or an operation lock.
Degraded and unknown observations still exit 0: read the facts, not only the exit.
Unknown or unreachable services and consumers do not establish health or drainage.
Human times use the install timezone; machine observations are ISO UTC.

`gws-ea --version` identifies this tool's package version and exact checkout
revision. An assistant's deployed revision is a separate fact in `status`.

## Create and continue

```sh
gws-ea create --track dogfood
# After a reserved creation pauses:
gws-ea resume --id 01234567-89ab-4def-8123-456789abcdef --chat-configured
```

`create` deploys this tool's clean committed release. `dogfood` and `prod` are
known tracks; another track requires `--source-remote`. The identities have
different purposes:

- `--google-account`: the operator managing Google Cloud resources.
- `--assistant-workspace-email`: the assistant's own Workspace account receiving
  mail and Chat. Sign in as this account for assistant Google authorization.
- `--principal-email`: one address belonging to the person served. Repeat the
  flag for several addresses; their order is retained.
- `--principal-chat-email`: that person's Chat address, selected from their
  principal addresses when several are supplied.
- `--provider`: the agent runtime. Its credential identity is independent of
  those Google accounts.

Creation may pause for an external prerequisite. Once the result confirms an
assistant ID, continue its journal with `resume`; `remove` tears down a partial
creation. Before reservation, inspect the failure and inputs before starting a
new creation. Do not blindly repeat `create` to recover an existing assistant.
`connect-google --id <full-id>` repairs that assistant's own Google connection
and is safe to rerun.

Credentials retain their existing environment, private-file, and gateway
boundaries. A `--secrets-file` is an owner-only file under the config root;
`--google-client-file` is the downloaded desktop OAuth client. Discovery and
recovery never print credential values. Do not place secrets in shell examples.

## Update, roll back, and remove

```sh
gws-ea update --id 01234567-89ab-4def-8123-456789abcdef
gws-ea update --all
gws-ea rollback --id 01234567-89ab-4def-8123-456789abcdef
gws-ea remove --id 01234567-89ab-4def-8123-456789abcdef
```

A single update prepares the release before confirmation. Its preview names
current and target revisions, repository or track changes, migrations, images,
and recovery consequences. Declining leaves the serving release unchanged and
retains staged preparation. `update --all` shows eligibility before preparing
anything, then runs eligible assistants sequentially on their own repository
and track. A busy target stops the rollout; results name completed, skipped,
busy, and unattempted targets.

Repeat `update` or `rollback` for their recorded continuation or receipt
follow-ups. Rollback keeps post-update data unless changed schemas or an explicit
`--snapshot` require restoration; the preview describes what is discarded and
what is retained. Repeat `remove` to continue its teardown journal. External
resource abandonment needs the command's explicit `--abandon` selection.
Busy results name the blocked command and offer read-only inspection.

`create` and `update` automatically clean a stray NanoClaw install from this
authoring checkout under the existing ownership rules. This cleanup can happen
before a later step pauses or is cancelled. Its scope, removed resources, and
incomplete cleanup remain visible, including under `--quiet`. `gws-ea cleanup`
repeats that authoring-checkout cleanup. Managed assistant state remains governed
by its own lifecycle and ownership rules.

## 1Password vaults

```sh
gws-ea capabilities enable onepassword
gws-ea capabilities check onepassword
gws-ea capabilities disable onepassword
gws-ea remove --id 01234567-89ab-4def-8123-456789abcdef --delete-vault
```

`enable` needs the 1Password CLI (`op`) 2.29 or later in an operator-owned
location on this host's PATH (for example `brew install 1password-cli`), and the
1Password desktop app signed in to the account assistants use, with Settings >
Developer > Integrate with 1Password CLI turned on. The operator must be an owner
or administrator allowed to create service accounts. The first run selects the
account (`--account <account_id>`, or a terminal choice), recording its ID with
the sign-in address the app lists for it, and the app may ask for approval. It
creates a host management service account that may only create
vaults. Then, for each compatible assistant, running or stopped, it creates a
vault named after the assistant's address and a runtime service account with
read and write access to only that vault. It never enables a browser or starts
Chrome. Later `create` and `resume` provision new assistants the same way,
through the same desktop sign-in; a wait there pauses with the assistant
already talkable. An older release is skipped; `update` it, then rerun
`enable`. A partial run keeps finished assistants, and a rerun continues the
rest. When a creation's outcome is unknown, the result names what to delete or
revoke on 1Password.com; then `--discard-unproven <instance_id|management>`
forgets that attempt.

`show` reads local records only. `check` spends service-account requests on
identities, one vault read per assistant, and the account's usage. It never
writes, so a recorded write grant is not a tested write. Every service account
in the 1Password account, including another host's, shares one daily request
limit set by the account's plan. `check` reports the account type, that limit,
its usage and the assistants sharing it. A spent limit returns a rate-limited
outcome, and nothing retries it automatically; a larger plan is the operator's
choice.

An assistant saves there the passwords it generates for new accounts and for
password changes, which it makes only on logins it saved itself, with their
username and site unchanged. A confirmed change replaces the password in that
login and deletes the separate item that held the new one, so no item the
assistant keeps holds the old password (1Password's item history and Recently
Deleted keep earlier versions, as for any edit). If someone changes or removes
the login in 1Password during the change, the assistant leaves it as they made
it and keeps the new password in its own item. Principals manage the saved
logins through their assistant, which shares its vault, view and edit, with the
principal's confirmed 1Password user, and gives them the account's sign-in
address and the vault's name. When it cannot (no confirmed member or guest has
that email, a guest already uses another vault, an Individual account cannot
share, or the host cannot share), the principal gets a message to forward naming
the assistant, the account's sign-in address and ID, the vault's name when known
and ID, and the email. Share the vault on 1Password.com, or add and confirm the
person; the principal then asks the assistant to check again. After adding a
login in 1Password, the principal asks the assistant to retry, which lists the
vault again.

`disable` stops every assistant's vault use at once and deletes their runtime
tokens. Vaults, items, recorded IDs, unfinished credential attempts and the
management service account stay. `enable` again reuses each vault and mints
replacement runtime service accounts through the desktop sign-in. `remove`
previews the vault and its item count, deletes the runtime token after the host
stops, and deletes the vault only when this host's management service account
created it and it is empty or `--delete-vault` was confirmed; never another
vault. gws-ea never revokes a service account: revoke the ones disable and
removal results name on 1Password.com under Developer > Directory. A removal
receipt keeps their IDs after the assistant is gone, and the names of any vault
or runtime service account whose creation was never proven; once you have
revoked or deleted them, close it with
`gws-ea remove --id <full-id> --yes --abandon onepassword`.

## Web alias

```sh
gws-ea capabilities enable browser --id 01234567-89ab-4def-8123-456789abcdef
# Once the offered alias is added in the Google Admin console:
gws-ea capabilities enable browser --id 01234567-89ab-4def-8123-456789abcdef --alias-added
```

An assistant whose browser is enabled has one web alias: its address for
everything it does on the web in its own name, guest bookings and checkouts
made for the principal included. The alias is the assistant's name,
lowercased, in ASCII, without spaces, and reversed (`Juno` gives `onuj`). A
name that reads the same reversed moves its first letter to the end instead
(`Anna` gives `nnaa`). Role addresses such as `admin` or `postmaster` are
never offered, and later candidates are numbered (`onuj2`, `onuj3`).

`capabilities enable browser`, and `create` or `resume` once the browser is
enabled, pause after every other step with the candidate and where to add
it: the assistant's account in the Admin console (Directory > Users), then
User information > Alternate email addresses (email aliases). The candidate
is claimed on this machine first, so no two assistants are asked for the
same address. Continue the same command with one of:

- `--alias-added`: the alias is added. The assistant sends a short,
  self-explaining test message to it and reads it back. An arrival records
  the alias. A bounce means it is not added yet, and a copy through a Google
  Group is refused. A new alias can take up to 24 hours to receive mail; run
  the command again later without a flag to read the same message back.
- `--alias-taken`: the Admin console says the address is in use; the next
  candidate is offered.
- `--alias <name>`: a name, or whole address, of your own; with
  `--alias-added` once it is added. A name that gives no candidate, such as
  one without ASCII letters, waits for this.

Until the alias is verified, `status` reports setup as incomplete: its
`web_alias` probe is degraded, naming the address it waits on and the command
that continues. The alias is set up through the running assistant, so a
stopped one pauses until `gws-ea start`. A recorded alias is not changed by
these flags.

## Browser access

```sh
# Let main and one more agent group use the browser:
gws-ea capabilities enable browser --id 01234567-89ab-4def-8123-456789abcdef \
  --agent-group <main_agent_group_id> --agent-group <agent_group_id>
# Back to main alone:
gws-ea capabilities enable browser --id 01234567-89ab-4def-8123-456789abcdef --main-only
```

By default only the assistant's main agent delegates browser errands. Repeat
`--agent-group` to list exactly the agent groups that may; include main's ID to
keep it. Before writing the list, gws-ea asks the running assistant to confirm
that it reads access lists and has each group. The browser and external-email
groups can never be listed. A listed group shares the one signed-in browser
profile and the vault's logins; its purchase, consent and watch approvals still
go to the principal, and its errands, cards and notices stay its own. A group
removed from the list has its errands cancelled.

`disable` and a plain `enable` keep the list, and `capabilities show browser`
reports it. While a list is in place, `rollback`, and reverting an open update,
are refused to a release that cannot read it; `--main-only` lifts that.

### Browser diagnosis and release acceptance

`gws-ea capabilities check browser --id <full-id>` checks the selected managed
assistant without starting Chrome. It reports proxy and debugger isolation
separately on that assistant network's existing host-gateway route. A stopped
Chrome reports debugger `not_run` and can remain ready when proxy isolation
passes. Starting Chrome, missing or malformed running-listener metadata, changed
targets during the check, or an unobservable probe makes isolation `unknown` and
ready false; a reachable listener fails isolation. This named route check does
not repeat the multi-route/gateway audit or establish isolation from trusted host
processes or ordinary Docker bridge containers.

Host Playwright uses the live Chrome child it launched, with ownership-verified
CDP on an explicit nonzero `127.0.0.1` port. Host health may report that integer
port; debugger endpoint URLs and browser IDs stay private. Browser request
evidence distinguishes an observed website response,
a local rule refusal, a transport failure and a runtime failure; a completed
navigation onto an Access Denied page is still a challenge. A website denial is
not proof of its cause or a completed booking. Main reports the practical
limitation; operator evidence stays bounded and redacted.

The implementation uses one persistent host Playwright runtime, with background
pages owned by individual errands. Recipe recording and site metadata are optional;
an unavailable recording cannot block ordinary actions or a later permitted
navigation. A successful watch region mark includes a fresh observation: use its
refs for the next action. After an error, observe again before acting.

Use the existing exact-commit managed update after deployment is authorized;
never start a second NanoClaw install in this tool checkout. Check the staged
preview for unchanged central migrations and session schemas. The default
code-only rollback preserves the live database and browser profile, including
attempts created between service start and health verification. Restoring a
snapshot cannot undo a website action. An older binary cannot safely save a
recording whose trace reservation failed but whose new request ledger records
unavailable coverage; fix that storage failure forward.

Real OpenTable, Resy and Tock results, sign-in and confirmed-result checks, active
operator focus/Spaces, cross-install isolation and the elapsed watch soak remain
separate release acceptance evidence. Follow
[`scripts/browser-live-check/README.md`](../scripts/browser-live-check/README.md)
on the authorized deployed release. Fixture passes and a locked-desktop sample
do not establish those claims.

## Automation and streams

```sh
gws-ea schema --json
gws-ea schema update --json
gws-ea status --id 01234567-89ab-4def-8123-456789abcdef --json
gws-ea update --id 01234567-89ab-4def-8123-456789abcdef --json --no-input
# Review the returned preview before supplying the defined confirmation:
gws-ea update --id 01234567-89ab-4def-8123-456789abcdef --json --no-input --yes
```

Managed `--json` invocations emit one result document on stdout. It contains
`schema_version: 1`, `command`, `outcome`, `changed`, `data`, `error`,
`next_actions`, and `diagnostics`. `changed` is true for confirmed domain
effects, false for confirmed absence of effects, and null for uncertainty;
creating a log alone is not a domain change. A pause can retain preparation.
Treat `next_actions` as domain-specific continuation, not blanket replay advice.
Read `data.assistants` for `list` and `data.probes` for `status`.
The schema publishes argument and option types, repeatability, modes, effects,
and exact result shapes. Help is human-only; combining `--help` with `--json`
returns one usage-error document directing automation to `schema`.

Results and requested previews go to stdout. Progress, prompts, diagnostics, and
cleanup notices go to stderr. Redirected progress uses plain transitions; no
pager is launched. `--quiet` suppresses progress while preserving results,
previews, errors, and cleanup diagnostics. Non-TTY output and a nonempty
`NO_COLOR` suppress color decoration. `--json`, `--no-input`, and unattended
invocations do not prompt, read keys, launch a browser, or offer diagnosis.
`--yes` supplies only a command's defined confirmation; it never supplies OAuth
consent or every future human decision.

| Exit         | Meaning                                     |
| ------------ | ------------------------------------------- |
| 0            | Completed, observed, or declined/cancelled  |
| 1            | Operational failure                         |
| 2            | Invalid invocation                          |
| 10           | Human prerequisite or confirmation required |
| 75           | Busy operation                              |
| 128 + signal | Interrupted                                 |

`logs` and `ncl` keep native output and exits. Child arguments after `--` are
unchanged; put child JSON flags there, as in
`gws-ea ncl --id <full-id> -- groups list --json`. Outer no-input flags do not
change the delegated command's interactive behavior.

## Shell completion

`gws-ea completion bash`, `zsh`, or `fish` prints a shell script for the user to
source through their preferred shell configuration. Generation does not install
or execute it. Completion includes nested help/schema paths, scoped options,
local capability names, enum values, and file arguments with spaces. It stops at
`--`; it does not query the registry for ID suggestions.
