/**
 * GWS-EA's meetings (KTD5, KTD11, KTD12, KTD16): the store of every job
 * `main` hands to `external-email`, a meeting to schedule or a conversation
 * to hold, and the typed requests that carry them.
 *
 *   - `main` → host: `meeting_arrange`, `meeting_reschedule`,
 *     `meeting_cancel`, `meeting_amend`, `email_respond`, `email_dismiss`,
 *     and `email_reply_to_principal`.
 *   - `external-email` → host: `meeting_free_time`, `meeting_hold`,
 *     `meeting_book` (`calendar-actions.ts`), `meeting_ask_main`,
 *     `email_recipients`, and `meeting_outcome`.
 *
 * Each runner tool is named after the action it sends (`MEETING_ACTIONS`).
 *
 * Each is a delivery action with a guard (`guard.ts`) that binds the caller
 * to the profile's agent pointers, and external-email's to its meeting's
 * session. Each request gets one `action_response`, errors included
 * (`answering` in `handoff.ts`).
 * `main` holds its side through the `gws-ea-meetings` capability, on by
 * default; `external-email`'s side is `gws-ea-meetings-external`.
 *
 * A forgotten person's meetings, threads, and sessions are purged, and a
 * thread the audience check stops ends its meeting at once. A delivered
 * email starts its job's quiet count, and a called-off meeting's closing
 * line ends it. `main` hears of any email in a job's thread delivery gave up
 * on, any email to it given up after its retries, and any turn of it that
 * failed.
 *
 * Follow-through (KTD12, `follow-through.ts`) runs on a module timer each
 * minute: a quiet thread's nudge and give-up, a reminder to `main` of a
 * question it left open, closing a booked meeting's conversation once its
 * event has passed, and holds or rooms left to finish. The inbox tells it
 * when a counterpart replies. Making room (R14, `room.ts`) lists the
 * meetings that could move for someone inner circle or close.
 */
import { setTimeout as delay } from 'node:timers/promises';

import { registerCapability } from '../../capabilities.js';
import { writeActionResponse } from '../../cli/delivery-action.js';
import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import { registerDeliveryAction, registerDeliveryFailedHook, registerPostDeliveryHook } from '../../delivery.js';
import type { DeliveryGuardSpec } from '../../delivery-guard.js';
import type { GuardedAction } from '../../guard/index.js';
import { onHostStart } from '../../host-lifecycle.js';
import { registerInboundFailedHook } from '../../reconcile-session.js';
import { log } from '../../log.js';
import { hostGoogleAccessToken } from '../gws-ea-google/index.js';
import { getInboxHealth, registerThreadReplyHook } from '../gws-ea-inbox/index.js';
import { registerTurnFailedHook } from '../gws-ea-notices/index.js';
import { registerPersonForgetHook } from '../gws-ea-people/index.js';
import { registerThreadStoppedHook } from '../gws-ea-privacy/index.js';
import { createMeetingsCalendarApi, type MeetingsCalendarApi } from './calendar-api.js';
import { createCalendarActions, FREE_TIME_ACTION } from './calendar-actions.js';
import { createFollowThrough } from './follow-through.js';
import {
  meetingAskAction,
  meetingCalendarAction,
  meetingOutcomeAction,
  meetingRecipientsAction,
  meetingRequestAction,
} from './guard.js';
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

/** main's side of the handoff: its requests. */
const MEETINGS_CAPABILITY = 'gws-ea-meetings';

registerCapability(MEETINGS_CAPABILITY, {
  description:
    'meeting_arrange, meeting_reschedule, meeting_cancel, meeting_amend, email_respond, email_dismiss, email_reply_to_principal: hand scheduling jobs and answers to external-email, which carries them out by email, close threads, and answer the principal by email',
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
  hasOpenTime: actions.hasOpenTime,
  updateBooking: actions.updateBooking,
});
const followThrough = createFollowThrough({
  calendar: calendarApi,
  inboxHealth: getInboxHealth,
  remindMain: handoff.remindMain,
  giveUp: handoff.giveUpUnanswered,
  closeBooked: (meeting) => handoff.endMeeting(meeting, 'booked', true),
  releaseHolds: (meeting) => actions.releaseHolds(meeting, 'all'),
  handOverRoom: room.handOver,
  finishCutShortReply: handoff.finishCutShortReply,
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

/**
 * Every request, by action name, with its guard; each is answered once
 * (`answering`). The runner's tool for each carries the same name.
 */
const REQUESTS: ReadonlyArray<readonly [string, Handle, GuardedAction]> = [
  // main's
  ['meeting_arrange', handoff.arrange, meetingRequestAction],
  ['meeting_reschedule', handoff.reschedule, meetingRequestAction],
  ['meeting_cancel', handoff.cancel, meetingRequestAction],
  ['meeting_amend', handoff.amend, meetingRequestAction],
  ['email_respond', handoff.respond, meetingRequestAction],
  ['email_dismiss', handoff.dismiss, meetingRequestAction],
  ['email_reply_to_principal', handoff.replyToPrincipal, meetingRequestAction],
  // external-email's question, its outcome, its recipients, and its calendar tools
  ['meeting_ask_main', handoff.askMain, meetingAskAction],
  ['meeting_outcome', handoff.outcome, meetingOutcomeAction],
  ['email_recipients', handoff.recipients, meetingRecipientsAction],
  [FREE_TIME_ACTION, actions.freeTime, meetingCalendarAction],
  ['meeting_hold', actions.hold, meetingCalendarAction],
  ['meeting_book', actions.book, meetingCalendarAction],
];

/** The action names the meetings module answers, which the runner's tools send. */
export const MEETING_ACTIONS: readonly string[] = REQUESTS.map(([action]) => action);

for (const [action, handle, guardAction] of REQUESTS) {
  registerDeliveryAction(action, answering(action, handle), guardSpec(guardAction));
}

registerPersonForgetHook('gws-ea-meetings:purge', (person) => handoff.forgetPerson(person));
registerThreadStoppedHook('gws-ea-meetings:close', (thread) => handoff.threadStopped(thread));
registerThreadReplyHook('gws-ea-meetings:follow-through', (threadKey) => followThrough.replied(threadKey));
// A delivered email starts its job's quiet count, and a called-off meeting's closing line ends it.
// main hears of every email a meeting's conversation wrote that delivery gave up on.
registerPostDeliveryHook((msg, session) => handoff.emailDelivered(msg, session));
registerDeliveryFailedHook((failed, session) => handoff.sendsFailed(failed, session));
// Nor does an email to a meeting's conversation it could not process, or a turn of it that failed.
registerInboundFailedHook((failed, session) => handoff.inboundFailed(failed, session));
registerTurnFailedHook('gws-ea-meetings:stalled', (route, session) => handoff.turnFailed(route, session));

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
  STALLED_NOTE_TYPE,
  UNSENT_NOTE_TYPE,
  type OutcomeNote,
  type RoomCandidate,
} from './notes.js';
