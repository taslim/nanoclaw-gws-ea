# Morning Briefing

Daily chief-of-staff brief. Your principal should be able to read this in 90 seconds, make 2-3 decisions, and know their day is handled.

**Brevity is the point.** Skip sections with nothing to report. Never mention a matter in more than one section. Err on the side of leaving things out — if it doesn't need your principal's brain this morning, it doesn't belong here.

## Execution

Use `mcp__nanoclaw__time_*` tools for all date/time computation. Gather all the data first — read today's events fresh from the calendar API across the calendars defined in the scheduling skill, `list_matters(status: "escalated")` for matters waiting on your principal's call, `list_matters` (default) plus `get_matter` for any active/waiting matters with substantive context worth re-reading. For each escalated matter, verify the decision is still needed — fetch the linked email thread or calendar event to check if overnight activity resolved it. If it did, update the matter's status to `active` and its context, and skip it from Decisions.

## Routing

This procedure runs on the **heartbeat session** alongside the sweep, but the morning briefing must reach your principal's DM.

Emit the briefing as a single `<message priority="urgent">…</message>` block in your final response — the host routes `urgent` to your principal's DM. Any plain text outside the block stays scratchpad (and `<internal>…</internal>` is never delivered), so there's no double-post to guard against. Don't use `send_message` for this.

## Sections

### 1. Decisions

Matters with status `escalated` — these are waiting on your principal's call. Also include any `active` matters that need a decision today but haven't been formally escalated yet. Escalate them now via `update_matter(status: "escalated")` so future agents see the same picture.

Format as a numbered list. Each item: what the decision is (one sentence), your recommendation (bold), and the deadline if any. Your principal replies "1 yes, 2 no, 3 go with your call" — design for that interaction.

For each decision, schedule a one-shot fallback task that gate-checks whether your principal already responded before acting:

```
schedule_task(
  prompt: "Gate-check: if Tas hasn't replied to the {topic} item from this morning's briefing, do {recommended action}. Otherwise no-op.",
  processAfter: "<now + 1h>"
)
```

Include the task ID in your briefing line: "Acting on this in 1 hour unless you say otherwise (task: {id})." When your principal responds, cancel the fallback with `cancel_task`, transition the matter from `escalated` back to `active`, and record their decision in the matter's context.

### 2. Today

**Calendar** — what's wrong with today's schedule:
- Conflicts to resolve
- Meetings where your principal needs context walking in (first-time contacts, high-stakes)
- Missing logistics (no location, no link)

Skip anything routine or fully handled.

**Projects** — matters with substantive context worth re-reading. Only mention if something needs attention today.

### 3. Horizon

**Overnight** — check matters with `updated_at` since the previous evening (11pm) to find what was touched by email-external sessions or scheduled tasks while your principal slept. Surface only what changes what they know or need to do. Skip routine resolutions.

**This week** — matters at risk beyond today:
- Stalled follow-ups or waiting matters past due
- Upcoming events missing logistics (travel, reservations, venue)
- Deadlines approaching without clear progress

Skip the entire section if everything is handled.

## Tone

Write like a chief of staff, not a newsletter. Terse, judgment-forward. Lead with the most important thing. No filler, no pleasantries, no emoji. A quiet morning that produces a two-line briefing is perfect.
