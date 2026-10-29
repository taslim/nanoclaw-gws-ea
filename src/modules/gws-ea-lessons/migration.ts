import type { ModuleMigration } from '../../db/migrations/index.js';

export const lessonsMigration: ModuleMigration = {
  version: 1,
  name: 'module:gws-ea-lessons:queue',
  async up(db) {
    await db.exec(`CREATE TABLE gws_ea_lessons (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL UNIQUE CHECK (text <> ''),
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','accepted','folded','declined')),
      created_at TEXT NOT NULL
    )`);
  },
};
