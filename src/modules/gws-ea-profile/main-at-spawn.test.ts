/**
 * main's group as a spawn reads it (KTD2). A restarted host releases the
 * messages its channels held before its modules start, so one can spawn
 * main before the host's start reads the profile: the spawn's admission
 * reads it first, and main still gets the commands only main is given. An
 * adopted container keeps the environment it started with.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';

import type { ContainerConfig } from '../../container-config.js';
import { assertSessionAdmitted, composeSessionSpec } from '../../container-runner.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import type { AgentGroup, Session } from '../../types.js';
import { WORKSPACE_GOG_COMMANDS } from '../gws-ea-google/workspace-commands.js';
import '../gws-ea-google/index.js';
import './index.js';

function group(id: string): AgentGroup {
  return { id, name: id, folder: id, agent_provider: null, created_at: '2026-10-10T09:00:00.000Z' };
}

/** The gog commands a spawn of this group holding Workspace is given, from the real composition. */
function gogCommandsAtSpawn(agentGroupId: string): readonly string[] | undefined {
  const [agent] = composeSessionSpec({
    agentGroup: group(agentGroupId),
    session: { id: 'session-1', agent_group_id: agentGroupId } as Session,
    containerName: `nanoclaw-v2-${agentGroupId}-1700000000000`,
    mounts: [],
    containerConfig: { capabilities: ['google-workspace'] } as unknown as ContainerConfig,
    mailboxEnvironment: {},
    contribution: {},
    gateway: { networkAccess: { endpoint: 'localhost', target: { kind: 'host' } } },
  }).containers;
  return { ...agent.env, ...agent.contributedEnv }.GOG_ENABLE_COMMANDS_EXACT?.split(',');
}

function admit(disposition: 'create' | 'adopt'): Promise<void> {
  return assertSessionAdmitted({
    disposition,
    key: { installSlug: 'install', agentGroupId: 'ag-main', sessionId: 'session-1' },
  });
}

beforeEach(async () => {
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
});

it("gives main its Workspace commands when a held message spawns it before the host's start", async () => {
  for (const id of ['ag-main', 'ag-research']) await createAgentGroup(group(id));
  // The profile an earlier host process wrote: nothing in this one has read it.
  await getDb().run("UPDATE gws_ea_profile SET main_agent_group_id = 'ag-main' WHERE singleton = 1");

  await admit('adopt');
  expect(gogCommandsAtSpawn('ag-main')).toBeUndefined();

  await admit('create');
  expect(gogCommandsAtSpawn('ag-main')).toEqual(WORKSPACE_GOG_COMMANDS);
  expect(gogCommandsAtSpawn('ag-research')).toBeUndefined();
});
