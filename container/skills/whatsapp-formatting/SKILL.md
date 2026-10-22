---
name: whatsapp-formatting
description: Format messages for WhatsApp, including mentions that render as real WhatsApp tags. Use when responding in a WhatsApp conversation (channel_type is whatsapp, or platform_id / chatJid ends with @lid, @s.whatsapp.net or @g.us).
---

# WhatsApp Message Formatting

WhatsApp uses its own lightweight markup and a phone-number-based mention syntax. The host's WhatsApp adapter (Baileys) handles markdown conversion automatically, but **mentions are only protocol-level mentions if you use the right syntax** — otherwise they render as plain text and don't notify the recipient.

## How to detect WhatsApp context

You're in a WhatsApp conversation when any of these are true:
- The channel type is `whatsapp`
- The chat JID / platform id ends with `@lid` (1-on-1 DM) or `@s.whatsapp.net` (phone-number JID)
- The chat JID / platform id ends with `@g.us` (group)
- Your inbound message metadata has `chatJid` matching the above

## Mentions — the important part

To tag a user so their name appears **bold and clickable** in WhatsApp and they get a push notification, write the `@` followed by their phone number digits (no `+`, no spaces, no display name):

```
@15551234567 can you confirm?
```

The adapter scans your outgoing text for `@<digits>` (5–15 digits, optional leading `+` is stripped) and tells WhatsApp to render them as real mention tags.

In this assistant, inbound `content.sender` is a display name and `senderId` is an opaque `whatsapp:<LID>`. A DM `chatJid` can end with `@lid`; a group ends with `@g.us`. LID digits are not phone digits. Never derive a phone number from a LID, group JID or display name. Use a real phone number only when it is already known from this conversation's permitted context; otherwise refer to the person by name in plain prose.

### Wrong vs right

| You write | What recipients see |
|-----------|---------------------|
| `@Adam can you...` | Plain text `@Adam`. No tag, no notification. |
| `@15551234567 can you...` | Bold/blue **@Adam** (or whatever name they're saved as), notification fires. |
| `@+15551234567 ...` | Same as above — adapter strips the `+`. |

### Picking who to tag

- In a DM, there's no real need to tag the recipient (they already see every message), but tagging still works if you want emphasis.
- In a group, tag only with an already known real phone number for the intended person. Display names can collide; neither a name nor an opaque sender id establishes a phone number.
- If you don't know their real phone number, just refer to the person by name in plain prose. Don't write `@<name>` — it won't tag and it will look like a tag that failed.

## Text styles

WhatsApp uses single-character delimiters, *not* doubled like standard Markdown.

| Style | Syntax | Renders as |
|-------|--------|------------|
| Bold | `*bold*` | **bold** |
| Italic | `_italic_` | *italic* |
| Strikethrough | `~strike~` | ~strike~ |
| Monospace | `` `code` `` | `code` |
| Block monospace | ```` ```block``` ```` | preformatted block |

The adapter converts standard Markdown (`**bold**`, `[link](url)`, `# heading`) to the WhatsApp-native form automatically, so you don't have to think about it — but be aware that single asterisks become italics, not bold.

Code spans and fenced code blocks pass through unchanged: markup inside them is not converted, and phone-like text inside them does not create mention tags.

## What not to do

- Don't write `<@U123>` (that's Slack), `<@!123>` (Discord), or any other channel's mention syntax.
- Don't paste a full JID like `@15551234567@s.whatsapp.net` in the text — only the digits before the JID's `@` go after your `@`.
- Don't try to tag display names. WhatsApp has no display-name-based mention API.
