import { afterEach, beforeEach, expect, it } from 'vitest';

import './index.js';
import '../permissions/index.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup, getMessagingGroupAgentByPair } from '../../db/messaging-groups.js';
import { reconcileGwsEaProfile, isVerifiedPrincipalUser } from './db.js';
import { getDestinationByTarget } from '../agent-to-agent/db/agent-destinations.js';
import { bindWhatsAppPrincipal, removeWhatsAppPrincipalBinding } from './bind.js';

beforeEach(async () => {
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: 'main',
    name: 'Main',
    folder: 'main',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await reconcileGwsEaProfile({
    assistantDisplayName: 'Aya',
    assistantWorkspaceEmail: 'aya@example.test',
    principalDisplayName: 'Pat',
    principalTimezone: 'UTC',
    mainAgentGroupId: 'main',
  });
});
afterEach(closeDb);

it('binds an authenticated WhatsApp LID as the principal in canonical main and removes only that binding', async () => {
  const result = await bindWhatsAppPrincipal(
    { lid: '12000', phoneJid: '447700900123@s.whatsapp.net' },
    new Date().toISOString(),
  );
  expect(await isVerifiedPrincipalUser('whatsapp:12000')).toBe(true);
  expect(await getMessagingGroupAgentByPair(result.messagingGroupId, 'main')).toMatchObject({
    sender_scope: 'known',
    session_mode: 'agent-shared',
  });
  expect(await getDb().get("SELECT role FROM user_roles WHERE user_id='whatsapp:12000'")).toEqual({ role: 'owner' });
  await removeWhatsAppPrincipalBinding('12000');
  expect(await isVerifiedPrincipalUser('whatsapp:12000')).toBe(false);
  expect(await getMessagingGroupAgentByPair(result.messagingGroupId, 'main')).toBeUndefined();
  expect(await getDestinationByTarget('main', 'channel', result.messagingGroupId)).toBeUndefined();
  expect((await getMessagingGroup(result.messagingGroupId))?.detached_at).toBeTruthy();
  await bindWhatsAppPrincipal({ lid: '12000', phoneJid: '447700900123@s.whatsapp.net' }, new Date().toISOString());
  expect((await getMessagingGroup(result.messagingGroupId))?.detached_at).toBeNull();
});
