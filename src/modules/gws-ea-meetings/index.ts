/**
 * GWS-EA's scheduling (KTD7): `external-email`'s four tools on the
 * principal's calendar, each bound to the email thread whose session calls
 * it (`tools.ts`). Nothing reserves a time before someone agrees to it; the
 * tools' calendar writes take turns across every thread.
 *
 *   free_time, book, change_booking, cancel_booking
 *
 * Beside them, `main`'s three writes on events, on the principal's calendars
 * or the assistant's own, which `gog` cannot make with the principal on the
 * guest list or with the private-details check, and cannot answer an event
 * the principal organizes (`principal-events.ts`), and its two calendar
 * facts, counted from Google's own answer (`calendar-facts.ts`), for a group
 * holding Google Calendar:
 *
 *   create_event, change_guests, respond_to_event, find_conflicts, people_stats
 *
 * Each is a delivery action with a guard (`guard.ts`): the scheduling tools
 * admit only `external-email`, from one email thread's session, and main's
 * a group holding Google Calendar. Each request gets one `action_response`,
 * refusals included. The runner's tool for each carries the same name.
 *
 * What a thread booked lives in the inbox's thread map (`thread-calendar.ts`);
 * this module has no tables of its own.
 */
import { answeredGuard, answeringAction, forbidden, type ActionAnswer } from '../../cli/delivery-action.js';
import { registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import { GOOGLE_CONNECTION_DOWN, isGoogleConnectionDown } from '../gws-ea-google/agent-boundary.js';
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

/**
 * An answer whose Google connection only the operator can restore tells
 * its agent so, and what to do meanwhile (R25): the error's own words, which
 * name the service and the remedy, go to the host log.
 */
function withConnectionStep(action: string, answer: ActionAnswer, nextStep: string): ActionAnswer {
  return async (content, session, requestId) => {
    try {
      return await answer(content, session, requestId);
    } catch (error) {
      if (!isGoogleConnectionDown(error)) throw error;
      log.error('A calendar tool found the Google connection down', { action, sessionId: session.id, err: error });
      throw forbidden(`${GOOGLE_CONNECTION_DOWN} ${nextStep}`);
    }
  };
}

/** What external-email does meanwhile: main tells the principal. */
const EXTERNAL_EMAIL_STEP = "Wake main with tell_main, saying what you couldn't do on this thread, and wait for main.";
/** What main does meanwhile, as its guidance has it for any account of its own that stops working. */
const MAIN_STEP = "Tell the principal in a line what you can't do, and carry on with the rest.";

const scheduling = createSchedulingTools({ calendar: calendarApi });

/** external-email's scheduling tools, by action name; each acts on the calling thread alone. */
const SCHEDULING_REQUESTS: ReadonlyArray<readonly [string, ActionAnswer]> = [
  ['free_time', scheduling.freeTime],
  ['book', scheduling.book],
  ['change_booking', scheduling.changeBooking],
  ['cancel_booking', scheduling.cancelBooking],
];

for (const [action, answer] of SCHEDULING_REQUESTS) {
  registerDeliveryAction(
    action,
    answeringAction(action, withConnectionStep(action, answer, EXTERNAL_EMAIL_STEP)),
    answeredGuard(threadCalendarAction),
  );
}

const principalEvents = createPrincipalEventTools({ calendar: calendarApi });
const facts = createCalendarFactTools({ calendar: calendarApi });

for (const [action, answer] of [
  ['create_event', principalEvents.createEvent],
  ['change_guests', principalEvents.changeGuests],
  ['respond_to_event', principalEvents.respondToEvent],
  ['find_conflicts', facts.findConflicts],
  ['people_stats', facts.peopleStats],
] as const) {
  registerDeliveryAction(
    action,
    answeringAction(action, withConnectionStep(action, answer, MAIN_STEP)),
    answeredGuard(principalEventAction),
  );
}

export { createMeetingsCalendarApi, type CalendarEvent, type MeetingsCalendarApi } from './calendar-api.js';
export { TAG_THREAD } from './tools.js';
