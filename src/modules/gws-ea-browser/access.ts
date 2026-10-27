/** Browser access is an agent grant, independent of the host's current Chrome availability. */
import { parseStoredCapabilities } from '../../capabilities.js';
import { getAgentGroup, getAllAgentGroups } from '../../db/agent-groups.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { getDb } from '../../db/connection.js';
import { normalizeName } from '../agent-to-agent/db/agent-destinations.js';
import {
  getBrowserAgentGroupId,
  getExternalChatAgentGroupId,
  getExternalEmailAgentGroupId,
  getMainAgentGroupId,
} from '../gws-ea-profile/db.js';

export async function hasBrowserAccess(agentGroupId: string | null | undefined): Promise<boolean> {
  if (
    typeof agentGroupId !== 'string' ||
    !(await getDb().hasTable('gws_ea_profile')) ||
    !(await getAgentGroup(agentGroupId))
  )
    return false;
  if (
    [
      await getBrowserAgentGroupId(),
      await getExternalEmailAgentGroupId(),
      await getExternalChatAgentGroupId(),
    ].includes(agentGroupId)
  )
    return false;
  if (agentGroupId === (await getMainAgentGroupId())) return true;
  if (await getDb().hasTable('gws_ea_job_agents')) {
    const job = await getDb().get<{ state: string }>(
      'SELECT state FROM gws_ea_job_agents WHERE agent_group_id = ?',
      agentGroupId,
    );
    if (job && job.state !== 'active') return false;
  }
  const selection = parseStoredCapabilities((await getContainerConfig(agentGroupId))?.capabilities, agentGroupId);
  return selection !== 'all' && selection.includes('browser-delegate');
}

export async function browserAccessGroups(): Promise<readonly string[]> {
  if (!(await getDb().hasTable('gws_ea_profile'))) return [];
  const granted: string[] = [];
  for (const group of await getAllAgentGroups()) if (await hasBrowserAccess(group.id)) granted.push(group.id);
  return granted;
}

export async function isMainAgentGroup(agentGroupId: string): Promise<boolean> {
  return agentGroupId === (await getMainAgentGroupId());
}

export interface BrowserDelegator {
  readonly agentGroupId: string;
  readonly name: string;
}

export async function browserDelegators(): Promise<readonly BrowserDelegator[]> {
  const main = (await getDb().hasTable('gws_ea_profile')) ? await getMainAgentGroupId() : null;
  const delegators: BrowserDelegator[] = [];
  const taken = new Set<string>();
  for (const agentGroupId of await browserAccessGroups()) {
    const group = await getAgentGroup(agentGroupId);
    if (!group) continue;
    const base = agentGroupId === main ? 'main' : normalizeName(group.name);
    let name = base;
    for (let suffix = 2; taken.has(name) || (name === 'main' && agentGroupId !== main); suffix++)
      name = `${base}-${suffix}`;
    taken.add(name);
    delegators.push({ agentGroupId, name });
  }
  return delegators;
}

/** A browser errand thread, `system:a2a:<group>:<errand>`, as agent-to-agent opens one for the group that sent it. */
const ERRAND_THREAD = /^system:a2a:([^:\s]+):\S+$/u;

export function errandSource(thread: string | null | undefined): string | undefined {
  return thread ? ERRAND_THREAD.exec(thread)?.[1] : undefined;
}
