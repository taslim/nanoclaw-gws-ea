# Scheduling Procedure

Read this before any calendar operation. Read `profile.md` for the calendar table (IDs, modes, notes).

## Week Template

Availability hours are the hard boundary for Tier 2-4 scheduling. Tier 1 (family, inner circle) gets flexibility beyond these windows — use the notes and judgment to find something that works.

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

Profile.md defines each calendar with an ID, mode, and notes. Respect the mode:

- **freebusy** — you can see when your principal is blocked but not why. Treat as immovable terrain. Schedule around it.
- **readonly** — you can read event details but not modify. Use for context only.
- **readwrite** — full access, but don't create events here unless the context calls for it (e.g., personal events on a personal calendar). Follow the notes in profile.md.
- **primary** — this is where you create and manage events by default.

Always use the calendar **ID** (from profile.md) when calling calendar tools — not the display name.

You can only edit events where your principal is the organizer. For events organized by others, don't edit directly — it only changes your principal's copy and won't reach other attendees. Instead, send an email to the organizer requesting the change.

When a `freebusy` calendar conflicts with a calendar you can write to, the freebusy one wins — move the event you control or find a different time.

## Judgment

The question is never "should I confirm this?" It's **how hard is this to undo if I get it wrong?**

### Who's asking matters

→ See `procedures/relationships.md` for tier definitions, assessment, and Google Contacts lookup.

Match scheduling effort and slot quality to tier:

- **Tier 1:** Prime time slots, maximum flexibility. Accommodate quickly, move other things if needed. A vague "let's catch up" is enough — book it.
- **Tier 2:** Good slots within 48 hours. Standard scheduling flow. Brief your principal before the meeting if context would help.
- **Tier 3:** Margins and off-peak slots. If the ask is vague or the purpose unclear, ask what it's about before offering time. If it doesn't need your principal specifically, redirect.
- **Tier 4:** Default to declining politely. If there's a reason to engage, offer the most constrained availability. Never displace anything for a Tier 4 request.

### Bias for action

Meetings are reversible. Default to handling everything — scheduling, rescheduling, declining, moving things around — without checking in. Your principal trusts you to manage their calendar.

**Just do it:**
- Known contacts, routine meetings, recurring 1:1s — book the best slot
- New scheduling requests from any tier — apply the tier logic above and act
- Slots are tight — move events you control, propose new times to the organizer for what you don't
- Someone important needs accommodating on a packed day — restructure the day
- A meeting makes better sense at a different time — move it
- Choosing between equally good options — pick one, don't ask
- Declining Tier 3-4 requests that don't warrant your principal's time

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

Use `mcp__time__*` tools for ALL date/time computation — resolving "next Tuesday", computing availability windows, converting timezones, calculating gaps between dates. Never do date math in your head.

1. Run `get-freebusy` on **all calendars** listed in profile.md
2. `freebusy` blocks: schedule around them silently
3. Conflicts on writable calendars: resolve per judgment above — move what you control, propose new times for what you don't
4. When offering times externally, offer 2–3 specific slots. Use `get-freebusy`, not `list-events`
5. Offering ≠ booking. Once a time is confirmed — or if the choice is low-stakes — create ONE event. Never create multiple events as "options"
6. Create the event in the **primary** calendar (see profile.md)
7. Organizer: **your principal's email** (see profile.md)
8. Timezone: use your principal's primary timezone

## Verification

After creating any event, silently verify (do not send these checks to your principal):
- [ ] Timezone is correct
- [ ] Correct calendar (the one marked `primary`, unless context dictates otherwise)
- [ ] Principal's email is organizer (see profile.md)
- [ ] Principal's email is an attendee (not just organizer)
- [ ] Duration matches what was communicated (email, message, etc.)
- [ ] No conflicts on any calendar in profile.md
- [ ] Schedule quality is intact (no triple-stacking, lunch protected, deep work blocks preserved)
