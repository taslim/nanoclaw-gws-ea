import { getDb } from '../../db/connection.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { writeDestinations } from '../agent-to-agent/write-destinations.js';
import {
  createDestination,
  deleteDestination,
  getDestinationByName,
  getDestinations,
} from '../agent-to-agent/db/agent-destinations.js';
import { getBrowserAgentGroupId, getMainAgentGroupId } from '../gws-ea-profile/db.js';
import { cancelBrowserJob } from './cancel.js';
import { ensureBrowserGroup, setBrowserAdmissionReady } from './group.js';
import { readBrowserPolicy } from './policy.js';
import './destination-policy.js';

/** Called by the browser composition on start, every use and periodic sweep, after request recovery. */
export async function reconcileBrowserGroup(policyFile?: string): Promise<void> {
  try {
    await reconcileDestinations(policyFile);
  } catch (error) {
    // On-use reconciliation shares the same admission boundary as startup and
    // sweeps. A partially projected map cannot keep a previous ready state.
    setBrowserAdmissionReady(false);
    throw error;
  }
}

async function reconcileDestinations(policyFile?: string): Promise<void> {
  if (!(await getDb().hasTable('gws_ea_profile'))) return;
  const main = await getMainAgentGroupId();
  const policy = await readBrowserPolicy(policyFile);
  if (!policy.enabled) {
    const browser = await getBrowserAgentGroupId();
    if (browser === null) return;
    if (await getDb().hasTable('gws_ea_browser_jobs')) {
      // A delegated thread exists before its first host-browser request creates its lazy job row.
      for (const session of await getSessionsByAgentGroup(browser)) {
        if (
          main !== null &&
          session.status === 'active' &&
          session.messaging_group_id === null &&
          session.thread_id?.startsWith(`system:a2a:${main}:`)
        )
          await cancelBrowserJob(session.thread_id);
      }
      const jobs = await getDb().all<{ thread_id: string }>(
        'SELECT thread_id FROM gws_ea_browser_jobs WHERE cancelled = 0',
      );
      for (const job of jobs) await cancelBrowserJob(job.thread_id);
    }
    const rows = await getDb().all<{ agent_group_id: string; local_name: string }>(
      "SELECT agent_group_id, local_name FROM agent_destinations WHERE agent_group_id = ? OR (target_type = 'agent' AND target_id = ?)",
      browser,
      browser,
    );
    // Retry projection even when a prior sweep deleted the central edge before
    // its mailbox write failed. Active containers may still hold that old map.
    const owners = new Set([browser, ...(main === null ? [] : [main]), ...rows.map((row) => row.agent_group_id)]);
    for (const row of rows) await deleteDestination(row.agent_group_id, row.local_name);
    for (const owner of owners) await project(owner);
    return;
  }
  if (main === null) return;
  const browser = await ensureBrowserGroup();
  const back = await getDestinationByName(browser, 'main');
  if (
    back?.target_type !== 'agent' ||
    back.target_id !== main ||
    back.session_mode !== 'agent-shared' ||
    back.inbound_untrusted !== 0
  ) {
    for (const destination of await getDestinations(browser)) await deleteDestination(browser, destination.local_name);
    await createDestination({
      agent_group_id: browser,
      local_name: 'main',
      target_type: 'agent',
      target_id: main,
      session_mode: 'agent-shared',
      inbound_untrusted: 0,
      created_at: new Date().toISOString(),
    });
  }
  const current = await getDestinationByName(main, 'browser');
  if (
    !(
      current?.target_type === 'agent' &&
      current.target_id === browser &&
      current.session_mode === 'per-thread' &&
      current.inbound_untrusted === 1
    )
  ) {
    // A stale or unsafe edge is replaced natively, never layered with a second route.
    for (const destination of await getDestinations(main)) {
      if (
        destination.local_name === 'browser' ||
        (destination.target_type === 'agent' && destination.target_id === browser)
      )
        await deleteDestination(main, destination.local_name);
    }
    await createDestination({
      agent_group_id: main,
      local_name: 'browser',
      target_type: 'agent',
      target_id: browser,
      session_mode: 'per-thread',
      inbound_untrusted: 1,
      created_at: new Date().toISOString(),
    });
  }
  // A correct central row is not evidence that its last mailbox projection
  // succeeded. Re-project both directions, including already-active main.
  await project(browser);
  await project(main);
}

async function project(agentGroupId: string): Promise<void> {
  for (const session of await getSessionsByAgentGroup(agentGroupId))
    if (session.status === 'active') await writeDestinations(agentGroupId, session.id);
}
