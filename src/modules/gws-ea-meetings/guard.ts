/**
 * Who may send the handoff's typed requests (KTD5). Every request is checked
 * against the profile's agent pointers, never against anything the agent
 * says about itself:
 *
 * - `main` alone hands meetings over and changes or cancels them;
 * - `external-email` alone reports an outcome, and only for the meeting
 *   bound to the very session it reports from, so one thread can never act
 *   on another's meeting.
 *
 * Neither decision ever holds for approval: these are structural checks.
 */
import { ALLOW, DENY, defineGuardedAction } from '../../guard/index.js';
import { getExternalEmailAgentGroupId, getMainAgentGroupId } from '../gws-ea-profile/db.js';
import { getMeeting } from './db.js';

export const meetingRequestAction = defineGuardedAction({
  action: 'gws_ea_meetings.request',
  decide: async ({ actor }) => {
    const mainAgentGroupId = await getMainAgentGroupId();
    if (actor.kind !== 'agent' || mainAgentGroupId === null || actor.agentGroupId !== mainAgentGroupId) {
      return DENY('Only main hands meetings to external-email, or changes or cancels them.');
    }
    return ALLOW("main, by the profile's pointer");
  },
});

export const meetingOutcomeAction = defineGuardedAction({
  action: 'gws_ea_meetings.outcome',
  decide: async ({ actor, payload }) => {
    const externalEmailAgentGroupId = await getExternalEmailAgentGroupId();
    if (
      actor.kind !== 'agent' ||
      externalEmailAgentGroupId === null ||
      actor.agentGroupId !== externalEmailAgentGroupId ||
      actor.sessionId === undefined
    ) {
      return DENY("Only external-email reports a meeting's outcome.");
    }
    const meeting = typeof payload.meeting_id === 'string' ? await getMeeting(payload.meeting_id) : undefined;
    if (!meeting || meeting.session_id !== actor.sessionId) {
      return DENY("That meeting is not this conversation's. Report only the meeting your brief names.");
    }
    return ALLOW("external-email, from the meeting's own session");
  },
});
