// The shared booking migration consumes both surfaces' released tables.
import '../gws-ea-inbox/index.js';
import '../gws-ea-chats/index.js';

import { answeredGuard, answeringAction, forbidden, type DeferredActionAnswer } from '../../cli/delivery-action.js';
import { registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import { onHostStart, onHostShutdown } from '../../host-lifecycle.js';
import { createBookingTools } from './booking.js';
import { GOOGLE_CONNECTION_DOWN, isGoogleConnectionDown } from '../gws-ea-google/agent-boundary.js';
import { registerMigration } from '../../db/migrations/index.js';
import { chatBookingRequestsMigration } from './chat-booking-migration.js';
import { chatBookingReportsMigration } from './chat-booking-report-migration.js';
import { hostGoogleAccessToken } from '../gws-ea-google/index.js';
import { createMeetingsCalendarApi, type MeetingsCalendarApi } from './calendar-api.js';
import { createCalendarFactTools } from './calendar-facts.js';
import { bookingAction, principalEventAction } from './guard.js';
import { resolveBookingSurface } from './booking-surface.js';
import { bookingsMigration } from './bookings-migration.js';
import type { Session } from '../../types.js';
import { createPrincipalEventTools } from './principal-events.js';

let calendar: MeetingsCalendarApi | undefined;
// Built on first use: only a GWS-EA host with the assistant's Google sign-in reads a calendar.
const calendarApi = (): MeetingsCalendarApi =>
  (calendar ??= createMeetingsCalendarApi({ token: () => hostGoogleAccessToken('calendar-host') }));

const booking = createBookingTools({ calendar: calendarApi });
let bookingTimer: NodeJS.Timeout | undefined;
let bookingStopped = true;
let bookingSweep: Promise<void> = Promise.resolve();
function scheduleBookingSweep(): void {
  if (bookingStopped) return;
  bookingTimer = setTimeout(runBookingSweep, 60_000);
  bookingTimer.unref();
}
function runBookingSweep(): void {
  bookingSweep = booking
    .resumePending()
    .catch((error: unknown) => {
      log.error('Booking recovery sweep failed', { error });
    })
    .finally(scheduleBookingSweep);
}
onHostStart(() => {
  bookingStopped = false;
  runBookingSweep();
});
onHostShutdown(async () => {
  bookingStopped = true;
  clearTimeout(bookingTimer);
  await bookingSweep;
});

/**
 * With the Google connection down, which only the operator can restore, the
 * agent hears so and `nextStep`; the error's own words, which name the
 * service and the remedy, go only to the host log.
 */
function withConnectionStep(
  action: string,
  answer: DeferredActionAnswer,
  nextStep: string | ((session: Session) => Promise<string>),
): DeferredActionAnswer {
  return async (content, session, requestId) => {
    try {
      return await answer(content, session, requestId);
    } catch (error) {
      if (!isGoogleConnectionDown(error)) throw error;
      log.error('A calendar tool found the Google connection down', { action, sessionId: session.id, err: error });
      const step = typeof nextStep === 'string' ? nextStep : await nextStep(session);
      throw forbidden(`${GOOGLE_CONNECTION_DOWN} ${step}`);
    }
  };
}

/** As main's guidance has it for a Google connection that stops working. */
const MAIN_STEP = "Tell the principal in a line what you can't do, and carry on with the rest.";

registerMigration(chatBookingRequestsMigration);
registerMigration(chatBookingReportsMigration);
registerMigration(bookingsMigration);

for (const [action, answer] of [
  ['free_time', booking.freeTime],
  ['book', booking.book],
  ['change_booking', booking.changeBooking],
  ['cancel_booking', booking.cancelBooking],
] as const) {
  registerDeliveryAction(
    action,
    answeringAction(
      action,
      withConnectionStep(
        action,
        answer,
        async (session) => (await resolveBookingSurface(session)).surface.words.connectionStep,
      ),
    ),
    answeredGuard(bookingAction),
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
