/**
 * main's two writes on the principal's own events, through the host. gog
 * cannot list the principal as an accepted guest, so creating an event and
 * changing who an event invites go to the host, which keeps the principal on
 * every event it writes (src/modules/gws-ea-meetings/principal-events.ts).
 * Everything else on the calendar stays with gog, as the gcalendar skill
 * teaches.
 */
import { requestTool } from '../action-request.js';
import { registerTools } from './server.js';

/** Google Calendar's key, which also grants gog's calendar commands; named here, since the tools' tests load them ahead of the barrel. */
const CALENDAR_CAPABILITY = 'google-calendar';

/** How long a tool waits for the host; a request may still go through after that. */
export const CALENDAR_REQUEST_TIMEOUT_MS = 120_000;

const CALENDAR = {
  type: 'string',
  description: "The calendar's ID: the principal's address for their primary calendar.",
} as const;
const ADDRESSES = { type: 'array', items: { type: 'string' } } as const;
const DATE_TIME = 'a date and time with its UTC offset, as time_resolve gives it, such as 2026-10-12T09:00:00-07:00';

export const createEvent = requestTool({
  name: 'create_event',
  description:
    "Put an event on one of the principal's calendars. The principal is always on its guest list, accepted, as on an event they made themselves; anyone you name in guests is invited too. Google emails no one. Answers with the event's id.",
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
  },
  required: ['calendar', 'title', 'start', 'end'],
  repeatable: false,
  timeoutMs: CALENDAR_REQUEST_TIMEOUT_MS,
});

export const changeGuests = requestTool({
  name: 'change_guests',
  description:
    "Invite people to an event the principal organizes, or take them off it. Everyone's answer stays as it was, and the principal stays on it: accepted, unless they answered otherwise. Google emails no one.",
  properties: {
    calendar: CALENDAR,
    event: {
      type: 'string',
      description: "The event's id, as gog calendar events gives it: an occurrence's own id changes that one alone.",
    },
    add: { ...ADDRESSES, description: 'Email addresses to invite.' },
    remove: { ...ADDRESSES, description: 'Email addresses to take off it.' },
  },
  required: ['calendar', 'event'],
  repeatable: true,
  timeoutMs: CALENDAR_REQUEST_TIMEOUT_MS,
});

registerTools([createEvent, changeGuests], CALENDAR_CAPABILITY);
