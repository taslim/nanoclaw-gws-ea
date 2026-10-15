# Host browser live checks

`index.ts` preserves the account-free U1 probes with a throwaway Chrome profile.
`acceptance.ts` records the end-to-end U14 checks against a **merged, deployed
dogfood assistant on the Mac, with its owner present**. Run the acceptance commands
only after that deployment. Never start the operator checkout's service to run
these checks.

The acceptance harness sends no errands, fills no credentials, grants no
permissions, approves no cards and restarts no services. The owner uses their
normal channel. The harness reads the deployed host's existing, owner-only
`ncl.sock` and independently checks the supplied verification artifacts. Any real
booking or purchase still needs its normal explicit principal authority.

## Start an evidence run

Use the deployed merged commit SHA, an absolute evidence directory, and the
**deployed assistant's** socket. The socket is its `<checkout>/data/ncl.sock`;
`gws-ea capabilities check browser --id <full-id>` identifies/checks the selected
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

| Scenario name                  | What its receipt must establish                                                                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `delegation_own_job`           | New errand has a distinct session; its follow-up reaches it; missing thread is refused.                                                                                                            |
| `different_sites_parallel`     | Different sites have distinct sessions and execute concurrently.                                                                                                                                   |
| `same_site_serialized`         | A second job waits while the first owns that site, including a pending purchase card.                                                                                                              |
| `restart_before_commit`        | Mid-batch restart answers once with `interrupted`; a fresh safe request continues; no automatic replay.                                                                                            |
| `restart_after_commit`         | A marked purchase answers `outcome_unknown`, remains site-blocked across jobs/accounts and does not automatically retry. Reconciliation or an informed one-attempt approval is required.           |
| `email_code_sign_in`           | Code/link sign-in succeeds without an external-email thread or a wake to main.                                                                                                                     |
| `vault_secret_confinement`     | Dedicated-vault fill succeeds, wrong/full-frame origins are refused, filled documents cannot be screenshotted and no agent output contains the canary.                                             |
| `purchase_card_revalidation`   | Complete terms; higher totals/material changes withdraw the old card; an unchanged lower total inside approved bounds may proceed once. Use owned fixtures or explicit real authority for commits. |
| `unsupported_purchase`         | Unsupported/drifted/no-visible-price flows refuse commits across generic activation and recipe/watch paths.                                                                                        |
| `standing_guarantee`           | No default grant; separately confirmed total conditional-fee bound applies per reservation/whole party only; prepayment/deposit/hold/trial/subscription needs separate authority.                  |
| `clipboard_and_external_links` | Clipboard is unchanged and external apps do not open.                                                                                                                                              |
| `cross_install_isolation`      | An actual agent-network container in another install cannot reach the assistant Chrome; include the attempted destinations and probe result.                                                       |
| `quiet_spaces`                 | Owner observes no unwanted Space switch throughout the active-desktop checks.                                                                                                                      |
| `public_only_egress`           | Loopback, link-local, LAN, rebinding, QUIC and non-proxied WebRTC attempts are refused; include live proxy probe evidence.                                                                         |
| `watch_soak`                   | At least 72 actual hours of native checks, no site block/account warning, and the watch stayed within the site's policy. See below.                                                                |

```sh
pnpm exec tsx scripts/browser-live-check/acceptance.ts scenario \
  --run /absolute/path/to/evidence/run --name cross_install_isolation \
  --receipt /private/path/to/container-probe-receipt.json
```

The source hash establishes which owner receipt was used. It does not turn an
operator assertion into an automated browser/system-of-record proof. Missing
checks stay `not-run`; a receipt with differing expected/observed facts fails.
Keep real fixtures or records for native assertions in the source artifacts.

## Secret canary scan

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
