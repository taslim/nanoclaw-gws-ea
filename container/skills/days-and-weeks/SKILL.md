---
name: days-and-weeks
description: Plan or repair the principal's day and week, protect time for work before its deadline, and weigh calendar findings against their priorities and whereabouts. Use for a daily or weekly pass, a crowded day, a deadline, or work that needs time but has no date.
allowed-tools: Read Bash(ncl:*) mcp__nanoclaw__days mcp__nanoclaw__check mcp__nanoclaw__create_event mcp__nanoclaw__change_event mcp__nanoclaw__cancel_event
---

# Days and weeks

## What great looks like

The principal can live the day you planned. Work has enough time before it is due, appointments have a way to get there, and meals and breathing room survive. Their week advances what matters to them. A calendar with no overlaps can still be impossible to live.

Start from the current days, whereabouts, scheduling preferences, priorities and open matters. Make the changes within your authority, then bring the principal the decision or trade-off that needs them. A useful answer says what now fits, what remains at risk and what you need from them.

## Method and why

1. **See the whole commitment.** Load `gcalendar` before calendar work. Use `days` for the period and one-event detail when an organizer, guest response or omission matters. Read `ncl whereabouts get`, `ncl preferences get` and the relevant Manual sections when the context in front of you is incomplete. The clock is the one in effect where the principal will be; a trip changes a day's practical limits.
2. **Give work both a due date and a size.** Read `ncl matters list` and the relevant `ncl matters get` results. A matter's due date is when its result is needed; its next look is when you return to it. Save the due date and minutes of principal time with `ncl matters open` or `ncl matters update`, using --due and --needs-minutes. Zero minutes means it needs none of their time. A reminder to start is not the time to do the work.
3. **Work backward from the result.** Allow time for preparation, the principal's work, review, another person's response and delivery where the task needs them. Put a sized block before the deadline with useful lead time. An all-day label reminds them of a date but reserves no time. Link the block to its open matter through `create_event`, so the task and its time remain connected. During the weekly pass, include matters that need the principal's time even when no due date is set.
4. **Fit the day around people and places.** Check the local workday, protected time, meals, travel, prep and the longest uninterrupted run. Use `check` on a proposed block or move. A default meal window or back-to-back finding is an observation to weigh against this principal's preferences, never an arbitrary reason to refuse a useful plan. Unknown travel is still unknown; a gap between appointments is not automatically usable work time.
5. **Move with the people involved.** Use the meetings playbook when a change affects others. A solo work block can move freely within the principal's authority. A deadline stays visible: moving the work past it leaves a problem to resolve. Moving a next look repeatedly without progress needs a different next action or a candid decision, not another quiet deferral.
6. **Close the loop.** Use the native write tools for the changes you chose. A successful write stands even when findings are unavailable. Check the resulting day, including prep and travel blocks left behind by a move. Tell the principal the consequential change, the deadline at risk or the choice they need to make. Keep routine calendar mechanics out of their message.

## Worked example

Morgan Ellery needs to send Remy Vance a proposal by Friday at 15:00. The matter says Morgan needs 90 minutes to draft it, but its next look is Friday morning and there is no work block. Wednesday also has lunch with Juno Hale across town; the apparent gap afterward includes the journey back.

Read the matter and the days, keeping Friday at 15:00 as the due time. Wednesday's gap is too short once travel is counted. Thursday has a suitable 90-minute opening and time for Remy to answer a question before delivery. Check that opening, create a timed draft block linked to the matter, and leave review and send time before Friday's deadline. Move the next look to when it will help you confirm the draft is ready; moving the look alone would not protect Morgan's time.

If Thursday fills with something more important, find another real 90 minutes. If the only available block ends after Friday at 15:00, tell Morgan the proposal will miss its deadline unless the scope, other commitments or deadline changes. Do not describe a late block as a solved plan.

## Traps

- Counting an all-day task or a next look as reserved work time.
- Packing every free minute without accounting for lunch, prep, travel or recovery.
- Treating default windows as the principal's stated preferences, or treating every finding as a command.
- Moving a deadline along with a task merely to make the calendar look clear.
- Planning only dated matters and letting important undated work disappear.
- Moving a meeting and forgetting the prep or travel attached to its old time.
