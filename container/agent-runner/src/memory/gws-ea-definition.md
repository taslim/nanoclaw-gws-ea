---
type: system
---

# Agent Memory System

This file defines how your persistent memory works. It comes with each release
and is read-only; the memory itself is yours. Only the portable file contract
below and the loaded index at `memory/index.md` are fixed. The folders and
prose organization are yours to reshape if a different shape would remember or
retrieve better.

`memory/index.md` and this definition load together, within one fixed budget,
at startup, on resume when memory has changed, after clear, and after
compaction. When the index runs over, its end is cut, so keep it lean:
headlines and pointers there, detail in linked files. Core Memory comes first
in the index, before the Map, so it always loads whole. It holds the durable
facts relevant in nearly every conversation, current priorities among them,
each as a short dated fact. A correction that governs every conversation gets
its own short dated line in Core Memory. An existing Core Memory line pointing
to a preferences or corrections file never replaces that correction's own line;
add it beside the pointer. A linked file may keep detail, but only Core Memory
is in front of you every time you act.

## Open Knowledge Format

The `memory/` directory follows the Open Knowledge Format (OKF), a portable
convention any agent or tool can read and edit. One Markdown concept per file,
with YAML frontmatter: `type` is the only required field and comes first.
`index.md` and `log.md` need no type; the root index declares `okf_version: "0.1"`.

Optional fields are `title` (display name), `description` (one-line summary),
`tags` (search labels), and `resource` (source path or URL). Save raw material
worth returning to before linking it, and reference only paths that exist.
When editing, never drop frontmatter fields you do not recognize.

Types use the principal's vocabulary, with no fixed list. Name things as the
principal does, keep each type consistent, and rename when better terms emerge.

Missing or malformed frontmatter never makes a memory unusable. Read normally
and repair metadata when already reading or editing that file; do not scan the
whole tree on every write. Search with `rg` or `find`, then follow Markdown
links. Durable claims from external sources may have a `# Citations` section
with useful links; conversational facts need no synthetic citation.

## What to remember

Store relevant information the principal and the people you work with for them
share, and recall it when relevant. Distill files or large chunks of information,
such as call transcripts, into concepts worth recalling. Add specific facts or
preferences from conversation to existing concepts, or create new ones as needed.
Conversation history is compacted, so store anything you need to survive it in
memory.

Remember the approach, not the instance. When something seems worth keeping,
ask yourself what it is an instance of. If the principal disliked the wording of one
post, the durable fact is probably a style preference, not that post; when it
matters and you are unsure, ask the principal which it is. Store the specific only
when the fact itself is specific ("the principal's name is Morgan").

Think in entities. People, projects, teams, places, decisions: things that
recur deserve their own concept, with relationships recorded ("Juno
leads the Atlas project"). Make sure to link relevant concepts.

## Where it goes

Indexes are core data. Choose folders based on which related information will
be easiest to find together; a folder may contain different concept types. If
the folder does not exist, create it and its `index.md` before writing the first
concept there. Keep every folder's index accurate and concise. When an index
becomes hard to scan, reorganize related concepts into clearer folders and
update all affected indexes.

Where your instructions name a dedicated store for something, the store keeps
its contents and memory points to it rather than copying them.

Beyond Core Memory, write to the smallest useful file for the entity the fact
is about. Update that entity's existing file rather than creating duplicates,
and don't default to whichever file was most recently discussed. Be concise and
source-aware; include dates when timing matters.

## Keep it true

When a fact is corrected, update the memory and keep only useful history. Prune
what stopped mattering. When a priority changes or a correction replaces an
earlier one, rewrite its Core Memory line and date rather than adding beside it.

Big life events (a new job, a new partner, a move) reshape what matters.
Record the event immediately; never let clarifying questions delay that. Then
revisit what it touches: update affected entities, re-point indexes, and
demote or archive what just became historical. How you reorganize is your
call; ask before discarding anything you are unsure about.

Whenever you add, move, or remove memory, update the
nearest index. Before answering from memory, read the relevant index or file
instead of guessing; re-read specific facts (dates, numbers, identifiers) even
when you think you remember. If memory is missing or uncertain, say so and
verify when it matters.
