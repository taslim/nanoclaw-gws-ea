/**
 * Who may use the calendar tools, checked against the profile's pointer, the
 * calling session and the group's capabilities, never against anything the
 * agent says about itself:
 *
 * - email scheduling tools (KTD7): only `external-email`, from the session of
 *   one email thread; every call acts on that thread alone;
 * - chat scheduling tools: the current serving session of an active chat,
 *   with a booking calendar main set; every call acts on that chat alone;
 * - `create_event`, `change_guests`, `respond_to_event`, `find_conflicts`
 *   and `people_stats`: a group holding Google Calendar, as `gog`'s calendar
 *   commands are, which `main` does and external-email never does.
 *
 * No decision here ever holds for approval: these are structural checks.
 */
import { ActionRefusal } from '../../cli/delivery-action.js';
import { requireServingChat } from '../gws-ea-chats/bridge.js';
import { getChatCalendar } from '../gws-ea-chats/handoffs.js';
import { getGroupCapabilities } from '../../capabilities.js';
import { getSession } from '../../db/sessions.js';
import { ALLOW, DENY, defineGuardedAction } from '../../guard/index.js';
import { getThread } from '../gws-ea-inbox/thread-map.js';
import { AGENT_GOOGLE_SERVICES } from '../gws-ea-google/grant.js';
import { getExternalEmailAgentGroupId } from '../gws-ea-profile/db.js';

/**
 * free_time, book, change_booking and cancel_booking: external-email, from
 * the session of one email thread, whose key is the session's thread. No
 * argument names a thread, so a call never reaches another thread's
 * bookings.
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
      return DENY("Only external-email offers, books, changes or cancels times on the principal's calendar.");
    }
    const session = await getSession(actor.sessionId);
    const threadKey = session?.agent_group_id === actor.agentGroupId ? session.thread_id : null;
    if (threadKey === null || (await getThread(threadKey)) === undefined) {
      return DENY('This conversation is not an email thread, so it has no times to offer or book.');
    }
    return ALLOW("external-email, from its email thread's own session");
  },
});

/**
 * main's calendar tools: a group holding Google Calendar, the key that hands
 * `gog` the principal's calendars. Which calendar and which event each call
 * may write is the tool's own check.
 */
export const principalEventAction = defineGuardedAction({
  action: 'gws_ea_meetings.principal_events',
  decide: async ({ actor }) => {
    if (
      actor.kind !== 'agent' ||
      !(await getGroupCapabilities(actor.agentGroupId)).has(AGENT_GOOGLE_SERVICES.calendar.capability)
    ) {
      return DENY("The principal's calendar needs Google Calendar, which this group does not hold.");
    }
    return ALLOW('a group holding Google Calendar');
  },
});

/**
 * Chat calendar tools act only for the canonical current serving chat with main's calendar.
 * to: external-chat, job
 */
export const chatCalendarAction = defineGuardedAction({
  action: 'gws_ea_meetings.chat_calendar',
  decide: async ({ actor }) => {
    if (actor.kind !== 'agent' || actor.sessionId === undefined)
      return DENY('Only a serving chat session books for its chat.');
    const session = await getSession(actor.sessionId);
    if (!session || session.agent_group_id !== actor.agentGroupId)
      return DENY('Only a serving chat session books for its chat.');
    try {
      const chat = await requireServingChat(session);
      if ((await getChatCalendar(chat.messaging_group_id)) === null)
        return DENY('No calendar is set for this chat. Ask main with tell_main.');
      return ALLOW('current serving chat with a calendar main set');
    } catch (error) {
      if (error instanceof ActionRefusal) return DENY(error.message);
      throw error;
    }
  },
});
