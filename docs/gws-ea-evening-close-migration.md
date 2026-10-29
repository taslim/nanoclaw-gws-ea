# Evening-close migration

This release replaces the daily sync with an evening close and a held morning.

## Detect

The earlier release keeps a `gws-ea-daily-sync` task series whose script calls
`ncl matters sync`. The replacement task is named `gws-ea close`; its script is
`ncl matters evening --run <run>`. `sync` is no longer a registered matters verb.

## Why

The host places the close at 21:00 in the principal's current zone. A dedicated
main session runs look-back and look-ahead workers and records a report for main.
Completion requires captured day-ledger coverage and the explicit completion
marker. Task acknowledgment alone cannot advance the ledger. A quiet morning
creates no task; held morning looks share one native task.

## Apply

After release acceptance and deployment authorization, use the normal managed
`gws-ea update --id <assistant-id>` or `gws-ea update --all` from the operator's
tool checkout. Follow its staged migration preview. The host applies additive
module migrations and keeps the new close. A claimed daily-sync occurrence may
finish before the host retires its series.

The host owns close tasks and run IDs. Agent procedures use `ncl matters evening`
and `ncl matters morning`; the close script supplies its run. The close finishes
with `ncl matters evening --done <run> --report <text>`, adding `--notify` only
when the agent judges that main should wake for the report.

Whereabouts, Manual sections and learned travel are not backfilled from guesses.
Existing profile facts retain their authority; missing home/place facts appear
as gaps for main to resolve with the principal.

## Verify

- One next close is pending at the principal-local placement, with no duplicate
  live close for that placement.
- The old daily-sync series is cancelled after any claimed occurrence settles.
- A completed close has captured ledger coverage and one durable report. A
  failed close leaves the previous completed ledger boundary intact.
- A quiet morning has no morning task or container; held looks retain their task.
- Main's front page shows whereabouts gaps, and its coming-days context updates
  after native calendar writes and Manual edits.

The behavioral scenarios and live experience acceptance remain release gates.
Deterministic fixture preparation does not establish either result.

## Rollback

Use `gws-ea rollback --id <assistant-id>` and follow its preview and recorded
continuation. The managed lifecycle determines whether state can be retained or
a snapshot must be restored across the schema change; its preview identifies
discarded and retained data. Verify the serving release's expected task series
after rollback. Restoring code or a snapshot does not undo calendar changes or
messages already delivered; their recorded outcomes remain the basis for any
follow-up decision.
