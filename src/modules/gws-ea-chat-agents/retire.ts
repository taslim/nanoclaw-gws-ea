import { isContainerRunning, killContainer } from '../../container-runner.js';
import { getDb } from '../../db/connection.js';
import { getSessionsByAgentGroup, updateSession } from '../../db/sessions.js';
import { deleteAllDestinationsTouching, getDestinationReferencers } from '../agent-to-agent/db/agent-destinations.js';
import { writeDestinations } from '../agent-to-agent/write-destinations.js';
import { reconcileBrowserGroup } from '../gws-ea-browser/reconcile.js';
import { retireChatGateway } from './gateway.js';
import { getJobAgent } from './jobs.js';

async function revokeBrowser(): Promise<void> {
  // The durable retiring state closes the grant before edges and errands reconcile.
  await reconcileBrowserGroup();
}

/** A durable retiring row resumes after any interrupted external cleanup. */
export async function retireJobAgent(group: string): Promise<void> {
  const current = await getJobAgent(group);
  if (!current || current.state === 'retired') return;
  await getDb().run(
    "UPDATE gws_ea_job_agents SET state = 'retiring', updated_at = ? WHERE agent_group_id = ?",
    new Date().toISOString(),
    group,
  );
  await revokeBrowser();
  await retireChatGateway(group);
  const peers = await getDb().transaction(async () => {
    const row = await getJobAgent(group);
    const saved: unknown = JSON.parse(row?.retirement_peer_ids_json ?? '[]');
    if (!Array.isArray(saved) || !saved.every((id): id is string => typeof id === 'string'))
      throw new Error('Job retirement peer list is invalid');
    const captured = [...new Set([...saved, ...(await getDestinationReferencers(group))])];
    await getDb().run(
      'UPDATE gws_ea_job_agents SET retirement_peer_ids_json = ? WHERE agent_group_id = ?',
      JSON.stringify(captured),
      group,
    );
    await getDb().run('DELETE FROM messaging_group_agents WHERE agent_group_id = ?', group);
    await deleteAllDestinationsTouching(group);
    return captured;
  });
  for (const peer of peers)
    for (const session of await getSessionsByAgentGroup(peer))
      if (session.status === 'active') await writeDestinations(peer, session.id);
  for (const session of await getSessionsByAgentGroup(group)) {
    await updateSession(session.id, { status: 'closed' });
    if (!isContainerRunning(session.id)) continue;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Job-agent container did not stop; retirement will resume')),
        30_000,
      );
      killContainer(session.id, 'chat-job-retired', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
  await getDb().run(
    "UPDATE gws_ea_job_agents SET state = 'retired', updated_at = ? WHERE agent_group_id = ?",
    new Date().toISOString(),
    group,
  );
}
