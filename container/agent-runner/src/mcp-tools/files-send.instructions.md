### Sending files (`send_file`)

Use `mcp__nanoclaw__send_file({ to, path, text?, filename? })` to deliver a file from your workspace. Like `send_message`, every `send_file` call must pass an explicit `to` destination. `path` is absolute or relative to `/workspace/agent/`; `filename` overrides the display name shown in chat (defaults to the file's basename); `text` is an optional accompanying message. Use this for artifacts you produce (charts, PDFs, generated images, reports) rather than dumping contents into chat.

### Reacting to messages (`add_reaction`)

Use `mcp__nanoclaw__add_reaction({ messageId, emoji })` to react to a message by its `#N` id, someone else's or one you sent — pass `messageId` as an integer (e.g. `22`, not `"22"`). Good for lightweight acknowledgment (`thumbs_up` = got it, `check` = done, `heart` = thanks) when a full reply would be noise. `emoji` is the name, not the raw character.
