import { answeredGuard, answeringAction, forbidden, type ActionAnswer } from '../../cli/delivery-action.js';
import { registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import { GOOGLE_CONNECTION_DOWN, isGoogleConnectionDown } from '../gws-ea-google/agent-boundary.js';
import { registerMigration } from '../../db/migrations/index.js';
import { registerChatLifecycleTask } from '../gws-ea-chats/lifecycle-tasks.js';
import { chatBookingRequestsMigration } from './chat-booking-migration.js';
import { chatBookingReportsMigration } from './chat-booking-report-migration.js';
import { hostGoogleAccessToken } from '../gws-ea-google/index.js';
import { createMeetingsCalendarApi, type MeetingsCalendarApi } from './calendar-api.js';
import { createCalendarFactTools } from './calendar-facts.js';
import { chatCalendarAction, principalEventAction, threadCalendarAction } from './guard.js';
import { createChatSchedulingTools } from './chat-calendar.js';
import { createPrincipalEventTools } from './principal-events.js';
import { createSchedulingTools } from './tools.js';

let calendar: MeetingsCalendarApi | undefined;
// Built on first use: only a GWS-EA host with the assistant's Google sign-in reads a calendar.
const calendarApi = (): MeetingsCalendarApi =>
  (calendar ??= createMeetingsCalendarApi({ token: () => hostGoogleAccessToken('calendar-host') }));

/**
 * With the Google connection down, which only the operator can restore, the
 * agent hears so and `nextStep`; the error's own words, which name the
 * service and the remedy, go only to the host log.
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

/** to: external-email */
const EXTERNAL_EMAIL_STEP = "Wake main with tell_main, saying what you couldn't do on this thread, and wait for main.";
/** As main's guidance has it for a Google connection that stops working. */
const MAIN_STEP = "Tell the principal in a line what you can't do, and carry on with the rest.";

const scheduling = createSchedulingTools({ calendar: calendarApi });

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

registerMigration(chatBookingRequestsMigration);
registerMigration(chatBookingReportsMigration);
const chatScheduling = createChatSchedulingTools({ calendar: calendarApi });
registerChatLifecycleTask('gws-ea-meetings:chat-bookings', chatScheduling.resumePending);
// The runner's chat tools send these actions under the email tools' names (`action` in their `requestTool`).
for (const [action, answer] of [
  ['chat_free_time', chatScheduling.freeTime],
  ['chat_book', chatScheduling.book],
  ['chat_change_booking', chatScheduling.changeBooking],
  ['chat_cancel_booking', chatScheduling.cancelBooking],
] as const) {
  registerDeliveryAction(action, answeringAction(action, answer), answeredGuard(chatCalendarAction));
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
