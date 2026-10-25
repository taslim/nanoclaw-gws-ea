import { getDb } from '../../db/connection.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { createAgentFromTemplate } from '../../templates/create-agent.js';
import { reconcileChatShape } from './external-chat.js';
import { reconcileChatGateway } from './gateway.js';
import { JOB_CHAT_TEMPLATE } from './shape.js';

export type JobAgentState = 'creating' | 'active' | 'retiring' | 'retired';
export interface JobAgent {
  readonly agent_group_id: string;
  readonly messaging_group_id: string;
  readonly state: JobAgentState;
  readonly retirement_peer_ids_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export async function getJobAgent(group: string): Promise<JobAgent | undefined> {
  return (await getDb().hasTable('gws_ea_job_agents'))
    ? getDb().get<JobAgent>('SELECT * FROM gws_ea_job_agents WHERE agent_group_id = ?', group)
    : undefined;
}

export async function getJobAgentForChat(chat: string): Promise<JobAgent | undefined> {
  return getDb().get<JobAgent>(
    "SELECT * FROM gws_ea_job_agents WHERE messaging_group_id = ? AND state <> 'retired'",
    chat,
  );
}

export async function listJobAgents(): Promise<JobAgent[]> {
  return getDb().all<JobAgent>('SELECT * FROM gws_ea_job_agents ORDER BY created_at, agent_group_id');
}

/** One live job group per chat, including a create interrupted before gateway reconciliation. */
export async function createJobAgent(chat: string): Promise<JobAgent> {
  const result = await getDb().transaction(async () => {
    const existing = await getJobAgentForChat(chat);
    if (existing) {
      if (existing.state === 'retiring') throw new Error('The previous chat job agent is still retiring');
      return existing;
    }
    if (!(await getMessagingGroup(chat))) throw new Error('The job chat does not exist');
    const { group } = await createAgentFromTemplate(JOB_CHAT_TEMPLATE, { name: `chat-${chat}` });
    await reconcileChatShape(group.id, 'job');
    const now = new Date().toISOString();
    const row: JobAgent = {
      agent_group_id: group.id,
      messaging_group_id: chat,
      state: 'creating',
      retirement_peer_ids_json: '[]',
      created_at: now,
      updated_at: now,
    };
    await getDb().run(
      'INSERT INTO gws_ea_job_agents (agent_group_id, messaging_group_id, state, created_at, updated_at) VALUES (@agent_group_id, @messaging_group_id, @state, @created_at, @updated_at)',
      row,
    );
    return row;
  });
  await reconcileChatGateway(result.agent_group_id);
  return result;
}

/** Runs inside the chat cutover's transaction, before the new wiring: wiring admission requires an active job agent. */
export async function activateJobAgent(group: string): Promise<void> {
  const row = await getJobAgent(group);
  if (row?.state === 'active') return;
  if (row?.state !== 'creating') throw new Error('Only a creating job agent can be activated');
  await getDb().run(
    "UPDATE gws_ea_job_agents SET state = 'active', updated_at = ? WHERE agent_group_id = ? AND state = 'creating'",
    new Date().toISOString(),
    group,
  );
}
