import { getDb } from '../../db/connection.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import type { AgentDestination } from '../../types.js';
import { writeDestinations } from '../agent-to-agent/write-destinations.js';
import {
  createDestination,
  deleteDestination,
  getDestinationByName,
  getDestinations,
} from '../agent-to-agent/db/agent-destinations.js';
import { getBrowserAgentGroupId } from '../gws-ea-profile/db.js';
import { browserDelegators, errandSource, type BrowserDelegator } from './access.js';
import { cancelBrowserJob } from './cancel.js';
import { ensureBrowserGroup, setBrowserAdmissionReady } from './group.js';

import { browserConfigured } from './availability.js';

import './destination-policy.js';

export async function reconcileBrowserGroup(root?: string): Promise<void> {
  try {
    await reconcileDestinations(root);
  } catch (error) {
    // On-use reconciliation shares the same admission boundary as startup and
    // sweeps. A partially projected map cannot keep a previous ready state.
    setBrowserAdmissionReady(false);
    throw error;
  }
}

/**
 * Cancel every errand whose group may not delegate now, one opened before its first host-browser request included:
 * an unconfigured root cancels them all, and revoking a group’s grant cancels its own. Returns the groups whose
 * errands remain open sessions, for projection.
 */
async function cancelErrandsOutside(browser: string, delegators: ReadonlySet<string>): Promise<Set<string>> {
  const sources = new Set<string>();
  if (!(await getDb().hasTable('gws_ea_browser_jobs'))) return sources;
  // A delegated thread exists before its first host-browser request creates its lazy job row;
  // one that has its row is cancelled below, once, rather than on every sweep.
  for (const session of await getSessionsByAgentGroup(browser)) {
    const thread = session.thread_id;
    const source = errandSource(thread);
    if (thread === null || source === undefined || session.status !== 'active' || session.messaging_group_id !== null)
      continue;
    sources.add(source);
    if (!delegators.has(source) && !(await getDb().get('SELECT 1 FROM gws_ea_browser_jobs WHERE id = ?', thread)))
      await cancelBrowserJob(thread);
  }
  const jobs = await getDb().all<{ thread_id: string; source_agent_group_id: string }>(
    'SELECT thread_id, source_agent_group_id FROM gws_ea_browser_jobs WHERE cancelled = 0',
  );
  for (const job of jobs) if (!delegators.has(job.source_agent_group_id)) await cancelBrowserJob(job.thread_id);
  return sources;
}

/** `out` sends the group's errands per thread and marks browser's reports untrusted; `back` is those reports' route. */
function edges(browser: string, delegator: BrowserDelegator): { back: AgentDestination; out: AgentDestination } {
  const created_at = new Date().toISOString();
  return {
    back: {
      agent_group_id: browser,
      local_name: delegator.name,
      target_type: 'agent',
      target_id: delegator.agentGroupId,
      session_mode: 'agent-shared',
      inbound_untrusted: 0,
      created_at,
    },
    out: {
      agent_group_id: delegator.agentGroupId,
      local_name: 'browser',
      target_type: 'agent',
      target_id: browser,
      session_mode: 'per-thread',
      inbound_untrusted: 1,
      created_at,
    },
  };
}

function sameEdge(row: AgentDestination | undefined, wanted: AgentDestination): boolean {
  return (
    row?.local_name === wanted.local_name &&
    row.target_type === wanted.target_type &&
    row.target_id === wanted.target_id &&
    row.session_mode === wanted.session_mode &&
    row.inbound_untrusted === wanted.inbound_untrusted
  );
}

async function reconcileDestinations(root?: string): Promise<void> {
  if (!(await getDb().hasTable('gws_ea_profile'))) return;
  const granted = await browserDelegators();
  const delegators = browserConfigured(root) ? granted : [];
  const existing = await getBrowserAgentGroupId();
  const sources =
    existing === null
      ? new Set<string>()
      : await cancelErrandsOutside(existing, new Set(delegators.map((delegator) => delegator.agentGroupId)));
  if (delegators.length === 0) {
    if (existing === null) return;
    const rows = await getDb().all<{ agent_group_id: string; local_name: string }>(
      "SELECT agent_group_id, local_name FROM agent_destinations WHERE agent_group_id = ? OR (target_type = 'agent' AND target_id = ?)",
      existing,
      existing,
    );
    // Retry projection even when a prior sweep deleted the central edge before
    // its mailbox write failed. Active containers may still hold that old map.
    const owners = new Set([
      existing,
      ...granted.map((delegator) => delegator.agentGroupId),
      ...sources,
      ...rows.map((row) => row.agent_group_id),
    ]);
    for (const row of rows) await deleteDestination(row.agent_group_id, row.local_name);
    for (const owner of owners) await project(owner);
    return;
  }
  const browser = existing ?? (await ensureBrowserGroup());
  const wanted = delegators.map((delegator) => edges(browser, delegator));
  const held = await getDestinations(browser);
  if (
    held.length !== wanted.length ||
    wanted.some(
      ({ back }) =>
        !sameEdge(
          held.find((row) => row.local_name === back.local_name),
          back,
        ),
    )
  ) {
    for (const destination of held) await deleteDestination(browser, destination.local_name);
    for (const { back } of wanted) await createDestination(back);
  }
  const owners = new Set([browser, ...sources]);
  for (const { out } of wanted) {
    owners.add(out.agent_group_id);
    if (sameEdge(await getDestinationByName(out.agent_group_id, 'browser'), out)) continue;
    // A stale or unsafe edge is replaced natively, never layered with a second route.
    for (const destination of await getDestinations(out.agent_group_id)) {
      if (
        destination.local_name === 'browser' ||
        (destination.target_type === 'agent' && destination.target_id === browser)
      )
        await deleteDestination(out.agent_group_id, destination.local_name);
    }
    await createDestination(out);
  }
  // A group no longer listed keeps no route to browser.
  const listed = new Set(delegators.map((delegator) => delegator.agentGroupId));
  for (const row of await getDb().all<{ agent_group_id: string; local_name: string }>(
    "SELECT agent_group_id, local_name FROM agent_destinations WHERE target_type = 'agent' AND target_id = ? AND agent_group_id <> ?",
    browser,
    browser,
  )) {
    if (listed.has(row.agent_group_id)) continue;
    await deleteDestination(row.agent_group_id, row.local_name);
    owners.add(row.agent_group_id);
  }
  // A correct central row is not evidence that its last mailbox projection
  // succeeded. Re-project every direction, including already-active delegators.
  for (const owner of owners) await project(owner);
}

async function project(agentGroupId: string): Promise<void> {
  for (const session of await getSessionsByAgentGroup(agentGroupId))
    if (session.status === 'active') await writeDestinations(agentGroupId, session.id);
}
