# Proposed upstream changes for chat channels

These general channel seams support GWS-EA's WhatsApp and group-chat behavior.
This is a proposal draft; no upstream pull request has been published.

## Classify WhatsApp formatting under reply

The existing `reply` capability names `whatsapp-formatting` alongside `welcome`.
A group can select this text-formatting skill without a shell. Skills that no
capability names still require shell, and an unselected skill stays out of the
composed document. This adds no tools, commands, network access or credentials;
formatting prose applies only to WhatsApp conversations.

Evidence: the native capability filter and project-document composition tests
exercise reply-only selection, absence of shell instructions and omission when
unselected. The recorded-divergence suite pins the classification. The GWS-EA
chat-agent tests compose the exact skill baseline for both chat audiences while
keeping browser delegation conditional on the existing explicit grant.

## Queue sends while a linked adapter is disconnected

An adapter can throw `ChannelNotConnectedError` before attempting a send. The
delivery poll leaves the row pending without consuming a delivery attempt and
backs off that adapter for one poll interval. Other channels and host actions in
the same session keep delivering. Ordinary send failures retain their attempt
limit, and missing adapters retain their existing behavior.

The durable outbound row ID reaches `ChannelAdapter.deliver` as an optional
fourth argument. An adapter can derive a platform message ID from it to reuse
after a crash. Existing adapters ignore the extra argument.
The native message also carries its original row timestamp from the mailbox
projection. An adapter can decline a stale row even if the host was down before
the adapter first saw it; a direct host send has no row timestamp.

Evidence: `src/delivery-not-connected.test.ts`, the existing delivery suites and
the recorded-divergence tests exercise outage recovery, unaffected channels,
attempt accounting and the real registry bridge.

## Let a module decide engagement after preparing content

The opt-in `module` engagement mode calls a channel decider after sender
admission and inbound preparation. This allows recognized speech, quoted replies
and a channel's expected-reply state to determine whether the assistant wakes.
An absent or declining decider keeps silent context. Existing engagement modes
retain their behavior.

Two related host seams support isolated chats: wiring creation can omit its
companion channel destination, and host work can run in the conversation's
ordered routing tail for a cutover between messages. Neither changes existing
wirings by default.

Evidence: module-engagement, native wiring-command, DB and existing routing
tests, plus the recorded-divergence tests.

## Stop and replace one linked channel

The factory type also permits an asynchronous `null` result. Both native startup
paths already await factories and skip that result. This lets a channel reconcile
private account state before deciding whether credentials remain, including when
an interrupted pairing expires. The instance-channel divergence proof checks
that startup and hot-start skip it while another channel stays connected.

`stopChannelAdapter(key)` removes only the exact active instance from delivery
before awaiting its teardown. It returns `not-active` when the key is absent;
teardown errors propagate. The caller can then use the existing hot-start API
to construct a fresh transport after unlinking or expired pairing. Other
channels keep running.

Evidence: the native hot-start tests cover withdrawal during teardown, exact
instance matching, replacement and failure propagation. The recorded-divergence
suite exercises replacing WhatsApp while Google Chat remains connected.

## Preserve engagement when releasing a held chat

`releaseHeldMessages(processAfter, { preserveTriggers: true })` makes held rows
pending while retaining which ones originally called for a turn. Ambient chat
context stays silent. The default still makes every released row a trigger, as
existing email holds require. Native mailbox and routing tests cover both
release modes, including a chat with only ambient held context.

## Serve a tool definition by capability

`registerToolVariant(tool, capability)` gives one capability its own schema and
handler for an existing MCP tool name. This lets email and chat agents each see
`tell_main` with their own arguments and wire action. Only the granted key's
definition is listed or callable. The base definition retains priority when
both keys are granted, and existing registration and extension behavior stays
unchanged.

Evidence: the runner's native MCP client/server variant test checks listing,
schemas, handler dispatch and absent grants. The recorded-divergence suite runs
that proof; existing tool extension tests also pass.

## Let a text-posting adapter use the durable delivery key

An adapter can implement `postTextOnce(threadId, text, deliveryId)`. The Chat SDK
bridge then passes each ordinary file-free text part a key derived from its
durable row and part number. Direct sends without a row ID, attachments and
adapters without the method keep their existing behavior. Google Chat uses the
key as the basis of `messages.create`'s idempotent `requestId`.

Evidence: the bridge retry test and recorded-divergence guard check the opt-in
key path. The native outage-notice test loses the acknowledgement after Google
accepts, retries through the real registry/bridge/Google client, and sees one
posted message. Google documents `requestId` for user authentication in
[messages.create](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/create).

## Keep duplicate inbound from consuming a later expected reply

For opt-in module engagement, a retry-safe inbound row already present in its
canonical mailbox is skipped before the module decider runs. This prevents a
delayed duplicate from consuming a new expected reply. Other engagement modes
keep their existing path. The native routing proof reproduces the lost wake;
the recorded-divergence test also verifies the decider is not run again.

## Give an interrupted reminder request one native task

`createScheduledTask` accepts an optional `options.id`. A caller can derive that
ID from its session and durable request, and a replay returns the task already
stored under it. Existing callers that omit the ID keep generated identities.
This closes the gap between persisting a conversation reminder and writing the
host action's answer, without a second task store.

Evidence: the reminder test replays an action after its task was made but before
its answer was written. The recorded-divergence test drives the native helper in
a temporary install, observes one task on replay, and checks that omitted IDs
still produce separate tasks.

## Resume a conversation cutover through the native mailbox

The host needs stable row identities and lifecycle facts to seed recent chat
history and move unread input without losing a delayed reply. The optional
`getInboundRecords({ since?, status? })` and `getOutboundRecords(since)` reads
return canonical records in arrival order. `getDeliveredIds('delivered')`
distinguishes an assistant's posted replies from failed settlements; omitted
status retains existing send-deduplication behavior. A cutover inserts the
destination first, then calls `settleUnreadMessages(ids)` to complete only its
pending/held source rows. `releaseHeldMessages` additionally accepts
`preserveProcessAfter: true`; omitted options retain existing behavior.

Evidence: native mailbox tests cover full source flags, selective settlement,
deadlines and successful-delivery filtering. The recorded-divergence test pins
those opt-in operations. Chat move integration reopens central and session
stores after each durable step, including the atomic wiring swap, and proves
that delayed and held input, recent conversation and native reminder rows
survive once with the original serving session closed.
