import type { Migration } from './index.js';

/**
 * Trust-bearing provenance for structural drops.
 *
 * The legacy key collapsed sibling bot instances and its sender fields could
 * be derived from message content. Rebuild the table so discovery can require
 * adapter-authenticated evidence without treating historical rows as trusted.
 */
export const migration026: Migration = {
  version: 26,
  name: 'unregistered-sender-provenance',
  async up(db) {
    const instanceOwners = await db.columnOwners?.('instance');
    const messagingGroupsHaveInstance = instanceOwners === undefined || instanceOwners.includes('messaging_groups');
    // Normal upgrades have already applied migration 016, so retain the exact
    // adapter instance from the referenced messaging group. The fallback is
    // for valid partial migration lists (used by migration recovery/tests)
    // where 016 has not yet run; those rows necessarily predate named
    // instances and therefore belong to the channel's default instance.
    const legacyInstance = messagingGroupsHaveInstance ? 'COALESCE(mg.instance, old.channel_type)' : 'old.channel_type';

    await db.exec(`
      CREATE TABLE unregistered_senders_new (
        channel_type             TEXT NOT NULL,
        platform_id              TEXT NOT NULL,
        instance                 TEXT NOT NULL,
        user_id                  TEXT,
        sender_name              TEXT,
        sender_authenticated     INTEGER NOT NULL DEFAULT 0,
        sender_kind              TEXT NOT NULL DEFAULT 'unknown',
        is_group                 INTEGER,
        authenticated_message_id TEXT,
        authenticated_message_at TEXT,
        reason                   TEXT NOT NULL,
        messaging_group_id       TEXT,
        agent_group_id           TEXT,
        message_count            INTEGER NOT NULL DEFAULT 1,
        first_seen               TEXT NOT NULL,
        last_seen                TEXT NOT NULL,
        PRIMARY KEY (channel_type, platform_id, instance)
      );

      INSERT INTO unregistered_senders_new (
        channel_type, platform_id, instance, user_id, sender_name,
        sender_authenticated, sender_kind, is_group,
        authenticated_message_id, authenticated_message_at,
        reason, messaging_group_id, agent_group_id, message_count,
        first_seen, last_seen
      )
      SELECT old.channel_type,
             old.platform_id,
             ${legacyInstance},
             old.user_id,
             old.sender_name,
             0,
             'unknown',
             mg.is_group,
             NULL,
             NULL,
             old.reason,
             old.messaging_group_id,
             old.agent_group_id,
             old.message_count,
             old.first_seen,
             old.last_seen
        FROM unregistered_senders old
        LEFT JOIN messaging_groups mg ON mg.id = old.messaging_group_id;

      DROP TABLE unregistered_senders;
      ALTER TABLE unregistered_senders_new RENAME TO unregistered_senders;
      CREATE INDEX idx_unregistered_senders_last_seen ON unregistered_senders(last_seen);
      CREATE INDEX idx_unregistered_senders_candidate
        ON unregistered_senders(channel_type, instance, sender_authenticated, sender_kind, is_group, authenticated_message_at);
    `);
  },
};
