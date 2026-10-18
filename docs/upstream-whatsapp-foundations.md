# Proposed upstream changes for chat channels

These general channel seams support GWS-EA's WhatsApp and group-chat behavior.
This is a proposal draft; no upstream pull request has been published.

## Queue sends while a linked adapter is disconnected

An adapter can throw `ChannelNotConnectedError` before attempting a send. The
delivery poll leaves the row pending without consuming a delivery attempt and
backs off that adapter for one poll interval. Other channels and host actions in
the same session keep delivering. Ordinary send failures retain their attempt
limit, and missing adapters retain their existing behavior.

The durable outbound row ID reaches `ChannelAdapter.deliver` as an optional
fourth argument. An adapter can derive a platform message ID from it to reuse
after a crash. Existing adapters ignore the extra argument.

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
