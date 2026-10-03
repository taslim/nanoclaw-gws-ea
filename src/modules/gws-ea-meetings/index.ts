/**
 * GWS-EA's meetings (KTD5, KTD11, KTD12): the store of every scheduling job
 * `main` hands to `external-email`, and the typed requests that carry them.
 *
 *   - `main` → host: `meeting_arrange`, `meeting_reschedule`,
 *     `meeting_ask_organizer`, `meeting_cancel`, `meeting_amend`.
 *   - `external-email` → host: `meeting_free_time`, `meeting_hold`,
 *     `meeting_release_holds`, `meeting_book` (`calendar-actions.ts`), and
 *     `meeting_outcome`.
 *
 * Each is a delivery action with a guard (`guard.ts`) that binds the caller
 * to the profile's agent pointers, and external-email's to its meeting's
 * session. Each request gets one `action_response`, errors included
 * (`answering` in `handoff.ts`).
 * `main` holds its side through the `gws-ea-meetings` capability, on by
 * default; `external-email`'s side is `gws-ea-meetings-external`.
 *
 * A forgotten person's meetings, threads, and sessions are purged, and a
 * thread the audience check stops ends its meeting at once.
 *
 * Follow-through (KTD12, `follow-through.ts`) runs on a module timer each
 * minute: a quiet thread's nudge and give-up, closing a booked meeting's
 * conversation once its event has passed, and holds or rooms left to
 * finish. The inbox tells it when a counterpart replies. Making room (R14,
 * `room.ts`) lists the meetings that could move for a needs-room outcome.
 */
import { setTimeout as delay } from 'node:timers/promises';

import { registerCapability } from '../../capabilities.js';
import { writeActionResponse } from '../../cli/delivery-action.js';
import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import { registerDeliveryAction } from '../../delivery.js';
import type { DeliveryGuardSpec } from '../../delivery-guard.js';
import type { GuardedAction } from '../../guard/index.js';
import { onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { hostGoogleAccessToken } from '../gws-ea-google/index.js';
import { getInboxHealth, registerThreadReplyHook } from '../gws-ea-inbox/index.js';
import { registerPersonForgetHook } from '../gws-ea-people/index.js';
import { registerThreadStoppedHook } from '../gws-ea-privacy/index.js';
import { createMeetingsCalendarApi, type MeetingsCalendarApi } from './calendar-api.js';
import { createCalendarActions, FREE_TIME_ACTION } from './calendar-actions.js';
import { createFollowThrough } from './follow-through.js';
import { meetingCalendarAction, meetingOutcomeAction, meetingRequestAction } from './guard.js';
import { answering, createMeetingHandoff, requestIdOf, type Handle } from './handoff.js';
import {
  gwsEaMeetingsCalendarActionsMigration,
  gwsEaMeetingsMigration,
  gwsEaMeetingsRoomsMigration,
} from './migration.js';
import { createRoom } from './room.js';

registerMigration(gwsEaMeetingsMigration);
registerMigration(gwsEaMeetingsCalendarActionsMigration);
registerMigration(gwsEaMeetingsRoomsMigration);

/** How often follow-through runs. */
const FOLLOW_THROUGH_INTERVAL_MS = 60_000;

/** main's side of the handoff: the five requests. */
export const MEETINGS_CAPABILITY = 'gws-ea-meetings';

registerCapability(MEETINGS_CAPABILITY, {
  description:
    'arrange, reschedule, ask_organizer, cancel, amend: hand scheduling jobs to external-email, which carries them out by email',
  default: 'on',
  instructions: [MEETINGS_CAPABILITY],
});

let calendar: MeetingsCalendarApi | undefined;
// Built on first use: only a GWS-EA host with the assistant's Google sign-in reads a calendar.
const calendarApi = (): MeetingsCalendarApi =>
  (calendar ??= createMeetingsCalendarApi({ token: () => hostGoogleAccessToken('calendar-host') }));

// Making room and booking each need the other: a booked move hands its room over, and the room
// holds through the calendar actions. Each reaches the other only when called.
const room = createRoom({
  calendar: calendarApi,
  openTimes: (meeting, range, ignore) => actions.openTimes(meeting, range, ignore),
  holdSlots: (meeting, slotIds) => actions.holdSlots(meeting, slotIds),
});
const actions = createCalendarActions({ calendar: calendarApi, afterBooking: room.handOverFrom });
const handoff = createMeetingHandoff({
  calendar: calendarApi,
  releaseHolds: actions.releaseHolds,
  bookDirectly: actions.bookDirectly,
  roomCandidates: room.candidates,
  roomCandidate: room.candidate,
});
const followThrough = createFollowThrough({
  calendar: calendarApi,
  inboxHealth: getInboxHealth,
  giveUp: handoff.giveUpUnanswered,
  closeBooked: (meeting) => handoff.endMeeting(meeting, 'booked', true),
  releaseHolds: (meeting) => actions.releaseHolds(meeting, 'all'),
  handOverRoom: room.handOver,
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

/** Every request, by action name, with its guard; each is answered once (`answering`). */
const REQUESTS: ReadonlyArray<readonly [string, Handle, GuardedAction]> = [
  // main's
  ['meeting_arrange', handoff.arrange, meetingRequestAction],
  ['meeting_reschedule', handoff.reschedule, meetingRequestAction],
  ['meeting_ask_organizer', handoff.askOrganizer, meetingRequestAction],
  ['meeting_cancel', handoff.cancel, meetingRequestAction],
  ['meeting_amend', handoff.amend, meetingRequestAction],
  // external-email's outcome, and its calendar tools
  ['meeting_outcome', handoff.outcome, meetingOutcomeAction],
  [FREE_TIME_ACTION, actions.freeTime, meetingCalendarAction],
  ['meeting_hold', actions.hold, meetingCalendarAction],
  ['meeting_release_holds', actions.releaseHoldsRequest, meetingCalendarAction],
  ['meeting_book', actions.book, meetingCalendarAction],
];

for (const [action, handle, guardAction] of REQUESTS) {
  registerDeliveryAction(action, answering(action, handle), guardSpec(guardAction));
}

registerPersonForgetHook('gws-ea-meetings:purge', (person) => handoff.forgetPerson(person));
registerThreadStoppedHook('gws-ea-meetings:close', (thread) => handoff.threadStopped(thread));
registerThreadReplyHook('gws-ea-meetings:follow-through', (threadKey) => followThrough.replied(threadKey));

/** One pass of follow-through, as the host's timer runs it each minute. Never throws. */
export function runFollowThrough(): Promise<void> {
  return followThrough.tick();
}

onHostStart(async ({ signal }) => {
  if (!(await getDb().hasTable('gws_ea_meetings'))) return;
  // Started, not awaited: host startup never waits on Google. The first pass runs at once,
  // so a deadline that came due while the host was down fires as soon as the inbox has read past it.
  void (async () => {
    while (!signal.aborted) {
      await followThrough.tick();
      await delay(FOLLOW_THROUGH_INTERVAL_MS, undefined, { signal }).catch(() => undefined);
    }
  })();
});

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
export {
  MOVED_NOTE_TYPE,
  NUDGE_NOTE_TYPE,
  OUTCOME_NOTE_TYPE,
  ROOM_LOST_NOTE_TYPE,
  ROOM_NOTE_TYPE,
  type OutcomeNote,
  type RoomCandidate,
} from './notes.js';
