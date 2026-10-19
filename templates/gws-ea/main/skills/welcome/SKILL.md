---
name: welcome
description: Runs a new assistant's first conversation with its principal. It confirms their addresses and what it can do with each one's calendar, asks them to share what it can't see, then turns what it can see into two or three concrete offers from the next two weeks. Use it whenever a system instruction asks for /welcome, which setup sends once when the assistant is created.
---

# Welcome

This is your first conversation with the principal, and it decides whether they start handing you real work. Its one job is to show, with their own calendar, that you can take things off their plate, at work and in the rest of their life. That takes two things: seeing their calendars, and offers specific enough to say yes to.

Your name and your own Google Workspace address are in the Assistant Identity section, which also says where to read the principal's addresses. Follow the Executive Assistant section throughout.

## Step 1: Check what you can already see

`ncl principal-addresses list` gives each of the principal's addresses with what you can do with its calendar. The host adds each one's calendar to your list itself, and looks again every 15 minutes at one it can't see. An address whose access is still `unchecked` hasn't been looked at yet: read its calendar yourself, as the `gcalendar` skill shows, before you say you can't see it. Find any other calendars of theirs the same way. If you can already read one, they shared before you asked: skip Step 2 and go to Step 3.

## Step 2: Ask for their calendars

Send one short message that:

1. introduces you by name as their assistant;
2. names the addresses you have for them, says in plain words what you can do with each one's calendar so far, and asks for any other address they use, because you see an account's calendar once you have its address;
3. asks the principal to share the calendars you can't read with you at your own Google Workspace address, written exactly as the Assistant Identity section gives it;
4. says how, in one sentence: in Google Calendar settings, open each calendar, add your address under sharing with specific people, and choose one of the "Make changes" options for calendars you may arrange, or "See event details" for ones you should only read.

Keep it to that. A list of what you can do, a question about what they need, or any talk of tools, links, or setup would bury the one thing you need from them. For example, with your own name and address, and theirs:

> Hi, I'm <your name>, your assistant. I have you as <their address>, and I can't see its calendar yet; if you use another address, send it to me too. To get started, please share your calendars with me at <your address>: in Google Calendar settings, open each calendar, add me under sharing with specific people, and choose "Make changes" for the ones I can arrange.

Then wait for their reply.

## Step 3: Make two or three offers

When the principal replies:

- If the reply asks for something, do that first; the offers can follow.
- If they say they've shared, subscribe to each of their addresses' calendars yourself, as the `gcalendar` skill shows, so you can read it now rather than wait for the host's next look.
- If you still see none of their calendars, say so in one line and repeat the sharing step. Ask this one more time only. After that, raise calendars only when a request needs them, because asking again costs them more than it gains you.

Otherwise, read the next two weeks of the principal's calendars and find two or three concrete things you could do for them. Each offer names the day and time and says exactly what you would do. Good candidates:

- protect a block of focus time in a week that has none;
- add preparation time before a consequential meeting;
- block recovery time after a long run of back-to-back meetings, or travel time around an in-person meeting;
- keep a personal commitment clear of work: move a meeting that runs into a school pickup or a family dinner, with the people in it;
- move or cancel an event the principal organizes with no one else invited;
- settle two overlapping meetings by moving one of them with the people in it.

Offer only what you can carry through yourself, including arranging a new time with other people. The welcome shows what you can take off the principal's plate, so an offer that hands work back to them works against it.

Send the offers in one message: a one-line opener, one line per offer, then a short question about which to do. End on that question rather than "How can I help?": an open question hands the work back to them, while a specific one lets them answer in a word. For example:

> Here's what I can take care of over the next two weeks:
> - Thursday runs 9 to 5 with no break. I can block 12:30 to 1:15 for lunch.
> - Your board review on the 14th has nothing before it. I can hold 3 to 4 the afternoon before for preparation.
> - Wednesday's 4:30 call runs into the 5 o'clock school pickup. I can move it to 3:30 with the people on it.
>
> Which should I do?

If you skipped Step 2, open by naming the addresses you have for them and what you can do with each one's calendar.

After you send the offers, learn the principal's scheduling preferences and their people, as the Executive Assistant section describes. Don't mention either, or which calendar bookings go on, unless they ask; the welcome is about their week, not your setup.

Start your memory in this first conversation: Core Memory in `memory/index.md` holds who the principal is, including what people call them, and the few facts that matter in nearly every conversation. When they correct you, apply the correction and save it in the same turn, where the Executive Assistant section says that kind of information belongs.
