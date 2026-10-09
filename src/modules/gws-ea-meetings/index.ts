/**
 * GWS-EA's scheduling (KTD7): `external-email`'s four tools on the
 * principal's calendar, each bound to the email thread whose session calls
 * it (`tools.ts`). Nothing reserves a time before someone agrees to it; the
 * tools' calendar writes take turns across every thread.
 *
 *   free_time, book, change_booking, cancel_booking
 *
 * Beside them, `main`'s two writes on the principal's own events, which list
 * the principal as an accepted guest as `gog` cannot (`principal-events.ts`),
 * and its two calendar facts, counted from Google's own answer
 * (`calendar-facts.ts`), for a group holding Google Calendar:
 *
 *   create_event, change_guests, find_conflicts, people_stats
 *
 * Each is a delivery action with a guard (`guard.ts`): the scheduling tools
 * admit only `external-email`, from one email thread's session, and main's
 * a group holding Google Calendar. Each request gets one `action_response`,
 * refusals included. The runner's tool for each carries the same name.
 *
 * What a thread booked lives in the inbox's thread map (`thread-calendar.ts`);
 * this module has no tables of its own.
 */
import { answeredGuard, answeringAction, type ActionAnswer } from '../../cli/delivery-action.js';
import { registerDeliveryAction } from '../../delivery.js';
import { hostGoogleAccessToken } from '../gws-ea-google/index.js';
import { createMeetingsCalendarApi, type MeetingsCalendarApi } from './calendar-api.js';
import { createCalendarFactTools } from './calendar-facts.js';
import { principalEventAction, threadCalendarAction } from './guard.js';
import { createPrincipalEventTools } from './principal-events.js';
import { createSchedulingTools } from './tools.js';

let calendar: MeetingsCalendarApi | undefined;
// Built on first use: only a GWS-EA host with the assistant's Google sign-in reads a calendar.
const calendarApi = (): MeetingsCalendarApi =>
  (calendar ??= createMeetingsCalendarApi({ token: () => hostGoogleAccessToken('calendar-host') }));

const scheduling = createSchedulingTools({ calendar: calendarApi });

/** external-email's scheduling tools, by action name; each acts on the calling thread alone. */
const SCHEDULING_REQUESTS: ReadonlyArray<readonly [string, ActionAnswer]> = [
  ['free_time', scheduling.freeTime],
  ['book', scheduling.book],
  ['change_booking', scheduling.changeBooking],
  ['cancel_booking', scheduling.cancelBooking],
];

for (const [action, answer] of SCHEDULING_REQUESTS) {
  registerDeliveryAction(action, answeringAction(action, answer), answeredGuard(threadCalendarAction));
}

const principalEvents = createPrincipalEventTools({ calendar: calendarApi });
const facts = createCalendarFactTools({ calendar: calendarApi });

for (const [action, answer] of [
  ['create_event', principalEvents.createEvent],
  ['change_guests', principalEvents.changeGuests],
  ['find_conflicts', facts.findConflicts],
  ['people_stats', facts.peopleStats],
] as const) {
  registerDeliveryAction(action, answeringAction(action, answer), answeredGuard(principalEventAction));
}

export { createMeetingsCalendarApi, type CalendarEvent, type MeetingsCalendarApi } from './calendar-api.js';
export { TAG_THREAD } from './tools.js';
