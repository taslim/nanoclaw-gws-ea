/**
 * Who may use the browser (R27, R28, KTD15): one operator setting, the
 * browser policy. Version 1 grants main alone; version 2 exactly the agent
 * groups it lists. Every host check, the delegate tools, guidance and
 * destinations ask here, whether or not the operator has the browser
 * enabled now: enablement is checked beside each grant, as it always was.
 *
 * A listed group shares the one signed-in browser profile and the vault
 * logins, and approvals still go to the principal. Its errands are its own:
 * an errand thread names the group that opened it, so every job, card,
 * notice and follow-up is scoped to that group.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { normalizeName } from '../agent-to-agent/db/agent-destinations.js';
import { getBrowserAgentGroupId, getExternalEmailAgentGroupId, getMainAgentGroupId } from '../gws-ea-profile/db.js';
import { readBrowserPolicy, type BrowserPolicy } from './policy.js';

/**
 * The agent groups `policy` grants the browser. An unreadable policy grants
 * as version 1 does, main alone: it also leaves the browser unavailable, so
 * that grant opens nothing, and main still knows to tell the principal.
 */
export async function browserAccessGroups(policy?: BrowserPolicy): Promise<readonly string[]> {
  const current = policy ?? (await readHostBrowserPolicy());
  if (current.status !== 'unavailable' && current.access.version === 2) return current.access.agentGroupIds;
  if (!(await getDb().hasTable('gws_ea_profile'))) return [];
  const main = await getMainAgentGroupId();
  return main === null ? [] : [main];
}

/** Whether `agentGroupId` may use the browser under `policy` (the operator's current one by default). */
export async function hasBrowserAccess(
  agentGroupId: string | null | undefined,
  policy?: BrowserPolicy,
): Promise<boolean> {
  return typeof agentGroupId === 'string' && (await browserAccessGroups(policy)).includes(agentGroupId);
}

/** Whether `agentGroupId` is main's: the one group a browser check names, besides those it grants. */
export async function isMainAgentGroup(agentGroupId: string): Promise<boolean> {
  return agentGroupId === (await getMainAgentGroupId());
}

/** A group with browser access, and what the browser calls it. */
export interface BrowserDelegator {
  readonly agentGroupId: string;
  /** `main` for main, as the browser's instructions name it; any other group by its own name, made unique. */
  readonly name: string;
}

/** The existing agent groups `policy` grants the browser, each with the name the browser addresses it by. */
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

/** The agent group that opened errand `thread`, or undefined for any other thread. */
export function errandSource(thread: string | null | undefined): string | undefined {
  return thread ? ERRAND_THREAD.exec(thread)?.[1] : undefined;
}

/** The native host validates sealed groups on every policy read; operator file reads stay DB-free. */
export async function readHostBrowserPolicy(file?: string): Promise<BrowserPolicy> {
  const policy = await readBrowserPolicy(file);
  if (policy.status === 'unavailable' || policy.access.version === 1) return policy;
  try {
    if (await getDb().hasTable('gws_ea_profile')) {
      const sealed = [await getBrowserAgentGroupId(), await getExternalEmailAgentGroupId()];
      if (policy.access.agentGroupIds.some((id) => sealed.includes(id)))
        return { status: 'unavailable', enabled: false, reason: 'invalid-browser-policy' };
    }
    return policy;
    // eslint-disable-next-line no-catch-all/no-catch-all -- Every failed host authority read denies browser admission.
  } catch {
    return { status: 'unavailable', enabled: false, reason: 'invalid-browser-policy' };
  }
}
