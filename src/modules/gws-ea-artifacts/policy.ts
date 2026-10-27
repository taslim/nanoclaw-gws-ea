import { readWebPolicy, type WebPolicy, type WebPolicyFile } from '../gws-ea-web/policy.js';
import { parseStoredCapabilities } from '../../capabilities.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { getDb } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
import type { Session } from '../../types.js';
import {
  getBrowserAgentGroupId,
  getExternalChatAgentGroupId,
  getExternalEmailAgentGroupId,
  getMainAgentGroupId,
} from '../gws-ea-profile/db.js';
import type { ArtifactActor } from './db.js';

export const ARTIFACTS_CAPABILITY = 'artifacts';

/** Reads the stored selection, not resolved capabilities: this is the capability's own `grantedTo`. */
export async function hasArtifactsAccess(agentGroupId: string, policy?: WebPolicy): Promise<boolean> {
  if (
    !(policy ?? (await readWebPolicy())).enabled ||
    !(await getDb().hasTable('gws_ea_profile')) ||
    !(await getAgentGroup(agentGroupId))
  )
    return false;
  const sealed = [
    await getBrowserAgentGroupId(),
    await getExternalEmailAgentGroupId(),
    await getExternalChatAgentGroupId(),
  ];
  if (sealed.includes(agentGroupId)) return false;
  if (await getDb().hasTable('gws_ea_job_agents')) {
    const job = await getDb().get<{ state: string }>(
      'SELECT state FROM gws_ea_job_agents WHERE agent_group_id=?',
      agentGroupId,
    );
    if (job && job.state !== 'active') return false;
  }
  if (agentGroupId === (await getMainAgentGroupId())) return true;
  const selection = parseStoredCapabilities((await getContainerConfig(agentGroupId))?.capabilities, agentGroupId);
  return selection !== 'all' && selection.includes(ARTIFACTS_CAPABILITY);
}

/** Identity comes from the freshly read host session, never from tool fields. */
export async function artifactActor(session: Session, policy?: WebPolicy): Promise<ArtifactActor | undefined> {
  const current = await getSession(session.id);
  if (
    !current ||
    current.status !== 'active' ||
    current.agent_group_id !== session.agent_group_id ||
    !(await hasArtifactsAccess(current.agent_group_id, policy))
  )
    return undefined;
  return {
    agentGroupId: current.agent_group_id,
    sessionId: current.id,
    isMain: current.agent_group_id === (await getMainAgentGroupId()),
  };
}
export function artifactPrivateUrl(config: WebPolicyFile, artifactId: string): string {
  return `https://${config.hostname}/artifacts/${encodeURIComponent(artifactId)}`;
}
