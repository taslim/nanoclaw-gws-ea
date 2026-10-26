# Host browser live checks

`index.ts` runs account-free local probes with a throwaway Chrome profile and a
deny-all proxy. It uses production `prepareChromeProfile`, `spawnChrome`,
`connectChrome`, `createBackgroundPage` and `verifyChromePolicy`; it owns only its
disposable profile and refusing proxy. No flag variants or alternative launcher
are used.

`acceptance.ts` records the end-to-end U14 checks against a **merged, deployed
dogfood assistant on the Mac, with its owner present**. Run the acceptance commands
only after that deployment. Never start the operator checkout's service to run
these checks.

The acceptance harness sends no errands, fills no credentials, grants no
permissions, approves no cards, restarts no services and runs no `gws-ea`
command. The owner uses their normal channel. The harness reads the deployed host's existing, owner-only
`ncl.sock` and independently checks the supplied verification artifacts. Any real
booking or purchase still needs its normal explicit principal authority.

## Local transport and isolation checks

```sh
GWS_EA_BROWSER_TEST_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  pnpm exec vitest run scripts/browser-live-check/probes.test.ts
pnpm exec tsx scripts/browser-live-check/index.ts
```

The native harness smoke verifies an actual nonzero listener owned by its Chrome
child and bound to literal `127.0.0.1`, native input, the present-but-denied
Notifications API, and process/listener/profile cleanup. The local Mac command
records policy admission, API behavior, background rendering/input and passive
desktop samples in a new owner-only evidence run. A locked desktop cannot prove
active operator focus or clipboard continuity. Minimized screenshot timeout is
reported as `not-run`, even when minimized input works; minimized operation stays
optional. Neither command uses a personal profile or reads clipboard contents.

The transport is native Playwright attachment to the ownership-verified loopback
CDP listener of the Chrome child production launched. Only its integer debugger
port may appear in host evidence; endpoint URLs, WebSocket paths and browser IDs
stay private. This is accessible to trusted host processes and, through host
forwarding, ordinary Docker bridge containers. It provides no pipe exclusivity.

`gws-ea connectors check browser --id <full-id>` separately checks the proxy
and active debugger through the managed assistant network's existing host-gateway
route, without launching Chrome. Stopped Chrome reports debugger `not_run`;
starting, missing, invalid, changed or unobservable active targets prevent a ready
result. This named-route observation does not repeat the recorded multi-route
and gateway audit. Stop adoption if the managed network can reach the debugger.

`publicSiteProbes` requires the production public-only filtering proxy supplied
to `launchProbeBrowser`. It runs only anonymous GET document navigation under the
production navigation guard, leased to each tested registrable site in this
single-owner disposable harness; it uses no job DB or account state. Its bounded
request facts omit raw native errors, page text, snapshots and redirect URLs.
A 403 or challenge fails page-load acceptance. The search probes do not establish sign-in, reservation or payment
success; record the exact previously failing OpenTable route twice on fresh
profiles separately, with Resy/Tock as controls.

## Refactor verification boundaries

The concrete runtime and security fixtures use the pinned Playwright 1.64.0 and
`GWS_EA_BROWSER_TEST_CHROME` pointing to the actual supported Chrome binary.
Run named focused suites during implementation, then the integrated full host
suite with Chrome configured. A suite skipped because that variable is absent
proves nothing about native operation. Keep fixture correctness separate from
the managed acceptance run below.

A navigation onto a denial remains `challenge`; its evidence can report the
observed status and any correlated local refusal without assigning an unobserved
bot-detection cause. Record the original OpenTable reservation route, Resy and
Tock independently on the same authorized release and account state. An
OpenTable denial leaves the booking unresolved even when fixture recovery passes.

A local temporary-profile rendering probe can verify screenshot content and
native input without a live account. It cannot prove active operator focus when
the sampler observes the login window, or prove Spaces through AppKit. Minimized
rendering remains a separate optional claim: on the October 20 U6 probe, native
input worked while minimized but screenshot capture timed out even with the old
screenshot feature override. Do not turn that limitation into a pass.

Code-only rollback keeps live DB/profile/authority records. An old binary cannot
safely save a newly affected recording whose optional trace reservation failed;
repair recording storage forward. Do not use a state snapshot to erase uncertain
external actions taken after startup but before health verification.

## Start an evidence run

Use the deployed merged commit SHA, an absolute evidence directory, and the
**deployed assistant's** socket. The socket is its `<checkout>/data/ncl.sock`;
`gws-ea connectors check browser --id <full-id>` identifies/checks the selected
assistant. Do not use `data/ncl.sock` from this operator checkout.

```sh
pnpm exec tsx scripts/browser-live-check/acceptance.ts begin \
  --output-root /absolute/path/to/docs/rebuild/evidence \
  --name 2026-10-20-host-browser \
  --deployment <deployed-40-character-merged-commit-SHA>
```

The command prints the run directory. It creates it with mode `0700`; evidence
files use `0600`. Every scenario and timing group starts as `not-run`. Existing
runs and completed records are never overwritten.

In another terminal, start passive desktop sampling **before** the first errand,
and leave it running until all verification is finished:

```sh
pnpm exec tsx scripts/browser-live-check/acceptance.ts observe \
  --run /absolute/path/to/evidence/run
```

Stop sampling with Ctrl-C. Observations stream to `desktop.ndjson`, so a multi-day
run does not retain its samples in memory. The sampler reads only the frontmost
application identifier and clipboard change counter, never clipboard contents.
The operator should type in one chosen foreground app during a measured check;
an intentional app switch is recorded as a change too. Test background windows,
navigation, dialogs, downloads, popups, clipboard attempts and external app links.
AppKit cannot passively identify the active Space: record the operator's separate
`quiet_spaces` observation. Locked-desktop observations cannot prove active use.
Every measured errand needs monotonic samples from before its start through its
verification, with no gap over 6.5 seconds (the five-second desktop read timeout
plus two sampling intervals). Stopping and restarting observation around an
errand leaves it `not-run`; gaps between measured errands do not invalidate their
coverage. An observed focus or clipboard change still fails quiet acceptance.

## Time a real errand

For each of `booking`, `form`, `invoice`, and `compare-buy`, run at least **five
fresh cold errands and five fresh recipe errands**. Use the same task/bounds for
both modes. Every sample needs a new delegated errand so its history starts after
the sample timestamp. Recipe samples must actually call native `run_recipe`;
cold samples must not. Saving a recipe after a cold run is allowed.

Start timing immediately before asking the assistant through its normal channel:

```sh
pnpm exec tsx scripts/browser-live-check/acceptance.ts start \
  --run /absolute/path/to/evidence/run --errand booking --mode cold
```

Keep the printed sample UUID. Ask for the OpenTable booking on an assistant-owned
account, a multi-page form, an invoice download, or compare-and-buy **stopped at
the card**. The real retailer case ends with the card unapproved. A real commit
is a separate owner-authorized check, never part of a dry run.

For an invoice, `start` additionally requires `--expected-sha256 <sha256>` from an
independently obtained copy/reference of that invoice, known before the errand.
Do not derive the expected hash from the assistant's output being tested.

Inspect the actual system of record independently: reservation confirmation and
venue/party/slot, submitted form record and values, original invoice, or the
principal's purchase card and its complete financial terms. Write a private JSON
receipt containing the facts expected and the facts observed. Both objects must
be nonempty and exactly match for verification to succeed:

```json
{
  "schemaVersion": 1,
  "source": {
    "system": "Restaurant reservation record, independently opened by the owner",
    "reference": "Actual confirmation reference"
  },
  "checkedAt": "2026-10-20T10:05:00.000Z",
  "expected": { "venue": "Bistro", "party": 4, "slot": "2026-10-23T19:30:00-07:00" },
  "observed": { "venue": "Bistro", "party": 4, "slot": "2026-10-23T19:30:00-07:00" }
}
```

Use actual facts and the actual UTC verification time. A model's report is not a
system-of-record receipt. These receipts are explicitly **owner verified**; the
harness hashes their exact bytes for provenance and does not claim to have
independently visited their source. For a failed result, preserve the mismatching
observed facts instead of replacing them with the expected values.

Capture the existing browser thread ID returned through native delegation. The
operator can inspect the browser group's active sessions with the deployed
`ncl sessions list --json`; no additional chat or browser access is introduced.

```sh
pnpm exec tsx scripts/browser-live-check/acceptance.ts capture \
  --run /absolute/path/to/evidence/run --sample <sample-UUID> \
  --socket /absolute/path/to/deployed-checkout/data/ncl.sock \
  --job <returned-browser-thread> --receipt /private/path/to/receipt.json \
  --reported-success true
```

Set `--reported-success` from what the assistant actually reported, even when the
independent verification disagrees. For `invoice`, also pass `--artifact
/absolute/path/to/invoice.pdf`, using the handed-off filename. The harness checks
that native durable handoff metadata has that filename/byte count and that the
actual file matches the predeclared hash. For `compare-buy`, it also requires an
open native purchase card, zero commit markers, zero committed attempts and zero
unresolved attempts. Its receipt must verify item/quantity/price/card/address,
current and future charges, delivery bounds, cancellation/recurrence terms and
the exact commit label.

Captures copy metadata only: no mailbox content, browser request payload, page
URL, cookie or credential. Missing/ambiguous native timestamps remain unavailable;
the harness never estimates them as successful measurements.

## Record the acceptance scenarios

Use one separate owner-verified receipt per scenario, with concrete `expected`
and `observed` facts. Name the actual source (website record, principal card,
container probe output, platform observation, or operator Space observation) and
its reference. Preserve the receipt and associated private source artifacts.

| Scenario name                  | What its receipt must establish                                                                                                                                                                                                                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `delegation_own_job`           | New errand has a distinct session; its follow-up reaches it; missing thread is refused.                                                                                                                                                                                                                                                        |
| `different_sites_parallel`     | Different sites have distinct sessions and execute concurrently.                                                                                                                                                                                                                                                                               |
| `same_site_serialized`         | A second job waits while the first owns that site, including a pending purchase card.                                                                                                                                                                                                                                                          |
| `restart_before_commit`        | Mid-batch restart answers once with `interrupted`; a fresh safe request continues; no automatic replay.                                                                                                                                                                                                                                        |
| `restart_after_commit`         | A restart after the commit marker answers `unconfirmed` and retries nothing. Browsing the site goes on; the next purchase there answers `waiting_on_earlier` until main records the outcome with `record_purchase_outcome`, from the merchant's order email or the principal's answer.                                                         |
| `email_code_sign_in`           | Code/link sign-in uses an isolated external-email system task, with no ordinary email thread or wake to main.                                                                                                                                                                                                                                  |
| `vault_secret_confinement`     | Dedicated-vault fill succeeds, wrong/full-frame origins are refused, filled documents cannot be screenshotted and no agent output contains the canary.                                                                                                                                                                                         |
| `purchase_card_revalidation`   | Complete terms; higher totals/material changes withdraw the old card; an unchanged lower total inside approved bounds may proceed once. Use owned fixtures or explicit real authority for commits.                                                                                                                                             |
| `open_browsing_unreviewed`     | On a site with no reviewed reader, navigation, search, filters and form fills run without a refusal; only a commit-class control is refused, as `purchase_control`, `speaks_as_principal` or `account_security`.                                                                                                                               |
| `unreviewed_checkout_card`     | One unreviewed checkout, through a payment platform's redirect, reaches a card with the site, the platform, the account or guest checkout, the quoted items, total, due now, payment method, contact email and any note, and a clipped picture of the total and the commit control. The card stays unapproved and no card details are entered. |
| `free_booking`                 | One free booking or waitlist on an unreviewed site is pressed by the host with no card, answers `booked`, and matches the venue's own confirmation.                                                                                                                                                                                            |
| `consent_form`                 | One real form with optional marketing and terms boxes: the host ticks only the site's own terms and unticks the marketing box; a required opt-in or bundled box stops with `consent_required` and reaches the principal as a card quoting the exact wording.                                                                                   |
| `cookie_banner`                | One real cookie banner: the host rejects it before the agent's observation (`rejected`), or reports it and the agent picks the least-sharing choice that lets it continue.                                                                                                                                                                     |
| `alias_admin_console`          | The operator adds the assistant's alias in the real Workspace Admin console from gws-ea's instructions; the probe email verifies it and gws-ea records it; a site form then gets the alias, never the primary address.                                                                                                                         |
| `standing_guarantee`           | No default grant; separately confirmed total conditional-fee bound applies per reservation/whole party only; prepayment/deposit/hold/trial/subscription needs separate authority.                                                                                                                                                              |
| `clipboard_and_external_links` | Clipboard is unchanged and external apps do not open.                                                                                                                                                                                                                                                                                          |
| `cross_install_isolation`      | An actual agent-network container in another install cannot reach the assistant Chrome; include the attempted destinations and probe result.                                                                                                                                                                                                   |
| `quiet_spaces`                 | Owner observes no unwanted Space switch throughout the active-desktop checks.                                                                                                                                                                                                                                                                  |
| `public_only_egress`           | Loopback, link-local, LAN, rebinding, QUIC and non-proxied WebRTC attempts are refused; include live proxy probe evidence.                                                                                                                                                                                                                     |
| `watch_soak`                   | At least 72 actual hours of native checks, no site block/account warning, and the watch stayed within the site's policy. See below.                                                                                                                                                                                                            |
| `onepassword_provisioning`     | Enabling covers two assistants, one stopped, with distinct vaults and runtime service accounts (a management-created vault, an operator-minted account, recorded grants); a rerun creates none; a later `create` provisions a third; no browser or Chrome starts.                                                                              |
| `onepassword_sharing`          | A confirmed member principal gets view and edit on only their assistant's vault, and its link opens their account, where the named vault is listed. A non-member or new guest gets the forwardable message, with no invitation promise, CLI terms or request to enable anything; a re-ask after the operator acts answers `shared`.            |
| `onepassword_signup`           | An authorized signup saves the generated password before the site sees it. A host restart during its input callback recovers the same saved candidate: one account, one Login, no second submission.                                                                                                                                           |
| `onepassword_owned_change`     | A change on an unedited assistant-created Login reaches the site once. Confirmed, the Login holds the new password with the principal's other edits, and no candidate or previous password remains; timed out, 1Password keeps both. No tool output or screenshot holds either.                                                                |
| `onepassword_change_refused`   | A change on a Login the principal added, and on an assistant-created Login whose username the principal edited, is refused before any page insertion with a plain explanation.                                                                                                                                                                 |
| `onepassword_fresh_login`      | A Login the principal adds in 1Password is used on their explicit retry, while the browser still cannot read its password.                                                                                                                                                                                                                     |
| `onepassword_disable_reenable` | Disable stops vault use on running and restarted hosts and deletes runtime tokens, keeping vault items; re-enable reuses each vault, mints new runtime accounts and names the old ones to revoke.                                                                                                                                              |
| `onepassword_scoped_removal`   | Removing one assistant deletes its token and only its own previewed vault, leaves the peer and the management account working, and keeps a receipt naming each service account to revoke on 1Password.com.                                                                                                                                     |
| `onepassword_pooled_quota`     | `check` shows the account type, daily limit, usage and every sharing assistant. With the limit nearly spent by the peer, a fill returns `rate_limited` without a retry burst. Record each operation's request cost.                                                                                                                            |

```sh
pnpm exec tsx scripts/browser-live-check/acceptance.ts scenario \
  --run /absolute/path/to/evidence/run --name cross_install_isolation \
  --receipt /private/path/to/container-probe-receipt.json
```

The source hash establishes which owner receipt was used. It does not turn an
operator assertion into an automated browser/system-of-record proof. Missing
checks stay `not-run`; a receipt with differing expected/observed facts fails.
Keep real fixtures or records for native assertions in the source artifacts.

Record `vault_secret_confinement` and the `onepassword_*` scenarios on two
disposable dogfood assistants, in a 1Password account the operator authorized
for disposable resources; no principal account or Login is a test fixture. The
operator runs `gws-ea connectors enable|check|disable onepassword` and
`gws-ea remove` themselves. Receipts cite resource IDs from
`gws-ea connectors show onepassword --json` and the 1Password.com vault,
access and service-account pages, never a password or token. A request cost is
the account usage `check` reports before and after the operation, less the
cost of a `check` itself.

## Secret canary scan

Vault and long-lived credential canaries must stay absent from all agent contexts.
For 1Password runs they include each password saved or generated in the test
vaults and every service-account token; scan host DBs, logs and retained
evidence as well as agent output, never the token files themselves.
Temporary email sign-in credentials intentionally enter the isolated external-email
system task; scan for those only in main/browser output and operator logs.

Store dedicated test secrets in a local `0600` JSON array and a JSON array of
agent-output/log file paths in another file. Supply paths, never secret values in
arguments or environment variables. The canary file is read locally and is never
copied into the evidence. Do not include it in the list of outputs to scan.

```sh
pnpm exec tsx scripts/browser-live-check/acceptance.ts scan \
  --run /absolute/path/to/evidence/run --canaries /private/path/to/canaries.json \
  --files /private/path/to/output-file-list.json
```

The scanner checks literal, URL-encoded, JSON-escaped and base64 representations,
including across read-buffer boundaries. It reports only scanned-file/matching-file
counts and status, never the values. A final pass needs a nonempty passing scan;
any recorded leak fails the run even if a later scan is clean. This byte scan
complements native screenshot refusal and full-frame checks; it does not inspect
image pixels or prove arbitrary encodings cannot exist.

## Multi-day watch soak

After the owner approves an actual watch with the intended bounds, collect its
native checks for at least 72 hours. Leave desktop observation running too:

```sh
pnpm exec tsx scripts/browser-live-check/acceptance.ts soak \
  --run /absolute/path/to/evidence/run \
  --socket /absolute/path/to/deployed-checkout/data/ncl.sock \
  --job <watch-browser-thread> --hours 72
```

The command samples the host once per minute, writing metadata to `soak.ndjson`.
It does not trigger checks or change the site's budget. Ctrl-C saves an incomplete
run. Connection failure preserves the journal; rerun in a fresh evidence run
rather than treating missing observations as a clean soak. A saved soak alone
never passes: it needs completed native checks, at least 72 elapsed hours, no
blocked/failed/interrupted check, continuous host observations (no gap above two
minutes), and schedule coverage from the initial native watch due time through
the end (with a five-minute scheduler allowance). Native quiet-hour and budget
reschedules count only when observed before that allowance expires; a late
reschedule cannot erase an outage. Missing coverage remains `not-run`,
including two isolated checks separated by three days. It also needs an
independently checked `watch_soak` receipt
after the soak with matching facts including:

```json
{ "noSiteBlock": true, "noAccountWarning": true, "watchActiveThroughout": true, "withinSitePolicy": true }
```

Record that receipt with the `scenario` command. An owner receipt cannot shorten
the measured duration or erase native failures. Account warning/politeness checks
remain explicitly owner verified because the metadata endpoint exposes no raw
site pages, mail or account contents.

## Summarize

After stopping desktop observation, record all receipts and run:

```sh
pnpm exec tsx scripts/browser-live-check/acceptance.ts summarize \
  --run /absolute/path/to/evidence/run
```

A new private summary is written each time. A pass requires every scenario,
a nonempty clean canary scan, observation coverage for every measured errand,
and five measured cold plus five measured recipe runs per errand with replay
p50 below cold p50 and no incorrect success claim. Otherwise it exits nonzero and
reports `not-run` or `failed`, preserving all underlying evidence.

The summary reports verified and self-reported success rates and nearest-rank
p50/p90 in milliseconds for total, transport, browser, verification, and
**model-and-orchestration residual**. Native request timestamps split emission,
acceptance, queue start, answer and delivery. The residual includes model turns,
uninstrumented orchestration/delegation and gaps between requests; it is not an
inference-time measurement. Verification starts at the authored timestamp of the
latest already-delivered report, and ends at the independent receipt's check time.
Missing/inconsistent timestamps produce no phase percentiles for that sample and
cannot satisfy the five-measured-runs gate. Preserve the raw captures so timing
attribution can be audited.
