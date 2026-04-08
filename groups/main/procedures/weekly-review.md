# Weekly Review

Friday system review. You review how the system performed this week and propose targeted edits to procedures and instructions. Your principal decides what ships.

This is not a retrospective or a report. It's a procedure edit session.

## Gather

Use `mcp__time__*` tools for ALL date/time computation.

1. **Corrections** — read `notes/corrections.md`. These are recorded instances where your principal corrected your approach during the week.
2. **Heartbeat activity** — read heartbeat messages from the heartbeat space (profile.md) for the past 7 days via `mcp__workspace__chat_list_messages`.
3. **Matters** — `list_matters(status: "all")`, filter to those with `updated_at` in the last 7 days. For each, `get_matter` and check the context for how it was handled — escalation patterns, resolution path, corrections recorded.
4. **Directives** — read `notes/directives.md`. Note any that were added this week — they often signal a procedure gap (the system did something the principal had to override).

## Identify

Look for patterns, not incidents. A single correction is noise. The same type of correction twice, or multiple escalations with the same shape, is a signal.

- Did a procedure lead to the wrong conclusion more than once?
- Were escalations predictable from existing rules? If yes, the auto-resolve scope could be wider.
- Were auto-resolutions overridden? If yes, the scope is too wide.
- Did the same type of issue recur (scheduling conflicts, email tone, missing context)?
- Were new directives added because the system acted on something it shouldn't have?

## Propose

For each pattern found, draft a specific edit:

1. **Read the full target file** before proposing any change.
2. **Read all related markdown files** — a change to one procedure or CLAUDE.md may conflict with another. Check cross-references.
3. **Draft the edit**: which file, which section, what it currently says, what it should say instead.
4. **Explain why**: what happened this week that this edit would have changed.
5. **Verify consistency**: ensure the edit doesn't contradict instructions elsewhere. If it does, draft edits to both files.

Edits should match the target file's existing voice and structure. No new sections unless the change genuinely warrants it. No bloat, no repetition. If the change fits as a clause in an existing rule, put it there.

## Present

Send via `mcp__nanoclaw__send_message`:

- If patterns were found: one item per proposed change — the file, the edit, and why. Keep it scannable. Your principal replies with what to apply, what to skip, and any adjustments.
- If nothing surfaced: exit quietly. A quiet week means the system is working. Don't manufacture observations.

## After

When your principal approves changes, make the edits. After editing, re-read the modified file to verify it reads coherently — the edit should look like it was always there.

Once the conversation is done and all approved edits are applied, clear `notes/corrections.md`.

## Output

Your final response text must be completely empty — output nothing. All communication happens exclusively through MCP tools.
