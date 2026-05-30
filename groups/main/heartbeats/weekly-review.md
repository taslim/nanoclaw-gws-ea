# Weekly Review

Friday system review. You review how the system performed this week and propose targeted edits to procedures and instructions. Your principal decides what ships.

This is not a retrospective or a report. It's a procedure edit session.

## Gather

Use `mcp__nanoclaw__time_*` tools for ALL date/time computation.

1. **Corrections** — read `/workspace/group/corrections.md` if it exists. These are recorded instances where your principal corrected your approach during the week.
2. **Heartbeat activity** — read messages from the heartbeat space (id in your runtime context) for the past 7 days via `mcp__gworkspace__chat_list_messages`.
3. **Matters** — `list_matters` (defaults exclude only archived). Filter to those with `updated_at` in the last 7 days. For each, `get_matter` and check the context for how it was handled — escalation patterns, resolution path, corrections recorded.
4. **Directives** — read `/workspace/group/directives.md` if it exists. Note any added this week — they often signal a procedure gap (the system did something the principal had to override).

## Identify

Look for patterns, not incidents. A single correction is noise. The same type of correction twice, or multiple escalations with the same shape, is a signal.

- Did a procedure lead to the wrong conclusion more than once?
- Were escalations predictable from existing rules? If yes, the auto-resolve scope could be wider.
- Were auto-resolutions overridden? If yes, the scope is too wide.
- Did the same type of issue recur (scheduling conflicts, email tone, missing context)?
- Were new directives added because the system acted on something it shouldn't have?

## Propose

For each pattern found, draft a specific edit:

1. **Read the full target file** before proposing any change. Skill files live at `/workspace/skills/<name>/SKILL.md`; main procedures live at `/workspace/agent/procedures/`; per-group posture lives in `CLAUDE.local.md`.
2. **Read all related files** — a change to one procedure or `CLAUDE.md` may conflict with another. Check cross-references.
3. **Draft the edit**: which file, which section, what it currently says, what it should say instead.
4. **Explain why**: what happened this week that this edit would have changed.
5. **Verify consistency**: ensure the edit doesn't contradict instructions elsewhere. If it does, draft edits to both files.

Edits should match the target file's existing voice and structure. No new sections unless the change genuinely warrants it. No bloat, no repetition. If the change fits as a clause in an existing rule, put it there.

## Present

This procedure runs on the **heartbeat session** alongside the sweep, but the weekly review must reach your principal's DM.

Emit the review as a single `<message priority="urgent">…</message>` block in your final response — the host routes `urgent` to your principal's DM. Any plain text outside the block stays scratchpad (and `<internal>…</internal>` is never delivered), so there's no double-post to guard against. Don't use `send_message` for this.

- If patterns were found: one item per proposed change — the file, the edit, and why. Keep it scannable. Your principal replies with what to apply, what to skip, and any adjustments.
- If nothing surfaced: send a one-line "Quiet week — nothing to propose." A quiet week means the system is working. Don't manufacture observations.

## After

When your principal approves changes, make the edits. After editing, re-read the modified file to verify it reads coherently — the edit should look like it was always there.

Once the conversation is done and all approved edits are applied, clear `/workspace/group/corrections.md` (truncate the file or delete it — fresh slate for next week).
