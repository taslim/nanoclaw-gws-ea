import type { Migration } from './index.js';

/**
 * What an agent's question asked, and when its asker stops waiting.
 *
 * `question` keeps the body, so the question can show its answer in place
 * on a channel whose requests are text; existing rows get an empty body.
 * `deadline` is when the agent's `ask_user_question` stops waiting for an
 * answer (ISO-8601 UTC); past it, the question takes no answer. Existing rows
 * have none.
 */
export const migration027: Migration = {
  version: 27,
  name: 'pending-question-deadline',
  async up(db) {
    await db.exec(`
      ALTER TABLE pending_questions ADD COLUMN question TEXT NOT NULL DEFAULT '';
      ALTER TABLE pending_questions ADD COLUMN deadline TEXT;
    `);
  },
};
