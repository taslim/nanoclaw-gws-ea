---
name: errands
description: Fit errands, pickups and appointments into a day using their real places, merchant hours, task lengths and routes. Use when several stops compete for time, an errand has a closing time, or a dinner or appointment adds travel across town.
allowed-tools: Read Bash(ncl:*) mcp__nanoclaw__days mcp__nanoclaw__check mcp__nanoclaw__create_event mcp__nanoclaw__change_event mcp__nanoclaw__cancel_event mcp__nanoclaw__send_message
---

# Errands

## What great looks like

The principal can leave, finish the errand while the right place is open, and reach the next commitment. Several stops form a sensible route. The plan accounts for the work at each stop as well as the journey, so a pickup never consumes an hour that looked free on the calendar.

Start from where the principal will actually be, the deadline or merchant's closing time, and the next fixed commitment. Check hours on the merchant's own page for that location and date. A search snippet, another branch's hours or the usual weekly pattern can be wrong when it matters.

## Method and why

1. **Understand the errand's result.** Is it collecting a ready order, choosing a gift, attending an appointment or dropping something off? Check what must be ready, what the principal must bring, how much of their time it needs and when it must be done. Keep the due date, required minutes and place in its matter through `ncl matters open` or `ncl matters update`. A check-in is not an appointment or a work block.
2. **Ground the stops.** Read `days`, and `ncl whereabouts get` for the relevant saved places, rhythm, stays and travel times. Start at the place before the errand and end at the next commitment's place; home is not automatically either. Read the exact location field, not just the appointment title.
3. **Verify merchant facts where they live.** Read the branch's own page yourself for its opening hours on the date, any last collection or service cutoff and its address. For a journey not already known, find the practical route and its assumptions. When a page needs interaction or a sign-in, delegate to the browser destination with `send_message`, starting a new errand thread and keeping its returned thread for follow-ups. You choose the plan; a browser report supplies information, and a factual lookup does not authorize a purchase.
4. **Route before you fill gaps.** Put fixed appointments and closing times first, then order flexible stops by geography, transport mode and what must happen before what. Count time at the shop, parking or waiting where relevant, travel between every pair of stops and room for ordinary variation. A merchant closing at 5pm needs the errand finished by then; arriving at 4:59 is not a usable plan.
5. **Check and protect real time.** Use `check` for the candidate block and the surrounding commitments, then create a block for the route, with its stops in order in the notes, linked to its matter. Travel or prep for an appointment can be a linked block. Save a useful recurring directional travel time with `ncl whereabouts pair set`; an estimate for one event belongs in `ncl whereabouts travel set`, with its learned or estimated source stated.
6. **Change commitments with care.** A solo gift-shopping block can move without asking the recipient, because it is about them. An appointment with a merchant or person is with them, so use the meetings playbook's move etiquette and the agent that talks with them. If the route no longer fits, change the order, use a different suitable day or bring the real trade-off to the principal.

## Worked example

Morgan Ellery needs a gift for Juno Hale by Friday, has a collection from a repair shop, and is meeting Remy Vance for dinner across town at 6:30. The calendar looks open from 4pm. The repair shop's own branch page shows collection ends at 5pm, although a search snippet says the shop closes at 6.

Read where Morgan will be at 4pm and the dinner's actual venue. Route the repair collection first, then allow the gift-shopping time and the journey to dinner. If those stops do not fit before dinner, protect gift time on Thursday with lead time before Friday, rather than squeezing it into an impossible route. Ask Remy before changing dinner; Juno does not need to approve moving a private gift block.

Tell Morgan the practical result: when to leave, which stop comes first, what to bring, and which errand is now on Thursday. If the merchant's current hours cannot be confirmed, state that limit where it affects the proposed trip.

## Traps

- Using a map's straight-line distance or an old snippet as a confirmed journey or closing time.
- Checking the brand's hours without checking the branch, date and service cutoff.
- Routing every journey from home even when the principal is at work or staying elsewhere.
- Protecting travel time but no time to complete the errand.
- Booking each stop as its own round trip when one loop would do.
- Asking a gift recipient about moving a private gift block, or moving an actual appointment without considering its other party.
