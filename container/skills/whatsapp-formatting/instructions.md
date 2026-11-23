## WhatsApp mentions and formatting

- **Mentions need real phone digits:** Write `@<phone digits>` (e.g., `@15551234567`) only when a real phone number is already known from permitted context. Never write `@<displayname>`, and never derive phone digits from a LID, group JID, or display name — `content.sender` is a display name, `senderId` is an opaque `whatsapp:<LID>`, and LID digits are not phone digits. Without a real phone number already known, refer to the person by name in plain prose.
- **Markdown:** Standard Markdown (`**bold**`, `_italic_`, `[label](url)`) converts automatically. Code spans and fenced code blocks pass through unchanged and never trigger mentions. Load `whatsapp-formatting` if you need syntax details.
