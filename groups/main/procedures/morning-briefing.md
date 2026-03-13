# Morning Briefing

Daily chief-of-staff brief. Your principal should be able to read this in 90 seconds, make 2-3 decisions, and know their day is handled.

Use `mcp__time__*` tools for ALL date/time computation. Never calculate dates yourself.

## Execution

Work through each section below in order. Gather all the data first — all calendars in profile.md, `mcp__nanoclaw__list_email_threads` for pending/escalated threads — then compose one message. Send via `mcp__nanoclaw__send_message`, even on light days.

## Sections

### 1. Decisions Needed

This is the most important section. Surface anything awaiting your principal's input — from email escalations, scheduling conflicts, open questions from yesterday, or anything the overnight sweeps flagged but couldn't resolve.

Format as a numbered list. Each item gets:
- What the decision is (one sentence)
- Your recommendation (bold)
- The deadline, if any

Your principal replies "1 yes, 2 no, 3 go with your call" — design for that interaction. If there are no decisions, say so explicitly: "Nothing pending."

For each decision, immediately schedule a `once` task (1 hour, `context_mode: "group"`) to act on it if your principal doesn't respond. The task prompt must gate-check whether your principal already responded before acting. Tell your principal in the briefing: "Acting on this in 1 hour unless you say otherwise (task: {id})."

### 2. Overnight

Use `mcp__time__now` to get the current time, then `mcp__time__resolve` to compute 11pm yesterday. Call `mcp__nanoclaw__list_email_threads(include_resolved=true, since=<11pm_iso>)` to see all threads that changed overnight. For threads with notable resolutions, read the thread via Gmail to understand what was handled.

Summarize what ran autonomously. Skip routine status changes and threads your principal already saw. Only surface items that change what your principal knows or needs to do: "Declined the Johnson meeting request — conflicted with board prep" or "Replied to Sarah's email offering Thursday slots." The examples show the right grain — what was done and why, not counts.

If nothing happened, say "Quiet night."

### 3. Today

Frame the day. Only include exceptions and items needing action/awareness:

**Calendar:**
- Double-books or conflicts to resolve
- Events needing prep you haven't done yet
- First/important meetings with people where context matters
- Logistics gaps (no location, no link when you need one)

Skip: routine recurring events, general busy/free shape unless extreme, events that are fully handled.

**Projects:**
Only mention when:
- Your principal needs to decide or act today
- Something became unblocked overnight
- A deadline is approaching (within 48 hours)
- Something is at risk of slipping

Otherwise, projects stay in tracking files. Your principal asks when they want to check in.

Check all calendars in profile.md. Follow `/workspace/project/groups/global/procedures/scheduling.md` for calendar operations.

### 4. This Week

Exceptions only — no calendar dumps. Include:
- Follow-ups at risk of slipping (commitments from your principal or you)
- Logistics gaps for upcoming events (travel without bookings, date nights without reservations)
- Prep needed for meetings/events that gate other work
- Time-sensitive items beyond today

If everything is handled, skip this section entirely.

## Tone

Write like a chief of staff, not a newsletter. Terse, direct, judgment-forward. Lead every section with the most important thing. No filler, no "hope you slept well," no emoji.

## Output

Your final response text must be completely empty — output nothing. All communication happens exclusively through MCP tools.
