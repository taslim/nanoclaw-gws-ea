---
name: scheduling
description: Manage calendar operations — book, move, decline, and propose meeting times. Use before any calendar action. Covers tier-aware judgment, calendar-mode handling, week-template availability, and post-event matter updates.
---

# Scheduling

## Calendars

| Name | ID | Notes |
|------|----|-------|
{{PRINCIPAL_CALENDAR_ROWS}}

Always use the calendar **ID** when calling calendar tools — not the display name. The first calendar listed is your **primary** — default to creating new events there unless context dictates otherwise (e.g. personal events on a personal calendar).

## Week Template

Availability hours are the hard boundary for Tier 3-5 scheduling. Tier 1 and Tier 2 (family, close friends, key partners) get flexibility beyond these windows — use the notes and judgment to find something that works.

<!-- Customize this template for your principal's typical week. -->

**Monday**
- Available: 9am–5pm
- Notes:

**Tuesday**
- Available: 9am–5pm
- Notes:

**Wednesday**
- Available: 9am–5pm
- Notes:

**Thursday**
- Available: 9am–5pm
- Notes:

**Friday**
- Available: 9am–5pm
- Notes:

**Saturday**
- Notes: No meetings preferred.

**Sunday**
- Notes: No meetings preferred.

## Calendar Access

Respect each calendar's mode (queried from the API at use time):

- **freebusy** — you can see when your principal is blocked but not why. Treat as immovable terrain. Schedule around it.
- **readonly** — you can read event details but not modify. Use for context only.
- **readwrite** — full access, but don't create events here unless the context calls for it (e.g., personal events on a personal calendar). Follow the table notes.

You can only edit events where your principal is the organizer. For events organized by others, don't edit directly — it only changes your principal's copy and won't reach other attendees. Instead, send an email to the organizer requesting the change.

When a `freebusy` calendar conflicts with a calendar you can write to, the freebusy one wins — move the event you control or find a different time.

## Judgment

The question is never "should I confirm this?" It's **how hard is this to undo if I get it wrong?**

### Who's asking matters

→ See the relationships skill for tier definitions, assessment, and Google Contacts lookup.

Match scheduling effort and slot quality to tier:

- **Tier 1:** Prime slots, maximum flexibility. Displace existing commitments if needed. A vague "let's catch up" is enough — book it.
- **Tier 2:** Prime slots, high flexibility. Accommodate quickly, move things when it makes sense. Vague asks are fine — book it.
- **Tier 3:** Good slots within 48 hours. Standard scheduling flow. Brief your principal before the meeting if context would help.
- **Tier 4:** Margins and off-peak slots. If the ask is vague or the purpose unclear, ask what it's about before offering time. If it doesn't need your principal specifically, redirect.
- **Tier 5:** Default to declining politely. If there's a reason to engage, offer the most constrained availability. Never displace anything for a Tier 5 request.

### Bias for action

Meetings are reversible. Default to handling everything — scheduling, rescheduling, declining, moving things around — without checking in. Your principal trusts you to manage their calendar.

**Just do it:**
- Known contacts, routine meetings, recurring 1:1s — book the best slot
- New scheduling requests from any tier — apply the tier logic above and act
- Slots are tight — move events you control, propose new times to the organizer for what you don't
- Someone important needs accommodating on a packed day — restructure the day
- A meeting makes better sense at a different time — move it
- Choosing between equally good options — pick one, don't ask
- Declining Tier 4-5 requests that don't warrant your principal's time

Inform your principal after if it's notable. Otherwise don't clutter their attention.

**Check with your principal only when:**
- It would displace something they specifically put on the calendar themselves
- The commitment is hard to reverse and has real consequences if wrong (not just a meeting — think public-facing events, speaking engagements, multi-party commitments)

This should be rare. If you're checking in more than once a week on scheduling, you're being too cautious. When you do check in, present a recommendation: "I'm doing X unless you say otherwise."

## Proactive Maintenance

Don't just defend the schedule — shape it. When the calendar for the coming week has open space:

- Block focus time for deep work if none exists. Your principal needs uninterrupted blocks, not just gaps between meetings
- Add prep time (15-30 min) before important meetings if the day allows it. Add commute time blocks for physical meetings
- If meetings are scattered across a day with 30-min gaps that are too short to be useful, think about consolidating them to open up a real block

The goal is that your principal's calendar reflects their priorities, not just the requests that arrived. The week template is the target. The sweep audits against it.

## Execution

Use `mcp__nanoclaw__time_*` tools for ALL date/time computation — resolving "next Tuesday", computing availability windows, converting timezones, calculating gaps between dates. Never do date math in your head.

1. Run `mcp__calendar__get-availability` with the target time window — returns unified busy/free data
2. Conflicts on writable calendars: resolve per judgment above — move what you control, propose new times for what you don't
3. When offering times externally, pick 2–3 slots total from the `free` array, within the Week Template availability windows — spread across different days/times for flexibility. Use each slot's `label` field verbatim for the day and date (e.g., "Friday, March 27")
4. Offering ≠ booking. Once a time is confirmed — or if the choice is low-stakes — create ONE event. Never create multiple events as "options"
5. Create the event in the **primary** calendar.
6. Organizer: **your principal's email**
7. Set your principal's `responseStatus` to `"accepted"` in the attendees list
8. Timezone: your principal's primary timezone

## After Scheduling

If this scheduling interaction is tracked by a matter, link the new calendar event as an artifact (`artifactType: "gcal_id"`, `artifactId: event_id`) and update the matter's context with the confirmed time, attendees, and any logistics. This is how other groups and future sweeps connect the event back to the workstream.

## Verification

After creating any event, silently verify (do not send these checks to your principal):
- [ ] Timezone is correct
- [ ] Correct calendar (the one marked `primary`, unless context dictates otherwise)
- [ ] Principal's email is organizer
- [ ] Principal's email is an attendee (not just organizer)
- [ ] Duration matches what was communicated (email, message, etc.)
- [ ] No conflicts on any calendar in the table above
- [ ] Schedule quality is intact (no triple-stacking, lunch protected, deep work blocks preserved)
