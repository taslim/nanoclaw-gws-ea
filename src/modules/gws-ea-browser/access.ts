/**
 * Who may use the browser: one operator setting, the browser policy. Version 1
 * grants main alone; version 2 the agent groups it lists, less any job agent
 * that is not active. Every check of who may use the browser asks here,
 * whether or not the browser is enabled now: enablement is checked beside
 * each grant.
 *
 * A listed group shares the one signed-in browser profile and the vault
 * logins, and approvals still go to the principal. Its errands are its own:
 * an errand thread names the group that opened it, so every job, card,
 * notice and follow-up is scoped to that group.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { normalizeName } from '../agent-to-agent/db/agent-destinations.js';
import {
  getBrowserAgentGroupId,
  getExternalChatAgentGroupId,
  getExternalEmailAgentGroupId,
  getMainAgentGroupId,
} from '../gws-ea-profile/db.js';
import { readBrowserPolicy, type BrowserPolicy } from './policy.js';

/**
 * An unreadable policy grants as version 1 does, main alone: it also leaves
 * the browser unavailable, so that grant opens nothing, and main still knows
 * to tell the principal.
 */
export async function browserAccessGroups(policy?: BrowserPolicy): Promise<readonly string[]> {
  const current = policy ?? (await readHostBrowserPolicy());
  if (current.status !== 'unavailable' && current.access.version === 2) {
    const allowed: string[] = [];
    for (const group of current.access.agentGroupIds) if (await eligibleChatGroup(group)) allowed.push(group);
    return allowed;
  }
  if (!(await getDb().hasTable('gws_ea_profile'))) return [];
  const main = await getMainAgentGroupId();
  return main === null ? [] : [main];
}

async function eligibleChatGroup(group: string): Promise<boolean> {
  const db = getDb();
  if ((await db.hasTable('gws_ea_profile')) && group === (await getExternalChatAgentGroupId())) return false;
  const job = (await db.hasTable('gws_ea_job_agents'))
    ? await db.get<{ state: string }>('SELECT state FROM gws_ea_job_agents WHERE agent_group_id = ?', group)
    : undefined;
  return job === undefined || job.state === 'active';
}

export async function hasBrowserAccess(
  agentGroupId: string | null | undefined,
  policy?: BrowserPolicy,
): Promise<boolean> {
  return typeof agentGroupId === 'string' && (await browserAccessGroups(policy)).includes(agentGroupId);
}

/** Main is the one group a browser check may name beyond the policy's grants. */
export async function isMainAgentGroup(agentGroupId: string): Promise<boolean> {
  return agentGroupId === (await getMainAgentGroupId());
}

export interface BrowserDelegator {
  readonly agentGroupId: string;
  /** `main` for main, as the browser's instructions name it; any other group by its own name, made unique. */
  readonly name: string;
}

export async function browserDelegators(policy?: BrowserPolicy): Promise<readonly BrowserDelegator[]> {
  const main = (await getDb().hasTable('gws_ea_profile')) ? await getMainAgentGroupId() : null;
  const delegators: BrowserDelegator[] = [];
  const taken = new Set<string>();
  for (const agentGroupId of await browserAccessGroups(policy)) {
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

/** Refuses a policy that lists a sealed group; `readBrowserPolicy` stays DB-free for operator file reads. */
export async function readHostBrowserPolicy(file?: string): Promise<BrowserPolicy> {
  const policy = await readBrowserPolicy(file);
  if (policy.status === 'unavailable' || policy.access.version === 1) return policy;
  try {
    if (await getDb().hasTable('gws_ea_profile')) {
      const sealed = [
        await getBrowserAgentGroupId(),
        await getExternalEmailAgentGroupId(),
        await getExternalChatAgentGroupId(),
      ];
      if (policy.access.agentGroupIds.some((id) => sealed.includes(id)))
        return { status: 'unavailable', enabled: false, reason: 'invalid-browser-policy' };
    }
    return policy;
    // eslint-disable-next-line no-catch-all/no-catch-all -- Every failed host authority read denies browser admission.
  } catch {
    return { status: 'unavailable', enabled: false, reason: 'invalid-browser-policy' };
  }
}
