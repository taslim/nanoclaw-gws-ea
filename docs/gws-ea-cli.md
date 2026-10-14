# GWS-EA operator and automation guide

`gws-ea` manages Google Workspace assistants from this tool checkout. Each
assistant has a separate full ID, owned resources, creation journal, release,
service, and recovery records. Optional capabilities have host scope.

Start with `gws-ea --help`. Use `gws-ea help update` or `gws-ea update --help`
for a command's flags, scope, effects, prerequisites, recovery, and examples.
`gws-ea help capabilities install` and `gws-ea capabilities install --help`
print identical help. Invalid paths remain errors even with `--help`.
See [the voice guide](gws-ea-voice.md) for optional voice installation,
activation, and health checks.

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
