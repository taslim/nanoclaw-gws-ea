import { afterEach, beforeEach, expect, it } from 'vitest';
import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
import '../gws-ea-profile/index.js';
import { bindVerifiedPrincipalUser } from '../gws-ea-profile/db.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { resolveAudience } from './audience.js';
beforeEach(async () => {
  await runMigrations(await initTestDb());
  const now = new Date().toISOString();
  await createAgentGroup({ id: 'main', name: 'Main', folder: 'main', agent_provider: null, created_at: now });
  await upsertUser({ id: 'gchat:principal', kind: 'gchat', display_name: 'Principal', created_at: now });
  await bindVerifiedPrincipalUser('gchat:principal', now);
  for (const [id, instance] of [
    ['principal-dm', 'gchat'],
    ['other-dm', 'second'],
  ])
    await createMessagingGroup({
      id,
      instance,
      channel_type: 'gchat',
      platform_id: 'same-platform-id',
      name: 'DM',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now,
    });
  await upsertUserDm({
    user_id: 'gchat:principal',
    channel_type: 'gchat',
    messaging_group_id: 'principal-dm',
    resolved_at: now,
  });
});
afterEach(async () => {
  await closeDb();
});
it('recognizes a verified principal DM only through its exact adapter instance, preserving the default instance', async () => {
  const send = {
    channelType: 'gchat',
    platformId: 'same-platform-id',
    threadId: null,
    kind: 'chat',
    content: '{}',
    files: undefined,
    instance: undefined,
  };
  expect(await resolveAudience(send)).toBe('principal');
  expect(await resolveAudience({ ...send, instance: 'gchat' })).toBe('principal');
  expect(await resolveAudience({ ...send, instance: 'second' })).toBe('others');
  expect(await resolveAudience({ ...send, instance: 'unknown-instance' })).toBe('others');
});
