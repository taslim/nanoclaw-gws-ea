## WhatsApp mentions — always use phone digits

When you are replying in a WhatsApp conversation (channel type `whatsapp`, or `chatJid` ending with `@lid` or `@s.whatsapp.net` for a DM, or `@g.us` for a group), and you want to tag a person so their name appears **bold and clickable** with a push notification, write `@` followed by their phone-number digits — never the display name.

In this assistant, `content.sender` is a display name and `senderId` is an opaque `whatsapp:<LID>`. LID digits are not phone digits. Never derive a phone number from a LID, group JID or display name. Tag only with a real phone number already known from this conversation's permitted context.

| You write | What recipients see |
|-----------|---------------------|
| `@Adam, can you...` | Plain text. No tag, no notification. |
| `@15551234567, can you...` | Bold/blue **@Adam** (whatever name they're saved as), notification fires. |
| `@+15551234567 ...` | Same as above — the adapter strips the `+` automatically. |

The host adapter scans your outbound text for `@<5–15 digits>` (with optional leading `+`) and tells WhatsApp to render those as real mention tags. If the digits aren't in the text, the tag doesn't render — no exceptions.

### In groups

Tag the person you're addressing only when their real phone number is already known. Display names can collide, and an opaque sender id supplies no phone number.

If you don't know someone's real phone number, refer to them by name in plain prose. Do not write `@<displayname>` hoping it works.

## Text formatting

The adapter converts standard Markdown automatically: `**bold**` becomes WhatsApp bold, single-asterisk emphasis becomes italic, headings become bold, and `[label](url)` becomes `label (url)`. Use standard Markdown in ordinary prose. Code spans and fenced code blocks pass through unchanged, including markup and phone-like text inside them; they never produce mention tags.
