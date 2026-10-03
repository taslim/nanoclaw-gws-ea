/**
 * The inbox's one wiring is pinned where wirings are written (KTD3, KTD4):
 * the inbox reaches only external-email, external-email only the inbox, and
 * only per thread.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../modules/agent-to-agent/write-destinations.js', () => ({ writeDestinations: vi.fn() }));
vi.mock('../gws-ea-external-email/index.js', () => ({
  getExternalEmailAgentGroupId: vi.fn(async () => 'ag-external'),
}));

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initTestDb } from '../../db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  updateMessagingGroupAgent,
} from '../../db/messaging-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import type { MessagingGroupAgent } from '../../types.js';
import { ensureInbox } from './index.js';

const now = () => new Date().toISOString();

function wiring(
  overrides: Partial<MessagingGroupAgent> & Pick<MessagingGroupAgent, 'id' | 'messaging_group_id' | 'agent_group_id'>,
): MessagingGroupAgent {
  return {
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'per-thread',
    threads: 1,
    priority: 0,
    created_at: now(),
    ...overrides,
  };
}

let inbox: string;

beforeEach(async () => {
  await runMigrations(await initTestDb());
  for (const [id, name] of [
    ['ag-external', 'external-email'],
    ['ag-other', 'research'],
  ] as const) {
    await createAgentGroup({ id, name, folder: name, agent_provider: null, created_at: now() });
  }
  await createMessagingGroup({
    id: 'mg-other',
    channel_type: 'gchat',
    platform_id: 'spaces/other',
    name: null,
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  inbox = await ensureInbox('ag-external');
});

afterEach(async () => {
  await closeDb();
});

describe('the inbox wiring', () => {
  it('is created once, and a second start changes nothing', async () => {
    expect(await ensureInbox('ag-external')).toBe(inbox);
    expect(await getMessagingGroupAgentByPair(inbox, 'ag-external')).toMatchObject({ session_mode: 'per-thread' });
  });

  it('refuses any other agent on the inbox', async () => {
    await expect(
      createMessagingGroupAgent(wiring({ id: 'w1', messaging_group_id: inbox, agent_group_id: 'ag-other' })),
    ).rejects.toThrow(/the inbox is wired only to external-email/);
  });

  it('refuses external-email anywhere but the inbox', async () => {
    await expect(
      createMessagingGroupAgent(wiring({ id: 'w2', messaging_group_id: 'mg-other', agent_group_id: 'ag-external' })),
    ).rejects.toThrow(/external-email is wired only to the inbox/);
  });

  it.each<[keyof MessagingGroupAgent, unknown]>([
    ['session_mode', 'shared'],
    ['engage_mode', 'mention'],
    ['sender_scope', 'known'],
    ['threads', 0],
  ])('refuses changing %s', async (column, value) => {
    const current = await getMessagingGroupAgentByPair(inbox, 'ag-external');
    await expect(updateMessagingGroupAgent(current?.id ?? '', { [column]: value })).rejects.toThrow(
      new RegExp(`${column} must be`),
    );
  });

  it('leaves every other wiring alone', async () => {
    await expect(
      createMessagingGroupAgent(
        wiring({ id: 'w3', messaging_group_id: 'mg-other', agent_group_id: 'ag-other', session_mode: 'shared' }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('privileges for email identities', () => {
  it('refuses owner or admin for an email identity on every write path, and leaves chat users alone', async () => {
    const { assertRoleGrantAdmitted, grantRole } = await import('../permissions/db/user-roles.js');

    for (const role of ['owner', 'admin'] as const) {
      await expect(
        grantRole({
          user_id: 'email:pat@example.test',
          role,
          agent_group_id: null,
          granted_by: null,
          granted_at: now(),
        }),
      ).rejects.toThrow(/email identity never holds/);
    }
    expect(() =>
      assertRoleGrantAdmitted({ user_id: 'gchat:users/1', role: 'admin', agent_group_id: null }),
    ).not.toThrow();

    const roles = await readFile(path.join(process.cwd(), 'src/cli/resources/roles.ts'), 'utf8');
    expect(roles).toContain('assertRoleGrantAdmitted({');
  });
});
