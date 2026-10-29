import type { ModuleMigration } from '../../../db/migrations/index.js';

export const weekAcknowledgementsMigration: ModuleMigration = {
  version: 4,
  name: 'module:gws-ea-meetings:week-acknowledgements',
  async up(db) {
    await db.exec(`CREATE TABLE gws_ea_week_acknowledgements (
    finding_key TEXT NOT NULL, event_key TEXT NOT NULL, kind TEXT NOT NULL, version TEXT NOT NULL,
    acknowledged_at TEXT NOT NULL, PRIMARY KEY(finding_key,version)
  );`);
  },
};
