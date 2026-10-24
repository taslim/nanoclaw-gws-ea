# Agent Memory

Every agent group has persistent, file-based memory: plain Markdown files that
survive container restarts, session ends, compaction, and provider switches.
There is no database and no embedding store. The agent reads and edits the
files with ordinary file tools, and you can too.

On the host the files live in `groups/<folder>/memory/`. Inside the container
the same directory is mounted at `/workspace/agent/memory/`.

## Layout

```
memory/
└── index.md              # top-level index: Core Memory first, then the Map (always loaded)
```

The memory definition is not part of the tree. It ships with the release at
`container/agent-runner/src/memory/gws-ea-definition.md`, mounted read-only in
every container at `/app/src/memory/gws-ea-definition.md`.

The scaffold is created automatically when a container boots. It writes only
`index.md`, and only when it is missing, so the agent's own edits and
accumulated memory are never overwritten.

Two files are always loaded:

- **`index.md`** holds the Core Memory section (the few durable facts relevant
  in nearly every conversation, including the principal's current priorities
  and the corrections that govern every conversation, as short dated facts)
  and a map of everything else. A correction gets its own dated line even when
  an existing Core Memory line points to a preferences or corrections file: the
  pointer stays, and the correction goes beside it. Core Memory comes first, ahead of
  the Map if the index is cut, but must still fit within the available index
  budget described below. Headlines and pointers only; detail belongs in linked
  files.
- **The release's definition** tells the agent how its memory works: what to
  store, where to put it, and how to keep it true. It is read-only, and each
  release may change it.

Groups created by an earlier release may still hold `memory/system/index.md`
and `memory/system/definition.md`. They stay on disk, and nothing reads them:
the definition in force is always the release's.

Folder layout and Markdown content are flexible, but every durable concept file
still follows the OKF frontmatter rules below. The agent chooses folders based
on which related information will be easiest to find together; a folder may
contain different concept types. Before writing into a new folder, the agent
creates it and its `index.md`.

## How memory reaches the agent

A session-start hook injects `index.md` and the release's definition into the
agent's context at startup, after a clear, and after compaction, every time.
On resume it injects them only when the rendered section differs from the one
it last delivered to that session: an unchanged section is already in the
resumed history. The section says it replaces any earlier memory section in
the conversation.

To know what it last delivered, the hook keeps a fingerprint of its output per
provider session (keyed by the hook input's `session_id`) under
`/workspace/.memory-delivered/`, in the NanoClaw session's own directory. That
directory outlives the container, so a respawn that resumes the session finds
it, and no other session shares it. The hook records the fingerprint only
after it has printed the section, so a section that never reaches the session
(the hook is killed first, or the write fails) is delivered again on the next
resume rather than skipped. A fingerprint that can't be written likewise only
means the next resume delivers the section again.

The hook lives in the agent-runner and is registered with whatever provider
the group runs, so every provider gets the same behavior. For Claude it is
wired through the Agent SDK; other providers wire it through their own
session-start mechanism. A sealed session keeps no group memory and installs
no hook.

The whole section, header and definition included, fits in 10,000 characters,
the size Claude Code passes inline. The release's definition leaves at least
3,500 characters for the index. Only the index is cut: from its end, at a
line break, with a notice giving its path on disk and asking for detail to
move into linked files. For anything deeper, the agent follows links from the
index and reads the files directly. This keeps the always-loaded footprint
small no matter how large memory grows.

Compaction also carries corrections and preferences from the conversation and
from earlier summaries, with their actual giver, and open promises including
the assistant's own. Only a person the agent's instructions allow to direct it
can give a correction. If an older summary omitted the giver, its wording stays
as unattributed context, never as authority or a standing instruction; the agent
must not invent a source. Corrections already in loaded Core Memory are omitted
from the summary, and a newer correction replaces an older one. Runtime notices
and nudges stay events even when an earlier summary carried them.

## Portable format (OKF)

`memory/` is an Open Knowledge Format (OKF) v0.1 bundle: one Markdown
concept per file, with YAML frontmatter declaring a
`type` (for example `person`, `project`, `decision`; `index.md` and `log.md`
are exempt). Types are the agent's vocabulary, not a fixed list.

The format is a convention, not a gate. A file with missing or malformed
frontmatter still works as memory; the agent repairs metadata when it next
touches the file. The payoff is portability: any OKF-aware agent or tool can
read the bundle, and switching a group to a different provider carries memory
over untouched (see [provider-migration.md](provider-migration.md)).

## What goes where

| Kind of information | Home |
|---------------------|------|
| Durable facts, people, projects, decisions | `memory/` |
| What the principal teaches: preferences, how they want things done, corrections, current priorities | `memory/` (priorities and corrections in Core Memory) |
| Operator overrides of the assistant's persona | `/workspace/agent/instructions.prepend.md`, the operator's |
| Past session transcripts | `conversations/` in the workspace |

## Migrating older memory

Groups created before the shared memory tree may still have legacy storage:
`.seed.md`, memory notes inside `CLAUDE.md` or `CLAUDE.local.md`, Claude's
auto-memory directory, or an `imported-agent-memory.md` from an earlier provider
switch. Run `/migrate-memory` to move standing role and persona into
`instructions.prepend.md` and organize durable facts in the shared memory tree.
Older groups may already contain folders named `memories` or `data`. Those are
still valid agent-chosen folders: normal startup neither creates nor deletes
them, and migration preserves their contents.

## Operator notes

- You can read or edit any memory file directly on the host under
  `groups/<folder>/memory/`; changes are picked up the next time a context
  window is created.
- Wrong or stale facts are just text: delete or correct them in place, or ask
  the agent to (it is instructed to prune and update on correction).
- The index template lives at
  `container/agent-runner/src/memory/templates/index.md`. NanoClaw copies it
  only when `memory/index.md` is missing, and never overwrites it.
  `templates/system/` is upstream NanoClaw's agent-owned definition, kept
  unchanged and no longer seeded.
