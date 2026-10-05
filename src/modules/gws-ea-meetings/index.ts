/**
 * GWS-EA's scheduling (KTD7): `external-email`'s five tools on the
 * principal's calendar, each bound to the email thread whose session calls
 * it (`tools.ts`), and the timer that releases each thread's holds once they
 * lapse.
 *
 *   free_time, hold, book, move_booking, cancel_booking
 *
 * Each is a delivery action with a guard (`guard.ts`) that admits only
 * `external-email`, from one email thread's session, and each request gets
 * one `action_response`, refusals included. The runner's tool for each
 * carries the same name.
 *
 * The inbox registers this module's store, before its own email channel's
 * (KTD10), and releases a forgotten person's threads' holds through
 * `releaseThreadHolds` before anything else of theirs goes.
 */
import { setTimeout as delay } from 'node:timers/promises';

import { answeredGuard, answeringAction, type ActionAnswer } from '../../cli/delivery-action.js';
import { getDb } from '../../db/connection.js';
import { registerDeliveryAction } from '../../delivery.js';
import { onHostStart } from '../../host-lifecycle.js';
import { hostGoogleAccessToken } from '../gws-ea-google/index.js';
import { createMeetingsCalendarApi, type MeetingsCalendarApi } from './calendar-api.js';
import { threadCalendarAction } from './guard.js';
import { createSchedulingTools } from './tools.js';

/** How often lapsed holds are released. */
const HOLD_SWEEP_INTERVAL_MS = 60_000;

let calendar: MeetingsCalendarApi | undefined;
// Built on first use: only a GWS-EA host with the assistant's Google sign-in reads a calendar.
const calendarApi = (): MeetingsCalendarApi =>
  (calendar ??= createMeetingsCalendarApi({ token: () => hostGoogleAccessToken('calendar-host') }));

const scheduling = createSchedulingTools({ calendar: calendarApi });

/** external-email's scheduling tools, by action name; each acts on the calling thread alone. */
const SCHEDULING_REQUESTS: ReadonlyArray<readonly [string, ActionAnswer]> = [
  ['free_time', scheduling.freeTime],
  ['hold', scheduling.hold],
  ['book', scheduling.book],
  ['move_booking', scheduling.moveBooking],
  ['cancel_booking', scheduling.cancelBooking],
];

for (const [action, answer] of SCHEDULING_REQUESTS) {
  registerDeliveryAction(action, answeringAction(action, answer), answeredGuard(threadCalendarAction));
}

/** Release every hold that lapsed, as the host's timer does each minute. Never throws. */
export function releaseExpiredHolds(): Promise<void> {
  return scheduling.releaseExpiredHolds();
}

/** Release every hold a thread placed; throws, with each hold left still recorded, when one could not go yet. */
export function releaseThreadHolds(threadKey: string): Promise<void> {
  return scheduling.releaseThreadHolds(threadKey);
}

onHostStart(async ({ signal }) => {
  if (!(await getDb().hasTable('gws_ea_thread_holds'))) return;
  // Started, not awaited: host startup never waits on Google. The first pass runs at once,
  // so a hold that lapsed while the host was down goes as soon as it starts.
  void (async () => {
    while (!signal.aborted) {
      await scheduling.releaseExpiredHolds();
      await delay(HOLD_SWEEP_INTERVAL_MS, undefined, { signal }).catch(() => undefined);
    }
  })();
});

export { createMeetingsCalendarApi, type CalendarEvent, type MeetingsCalendarApi } from './calendar-api.js';
export { BOOKING_FACT_TYPE, TAG_THREAD } from './tools.js';
