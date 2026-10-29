---
name: meetings
description: Shape a meeting for the principal, choose who owns it and how to attend, handle invitations and holds, or move a commitment with the people it affects. Use before offering or changing meeting times, deciding a meeting's length, or repairing missing guests or attendance details.
allowed-tools: Read Bash(ncl:*) mcp__nanoclaw__days mcp__nanoclaw__check mcp__nanoclaw__create_event mcp__nanoclaw__change_event mcp__nanoclaw__cancel_event mcp__nanoclaw__change_guests mcp__nanoclaw__respond_to_event mcp__nanoclaw__email_handoff mcp__nanoclaw__send_message
---

# Meetings

## What great looks like

Every meeting is shaped for the principal. Who needs it and why determine who owns it, how much time it deserves and how to attend. The time comes last because it depends on those choices. Often the conversation has already settled most of them; use what is known rather than reopening each decision.

An invitation tells each guest what they are coming to, where or how to join, and when it ends. A move respects the people whose time it changes. The requester's ask is information to weigh alongside the relationship, purpose, principal's preferences and the week they have.

## Method and why

1. **Understand the purpose and relationship.** Load `gcalendar`. Read the existing thread or brief and the relevant days. Use the people, six-month meeting history and recorded meeting lengths in `check` to ground a decision. Choose the kind explicitly; the host does not infer it. An unfamiliar name with no people record does not prove a first meeting, and meeting count does not decide how much a relationship matters.
2. **Shape the meeting.** Choose its length, owner and way to attend for this purpose and principal. A first conversation usually needs less time than the ask, at the principal's recorded first-call length. A close friend's dinner deserves unhurried time. Whoever needs the meeting usually owns it. When the other side has an assistant, they usually send the invitation; when they offer a booking link, delegate booking through that link to the browser so their system sends it. These are reasons for judgment, not a fixed list of lengths or a rule that you always organize.
3. **Choose a time that works in the real week.** Use `check` with the shaped length, guests, kind and place, or the existing event for a move. Consider local hours, prep, journeys, meals and the commitments around it. Other people's calendar IDs can return busy windows without exposing their event details. A free rectangle is useful only when the principal can actually attend.
4. **Make the invitation complete.** Use the native calendar tools when you should send it. Put the place in location. For **in person**, give the place with no video link; for **video**, give the joining link with no street address; for **phone**, give the number and who calls whom; for **hybrid**, give both the place and link. A lunch with someone dialling in needs both. The kind follows what was agreed and the context. When still unclear, choose a sensible default and say which. Notes can explain attendance; the location field carries the place. A task or prep item is a sized block, not an all-day event, and a deadline needs lead time.
5. **Invite the people the meeting is with.** An assistant-created invitation normally includes the people it names, so they receive it and changes reach their calendars. If someone is named but not invited in an event you create or change, note that in the result and usually invite them. Keep the useful exceptions: an event about them, the other side sending the invitation, or the principal asking only to hold time. Events the principal created keep their omissions; tell the principal about a named person left off, and judge contact under the move etiquette below. When the time is agreed and the other side will invite, you may create a hold; remove it when the real invitation arrives so one meeting does not block the time twice.
6. **Move according to who is involved.** Read the event detail and `check` result before deciding. A solo commitment moves freely. Guests and people a matter's commitment is with are usually asked first, through the agent that talks with them, because their time is committed too. If the move cannot wait, make it and tell them at once through that agent. People it is only about, such as a gift block for Juno, are not asked. For a person named but not invited, tell the principal; usually do not contact them because there is often a reason they are absent. Contact them when the principal asks or clearly would want it: rescheduling “Call with the dentist” entails contacting the dentist.
7. **Respect ownership and report the effect.** Another person's meeting is usually moved by asking its organizer. If guests may edit it, moving it is your judgment. `change_event` and `cancel_event` take your guest-update choice; report who Google notified, and distinguish an update from an agreed move. The host sends no separate conversation. Cancelling someone else's event may only remove the principal's copy; `respond_to_event` with declined tells its organizer. Check any prep or travel left at the old time, and keep a move past a deadline visible as a problem.
8. **Keep what the correction teaches.** A corrected length by kind goes in `ncl preferences set` as a meeting-length preference with the principal as its source and the correction as its basis. A broader taste or judgment goes in the Manual's principles through `ncl manual get` and `ncl manual set`. Preserve what else is already in the section. Learn this principal's choices instead of replacing them with general etiquette.

## Worked example

Juno Hale asks Morgan Ellery for an hour for their first conversation about a project. The recorded first-call length is 25 minutes. The purpose can be settled in that time, so choose 25 minutes before finding slots. Juno has an assistant who will send the invitation. Agree a suitable time through the agent on that conversation, hold it if useful, then remove the hold when their invitation arrives. If Juno's assistant instead gives a booking link, send the browser that booking errand; their system should own the resulting invite.

That evening Morgan is having dinner with Remy Vance, a close friend. The same 25-minute choice would defeat its purpose. Leave an unhurried evening and the journey to the restaurant, with the restaurant in location and Remy invited. There is no need for a video link on this in-person dinner.

If an urgent change makes dinner impossible, judge whether you can ask first. When the change cannot wait, move it and have the conversational agent tell the guests at once. If Morgan's original event names Remy but leaves them off the invite, tell Morgan about the omission; do not add Remy or contact them automatically. If Morgan then says first calls should be 20 minutes, record that kind's corrected preference so the next invitation starts from it.

## Traps

- Accepting an hour merely because someone asked for one, or shrinking a friend's dinner to a first-call length.
- Choosing the time before knowing the length, place or way to attend.
- Creating your own invitation while another assistant or booking system is sending one.
- Leaving a hold behind after the invitation arrives.
- Adding a video link to an agreed in-person meeting, or omitting the remote half of a hybrid one.
- Treating someone mentioned in notes as automatically invited or authorized to receive contact.
- Treating Google guest updates as evidence that people agreed to a move.
- Repeating the principal's correction in chat without saving the preference or principle it establishes.
