import type { ModuleMigration } from '../../db/migrations/index.js';

/** When a closed chat's mailbox settle last finished, so the sweep repeats only an interrupted one. */
export const chatSettleMigration: ModuleMigration = {
  version: 1,
  name: 'module:gws-ea-chats:settled',
  async up(db) {
    await db.exec('ALTER TABLE gws_ea_chats ADD COLUMN settled_at TEXT;');
  },
};
