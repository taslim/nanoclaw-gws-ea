import type { ModuleMigration } from '../../db/migrations/index.js';
import { displayPersonName } from '../../gws-ea/person-name.js';
import {
  assertProfileNameMigrationSource,
  parseProfileNameMigrationInput,
  PROFILE_NAME_INPUT_TABLE,
  PROFILE_NAME_MIGRATION,
  type LegacyProfileNames,
} from '../../gws-ea/profile-name-migration.js';

export const gwsEaPrincipalDmRoutingMigration: ModuleMigration = {
  version: 8,
  name: 'module:gws-ea-profile:principal-dm-routing',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_principal_dm_activity (
        user_id TEXT NOT NULL REFERENCES gws_ea_principal_users(user_id) ON DELETE CASCADE,
        messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id) ON DELETE CASCADE,
        last_message_at TEXT NOT NULL,
        PRIMARY KEY (user_id, messaging_group_id)
      );
    `);
  },
};

export const gwsEaPrincipalMessagesMigration: ModuleMigration = {
  version: 7,
  name: 'module:gws-ea-profile:principal-messages',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_principal_messages (
        messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        timestamp TEXT NOT NULL,
        text TEXT NOT NULL CHECK (text <> ''),
        PRIMARY KEY (messaging_group_id, message_id)
      );
      CREATE INDEX gws_ea_principal_messages_timestamp ON gws_ea_principal_messages(timestamp);
    `);
  },
};

export const gwsEaExternalChatPointerMigration: ModuleMigration = {
  version: 6,
  name: 'module:gws-ea-profile:external-chat-pointer',
  async up(db) {
    await db.exec(
      'ALTER TABLE gws_ea_profile ADD COLUMN external_chat_agent_group_id TEXT REFERENCES agent_groups(id);',
    );
  },
};

export const gwsEaBrowserPointerMigration: ModuleMigration = {
  version: 4,
  name: 'module:gws-ea-profile:browser-pointer',
  async up(db) {
    await db.exec('ALTER TABLE gws_ea_profile ADD COLUMN browser_agent_group_id TEXT REFERENCES agent_groups(id);');
  },
};

/**
 * The assistant's web alias (KTD13): the alias once a probe verifies it, and
 * until then the candidate the operator was asked to add and the Message-ID
 * of the probe sent to it. All three are written together by one
 * compare-and-set; a profile from before holds none.
 */
export const gwsEaWebAliasMigration: ModuleMigration = {
  version: 5,
  name: 'module:gws-ea-profile:web-alias',
  async up(db) {
    await db.exec(`
      ALTER TABLE gws_ea_profile ADD COLUMN assistant_alias TEXT;
      ALTER TABLE gws_ea_profile ADD COLUMN alias_candidate TEXT;
      ALTER TABLE gws_ea_profile ADD COLUMN alias_probe_message_id TEXT;
    `);
  },
};

export const gwsEaProfileMigration: ModuleMigration = {
  version: 1,
  name: 'module:gws-ea-profile:create-profile',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_profile (
        singleton                    INTEGER PRIMARY KEY CHECK (singleton = 1),
        assistant_display_name       TEXT,
        assistant_workspace_email    TEXT,
        principal_display_name       TEXT,
        principal_timezone           TEXT,
        main_agent_group_id          TEXT UNIQUE REFERENCES agent_groups(id),
        updated_at                    TEXT
      );

      CREATE TABLE gws_ea_principal_users (
        user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        verified_at  TEXT NOT NULL
      );

      INSERT INTO gws_ea_profile (singleton) VALUES (1);
    `);
  },
};

/**
 * `external-email`'s agent group, beside main's. The host creates the group
 * once and records it here (src/modules/gws-ea-external-email). An assistant
 * from before it gains an empty pointer, which its next start fills.
 */
export const gwsEaExternalEmailPointerMigration: ModuleMigration = {
  version: 3,
  name: 'module:gws-ea-profile:external-email-pointer',
  async up(db) {
    await db.exec(
      'ALTER TABLE gws_ea_profile ADD COLUMN external_email_agent_group_id TEXT REFERENCES agent_groups(id);',
    );
  },
};

/** The principal's email addresses: one row each, stored lowercased, so each address is held once. */
export const gwsEaPrincipalAddressesMigration: ModuleMigration = {
  version: 2,
  name: 'module:gws-ea-profile:principal-addresses',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_principal_addresses (
        email     TEXT PRIMARY KEY,
        added_at  TEXT NOT NULL
      );
    `);
  },
};

/** Convert only with explicitly supplied boundaries; the runner owns the transaction. */
export const gwsEaStructuredNamesMigration: ModuleMigration = {
  version: 9,
  name: PROFILE_NAME_MIGRATION,
  disableForeignKeys: true,
  async up(db) {
    const legacy = await db.get<LegacyProfileNames & { main_agent_group_id: string | null }>(
      'SELECT assistant_display_name, principal_display_name, main_agent_group_id FROM gws_ea_profile WHERE singleton = 1',
    );
    if (!legacy) throw new Error('GWS-EA profile singleton is missing');
    const hasInput = await db.hasTable(PROFILE_NAME_INPUT_TABLE);
    const row = hasInput
      ? await db.get<{ payload: string }>(`SELECT payload FROM ${PROFILE_NAME_INPUT_TABLE} WHERE singleton = 1`)
      : undefined;
    const input = row === undefined ? undefined : parseProfileNameMigrationInput(JSON.parse(row.payload) as unknown);
    if (input) assertProfileNameMigrationSource(input, legacy);
    if (
      (legacy.assistant_display_name !== null ||
        legacy.principal_display_name !== null ||
        legacy.main_agent_group_id !== null) &&
      !input
    ) {
      throw new Error('Structured-name migration requires explicit names: run gws-ea names prepare before updating');
    }
    await db.exec(`
      CREATE TABLE gws_ea_profile_structured (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        assistant_first_name TEXT CHECK (assistant_first_name IS NULL OR length(trim(assistant_first_name)) > 0),
        assistant_last_name TEXT CHECK (assistant_last_name IS NULL OR length(trim(assistant_last_name)) > 0),
        assistant_workspace_email TEXT,
        principal_first_name TEXT CHECK (principal_first_name IS NULL OR length(trim(principal_first_name)) > 0),
        principal_last_name TEXT CHECK (principal_last_name IS NULL OR length(trim(principal_last_name)) > 0),
        principal_timezone TEXT,
        main_agent_group_id TEXT UNIQUE REFERENCES agent_groups(id),
        updated_at TEXT,
        external_email_agent_group_id TEXT REFERENCES agent_groups(id),
        browser_agent_group_id TEXT REFERENCES agent_groups(id),
        assistant_alias TEXT,
        alias_candidate TEXT,
        alias_probe_message_id TEXT,
        external_chat_agent_group_id TEXT REFERENCES agent_groups(id),
        CHECK (main_agent_group_id IS NULL OR (assistant_first_name IS NOT NULL AND principal_first_name IS NOT NULL))
      );
    `);
    await db.run(
      `
      INSERT INTO gws_ea_profile_structured (
        singleton, assistant_first_name, assistant_last_name, assistant_workspace_email,
        principal_first_name, principal_last_name, principal_timezone, main_agent_group_id, updated_at,
        external_email_agent_group_id, browser_agent_group_id, assistant_alias, alias_candidate,
        alias_probe_message_id, external_chat_agent_group_id
      ) SELECT singleton, ?, ?, assistant_workspace_email, ?, ?, principal_timezone, main_agent_group_id, updated_at,
        external_email_agent_group_id, browser_agent_group_id, assistant_alias, alias_candidate,
        alias_probe_message_id, external_chat_agent_group_id FROM gws_ea_profile`,
      input?.assistant.firstName ?? null,
      input?.assistant.lastName ?? null,
      input?.principal.firstName ?? null,
      input?.principal.lastName ?? null,
    );
    await db.exec('DROP TABLE gws_ea_profile; ALTER TABLE gws_ea_profile_structured RENAME TO gws_ea_profile;');
    if (input && legacy.main_agent_group_id !== null) {
      const jobs = (await db.hasTable('gws_ea_job_agents'))
        ? "UNION SELECT agent_group_id FROM gws_ea_job_agents WHERE state IN ('creating', 'active')"
        : '';
      const assistantName = displayPersonName(input.assistant);
      await db.run(
        `UPDATE container_configs SET assistant_name = ?, updated_at = ?
          WHERE agent_group_id IN (
            SELECT main_agent_group_id FROM gws_ea_profile
            UNION SELECT external_email_agent_group_id FROM gws_ea_profile
            UNION SELECT external_chat_agent_group_id FROM gws_ea_profile
            UNION SELECT browser_agent_group_id FROM gws_ea_profile
            ${jobs}
          ) AND (assistant_name IS NULL OR assistant_name <> ?)`,
        assistantName,
        new Date().toISOString(),
        assistantName,
      );
    }
    if (hasInput) await db.exec(`DROP TABLE ${PROFILE_NAME_INPUT_TABLE}`);
  },
};
