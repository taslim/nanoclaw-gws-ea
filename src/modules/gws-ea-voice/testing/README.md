# Private voice acceptance

The comparison CLI calls the production decoder and recognizer with externally
installed, verified base, small, and turbo candidates. It sends no messages,
starts no assistant, changes no host policy, and downloads nothing. Recognition
evidence alone cannot qualify a model or the voice job. Live Google Chat,
receiving-agent intention/action evidence, and model qualification remain
pending by user direction.

## Compare the same recordings

Keep the manifest, human recordings, transcripts, and results in a private
directory outside the checkout and the shared voice cache. Do not commit them.
Record real short instructions, a complete multi-minute rambling note, mixed
language, explicit corrections, negations, dates, numbers, and a silence sample.
Write expected requests, dependencies, recipients, final corrections, and
forbidden actions before running a candidate. TTS, stitched snippets, public
speech samples, and mocked subprocesses do not qualify principal-note quality.

Provision comparison assets explicitly while voice is disabled; the ordinary
installer retains verified model installations when another model is selected.
Do not remove or replace installations during comparison. Use the canonical
installation directories in the receipts. A private manifest has this shape:

```json
{
  "schemaVersion": 1,
  "repetitions": 3,
  "installations": {
    "base": "/private/voice-assets/base-installation",
    "small": "/private/voice-assets/small-installation",
    "large-v3-turbo-q5_0": "/private/voice-assets/turbo-installation"
  },
  "notes": [
    {
      "id": "date-correction",
      "audioFile": "/private/voice-acceptance/human-note.m4a",
      "expectedIntent": "Friday replaces Thursday. Wait for Sarah's confirmation; do not book before it. No question about which day."
    }
  ]
}
```

From the authoring checkout, run the isolated comparison:

```sh
pnpm exec node --import tsx src/modules/gws-ea-voice/testing/compare.ts \
  --manifest /private/voice-acceptance/notes.json \
  --output /private/voice-acceptance/new-results
```

The output directory must not exist; its parent must exist. The CLI creates a
private directory and a private `comparison.json`, refuses checkout/shared
installation output, and removes recognition temporary files. It reads each
original once per comparison and feeds those same bytes to every candidate and
repetition. Source hashes, byte counts, host facts, exact asset receipts,
faithful speech, terminal failures, and expected intentions remain in the
report. A failure records its whole-note outcome and continues the other
candidates. Ctrl-C terminates recognition through the production cancellation
path; an interrupted run has no completed report.

`wallMs` measures the complete `transcribeAudio` call: private staging, decoding,
recognition, validation, and cleanup. It excludes asset verification, reading
the original, platform media hydration, router queueing, and the receiving
agent's turn. It is not separate decode or inference time, child peak RSS, or
principal response latency. These remain explicit pending evidence. Exit zero
means the comparison completed without a recorded recognition failure; every
report still says `qualification: "pending"`.

## Complete the live gate

Use disposable, authenticated Google Chat principals and assistants on the
actual supported receiving provider. Leave the live Soji install untouched.
Record the source message ID, caption, transport sender, provenance, original
audio hash and measured duration, model/receipt, host hardware, ordinary
response, actual tool calls/results, durable work records, and verified side
effects for each run. Reset disposable work targets between runs; retries of
the same source message test deduplication, while quality repetitions use fresh
message IDs. Evaluate at least three repetitions of each intended-job case for
each candidate against the human expectations established before the run.

| Case                               | Observable evidence required                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AE1: brief instruction             | Resolve a plausible person-name misrecognition using permitted context, perform the intended job, and reply normally. No extra recipient or action.                                                                                                                                                                                     |
| AE2: long rambling note            | Complete a multi-minute note containing three jobs, a corrected date, and a digression. Verify all three durable outcomes; abandoned date and digression cause no side effect. Include mixed language, numbers, and negation.                                                                                                           |
| AE3: conditional correction        | Friday definitively replaces Thursday. Track Sarah's confirmation as the execution dependency. Deliver that confirmation through ordinary input and verify the Friday move exactly once.                                                                                                                                                |
| AE4: cancellation/order            | Delay actual media hydration and recognition, then send cancellation in the same conversation. Observe note-before-cancellation, cancel still-unperformed work, and verify unrelated conversations continue. Distinguish work already completed and verified.                                                                           |
| AE5: forwarded/quoted source       | Forward an imperative recording with a summary request. Summarize without executing the recording. Check source status remains informational in history, echo, and backfill. Ordinary reply quotes do not relabel new direct audio.                                                                                                     |
| AE6: context isolation/corrections | Send a similar reference to main and a restricted conversation. Verify only permitted context is used. Correct a recognized name naturally and verify an existing durable memory correction is reused without a new global vocabulary store.                                                                                            |
| AE7: inability/text                | Exercise disabled/unhealthy voice, decode failure, silence, and complete-note bounds. Verify honest ordinary inability, no claimed action or accepted transcript prefix, and subsequent working text.                                                                                                                                   |
| AE8: host lifecycle                | Prove base setup/update download no voice assets. One installation/enablement serves two compatible assistants, later creates, and supported updates. Unsupported release retains text. Record private media separation, unchanged peers/policy after removal or rollback of one assistant, host-wide disablement, and drained removal. |
| AE9: prerequisite experience       | Before setup and while disabled, a real note gets the ordinary operator-enablement explanation without an installation card, technical choice, or download. A subsequent note after operator enablement works quietly without principal approval. Earlier unprocessed notes are not automatically resumed.                              |

Also exercise authenticated Google Chat redelivery during preparation, a
persisted incomplete SDK claim after host death, source retry and partial
fan-out, and restart after insertion. Inspect one ordinary mailbox turn and
one verified effect; do not infer recovery from a transcript alone. The
existing SDK completion and non-mailbox interceptor effect are not atomic:
hard death between the effect and its completion mark can repeat that effect.
Also fail routing after a partial fan-out, send cancellation, and then retry
the note. The native failure path releases the conversation queue, so a target
that missed the original note can receive cancellation before redelivery.
Record that distinction from successful preparation ordering. This slice adds
no stronger ingress guarantee.

Measure actual source duration, media hydration, queue wait, separate decode
and inference time, child peak RSS, and whole ordinary response latency with
supported-host process/channel observations. Record instrumentation and
measurement boundaries; do not relabel CLI wall time or host-process RSS as
these missing measurements. Establish a conversational latency budget from
the measurements before accepting a candidate. Keep resource failures and
timeouts as failures, not successful long-note cases.

Choose the smallest candidate that meets that latency budget and has zero
critical wrong dates, conditions, negations, numbers, recipients, lost requests,
or extra side effects across the repeated cases. Record human review plus
actual tool-side verification. The initial turbo installer candidate stays
unqualified until these gates pass. WhatsApp and additional providers/channels
are outside this acceptance slice.
