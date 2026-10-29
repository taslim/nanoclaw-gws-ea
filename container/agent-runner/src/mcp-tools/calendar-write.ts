/**
 * main's calendar tools that go through the host. gog cannot list the
 * principal as an accepted guest, nor check an invitation for their private
 * details, so creating an event and changing who an event invites go to the
 * host, on the principal's calendars or the assistant's own. It keeps the
 * principal on every event it writes on theirs, and puts them on one of the
 * assistant's only when main invites them. gog refuses to answer an event
 * the principal organizes, so every answer for them goes to the host too,
 * which changes their own entry alone
 * (src/modules/gws-ea-meetings/principal-events.ts). Whether a time is
 * free and who the principal meets are counted by the host from every page
 * of their calendars (src/modules/gws-ea-meetings/calendar-facts.ts), so no
 * model copies events to count them. Calendar reads and changes stay on the host.
 */
import { requestTool } from '../action-request.js';
import { registerTools } from './server.js';

/** Also grants gog's calendar commands. Named here, since the tools' tests load them ahead of the barrel. */
const CALENDAR_CAPABILITY = 'google-calendar';

/** How long a tool waits for the host; a request may still go through after that. */
export const CALENDAR_REQUEST_TIMEOUT_MS = 120_000;

const CALENDAR = {
  type: 'string',
  description: "The calendar's ID: the principal's address for their primary calendar, or your own address for yours.",
} as const;
const EVENT = {
  type: 'string',
  description: "The event's id, as days gives it: an occurrence's own id changes that one alone.",
} as const;
const ADDRESSES = { type: 'array', items: { type: 'string' } } as const;
const DATE_TIME = 'a date and time with its UTC offset, as time_resolve gives it, such as 2026-10-12T09:00:00-07:00';
const MATTER = {
  type: 'string',
  description: 'The id of the open matter the event belongs to, such as m-1a2b3c4d5e6f: the event joins it.',
} as const;

export const createEvent = requestTool({
  name: 'create_event',
  description:
    "Put an event on one of the principal's calendars or on your own. On theirs, the principal is always on its guest list, accepted, as on an event they made themselves. On yours, the principal is a guest, and the event takes their time, only if you name them in guests; anyone your calendar is shared with, colleagues in a company Workspace among them, sees its details unless it is private. Anyone you name in guests is invited, and Google sends them the invitation. Answers with the event's id.",
  properties: {
    calendar: CALENDAR,
    title: { type: 'string', description: 'What the event is called.' },
    start: { type: 'string', description: `When it starts: ${DATE_TIME}. For an all-day event, its first day.` },
    end: { type: 'string', description: `When it ends: ${DATE_TIME}. For an all-day event, its last day.` },
    all_day: { type: 'boolean', description: 'true for an all-day event, with start and end as dates (2026-10-12).' },
    timezone: { type: 'string', description: "The IANA zone its times show in; the principal's when left out." },
    notes: { type: 'string', description: 'Its description.' },
    location: { type: 'string', description: 'Where it is: an address, a phone number, or a link.' },
    guests: { ...ADDRESSES, description: 'Email addresses of other people to invite (up to 50).' },
    free: { type: 'boolean', description: "true when it shouldn't make the principal look busy." },
    private: { type: 'boolean', description: "true when its details are no one else's business." },
    recurrence: {
      ...ADDRESSES,
      description: 'How it repeats, as RRULE lines, such as RRULE:FREQ=WEEKLY;BYDAY=MO.',
    },
    video_call: { type: 'boolean', description: 'true to add a Google Meet link.' },
    kind: {
      type: 'string',
      description: 'The meeting kind you choose; its recorded length is returned without inferring one.',
    },
    parent_event: EVENT,
    parent_calendar: CALENDAR,
    parent_start: {
      type: 'string',
      description: 'The parent event’s observed start, for detecting linked blocks left behind after a move.',
    },
    block_kind: { type: 'string', description: 'Kind of linked block, such as prep, travel, preflight, work or hold.' },
    matter: MATTER,
  },
  required: ['calendar', 'title', 'start', 'end'],
  repeatable: false,
  timeoutMs: CALENDAR_REQUEST_TIMEOUT_MS,
});

export const changeGuests = requestTool({
  name: 'change_guests',
  description:
    "Invite people to an event the principal organizes or one you organize on your own calendar, or take them off it. Everyone's answer stays as it was, and the principal stays on their own events: accepted, unless they answered otherwise. Google tells the guests whenever someone joins or leaves, except the principal on their own events.",
  properties: {
    calendar: CALENDAR,
    event: EVENT,
    add: { ...ADDRESSES, description: 'Email addresses to invite.' },
    remove: { ...ADDRESSES, description: 'Email addresses to take off it.' },
    matter: MATTER,
  },
  required: ['calendar', 'event'],
  repeatable: true,
  timeoutMs: CALENDAR_REQUEST_TIMEOUT_MS,
});

export const respondToEvent = requestTool({
  name: 'respond_to_event',
  description:
    "Set the principal's own answer on an event on one of their calendars: an invitation from someone else, or an event they organize after someone else moved it and Google reset their answer, so its guests see them as unconfirmed. Only their entry changes. On their own events Google emails no one; on someone else's, Google is asked to tell the organizer, unless that is another of the principal's addresses. Answers with what Google now shows.",
  properties: {
    calendar: {
      type: 'string',
      description: "The principal's calendar the event is on: their address for their primary calendar.",
    },
    event: EVENT,
    response: {
      type: 'string',
      enum: ['accepted', 'tentative', 'declined'],
      description: "The principal's answer: accepted, tentative (maybe), or declined.",
    },
    matter: MATTER,
  },
  required: ['calendar', 'event', 'response'],
  repeatable: true,
  timeoutMs: CALENDAR_REQUEST_TIMEOUT_MS,
});

export const peopleStats = requestTool({
  name: 'people_stats',
  description:
    'Who the principal has met over the last six months, counted by the host from meetings they organized or accepted: meetings, and on which of their calendars, one-on-ones, recurring series, and the first and last day met, for the people met most or the people you name. Names come wrapped as untrusted text.',
  properties: {
    people: { ...ADDRESSES, description: 'Email addresses to report on, each listed even with no meetings.' },
  },
  required: [],
  repeatable: true,
  timeoutMs: CALENDAR_REQUEST_TIMEOUT_MS,
});

export const days = requestTool({
  name: 'days',
  description:
    'Read the principal’s days on the clock in effect at each event, with places, creators, organizer and guest responses. Copies across calendars are folded and all-day ends are inclusive. Read one event with calendar and event; filter by text. Export writes bounded text fields to this session’s inbox and returns its path and event count.',
  properties: {
    start: { type: 'string', description: 'First local date (YYYY-MM-DD) or instant with offset; today when omitted.' },
    end: {
      type: 'string',
      description: 'Last local date, included, or exclusive instant with offset; eight local days when omitted.',
    },
    calendar: CALENDAR,
    event: EVENT,
    filter: { type: 'string', description: 'Text to match in title, notes or location.' },
    export: { type: 'boolean', description: 'Write the complete range as a text file in your session inbox.' },
  },
  required: [],
  repeatable: true,
  timeoutMs: CALENDAR_REQUEST_TIMEOUT_MS,
});
export const check = requestTool({
  name: 'check',
  description:
    'Check a proposed time or move without booking or changing anything. Leads with who it affects, organizer, guest responses and people named without invitations, then the principal’s relationship/history and recorded meeting lengths, and findings for the touched days. Pass calendars to read colleagues’ busy windows without event details.',
  properties: {
    start: { type: 'string', description: DATE_TIME },
    end: { type: 'string', description: DATE_TIME },
    calendar: CALENDAR,
    event: EVENT,
    title: { type: 'string', description: 'The proposed meeting’s title.' },
    location: { type: 'string', description: 'Proposed place, phone number or link.' },
    guests: { ...ADDRESSES, description: 'The proposed guests’ email addresses.' },
    calendars: {
      ...ADDRESSES,
      description: 'Colleague calendar IDs whose busy windows to read instead of checking principal event details.',
    },
    kind: { type: 'string', description: 'The meeting kind you choose; never inferred by the host.' },
  },
  required: ['start', 'end'],
  repeatable: true,
  timeoutMs: CALENDAR_REQUEST_TIMEOUT_MS,
});
const SEND_UPDATES = {
  type: 'string',
  enum: ['all', 'none'],
  description:
    'Your choice: all asks Google to notify guests; none sends no Google updates. The answer states who was notified.',
} as const;
const SCOPE = {
  type: 'string',
  enum: ['event', 'following'],
  description:
    'event changes the supplied event or single occurrence; following changes that occurrence and all after it by splitting the series.',
} as const;
export const changeEvent = requestTool({
  name: 'change_event',
  description:
    'Move or edit an event on a principal calendar or your own, conditioned on the version read. Fields omitted stay unchanged. Reports who it affects, who organizes it, Google’s outcome and your guest-update choice, then best-effort findings for both old and new days. People named without invitations are reported as information; the host sends no separate contact.',
  properties: {
    calendar: CALENDAR,
    event: EVENT,
    send_updates: SEND_UPDATES,
    scope: SCOPE,
    title: { type: 'string', description: 'New title.' },
    start: { type: 'string', description: `New start: ${DATE_TIME}; for all-day events, first date.` },
    end: { type: 'string', description: `New end: ${DATE_TIME}; for all-day events, last date, included.` },
    all_day: { type: 'boolean' },
    timezone: { type: 'string' },
    notes: { type: 'string', description: 'New notes; empty clears.' },
    location: { type: 'string', description: 'New location; empty clears.' },
    guests: {
      ...ADDRESSES,
      description: 'The full guest list to keep, with the calendar owner retained and existing responses preserved.',
    },
    free: { type: 'boolean' },
    private: { type: 'boolean' },
    recurrence: ADDRESSES,
    video_call: { type: 'boolean' },
    reminders: { type: 'string', enum: ['default', 'none'] },
    kind: { type: 'string' },
    matter: MATTER,
    parent_event: EVENT,
    parent_calendar: CALENDAR,
    parent_start: { type: 'string' },
    block_kind: { type: 'string' },
  },
  required: ['calendar', 'event', 'send_updates'],
  repeatable: true,
  timeoutMs: CALENDAR_REQUEST_TIMEOUT_MS,
});
export const cancelEvent = requestTool({
  name: 'cancel_event',
  description:
    'Cancel an event or one occurrence and optionally all following, over the version read, choosing whether Google notifies guests. For another organizer’s event, reports the effect on the principal’s copy and that respond_to_event declines it and tells the organizer. Returns its outcome followed by findings; no separate contact is sent.',
  properties: { calendar: CALENDAR, event: EVENT, send_updates: SEND_UPDATES, scope: SCOPE },
  required: ['calendar', 'event', 'send_updates'],
  repeatable: true,
  timeoutMs: CALENDAR_REQUEST_TIMEOUT_MS,
});
registerTools(
  [createEvent, changeGuests, respondToEvent, days, check, changeEvent, cancelEvent, peopleStats],
  CALENDAR_CAPABILITY,
);
