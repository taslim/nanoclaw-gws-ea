# GWS-EA operator and automation guide

`gws-ea` manages Google Workspace assistants from this tool checkout. Each
assistant has a separate full ID, owned resources, creation journal, release,
service, and recovery records.

Start with `gws-ea --help`. Use `gws-ea help update` or `gws-ea update --help`
for a command's flags, scope, effects, prerequisites, recovery, and examples.
`gws-ea help connectors install voice` and
`gws-ea connectors install voice --help` print identical help. Invalid paths
remain errors even with `--help`.

## Connectors and scopes

A connector provides optional functionality that gws-ea sets up outside the
base install: downloaded programs or models, or provisioned accounts
and services. The catalog contains `voice` and `web`.
Each has four commands:

```sh
gws-ea connectors list
gws-ea connectors install <name>
gws-ea connectors uninstall <name>
gws-ea connectors show <name> [--id <instance_id>]
gws-ea connectors check <name> [--id <instance_id>]
```

Installation and configuration belong to the operator host. Voice shares
immutable programs and models; web keeps separate resources
for each assistant in the operator's selected account. Access remains a
separate decision: agent permissions, the principal's confirmed addresses, and
artifact reader grants retain their own boundaries. Installing a connector
makes its supported functionality available without a second switch.

`list` and `show` read local records only: no asset hashing, provider requests,
provisioning or repair. Their readiness is `not_checked`, and they exit 0 once
observed. `check` performs bounded read-only verification and exits 0 only when
its target is ready; a failure uses `<name>_not_ready`. Without `--id`, it checks
the host and observed supported assistants. Stopped or unreachable assistants
remain `not_checked`, and unsupported releases get an update command; neither
fails the host check. With `--id`, that selected assistant must be ready.
Every observation carries compatibility, prerequisites, setup, readiness and
whether it was checked, scope, reasons and next actions, with connector details.

Create, resume, update, start and restart reconcile installed connectors for
eligible assistants. Existing resources are retained. A missing prerequisite
or operator approval becomes pending with the next action; optional setup never
fails a committed update. Rollback does not provision connectors.

See [voice](gws-ea-voice.md) and [HTML artifacts](gws-ea-artifacts.md) for their lifecycle details. The
[built-in browser](#browser-access) detects Chrome; the [web alias](#web-alias)
is optional assistant identity.

## Assistant web

The `web` connector gives each assistant a stable address such as
`aya.example.com`. HTML artifacts live at `/artifacts` and the principal’s saved
logins page at `/logins`; there is no home page. There is one connector install
and no separate feature switch. Cloudflare Access covers the whole hostname;
public artifacts retain their explicit public route.

For an existing web install, uninstall web using the **current checkout before
updating to this release**. Then pull the release, run `bash gws-ea.sh`, run
`gws-ea update --all`, and run `gws-ea connectors install web` with its setup
options. The old artifacts-only Cloudflare route is deliberately refused; it
cannot protect the logins page. Uninstall keeps saved HTML and logins, while
issued artifact links stop until their serving resources are installed again.

After reinstalling, run `gws-ea connectors check web --id <instance_id>` and
open the assistant's `/logins` link as the principal. A retained artifacts-only
route leaves web not ready.

The operator needs an active Cloudflare DNS zone, an Access team, an
account-scoped management token with the required Tunnel, DNS, Access
application/policy and identity-provider permissions, and `cloudflared`
2025.4.0 or later. Unattended first installs read the token from an owner-only
file inside the operator config root; the default root is `~/.config/gws-ea`, respecting
`XDG_CONFIG_HOME` and `GWS_EA_CONFIG_ROOT`.

```sh
# First install in a terminal: replace ACCOUNT_ID, TEAM_NAME and ZONE_ID.
# The token is entered securely when prompted; no credential file is needed.
gws-ea connectors install web \
  --account ACCOUNT_ID --team TEAM_NAME --zone ZONE_ID

# Unattended first install uses an existing owner-only token file:
gws-ea connectors install web \
  --account <cloudflare_account_id> --team <access_team_subdomain> \
  --zone <active_zone_id> \
  --credential-file <absolute_owner_only_token_file>
gws-ea connectors show web
gws-ea connectors check web --id <instance_id>
gws-ea connectors uninstall web
```

Terminal token entry is hidden. Install validates the token against the selected
zone and Access team before saving its owner-only managed copy. `--json`,
`--no-input`, and runs without a terminal require `--credential-file` on first
install. Later installs reuse the recorded token without prompting.

Install verifies the account, Access team and active zone before recording
configuration. It uses the selected zone's apex: zone `example.com` gives Aya
`aya.example.com`, within Universal SSL's first-level coverage. There is no
`--hostname` option. Later installs reuse the fixed coordinates and verify ready
assistants without restarting their author containers. Pass `--credential-file`
again to rotate the management token; changing the zone requires uninstall first.

The address label uses the web alias's ASCII name reduction, capped at 63
characters. The claim stays fixed across assistant renames. A name with no Latin
letter or one another assistant holds leaves web pending; recreate under another
first name, or remove the holder. There is no suffix or override. A foreign DNS
record, including a covering wildcard, Access destination or tunnel route also
leaves web pending without claiming the name or creating assistant resources.
The reason names the conflict; remove it and rerun install. These web conditions
let create/resume continue to the alias step.

The principal requests a view in conversation and opens its private link with an
email PIN. Every currently confirmed principal address can open private views.
Named guests use their exact invited email; public snapshots need no sign-in.
Check the operator's Cloudflare Access seat allowance for the intended readers.
Viewing requires the operator host and tunnel process. A temporary serving or
verification outage leaves the artifact tools available and `check web` not ready;
ordinary authoring and viewing make no Cloudflare management calls.

Removing one assistant deletes only its DNS record, route and Access application.
Even removing the last assistant retains the installed connector's tunnel, PIN,
service, configuration and tokens for the next assistant. Uninstall closes every
assistant's policy first, then removes verified owned assistant resources and
shared resources last. Issued links stop working; local content and external
resources remain. Its receipt resumes interrupted cleanup, and its result tells
the operator to revoke the management token and remove the original credential
file. Inspect an exact unproven creation and remove any resource it created before
acknowledging it with `--discard-unproven <attempt>`.

See the [artifact guide](gws-ea-artifacts.md) for retention, sharing and native tools.

## Find and inspect an assistant

```sh
gws-ea list
gws-ea status --id 01234567-89ab-4def-8123-456789abcdef
gws-ea status --id 01234567-89ab-4def-8123-456789abcdef --details
gws-ea logs --id 01234567-89ab-4def-8123-456789abcdef --errors
gws-ea lessons --id 01234567-89ab-4def-8123-456789abcdef
```

Copy the full ID from `list`; IDs are never selected implicitly or abbreviated.
Narrow output uses stacked records, preserving full IDs. Default status shows
identity, service and conversation condition, active operation, observation time,
and useful next actions. Browser availability, optional alias identity and each
connector appear independently. Not installed is informational; owed operator
setup is degraded. A stopped assistant shows local facts without live connector
checks. `--details` adds probe facts, browser network isolation and technical diagnostics.
Status observes without repair, a run log or an operation lock. Live checks may
use existing host credentials within their connector boundary; output never
contains their values.
Degraded and unknown observations still exit 0: read the facts, not only the exit.
Unknown or unreachable services and consumers do not establish health or drainage.
Human times use the install timezone; machine observations are ISO UTC.

“Last observed agent outcome (main)” shows the last terminal provider turn in main's
selected conversation, with its provider, observation time, and safe failure cause.
It is historical evidence, separate from conversation readiness and task or delivery
success. JSON carries it in `data.main_turn`, outside `data.probes`. A later
successful provider result replaces a failure, including a turn with no response
text. Missing or malformed state and a different configured provider leave `last`
null with a reason. Restarting or replacing credentials does not update the record.
A recorded credential failure includes sign-in guidance. This observation does not
cover every agent or establish that all external effects of a turn succeeded.

`gws-ea --version` identifies this tool's package version and exact checkout
revision. An assistant's deployed revision is a separate fact in `status`.

## Create and continue

Setup retains the assistant's and principal's first names and optional last
names separately. Display names are derived from those components. An omitted
last name is stored as absent, and compound first or last names keep their
boundaries.

Main and the operator can read the principal's current components with
`ncl principal-profile get` and edit them with `set --first-name`, `--last-name`
or `--clear-last-name`. Omitted components stay unchanged. A change sends the
principal a receipt, including a boundary change whose display text is the same.

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

Creation offers optional web alias setup after the assistant is talkable. At a
terminal, decline it to finish without an alias, or use `--skip-alias` on create
or resume. That decision is retained on resume and releases an outstanding
unconfirmed candidate. Set the alias later with `gws-ea alias --id <full-id>`.

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

### Maintainer release tracks

`src/gws-ea/release-tracks.json` declares each product track's backing branch.
A `null` branch means that track has no release. Runtime create/update commands,
release-test fixtures and repository branch filters use this declaration.
Changing it does not rename a branch or change an assistant's deployed commit.

```sh
# Read-only lookup; prints just the backing branch for use in shell commands.
DOGFOOD_BRANCH="$(pnpm --silent run release-tracks:branch dogfood)" || exit
git fetch origin "$DOGFOOD_BRANCH"

# After editing the declaration, update generated CI/CodeRabbit filters.
pnpm run release-tracks:generate
pnpm run release-tracks:check
```

Use the resolved branch as the explicit base for dogfood PRs. The generator
changes only marked filter sections; public `main` retains CI/review coverage
while `prod` has no release. CI checks for drift without rewriting files.

### Assistant lifecycle commands

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

## Web alias

```sh
gws-ea alias --id 01234567-89ab-4def-8123-456789abcdef
```

An assistant may have one web alias: its email for actions on the web in its own
name, guest bookings and checkouts for the principal included, and one of its
mail-routing addresses. Setup offers it independently of browser availability.
Public browsing works without it; an action that would disclose the assistant's
address stops with `alias_unavailable` until it is configured.

The default alias is the assistant's name, lowercased, in ASCII, without spaces,
and reversed (`Juno` gives `onuj`). A name that reads the same reversed moves
its first letter to the end (`Anna` gives `nnaa`). Role addresses such as
`admin` or `postmaster` are never offered; later candidates are numbered.

`alias --id`, or optional alias setup during create/resume, shows the candidate
and where to add it: the assistant's account in Google Admin (Directory > Users),
then User information > Alternate email addresses. The candidate is claimed on
this machine first. Confirm that you added that exact address; if it is taken,
choose the next candidate or a name of your own. No test email is sent.

The command pauses with its next action when confirmation is still needed.
These flags work with `alias --id` and create/resume:

- `--alias-added`: confirm that you added the proposed alias.
- `--alias-taken`: offer the next candidate when the name is already in use.
- `--alias <name>`: propose your own name or whole address; combine with
  `--alias-added` when you have already added it.

`--skip-alias` belongs to create/resume. An unrequested alias is informational;
an outstanding candidate is pending and needs confirmation. A recorded alias
is configured and is not changed by these flags. Gws-ea does not test delivery;
Google can take up to 24 hours to apply a new alias. Start a stopped assistant
before recording its profile identity.

## Browser access

Browsing is built in. Gws-ea detects Google Chrome at
`/Applications/Google Chrome.app`; it never installs a browser and supports no
custom browser path. Missing Chrome refuses a new delegation with a reason and
asks the principal to contact their operator. It does not remove destinations
or cancel existing errands merely because the binary is missing. A launch
failure ends the affected work through the unavailable path.

Main always delegates browser errands. Sealed browser, external-email and
external-chat groups never do. Other groups, including active job agents, need
`browser-delegate` explicitly selected in their stored agent capabilities;
`all` does not grant it. Use the existing capability permission and approval
flow. A permitted group shares the assistant's signed-in browser profile and
saved logins; purchase, consent and watch approvals still go to the principal,
and its errands, cards and notices stay its own. Revoking its permission
cancels its errands.

Updating an existing assistant makes built-in browsing available when Chrome is
present. Retired version-2 access lists no longer grant delegation: select
`browser-delegate` for other groups that should retain access. Retired local
policy records are left untouched for rollback.

### Saved logins

Saved logins are built in and need no setup or outside account. Each assistant
keeps `browser/logins.db` under its instance root, outside NanoClaw update
snapshots and container mounts. Passwords, including generated passwords for
unsettled attempts, are encrypted with AES-256-GCM under a random per-assistant
key in the macOS Keychain. The directory is owner-only (0700), and the file is
owner-only (0600). Website, username and label remain readable so listing and
removing logins work when the key cannot be read. Plaintext passwords exist in
host memory when generated, saved, filled or revealed, and in the principal’s
browser during a requested reveal. Agents receive only opaque handles and
outcomes.

Any process running as the same macOS user can read the key through
`/usr/bin/security`. Encryption protects a copied store file; it does not protect
passwords from another process running as that user. NanoClaw provides no backup
or export of logins and stores no one-time codes. Email-code sign-in is unchanged.
Updates and rollbacks preserve saved logins, account ownership and unsettled
attempts together in the store file. Releases that predate the built-in store
cannot read it.

The assistant saves generated passwords before submitting a signup or password
change. An account belongs to the assistant when its username is any spelling of
its web alias, or a non-email username from a completed signup on that site. Who
added or edited the login does not decide ownership. Other logins belong to the
principal. The assistant changes only its own accounts' passwords; the principal
changes their own password on the site, then updates the saved login. Sign-in
email, phone, two-factor and payment-method changes remain refused.

A confirmed change replaces the saved password and erases the old password from
the store's contents. Filesystem remnants in freed blocks are not erased. An
unsettled attempt keeps its generated password until confirmed, rejected or
released. Releasing it discards that password and preserves the previous saved
login; if the site took it, the assistant can reset it through its own email.
The persistent browser profile keeps every sign-in, including the principal's
accounts.

Main sends the principal their private `https://<assistant-host>/logins` link
when a login is missing or they ask. Cloudflare Access admits the principal and
invited artifact readers; the host permits `/logins` only for the principal's
currently confirmed addresses. They can add or remove logins and edit the
account label, website, username or saved password for either account owner.
Logins are grouped by website and can be searched by site, label or username.
On a login’s details page, Show password fetches only its saved password after
an explicit click, using the current principal Access session. Hide clears it
from the page; it also hides after 30 seconds, when the tab is hidden, or on
navigation. This does not erase browser developer tools or network history.
Pending generated passwords are never revealed. The managed assistant browser
is blocked from every assistant’s saved-logins page and endpoints, even if it
has the principal’s cookies. Each login also has an edit form; a blank
replacement password keeps the current one. An older form cannot overwrite newer saved details. Editing this page changes the saved login, not
the account on the website. A saved change is ready for the next errand. Passwords
are entered on the page, never sent through chat.

An unsent password change gives way to a page edit or removal. Once its password
may have reached the site, the page answers `login_busy` until the attempt is
settled or released. When web setup is missing, main tells the principal to ask
their operator; when installed web is temporarily unavailable, to try again later.

The key is read fresh at each use and is never automatically replaced while any
saved or pending password remains. When it is missing, different or unavailable,
filling, generating, saving and revealing answer `vault_unavailable`: ask the operator.
Listing and removing logins, and settling or releasing attempts, still work.
`gws-ea status --details` reports the running host's login-store state:
`key_missing`, `key_mismatch` or `keychain_unavailable`, with an operator action.
It never reads the key from the CLI; a stopped assistant reports not checked.
Log in at the Mac and unlock its keychain, or have the principal remove unreadable
logins on the page. Once no saved or pending passwords remain, adding a login
can create a key. Removing an assistant deletes its Keychain key after stopping
the host; an unreachable key is reported as left behind without failing removal.

Saved-login sign-in follows the page's current controls, including JavaScript
forms and pages without a form element. When email and password appear together,
the host fills both before activating the sign-in control. When they appear on
separate pages, browser supplies fresh references for each step using the same
saved-login handle. Sign-in does not depend on a catalog of website login URLs.
The host keeps the values out of agent observations, checks the selected HTTPS
frame and form destination, and reclassifies the control before activation.
It cancels native GET submissions and guards navigation addresses while the
sign-in action runs. The intended site's JavaScript receives the filled values.

Email-code and magic-link sign-in uses the existing site-bound mailbox wait.
Codes sent to the principal can be relayed through main; browser receives only
the outcome. Authenticator codes can use the same relay. Push approvals and
security keys need the principal. CAPTCHA and access-denied pages are reported
as `challenge`; there is no remote browser takeover page or automatic CAPTCHA
solver. Completing a challenge in another browser does not sign this browser in.

### Browser diagnosis and release acceptance

`gws-ea status --id <full-id> --details` checks the selected managed
assistant's browser network isolation without starting Chrome. It reports
proxy and debugger isolation
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

Chrome starts on demand for an errand or a due watch check. When a browser
container stops, the host releases its pages after outstanding browser operations
settle. A checkout awaiting approval or an authorized commit keeps its page until
that work settles. Other running browser containers retain their own pages.
Watches keep their schedules in the database and open temporary pages for each
check; waiting for the next check keeps no browser process alive. Chrome closes
30 seconds after its last page and operation are released, preserving the profile
and saved sign-ins. A disconnect interrupts affected operations; the next request
can launch Chrome again without replaying an interrupted action.

Host shutdown refuses new browser work and retires Chrome and its owned helper
processes before reporting success. Startup retires verified leftovers for this
assistant's private profile, refusing processes owned by another live host. Failed
cleanup reports an incomplete shutdown so a managed update still refuses an
unsafe cutover.

Recipe recording and site metadata are optional;
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
