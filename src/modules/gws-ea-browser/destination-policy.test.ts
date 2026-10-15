import { afterEach, beforeEach, expect, it } from 'vitest';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { createDestination } from '../agent-to-agent/db/agent-destinations.js';
import '../gws-ea-profile/index.js';
import './destination-policy.js';

beforeEach(async () => {
  await runMigrations(await initTestDb());
  for (const id of ['main', 'browser', 'external'])
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
  await getDb().run(
    'UPDATE gws_ea_profile SET main_agent_group_id = ?, browser_agent_group_id = ? WHERE singleton = 1',
    'main',
    'browser',
  );
});
afterEach(closeDb);

it('admits only the two sealed main/browser edges with per-thread untrusted delegation', async () => {
  const row = {
    agent_group_id: 'main',
    local_name: 'browser',
    target_type: 'agent' as const,
    target_id: 'browser',
    created_at: new Date().toISOString(),
    session_mode: 'per-thread' as const,
    inbound_untrusted: 1 as const,
  };
  await createDestination(row);
  await createDestination({
    ...row,
    agent_group_id: 'browser',
    local_name: 'main',
    target_id: 'main',
    session_mode: 'agent-shared',
    inbound_untrusted: 0,
  });
  await expect(createDestination({ ...row, agent_group_id: 'external' })).rejects.toThrow('only main');
  await expect(
    createDestination({ ...row, agent_group_id: 'browser', local_name: 'external', target_id: 'external' }),
  ).rejects.toThrow('browser may address only main');
  await expect(createDestination({ ...row, local_name: 'unsafe', session_mode: 'agent-shared' })).rejects.toThrow(
    'per-thread',
  );
  await expect(createDestination({ ...row, local_name: 'trusted', inbound_untrusted: 0 })).rejects.toThrow('untrusted');
});
