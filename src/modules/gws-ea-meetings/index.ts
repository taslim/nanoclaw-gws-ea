import { calendarWriteLogMigration } from './week/write-log-migration.js';
import { pendingCalendarChangesMigration } from './week/pending-changes-migration.js';
import '../gws-ea-inbox/index.js';
import '../gws-ea-chats/index.js';
import '../gws-ea-whereabouts/index.js';
import '../gws-ea-preferences/index.js';

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
import { registerCalendarChangeRenderer } from '../gws-ea-inbox/calendar-notifications.js';
import { createDaysTools, loadCalendarWeek, renderDays, boundedCalendarMessage } from './days.js';
import { boundary } from '../gws-ea-whereabouts/clock.js';
import { loadTimeline } from '../gws-ea-whereabouts/timeline.js';
import { checkWeek, presentFinding } from './week/checker.js';
import { inWindow, spanOf } from './week/model.js';
import { createPrincipalEventTools } from './principal-events.js';
import { createWeekRefresher } from './week/refresh.js';

let calendar: MeetingsCalendarApi | undefined;
// Built on first use: only a GWS-EA host with the assistant's Google sign-in reads a calendar.
const calendarApi = (): MeetingsCalendarApi =>
  (calendar ??= createMeetingsCalendarApi({ token: () => hostGoogleAccessToken('calendar-host') }));

const weekRefresher = createWeekRefresher({ calendar: calendarApi });
onHostStart(() => {
  void weekRefresher
    .start()
    .catch((error: unknown) => log.warn('The initial coming-days view is unavailable', { error }));
});
onHostShutdown(() => weekRefresher.stop());

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
registerMigration(calendarWriteLogMigration);
registerMigration(pendingCalendarChangesMigration);

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
        async (session) => (await resolveBookingSurface(session)).words.connectionStep,
      ),
    ),
    answeredGuard(bookingAction),
  );
}

const principalEvents = createPrincipalEventTools({ calendar: calendarApi });
const facts = createCalendarFactTools({ calendar: calendarApi });
const days = createDaysTools({ calendar: calendarApi });

for (const [action, answer] of [
  ['create_event', principalEvents.createEvent],
  ['change_guests', principalEvents.changeGuests],
  ['respond_to_event', principalEvents.respondToEvent],
  ['days', days.days],
  ['check', days.check],
  ['change_event', principalEvents.changeEvent],
  ['cancel_event', principalEvents.cancelEvent],
  ['people_stats', facts.peopleStats],
] as const) {
  registerDeliveryAction(
    action,
    answeringAction(action, withConnectionStep(action, answer, MAIN_STEP)),
    answeredGuard(principalEventAction),
  );
}

export { createMeetingsCalendarApi, type CalendarEvent, type MeetingsCalendarApi } from './calendar-api.js';

registerCalendarChangeRenderer(async (changes, at, context) => {
  const changed = (calendarId: string, eventId: string | undefined) =>
    changes.some(({ notice }) => notice.calendarId === calendarId && notice.eventId === eventId);
  const timeline = context.timeline ?? (await loadTimeline());
  const left = (context.previous ?? []).flatMap((copy) =>
    changed(copy.calendarId, copy.event.id) ? (spanOf(copy.event, timeline) ?? []) : [],
  );
  let week = context.week;
  if (!week) {
    const details = await Promise.all(
      changes.map(({ notice }) => calendarApi().getEventDetail(notice.calendarId, notice.eventId)),
    );
    const spans = [...left, ...details.flatMap((event) => (event && spanOf(event, timeline)) ?? [])];
    const start = spans.length ? Math.min(...spans.map((span) => span.start)) : at.getTime();
    const end = spans.length ? Math.max(...spans.map((span) => span.end)) : start + 86_400_000;
    week = await loadCalendarWeek(calendarApi(), { start, end: Math.max(start + 1, end), timeline });
  }
  const affected = week.events.filter((e) => changed(e.calendarId, e.id));
  // The days the change left and the days it now holds.
  const touched = week.days
    .filter((day) => {
      const zone = day.zone ?? 'UTC';
      const window = { start: boundary(day.date, zone, 'start'), end: boundary(day.date, zone, 'end') };
      return [...left, ...affected].some((span) => inWindow(span, window));
    })
    .map((day) => day.date);
  const findings = checkWeek(week).filter((f) => f.day !== null && touched.includes(f.day));
  return {
    text: boundedCalendarMessage(
      'Calendar facts:',
      [
        ...affected.map((e) => renderDays({ ...week, events: [e] })),
        ...(touched.length
          ? [
              `Findings for ${touched.join(', ')}:`,
              ...(findings.length ? findings.map((f) => presentFinding(f, week)) : ['No findings.']),
            ]
          : []),
      ],
      10_000,
    ),
    pieces: changes.map(({ notice }) => ({
      kind: 'event' as const,
      reference: `${notice.calendarId}/${notice.eventId}`,
      ...(notice.change === 'created'
        ? {
            arrival: {
              from: affected.find((e) => e.calendarId === notice.calendarId && e.id === notice.eventId)?.event.organizer
                ?.email,
            },
          }
        : {}),
    })),
  };
});
