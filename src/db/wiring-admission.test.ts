import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initSqliteTestDb } from './connection.js';
import { createAgentGroup } from './agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent, updateMessagingGroupAgent } from './messaging-groups.js';
import { runMigrations } from './migrations/index.js';
import { registerWiringAdmissionPolicy } from './wiring-admission.js';

const now = () => new Date().toISOString();

registerWiringAdmissionPolicy('test:block-one-group', ({ proposed }) => {
  if (proposed.agent_group_id === 'ag-blocked') throw new Error('blocked by test policy');
});

beforeEach(async () => {
  await runMigrations(await initSqliteTestDb());
  for (const id of ['ag-allowed', 'ag-blocked']) {
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
  }
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'test',
    platform_id: 'dm-1',
    name: null,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
});

afterEach(closeDb);

const wiring = (agentGroupId: string) => ({
  id: `mga-${agentGroupId}`,
  messaging_group_id: 'mg-1',
  agent_group_id: agentGroupId,
  engage_mode: 'pattern' as const,
  engage_pattern: '.',
  sender_scope: 'all' as const,
  ignored_message_policy: 'drop' as const,
  session_mode: 'shared' as const,
  priority: 0,
  created_at: now(),
});

describe('wiring admission registry', () => {
  it('guards direct helper creates without changing unrelated wirings', async () => {
    await expect(createMessagingGroupAgent(wiring('ag-allowed'))).resolves.toBeUndefined();
    await expect(createMessagingGroupAgent(wiring('ag-blocked'))).rejects.toThrow(/blocked by test policy/);
  });

  it('guards updates against the complete proposed row', async () => {
    await createMessagingGroupAgent(wiring('ag-allowed'));
    await expect(updateMessagingGroupAgent('mga-ag-allowed', { priority: 2 })).resolves.toBeUndefined();
  });
});
