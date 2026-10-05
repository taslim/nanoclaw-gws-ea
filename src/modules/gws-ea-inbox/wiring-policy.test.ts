/**
 * The email channel's two wirings are pinned where wirings are written
 * (KTD1): the inbox reaches only external-email, external-email only the
 * inbox, and only per thread; the principal's email conversation reaches only
 * main, in its shared session, from known senders.
 */
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
import '../gws-ea-profile/index.js';
import { reconcileGwsEaProfile } from '../gws-ea-profile/db.js';
import { ensureInbox, ensurePrincipalConversation } from './index.js';

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
let principalEmail: string;

beforeEach(async () => {
  await runMigrations(await initTestDb());
  for (const [id, name] of [
    ['ag-external', 'external-email'],
    ['ag-other', 'research'],
    ['ag-main', 'main'],
  ] as const) {
    await createAgentGroup({ id, name, folder: name, agent_provider: null, created_at: now() });
  }
  await reconcileGwsEaProfile({
    assistantDisplayName: 'Aya',
    assistantWorkspaceEmail: 'aya@example.test',
    principalDisplayName: 'Pat',
    principalTimezone: 'UTC',
    mainAgentGroupId: 'ag-main',
    principalEmails: ['pat@example.test'],
  });
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
  principalEmail = await ensurePrincipalConversation('ag-main');
});

afterEach(async () => {
  await closeDb();
});

describe('the inbox wiring', () => {
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

  it('refuses main on the inbox', async () => {
    await expect(
      createMessagingGroupAgent(
        wiring({
          id: 'w-main',
          messaging_group_id: inbox,
          agent_group_id: 'ag-main',
          sender_scope: 'known',
          session_mode: 'agent-shared',
        }),
      ),
    ).rejects.toThrow(/wiring rejected/);
  });

  it('leaves every other wiring alone', async () => {
    await expect(
      createMessagingGroupAgent(
        wiring({ id: 'w3', messaging_group_id: 'mg-other', agent_group_id: 'ag-other', session_mode: 'shared' }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe("the principal's email conversation", () => {
  it('is created once, wired to main alone', async () => {
    expect(await ensurePrincipalConversation('ag-main')).toBe(principalEmail);
    expect(await getMessagingGroupAgentByPair(principalEmail, 'ag-main')).toMatchObject({
      session_mode: 'agent-shared',
      sender_scope: 'known',
      threads: 1,
    });
  });

  it.each(['ag-other', 'ag-external'])('refuses %s on it', async (agentGroupId) => {
    await expect(
      createMessagingGroupAgent(
        wiring({
          id: `w-${agentGroupId}`,
          messaging_group_id: principalEmail,
          agent_group_id: agentGroupId,
          sender_scope: 'known',
          session_mode: 'agent-shared',
        }),
      ),
    ).rejects.toThrow(/wired only to main|external-email is wired only to the inbox/);
  });

  it.each<[keyof MessagingGroupAgent, unknown]>([
    ['engage_mode', 'mention'],
    ['threads', 0],
    ['ignored_message_policy', 'accumulate'],
  ])('refuses changing %s', async (column, value) => {
    const current = await getMessagingGroupAgentByPair(principalEmail, 'ag-main');
    await expect(updateMessagingGroupAgent(current?.id ?? '', { [column]: value })).rejects.toThrow(
      new RegExp(`${column} must be`),
    );
  });
});

describe('privileges for email identities', () => {
  it('refuses owner or admin for an email identity, and leaves chat users alone', async () => {
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
  });
});
