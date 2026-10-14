# Optional local voice notes

Voice is an operator capability. One installation and one enablement apply to
every compatible assistant on the host, including assistants created or updated
later. There is no assistant voice switch or principal installation approval.
The current receiving channel is Google Chat. The preparation contract and
local engine are independent of channels; future installed channels can supply
the same audio content and source facts.

The principal sends a note and receives the assistant's normal response. The
receiving agent interprets faithful speech with its own permitted context in
its normal turn. Known forwarded or quoted recordings remain source material.
Original recordings stay in the assistant's private session storage. Models
and programs are shared; recordings, temporary files, transcripts, and inference
processes are private to an instance.

## Install and enable

Run these commands from the operator's existing gws-ea checkout:

```sh
gws-ea capabilities list
gws-ea capabilities show voice
gws-ea capabilities install voice
gws-ea capabilities enable voice
gws-ea capabilities check voice
gws-ea status --id <instance_id> --details
```

Use `gws-ea help capabilities` to discover available actions and
`gws-ea help capabilities install` for installation options.

Installation is explicit and leaves voice disabled. Package installation,
container builds, assistant creation, ordinary updates, and incoming notes never
download a recognizer or model. Repeating installation verifies and reuses an
existing installation. A concurrent host voice operation returns busy; retry
after it finishes. Enabling absent or corrupt assets gives the installation or
repair prerequisite and downloads nothing.

The recipe supports macOS and Linux on arm64 or x64. It needs C/C++ compilers,
make, CMake, and tar. macOS builds embed Metal support; Linux builds use the
CPU. Tools must be installed before the recipe runs. If CMake is outside the
operator's PATH, pass `--cmake /absolute/path/to/cmake`.

Preflight names the first failing tool before any download and distinguishes a
missing executable from an installed tool that fails. On macOS, missing CMake
suggests `brew install cmake` when Homebrew is on PATH; compiler failures point
to Apple Command Line Tools. These are instructions only: gws-ea never installs
system tools. Linux guidance identifies Debian/Ubuntu commands as examples for
those distributions, rather than assuming every Linux host uses apt.

An explicit install retains a private run log and step log outside its scratch
build directory. Failures name the download artifact or build stage, expose
bounded redacted subprocess stderr, and report both log paths. Build output and
available configure diagnostics survive scratch cleanup. The JSON envelope
exposes the same recovery through `next_actions` and log paths through
`diagnostics`. Retry commands preserve explicit `--model` and `--cmake` choices.

The pinned recipe builds whisper.cpp 1.9.5 and FFmpeg 8.1, with Silero VAD 6.2.0.
FFmpeg accepts local media files and has network protocols disabled. Program
paths are absolute in the receipt and do not depend on an interactive Homebrew
PATH at service runtime. Source, build, model, and license provenance stay with
the installation. Download checksums and model sizes are checked before
publication; interrupted or failed builds publish no installation. A failure
after publication retains that directory disabled for inspection or retry;
failure cleanup never deletes a published installation.

The default model is `base`. Larger models are explicit operator choices through
`capabilities install voice --model small` or `--model large-v3-turbo-q5_0`.
Disable voice before changing the selected installation. Real principal-note
quality qualification and Google Chat live acceptance remain pending; the
default is not a claim that those launch gates passed. Recorded engine smoke
proves the pinned interface, decoding, and silence handling, and does not prove
intention accuracy or successful assistant actions.

## Host policy and status

The dedicated policy is `<config root>/voice.json`; its selected immutable
installation is under `<state root>/voice/<recipe>-<platform>-<architecture>-<model>`.
The operator roots also respect `GWS_EA_CONFIG_ROOT` and `GWS_EA_STATE_ROOT`.
Instance `.env` files carry only `GWS_EA_VOICE_POLICY_FILE`, the same absolute
policy locator. This is a native configuration binding, not per-assistant
enablement. Enabling binds current instances; creates and release cutovers bind
future compatible hosts. Hosts read the shared policy for each note.

`capabilities list` distinguishes supported host functionality, installed
recipe-owned directories, the selected assets, and host activation. `capabilities
show voice` reports the selected model, exact recipe and source provenance,
installation prerequisites, current release compatibility, and readiness limits.
`capabilities check voice --json` verifies assets and queries only bounded native
voice health. It retains unknown compatibility and unreachable consumers;
missing or corrupt assets never count as drained consumers. These observations
do not download, enable, restart, or process recordings. Principal response
preferences remain principal-owned. Inspection returns exit 0 when the
observation completed, including absent assets, corrupt assets, disabled policy,
or unreachable consumers retained as facts; it does not mean voice is ready.
Every inspection includes `observed_at` in ISO UTC. Human observation and
verified-build times use the install timezone; stored receipt times are unchanged.
Every managed JSON result uses the schema-version-1 envelope. Invalid or
unsupported invocations return exit 2; operational failure returns 1 and busy
returns 75. Voice failures retain native error codes and structured next actions
when the domain has an exact recovery command.
Human and JSON inspection handoffs follow the observed state: install absent
assets, enable verified disabled assets, check enabled consumers, or inspect and
repair unknown state. Unsupported assistant releases receive an update command.

`status --json` reports the global flag, verified/absent/invalid assets, release
compatibility, observed host readiness, queued and active preparation, and the
last outcome and failure. Ready assets alone do not count as observed successful
recognition. Readiness is unknown until the host answers, and successful voice
operation is unknown until actual recognition succeeds. A failure remains
visible until successful recognition clears it. Status repairs and starts
nothing.

An unsupported rollback reports that voice needs an operator update and keeps
text available. Updating, rolling back, or removing one assistant never changes
the host policy or shared cache. A malformed policy or unhealthy optional
installation produces a bounded voice limitation and leaves text service
available. Inspect or restore a valid disabled policy before running the
operator repair commands.

## Disable and remove

```sh
gws-ea capabilities disable voice
gws-ea capabilities uninstall voice
```

Disablement stops new recognition everywhere without restarting text service.
It retains assets and lets preparation already under way finish. Removal
requires disabled policy and proof that managed consumers have drained, covering
the whole preparation window before policy reads as well as actual processes
holding any installed model or program open. An unreachable host is not proof
of idle work. Let a running host finish its notes, or stop the affected assistant
and wait for its processes and containers to become quiet, then retry removal.
No live text host is stopped by these commands.

Host policy, instance operation locks, and the registry reservation lock prevent
concurrent enablement, cutover, or create from racing asset deletion. Removal
checks every model directory this recipe owns, including older selections, and
leaves unrelated cache entries untouched. Selection is cleared while disabled
before files are removed, so an interrupted removal stays safely disabled.

Runtime bounds are 64 MiB encoded input, 30 minutes decoded audio, two minutes
decoding, ten minutes recognition, and eight pending notes per assistant host
process. Exceeding a bound is a complete-note failure; partial transcript
prefixes are never accepted
as successful instructions. Silence and missing setup receive an honest normal
assistant reply. Installing later does not automatically resume an earlier
unprocessed note.

## Acceptance status and comparison

Implementation and local contract/engine checks are complete. Live Google Chat
notes, the receiving assistant's intended actions and quiet normal reply, and
real-note model qualification remain pending by user direction. Public speech
and silence smoke checks demonstrate the engine interface; they do not qualify
the base default or the whole voice job.

The [private comparison CLI and acceptance protocol](../src/modules/gws-ea-voice/testing/README.md)
compare the same operator-supplied human notes through verified base, small,
and turbo installations. The CLI records faithful speech, exact source/asset
identities, host facts, and complete decode-plus-recognition wall time in a new
private output directory outside the checkout. It downloads nothing and
changes no host setting. Human intention review, actual tool results,
follow-through, ordinary responses, separate phase timings, queue wait, and
child peak RSS remain the live acceptance evidence; the CLI produces no quality
score or qualification decision.

Google Chat retries an incomplete audio SDK claim through the ordinary router.
Completed SDK claims and mailbox source IDs prevent ordinary duplicate turns.
The SDK completion mark is not atomic with a non-mailbox interceptor effect;
a hard death between that effect and the mark can repeat it. Voice preserves
that native recovery boundary and introduces no new ingress guarantee. A
routing failure releases the conversation queue. If fan-out was only partly
written, a later cancellation can reach a previously unwritten target before
the failed note is redelivered there. Successful preparation preserves order;
retry after a routing failure retains the native recovery limits.

See [the CLI guide](gws-ea-cli.md) for explicit assistant IDs, machine envelopes,
stdout/stderr composition, confirmation pauses, discovery, and shell completion.
