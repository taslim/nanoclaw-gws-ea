import type { ModuleMigration } from '../../db/migrations/index.js';

/**
 * Matters: what `main` must come back to, each with only what lives nowhere
 * else and links to where the facts live. The schema holds what it can on its
 * own, so a writer that skips `db.ts` still cannot break it:
 *
 * - a matter has a title, an open loop, an optional parent (a strand of that
 *   project), and the task that is its next look; it is open until it closes
 *   with an outcome, so an open matter never has one and a closed one always
 *   does. There is no status, stage, priority, owner or log;
 * - `look_failed_at` marks a failed look. The runner settles a failed turn's
 *   rows as done, so a repeating look's next occurrence is armed on its next
 *   date as if it had run; the host marks the matter when it hears of the
 *   failure, and its loop brings that occurrence to the next daily sync, then
 *   clears the mark. It is the host's bookkeeping for one guarantee, never
 *   shown to `main` or anyone, and no status of the matter;
 * - a link is a reference by id: a thread key, `<calendar id>/<event id>`, a
 *   Drive file id, a person id, or a memory path. `handler` names the agent
 *   that works it;
 * - a thread, event, file or job sits in at most one open matter. SQLite's
 *   partial index cannot read another table, so each link carries its
 *   matter's open flag, which `db.ts` writes in the same transaction as the
 *   matter's open, close and reopen. A closed matter keeps its links.
 *
 * Strands stay one level deep, and a project stays open while a strand is:
 * rules across rows, which `db.ts` enforces.
 */
export const gwsEaMattersMigration: ModuleMigration = {
  version: 1,
  name: 'module:gws-ea-matters:create-matters',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_matters (
        id            TEXT PRIMARY KEY CHECK (id LIKE 'm-%'),
        title         TEXT NOT NULL CHECK (title <> ''),
        open_loop     TEXT NOT NULL CHECK (open_loop <> ''),
        parent_id     TEXT REFERENCES gws_ea_matters(id),
        outcome       TEXT CHECK (outcome <> ''),
        look_task_id  TEXT CHECK (look_task_id <> ''),
        look_failed_at TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        closed_at     TEXT,
        CHECK (parent_id IS NULL OR parent_id <> id),
        CHECK ((closed_at IS NULL) = (outcome IS NULL))
      );
      CREATE INDEX idx_gws_ea_matters_parent ON gws_ea_matters (parent_id);

      CREATE TABLE gws_ea_matter_links (
        matter_id    TEXT NOT NULL REFERENCES gws_ea_matters(id) ON DELETE CASCADE,
        kind         TEXT NOT NULL CHECK (kind IN ('thread', 'event', 'file', 'person', 'memory')),
        reference    TEXT NOT NULL CHECK (reference <> ''),
        handler      TEXT CHECK (handler <> ''),
        matter_open  INTEGER NOT NULL CHECK (matter_open IN (0, 1)),
        linked_at    TEXT NOT NULL,
        PRIMARY KEY (matter_id, kind, reference)
      );
      CREATE INDEX idx_gws_ea_matter_links_reference ON gws_ea_matter_links (kind, reference);
      CREATE UNIQUE INDEX idx_gws_ea_matter_links_one_open_matter
        ON gws_ea_matter_links (kind, reference)
        WHERE matter_open = 1 AND kind IN ('thread', 'event', 'file');
    `);
  },
};

/** Adds `job` as a piece kind, which like a thread sits in at most one open matter. */
export const gwsEaMatterJobsMigration: ModuleMigration = {
  version: 1,
  name: 'module:gws-ea-matters:browser-jobs',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_matter_links_with_jobs (
        matter_id TEXT NOT NULL REFERENCES gws_ea_matters(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('thread', 'event', 'file', 'person', 'memory', 'job')),
        reference TEXT NOT NULL CHECK (reference <> ''),
        handler TEXT CHECK (handler <> ''),
        matter_open INTEGER NOT NULL CHECK (matter_open IN (0, 1)),
        linked_at TEXT NOT NULL,
        PRIMARY KEY (matter_id, kind, reference)
      );
      INSERT INTO gws_ea_matter_links_with_jobs SELECT * FROM gws_ea_matter_links;
      DROP TABLE gws_ea_matter_links;
      ALTER TABLE gws_ea_matter_links_with_jobs RENAME TO gws_ea_matter_links;
      CREATE INDEX idx_gws_ea_matter_links_reference ON gws_ea_matter_links (kind, reference);
      CREATE UNIQUE INDEX idx_gws_ea_matter_links_one_open_matter
        ON gws_ea_matter_links (kind, reference)
        WHERE matter_open = 1 AND kind IN ('thread', 'event', 'file', 'job');
    `);
  },
};

export const gwsEaMatterChatsMigration: ModuleMigration = {
  version: 1,
  name: 'module:gws-ea-matters:chat-links',
  async up(db) {
    await db.exec(`
      CREATE TABLE gws_ea_matter_links_with_chats (
        matter_id TEXT NOT NULL REFERENCES gws_ea_matters(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('thread', 'event', 'file', 'person', 'memory', 'job', 'chat')),
        reference TEXT NOT NULL CHECK (reference <> ''),
        handler TEXT CHECK (handler <> ''),
        matter_open INTEGER NOT NULL CHECK (matter_open IN (0, 1)),
        linked_at TEXT NOT NULL,
        account TEXT CHECK (account <> ''),
        account_at TEXT,
        PRIMARY KEY (matter_id, kind, reference),
        CHECK ((account IS NULL) = (account_at IS NULL)),
        CHECK (kind = 'chat' OR account IS NULL)
      );
      INSERT INTO gws_ea_matter_links_with_chats (matter_id, kind, reference, handler, matter_open, linked_at)
        SELECT matter_id, kind, reference, handler, matter_open, linked_at FROM gws_ea_matter_links;
      DROP TABLE gws_ea_matter_links;
      ALTER TABLE gws_ea_matter_links_with_chats RENAME TO gws_ea_matter_links;
      CREATE INDEX idx_gws_ea_matter_links_reference ON gws_ea_matter_links (kind, reference);
      CREATE UNIQUE INDEX idx_gws_ea_matter_links_one_open_matter
        ON gws_ea_matter_links (kind, reference)
        WHERE matter_open = 1 AND kind IN ('thread', 'event', 'file', 'job');
    `);
  },
};

export const gwsEaMatterPlanningMigration: ModuleMigration = {
  version: 1,
  name: 'module:gws-ea-matters:planning-facts',
  async up(db) {
    await db.exec(`
      ALTER TABLE gws_ea_matters ADD COLUMN due_at TEXT;
      ALTER TABLE gws_ea_matters ADD COLUMN needs_minutes INTEGER CHECK (needs_minutes IS NULL OR needs_minutes >= 0);
      ALTER TABLE gws_ea_matters ADD COLUMN place TEXT;
      ALTER TABLE gws_ea_matters ADD COLUMN deferrals INTEGER NOT NULL DEFAULT 0 CHECK (deferrals >= 0);
    `);
  },
};

export const gwsEaTimeAnchorsMigration: ModuleMigration = {
  version: 1,
  name: 'module:gws-ea-matters:time-anchors',
  async up(db) {
    await db.exec(`CREATE TABLE gws_ea_time_anchors (
      session_id TEXT NOT NULL,
      series_id TEXT NOT NULL,
      anchor TEXT NOT NULL,
      PRIMARY KEY (session_id,series_id)
    )`);
  },
};
