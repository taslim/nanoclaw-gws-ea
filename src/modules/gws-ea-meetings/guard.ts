/**
 * Who may use the calendar tools, decided from the profile's pointer, the
 * calling session and the group's capabilities, never from anything the
 * agent says about itself.
 */
import { ActionRefusal } from '../../cli/delivery-action.js';
import { getGroupCapabilities } from '../../capabilities.js';
import { getSession } from '../../db/sessions.js';
import { ALLOW, DENY, defineGuardedAction } from '../../guard/index.js';
import { AGENT_GOOGLE_SERVICES } from '../gws-ea-google/grant.js';
import { resolveBookingSurface } from './booking-surface.js';

export const bookingAction = defineGuardedAction({
  action: 'gws_ea_meetings.booking',
  decide: async ({ actor }) => {
    if (actor.kind !== 'agent' || actor.sessionId === undefined)
      return DENY('Only a serving conversation session may offer or book times.');
    const session = await getSession(actor.sessionId);
    if (!session || session.agent_group_id !== actor.agentGroupId)
      return DENY('Only a serving conversation session may offer or book times.');
    try {
      await resolveBookingSurface(session);
      return ALLOW('the current session of its own email thread or chat');
    } catch (error) {
      if (error instanceof ActionRefusal) return DENY(error.message);
      throw error;
    }
  },
});

/**
 * The capability that also hands `gog` the principal's calendars. Which
 * calendar and which event a call may write is the tool's own check.
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
