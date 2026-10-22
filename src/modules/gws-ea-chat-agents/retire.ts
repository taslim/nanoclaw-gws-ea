import path from 'node:path';
import { processLock } from '../../community-portal/process-lock.js';
import { isContainerRunning, killContainer } from '../../container-runner.js';
import { getDb } from '../../db/connection.js';
import { getSessionsByAgentGroup, updateSession } from '../../db/sessions.js';
import { readEnvFile } from '../../env.js';
import { assertInstanceId } from '../../gws-ea/registry.js';
import { GwsEaError } from '../../gws-ea/types.js';
import { deleteAllDestinationsTouching, getDestinationReferencers } from '../agent-to-agent/db/agent-destinations.js';
import { writeDestinations } from '../agent-to-agent/write-destinations.js';
import { readPrivateFile, writePrivateFile } from '../gws-ea-browser/paths.js';
import { browserPolicyFile, parseBrowserPolicyFile } from '../gws-ea-browser/policy.js';
import { reconcileBrowserGroup } from '../gws-ea-browser/reconcile.js';
import { retireChatGateway } from './gateway.js';
import { getJobAgent } from './jobs.js';

async function revokeBrowser(group: string): Promise<void> {
  const file = browserPolicyFile();
  if (!file) return;
  const stored = readEnvFile(['GWS_EA_INSTANCE_LOCK_FILE', 'NANOCLAW_INSTALL_ID']);
  const lock = stored.GWS_EA_INSTANCE_LOCK_FILE;
  if (!lock) {
    try {
      await readPrivateFile(file, 16 * 1024);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    throw new Error('Job retirement needs the bound assistant lock before changing browser access');
  }
  const instanceId = path.basename(lock, '.lock');
  assertInstanceId(instanceId);
  const install = process.env.NANOCLAW_INSTALL_ID || stored.NANOCLAW_INSTALL_ID;
  if (!path.isAbsolute(lock) || !lock.endsWith('.lock') || instanceId.replaceAll('-', '') !== install)
    throw new Error('Job retirement lock does not belong to this assistant');
  const release = await processLock(lock);
  if (!release) throw new GwsEaError('instance_busy', 'Instance operation is already in progress');
  try {
    await removeBrowserGrant(file, group);
  } finally {
    release();
  }
  await reconcileBrowserGroup(file);
}

async function removeBrowserGrant(file: string, group: string): Promise<void> {
  let raw: string;
  try {
    raw = await readPrivateFile(file, 16 * 1024);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  const policy = parseBrowserPolicyFile(JSON.parse(raw));
  if (!policy) throw new Error('Cannot revoke job browser access from an invalid browser policy');
  if (policy.schemaVersion === 2 && policy.agentGroupIds.includes(group))
    await writePrivateFile(
      file,
      JSON.stringify({ ...policy, agentGroupIds: policy.agentGroupIds.filter((id) => id !== group) }),
    );
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
  await revokeBrowser(group);
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
