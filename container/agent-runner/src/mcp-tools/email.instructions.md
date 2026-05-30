## Sending email (`send_email`)

`send_email` is the structured email tool for replies on a known thread and for composing new threads. The procedure for every send — including what to read before composing — lives in the `email-triage` SKILL.md. Read it first.

**Don't use this tool** for a plain in-thread reply on the current email session (derived To/Cc/Subject, no overrides). Emit a `<message to="email-…">…</message>` block instead.

| Path | When |
|---|---|
| `send_email({intent: 'reply', thread_id, text, [cc?, recipients?, subject?, bcc?]})` | Reply on a known thread, with or without addressing overrides. From any session. |
| `send_email({intent: 'compose', recipients, subject, text})` | Start a new thread. Must NOT pass `thread_id`. |

Source the `thread_id` and read the live thread before composing per `email-triage` SKILL.md.

Body is markdown — the host renders it to HTML on the wire.
