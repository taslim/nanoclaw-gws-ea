/**
 * GWS-EA's meetings (KTD5, KTD11, KTD12): the store of every scheduling job
 * `main` hands to `external-email`, and the typed requests that carry them.
 *
 *   - `main` → host: `meeting_arrange`, `meeting_reschedule`,
 *     `meeting_ask_organizer`, `meeting_cancel`, `meeting_amend`.
 *   - `external-email` → host: `meeting_outcome`.
 *
 * Each is a delivery action with a guard (`guard.ts`) that binds the caller
 * to the profile's agent pointers and an outcome to its meeting's session.
 * Each request gets one `action_response`, errors included (`handoff.ts`).
 * `main` holds its side through the `gws-ea-meetings` capability, on by
 * default; `external-email`'s side is `gws-ea-meetings-external`.
 *
 * A forgotten person's meetings, threads, and sessions are purged, and a
 * thread the audience check stops ends its meeting at once.
 */
import { registerCapability } from '../../capabilities.js';
import { writeActionResponse } from '../../cli/delivery-action.js';
import { registerMigration } from '../../db/migrations/index.js';
import { registerDeliveryAction } from '../../delivery.js';
import type { DeliveryGuardSpec, GuardedDeliveryHandler } from '../../delivery-guard.js';
import type { GuardedAction } from '../../guard/index.js';
import { log } from '../../log.js';
import { hostGoogleAccessToken } from '../gws-ea-google/index.js';
import { registerPersonForgetHook } from '../gws-ea-people/index.js';
import { registerThreadStoppedHook } from '../gws-ea-privacy/index.js';
import { createMeetingsCalendarApi, type MeetingsCalendarApi } from './calendar-api.js';
import { meetingOutcomeAction, meetingRequestAction } from './guard.js';
import { createMeetingHandoff, requestIdOf } from './handoff.js';
import { gwsEaMeetingsMigration } from './migration.js';

registerMigration(gwsEaMeetingsMigration);

/** main's side of the handoff: the five requests. */
export const MEETINGS_CAPABILITY = 'gws-ea-meetings';

registerCapability(MEETINGS_CAPABILITY, {
  description:
    'arrange, reschedule, ask_organizer, cancel, amend: hand scheduling jobs to external-email, which carries them out by email',
  default: 'on',
  instructions: [MEETINGS_CAPABILITY],
});

let calendar: MeetingsCalendarApi | undefined;

const handoff = createMeetingHandoff({
  // Built on first use: only a GWS-EA host with the assistant's Google sign-in reads a calendar.
  calendar: () => (calendar ??= createMeetingsCalendarApi({ token: () => hostGoogleAccessToken('calendar-host') })),
  // The handoff creates no holds; the calendar actions that create them supply their release.
  releaseHolds: async () => undefined,
});

/** Every request is answered, a refusal included, so the calling tool never waits it out. */
function guardSpec(guardAction: GuardedAction): DeliveryGuardSpec {
  return {
    guardAction,
    precheck: (content, session) => {
      if (requestIdOf(content) !== undefined) return true;
      log.warn('Meeting request without a request id: nothing to answer', { sessionId: session.id });
      return false;
    },
    // These guards never hold; a hold would be a decision this action cannot honor.
    requestHold: async (content, session) => {
      const requestId = requestIdOf(content) ?? '';
      await writeActionResponse(session, requestId, {
        id: requestId,
        ok: false,
        error: { code: 'forbidden', message: 'This request cannot wait for an approval.' },
      });
    },
    onDeny: async (content, session, reason) => {
      const requestId = requestIdOf(content) ?? '';
      await writeActionResponse(session, requestId, {
        id: requestId,
        ok: false,
        error: { code: 'forbidden', message: reason },
      });
    },
  };
}

const MAIN_REQUESTS: ReadonlyArray<readonly [string, GuardedDeliveryHandler]> = [
  ['meeting_arrange', handoff.arrange],
  ['meeting_reschedule', handoff.reschedule],
  ['meeting_ask_organizer', handoff.askOrganizer],
  ['meeting_cancel', handoff.cancel],
  ['meeting_amend', handoff.amend],
];

for (const [action, handler] of MAIN_REQUESTS) registerDeliveryAction(action, handler, guardSpec(meetingRequestAction));
registerDeliveryAction('meeting_outcome', handoff.outcome, guardSpec(meetingOutcomeAction));

registerPersonForgetHook('gws-ea-meetings:purge', (person) => handoff.forgetPerson(person));
registerThreadStoppedHook('gws-ea-meetings:close', (thread) => handoff.threadStopped(thread));

export { createMeetingsCalendarApi, type CalendarEvent, type MeetingsCalendarApi } from './calendar-api.js';
export {
  getBooking,
  getMeeting,
  listOfferedSlots,
  type Booking,
  type Meeting,
  type MeetingCounterpart,
  type MeetingKind,
  type MeetingLevel,
  type MeetingState,
  type OfferedSlot,
  type Outcome,
} from './db.js';
export { OUTCOME_NOTE_TYPE, type OutcomeNote } from './notes.js';
