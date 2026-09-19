import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../modules/agent-to-agent/write-destinations.js', () => ({ writeDestinations: vi.fn() }));

import './index.js';
import '../permissions/index.js';
import '../../cli/resources/wirings.js';
import { lookup } from '../../cli/registry.js';
import { getResponseHandlers } from '../../response-registry.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initSqliteTestDb } from '../../db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  updateMessagingGroupAgent,
} from '../../db/messaging-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import { addMember } from '../permissions/db/agent-group-members.js';
import { createPendingChannelApproval } from '../permissions/db/pending-channel-approvals.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { upsertUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { bindVerifiedPrincipalUser, reconcileGwsEaProfile } from './db.js';

const now = () => new Date().toISOString();
const hostCtx = { caller: 'host' as const };

async function seedDm(id: string, userId: string, verified: boolean): Promise<void> {
  await createMessagingGroup({
    id,
    channel_type: 'gchat',
    platform_id: `spaces/${id}`,
    instance: 'gchat-instance',
    name: null,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await upsertUser({ id: userId, kind: 'gchat', display_name: userId, created_at: now() });
  await upsertUserDm({ user_id: userId, channel_type: 'gchat', messaging_group_id: id, resolved_at: now() });
  if (verified) {
    await bindVerifiedPrincipalUser(userId, now());
    await grantRole({
      user_id: userId,
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });
  }
  await addMember({ user_id: userId, agent_group_id: 'ag-main', added_by: null, added_at: now() });
}

function wiring(id: string, mgId: string, overrides: Partial<Parameters<typeof createMessagingGroupAgent>[0]> = {}) {
  return {
    id,
    messaging_group_id: mgId,
    agent_group_id: 'ag-main',
    engage_mode: 'pattern' as const,
    engage_pattern: '.',
    sender_scope: 'known' as const,
    ignored_message_policy: 'drop' as const,
    session_mode: 'agent-shared' as const,
    priority: 0,
    created_at: now(),
    ...overrides,
  };
}

beforeEach(async () => {
  await runMigrations(await initSqliteTestDb());
  await createAgentGroup({ id: 'ag-main', name: 'main', folder: 'main', agent_provider: null, created_at: now() });
  await createAgentGroup({ id: 'ag-other', name: 'other', folder: 'other', agent_provider: null, created_at: now() });
  await reconcileGwsEaProfile({
    assistantDisplayName: 'Aya',
    assistantWorkspaceEmail: 'aya@example.test',
    principalDisplayName: 'Principal',
    principalTimezone: 'UTC',
    mainAgentGroupId: 'ag-main',
  });
  await seedDm('mg-principal-1', 'gchat:users/1', true);
  await seedDm('mg-principal-2', 'gchat:users/2', true);
  await seedDm('mg-external', 'gchat:users/external', false);
  await createMessagingGroup({
    id: 'mg-group',
    channel_type: 'gchat',
    platform_id: 'spaces/group',
    instance: 'gchat-instance',
    name: null,
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
});

afterEach(closeDb);

describe('canonical main wiring policy', () => {
  it('admits multiple verified principal DMs with known agent-shared semantics', async () => {
    await expect(createMessagingGroupAgent(wiring('mga-1', 'mg-principal-1'))).resolves.toBeUndefined();
    await expect(createMessagingGroupAgent(wiring('mga-2', 'mg-principal-2'))).resolves.toBeUndefined();
  });

  it.each([
    ['a group', 'mg-group', {}],
    ['an unverified sender', 'mg-external', {}],
    ['a broad sender scope', 'mg-principal-1', { sender_scope: 'all' as const }],
    ['a separate session', 'mg-principal-1', { session_mode: 'shared' as const }],
  ])('rejects %s through the direct database helper', async (_label, mgId, overrides) => {
    await expect(createMessagingGroupAgent(wiring(`mga-${mgId}`, mgId, overrides))).rejects.toThrow(/canonical main/i);
  });

  it('rejects unsafe create and update through ncl as well as the direct update helper', async () => {
    const create = lookup('wirings-create')!;
    const update = lookup('wirings-update')!;
    await expect(
      create.handler(
        {
          messaging_group_id: 'mg-external',
          agent_group_id: 'ag-main',
          engage_mode: 'pattern',
          engage_pattern: '.',
          sender_scope: 'known',
          session_mode: 'agent-shared',
        },
        hostCtx,
      ),
    ).rejects.toThrow(/canonical main/i);

    await createMessagingGroupAgent(wiring('mga-safe', 'mg-principal-1'));
    await expect(update.handler({ id: 'mga-safe', sender_scope: 'all' }, hostCtx)).rejects.toThrow(/canonical main/i);
    await expect(updateMessagingGroupAgent('mga-safe', { session_mode: 'shared' })).rejects.toThrow(/canonical main/i);
    expect(await getMessagingGroupAgentByPair('mg-principal-1', 'ag-main')).toMatchObject({
      sender_scope: 'known',
      session_mode: 'agent-shared',
    });
  });

  it('does not constrain non-main groups', async () => {
    await expect(
      createMessagingGroupAgent({
        ...wiring('mga-other', 'mg-external'),
        agent_group_id: 'ag-other',
        sender_scope: 'all',
        session_mode: 'shared',
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects the generic channel-approval wiring path for canonical main', async () => {
    await createPendingChannelApproval({
      messaging_group_id: 'mg-group',
      agent_group_id: 'ag-main',
      approver_user_id: 'gchat:users/1',
      created_at: now(),
      title: 'New group',
      question: 'Connect?',
      options_json: '[]',
      original_message: JSON.stringify({
        channelType: 'gchat',
        instance: 'gchat-instance',
        platformId: 'spaces/group',
        threadId: null,
        message: {
          id: 'm-1',
          kind: 'chat',
          content: JSON.stringify({ senderId: 'users/external', sender: 'External' }),
          timestamp: now(),
          isGroup: true,
        },
      }),
    });

    await expect(
      (async () => {
        for (const handler of getResponseHandlers()) {
          const claimed = await handler({
            questionId: 'mg-group',
            value: 'connect:ag-main',
            userId: 'gchat:users/1',
            channelType: 'gchat',
            platformId: 'spaces/principal',
            threadId: null,
          });
          if (claimed) return;
        }
      })(),
    ).rejects.toThrow(/canonical main/i);
    expect(await getMessagingGroupAgentByPair('mg-group', 'ag-main')).toBeUndefined();
  });
});
