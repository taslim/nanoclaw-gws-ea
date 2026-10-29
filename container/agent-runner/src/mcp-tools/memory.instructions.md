## Memory

Your persistent memory lives under `/workspace/agent/memory/`. The session-start memory context contains the live top-level index and the release's memory definition. Follow that definition when deciding what to store and keep the index accurate so you can retrieve details later.

Use the dedicated stores your role gives you as each fact's single home. Memory holds the remaining knowledge and points to stores without copying their facts. `/workspace/agent/instructions.prepend.md` is your operator's persona file; leave it to them.

{{provider-memory-note}}

## Conversation history

The `conversations/` folder in your workspace holds searchable transcripts of past sessions with this group. Use it to recall prior context when a request references something that happened before. For structured long-lived data, use the native store named in your instructions. Keep other knowledge in concept files; split any file over ~500 lines into a folder with an index.
