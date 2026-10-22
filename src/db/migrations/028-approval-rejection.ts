import type { Migration } from './index.js';

/** Keep a rejection's attribution and reason until its durable settlement completes. */
export const migration028: Migration = {
  version: 28,
  name: 'approval-rejection-settlement',
  async up(db) {
    await db.exec(`
      ALTER TABLE pending_approvals ADD COLUMN rejection_user_id TEXT;
      ALTER TABLE pending_approvals ADD COLUMN rejection_reason TEXT;
      ALTER TABLE pending_approvals ADD COLUMN rejected_at TEXT;
    `);
  },
};
