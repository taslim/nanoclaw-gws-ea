import type { ModuleMigration } from '../../db/migrations/index.js';

export const gwsEaManualMigration: ModuleMigration = {
  version: 1,
  name: 'module:gws-ea-manual:create-manual',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_manual_sections (
        key TEXT PRIMARY KEY CHECK (key IN ('priorities','principles','preferences','authority','narrative')),
        text TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        previous_text TEXT,
        previous_updated_at TEXT,
        CHECK ((previous_text IS NULL) = (previous_updated_at IS NULL))
      );
    `);
  },
};
