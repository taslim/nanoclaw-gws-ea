/**
 * The CLI guard's protected-group seam: a group a module registers as the
 * host's alone cannot be named by any agent caller's command, whatever the
 * caller's CLI scope and whatever an admin would approve. The host caller,
 * and every command that names no protected group, decide as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { ensureContainerConfig, updateContainerConfigScalars } from '../db/container-configs.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../db/messaging-groups.js';
import { closeDb, createAgentGroup, createSession, initTestDb, runMigrations } from '../db/index.js';
import { guard, type GuardActor } from '../guard/index.js';
import { registerProtectedGroupPolicy } from './guard.js';
import { commandGuard } from './registry.js';
import './resources/index.js';

const PROTECTED = 'ag-protected';
const OWNER = 'ag-owner';

registerProtectedGroupPolicy('guard-test:protected', (agentGroupId) =>
  agentGroupId === PROTECTED ? 'it is the host’s alone' : undefined,
);

const owner: GuardActor = { kind: 'agent', agentGroupId: OWNER, sessionId: 'sess-owner' };

function decide(command: string, payload: Record<string, unknown>, actor: GuardActor = owner) {
  return guard(commandGuard(command), { actor, payload });
}

beforeEach(async () => {
  await runMigrations(await initTestDb());
  const now = new Date().toISOString();
  for (const id of [PROTECTED, OWNER]) {
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now });
    await ensureContainerConfig(id);
  }
  // The owner's agent runs `ncl` at global scope, as main does.
  await updateContainerConfigScalars(OWNER, { cli_scope: 'global' });
  await createMessagingGroup({
    id: 'mg-inbox',
    channel_type: 'email',
    platform_id: 'email:inbox',
    name: 'inbox',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now,
  });
  await createMessagingGroupAgent({
    id: 'wiring-protected',
    messaging_group_id: 'mg-inbox',
    agent_group_id: PROTECTED,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'per-thread',
    priority: 0,
    created_at: now,
  });
  await createSession({
    id: 'sess-protected',
    agent_group_id: PROTECTED,
    messaging_group_id: 'mg-inbox',
    thread_id: 'thread-1',
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now,
  });
});

afterEach(async () => {
  await closeDb();
});

describe('a protected agent group', () => {
  it.each([
    ['groups-config-update', { id: PROTECTED, capabilities: 'all' }],
    ['groups-config-add-mcp-server', { id: PROTECTED, name: 'tools', command: 'x' }],
    ['groups-delete', { id: PROTECTED }],
    ['groups-update', { id: PROTECTED, name: 'renamed' }],
    ['groups-get', { id: PROTECTED }],
    ['destinations-add', { agent_group_id: PROTECTED, local_name: 'x', target_type: 'agent', target_id: OWNER }],
    ['tasks-create', { group: PROTECTED, prompt: 'write to them' }],
    ['members-add', { group: PROTECTED, user: 'email:sam@example.test' }],
    ['wirings-delete', { id: 'wiring-protected' }],
    ['sessions-history', { id: 'sess-protected' }],
    ['policies-set', { from: OWNER, to: PROTECTED }],
  ])('denies an agent caller %s that names it', async (command, payload) => {
    const decision = await decide(command, payload);

    expect(decision).toMatchObject({ effect: 'deny', reason: expect.stringContaining('it is the host’s alone') });
  });

  it('leaves the host caller and commands naming another group as they were', async () => {
    expect(
      await decide('groups-config-update', { id: PROTECTED, capabilities: 'all' }, { kind: 'host' }),
    ).toMatchObject({ effect: 'allow' });
    expect(await decide('groups-config-update', { id: OWNER, model: 'opus' })).toMatchObject({ effect: 'hold' });
    expect(await decide('groups-list', {})).toMatchObject({ effect: 'allow' });
  });
});
