import { getDb } from '../../db/connection.js';
import { registerDestinationAdmissionPolicy, registerWiringAdmissionPolicy } from '../../db/wiring-admission.js';
import type { AgentDestination } from '../../types.js';
import { getBrowserAgentGroupId, getMainAgentGroupId } from '../gws-ea-profile/db.js';

/** Browser is a sealed tool agent, reachable only from canonical main. */
export async function browserDestinationViolation(row: AgentDestination): Promise<string | undefined> {
  if (!(await getDb().hasTable('gws_ea_profile'))) return undefined;
  const browser = await getBrowserAgentGroupId();
  if (browser === null) return undefined;
  const main = await getMainAgentGroupId();
  if (row.agent_group_id === browser) {
    if (row.target_type === 'agent' && main !== null && row.target_id === main) return undefined;
    return 'browser may address only main';
  }
  if (row.target_type !== 'agent' || row.target_id !== browser) return undefined;
  if (main === null || row.agent_group_id !== main) return 'only main may address browser';
  if (row.session_mode !== 'per-thread') return 'main must address browser through a per-thread destination';
  if (row.inbound_untrusted !== 1) return 'browser reports must be marked untrusted';
  return undefined;
}

registerDestinationAdmissionPolicy('gws-ea-browser:separation', ({ proposed }) =>
  browserDestinationViolation(proposed),
);

registerWiringAdmissionPolicy('gws-ea-browser:errands-only', async ({ proposed }) => {
  if ((await getDb().hasTable('gws_ea_profile')) && proposed.agent_group_id === (await getBrowserAgentGroupId()))
    throw new Error('browser takes work only in a main-owned errand, without a channel wiring');
});
