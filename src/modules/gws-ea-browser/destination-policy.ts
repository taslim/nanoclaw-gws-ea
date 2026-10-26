import { getDb } from '../../db/connection.js';
import { registerDestinationAdmissionPolicy, registerWiringAdmissionPolicy } from '../../db/wiring-admission.js';
import type { AgentDestination } from '../../types.js';
import { registerA2aRoutePolicy } from '../agent-to-agent/agent-route.js';
import { getBrowserAgentGroupId } from '../gws-ea-profile/db.js';
import { errandSource, hasBrowserAccess } from './access.js';
import { browserAvailability, browserUnavailableMessage } from './availability.js';

/** Browser is a sealed tool agent, reachable only from the agent groups with browser access. */
export async function browserDestinationViolation(row: AgentDestination): Promise<string | undefined> {
  if (!(await getDb().hasTable('gws_ea_profile'))) return undefined;
  const browser = await getBrowserAgentGroupId();
  if (browser === null) return undefined;
  if (row.agent_group_id === browser) {
    if (row.target_type === 'agent' && (await hasBrowserAccess(row.target_id))) return undefined;
    return 'browser may address only the agents with browser access';
  }
  if (row.target_type !== 'agent' || row.target_id !== browser) return undefined;
  if (!(await hasBrowserAccess(row.agent_group_id))) return 'only an agent with browser access may address browser';
  if (row.session_mode !== 'per-thread') return 'an agent must address browser through a per-thread destination';
  if (row.inbound_untrusted !== 1) return 'browser reports must be marked untrusted';
  return undefined;
}

registerDestinationAdmissionPolicy('gws-ea-browser:separation', ({ proposed }) =>
  browserDestinationViolation(proposed),
);

registerWiringAdmissionPolicy('gws-ea-browser:errands-only', async ({ proposed }) => {
  if ((await getDb().hasTable('gws_ea_profile')) && proposed.agent_group_id === (await getBrowserAgentGroupId()))
    throw new Error('browser takes work only in a delegated errand, without a channel wiring');
});

// Browser addresses every agent with browser access, but each errand answers only the agent that opened it.
registerA2aRoutePolicy('gws-ea-browser:errand-reports', async ({ session, targetAgentGroupId }) => {
  if (!(await getDb().hasTable('gws_ea_profile')) || session.agent_group_id !== (await getBrowserAgentGroupId()))
    return undefined;
  return session.messaging_group_id === null && errandSource(session.thread_id) === targetAgentGroupId
    ? undefined
    : 'An errand reports only to the agent that delegated it.';
});

/** Keep the named destination while Chrome is missing, but refuse before a sealed errand is created. */
registerA2aRoutePolicy('gws-ea-browser:availability', async ({ targetAgentGroupId }) => {
  if (!(await getDb().hasTable('gws_ea_profile')) || targetAgentGroupId !== (await getBrowserAgentGroupId()))
    return undefined;
  const availability = await browserAvailability();
  return availability.available ? undefined : browserUnavailableMessage(availability.reason);
});
