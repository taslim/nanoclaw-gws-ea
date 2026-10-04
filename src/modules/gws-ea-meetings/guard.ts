/**
 * Who may use the scheduling tools (KTD7): only `external-email`, from the
 * session of one email thread, checked against the profile's pointer and the
 * calling session, never against anything the agent says about itself. Every
 * call acts on that thread alone.
 *
 * No decision here ever holds for approval: these are structural checks.
 */
import { getSession } from '../../db/sessions.js';
import { ALLOW, DENY, defineGuardedAction } from '../../guard/index.js';
import { getThread } from '../gws-ea-inbox/thread-map.js';
import { getExternalEmailAgentGroupId } from '../gws-ea-profile/db.js';

/**
 * free_time, hold, book, move_booking and cancel_booking: external-email,
 * from the session of one email thread, whose key is the session's thread.
 * No argument names a thread, so a call never reaches another thread's
 * holds or bookings.
 */
export const threadCalendarAction = defineGuardedAction({
  action: 'gws_ea_meetings.thread_calendar',
  decide: async ({ actor }) => {
    const externalEmailAgentGroupId = await getExternalEmailAgentGroupId();
    if (
      actor.kind !== 'agent' ||
      externalEmailAgentGroupId === null ||
      actor.agentGroupId !== externalEmailAgentGroupId ||
      actor.sessionId === undefined
    ) {
      return DENY("Only external-email offers, holds, books, moves or cancels times on the principal's calendar.");
    }
    const session = await getSession(actor.sessionId);
    const threadKey = session?.agent_group_id === actor.agentGroupId ? session.thread_id : null;
    if (threadKey === null || (await getThread(threadKey)) === undefined) {
      return DENY('This conversation is not an email thread, so it has no times to offer, hold or book.');
    }
    return ALLOW("external-email, from its email thread's own session");
  },
});
