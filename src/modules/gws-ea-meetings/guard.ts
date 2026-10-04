/**
 * Who may send the handoff's typed requests (KTD5). Every request is checked
 * against the profile's agent pointers, never against anything the agent
 * says about itself:
 *
 * - `main` alone hands meetings and replies over, changes or cancels them,
 *   dismisses a thread waiting for it, and answers the principal by email;
 * - `external-email` alone reports an outcome, uses a meeting's calendar
 *   tools, or places the people its replies go to, and only for the meeting
 *   bound to the very session it calls from, so one thread can never act on
 *   another's meeting.
 *
 * No decision here ever holds for approval: these are structural checks.
 */
import { ALLOW, DENY, defineGuardedAction, type GuardActor } from '../../guard/index.js';
import { getExternalEmailAgentGroupId, getMainAgentGroupId } from '../gws-ea-profile/db.js';
import { getMeeting } from './db.js';

export const meetingRequestAction = defineGuardedAction({
  action: 'gws_ea_meetings.request',
  decide: async ({ actor }) => {
    const mainAgentGroupId = await getMainAgentGroupId();
    if (actor.kind !== 'agent' || mainAgentGroupId === null || actor.agentGroupId !== mainAgentGroupId) {
      return DENY(
        'Only main hands work to external-email, changes or cancels it, dismisses a thread, or answers the principal by email.',
      );
    }
    return ALLOW("main, by the profile's pointer");
  },
});

/** external-email, from the very session its meeting is bound to; otherwise why not. */
async function fromOwnMeetingSession(
  actor: GuardActor,
  payload: Record<string, unknown>,
  notExternalEmail: string,
): Promise<string | undefined> {
  const externalEmailAgentGroupId = await getExternalEmailAgentGroupId();
  if (
    actor.kind !== 'agent' ||
    externalEmailAgentGroupId === null ||
    actor.agentGroupId !== externalEmailAgentGroupId ||
    actor.sessionId === undefined
  ) {
    return notExternalEmail;
  }
  const meeting = typeof payload.meeting_id === 'string' ? await getMeeting(payload.meeting_id) : undefined;
  if (!meeting || meeting.session_id !== actor.sessionId) {
    return "That meeting is not this conversation's. Use only the meeting your brief names.";
  }
  return undefined;
}

export const meetingOutcomeAction = defineGuardedAction({
  action: 'gws_ea_meetings.outcome',
  decide: async ({ actor, payload }) => {
    const refusal = await fromOwnMeetingSession(actor, payload, "Only external-email reports a meeting's outcome.");
    return refusal === undefined ? ALLOW("external-email, from the meeting's own session") : DENY(refusal);
  },
});

/** free_time, hold, release_holds and book: external-email's calendar tools, for its own meeting only. */
export const meetingCalendarAction = defineGuardedAction({
  action: 'gws_ea_meetings.calendar',
  decide: async ({ actor, payload }) => {
    const refusal = await fromOwnMeetingSession(
      actor,
      payload,
      "Only external-email offers, holds or books a meeting's times.",
    );
    return refusal === undefined ? ALLOW("external-email, from the meeting's own session") : DENY(refusal);
  },
});

/** recipients: external-email places the people on its own meeting's thread, and no other. */
export const meetingRecipientsAction = defineGuardedAction({
  action: 'gws_ea_meetings.recipients',
  decide: async ({ actor, payload }) => {
    const refusal = await fromOwnMeetingSession(
      actor,
      payload,
      'Only external-email places the people its replies go to, in its own thread.',
    );
    return refusal === undefined ? ALLOW("external-email, from the meeting's own session") : DENY(refusal);
  },
});
