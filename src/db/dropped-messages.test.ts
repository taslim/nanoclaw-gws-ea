import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initSqliteTestDb } from './connection.js';
import { getUnregisteredSenders, recordDroppedMessage } from './dropped-messages.js';
import { migrations, runMigrations } from './migrations/index.js';

const now = '2026-09-18T20:00:00.000Z';

beforeEach(async () => {
  await runMigrations(await initSqliteTestDb());
});

afterEach(async () => {
  await closeDb();
});

describe('dropped-message provenance', () => {
  it('keeps sibling adapter instances separate and retains authenticated message evidence', async () => {
    const common = {
      channel_type: 'gchat',
      platform_id: 'spaces/dm-1',
      user_id: 'gchat:users/1',
      sender_name: 'Principal',
      reason: 'no_agent_wired',
      messaging_group_id: 'mg-1',
      agent_group_id: null,
      sender_authenticated: true,
      sender_kind: 'human' as const,
      is_group: false,
      message_id: 'message-1',
      message_timestamp: now,
    };

    await recordDroppedMessage({ ...common, instance: 'gchat-alpha' });
    await recordDroppedMessage({
      ...common,
      instance: 'gchat-beta',
      messaging_group_id: 'mg-2',
      message_id: 'message-2',
    });

    expect(await getUnregisteredSenders()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instance: 'gchat-alpha',
          user_id: 'gchat:users/1',
          sender_authenticated: 1,
          sender_kind: 'human',
          is_group: 0,
          authenticated_message_id: 'message-1',
          authenticated_message_at: now,
        }),
        expect.objectContaining({
          instance: 'gchat-beta',
          messaging_group_id: 'mg-2',
          authenticated_message_id: 'message-2',
        }),
      ]),
    );
  });

  it('preserves legacy rows while marking their sender evidence untrusted', async () => {
    await closeDb();
    const db = await initSqliteTestDb();
    await runMigrations(
      db,
      migrations.filter((migration) => migration.version < 26),
    );
    await db.run(
      `INSERT INTO messaging_groups
         (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, ?, ?, ?, NULL, 0, 'strict', ?)`,
      'mg-legacy',
      'gchat',
      'spaces/legacy',
      'gchat-instance',
      now,
    );
    await db.run(
      `INSERT INTO unregistered_senders
         (channel_type, platform_id, user_id, sender_name, reason, messaging_group_id,
          agent_group_id, message_count, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 3, ?, ?)`,
      'gchat',
      'spaces/legacy',
      'gchat:users/legacy',
      'Legacy',
      'no_agent_wired',
      'mg-legacy',
      now,
      now,
    );

    await runMigrations(db);

    expect(await getUnregisteredSenders()).toEqual([
      expect.objectContaining({
        instance: 'gchat-instance',
        user_id: 'gchat:users/legacy',
        message_count: 3,
        sender_authenticated: 0,
        sender_kind: 'unknown',
        authenticated_message_id: null,
        authenticated_message_at: null,
      }),
    ]);
    expect(
      await getDb().get<{ ok: number }>(
        'SELECT 1 AS ok FROM unregistered_senders WHERE messaging_group_id = ?',
        'mg-legacy',
      ),
    ).toEqual({ ok: 1 });
  });
});
