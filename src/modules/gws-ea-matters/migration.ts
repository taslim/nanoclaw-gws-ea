import type { ModuleMigration } from '../../db/migrations/index.js';

/**
 * Matters (KTD3): what `main` must come back to, each with only what lives
 * nowhere else (R2) and links to where the facts live (R3, R4). The schema
 * holds what it can on its own, so a writer that skips `db.ts` still cannot
 * break it:
 *
 * - a matter has a title, an open loop, an optional parent (a strand of that
 *   project, R29), and the task that is its next look (KTD4); it is open
 *   until it closes with an outcome, so an open matter never has one and a
 *   closed one always does (R5). There is no status, stage, priority, due
 *   date, owner or log;
 * - `look_failed_at` marks a failed look (KTD7 step 3). The runner settles a
 *   failed turn's rows as done, so a repeating look's next occurrence is
 *   armed on its next date as if it had run; the host marks the matter when
 *   it hears of the failure, and its loop brings that occurrence to the next
 *   daily sync, then clears the mark. It is the host's bookkeeping for one
 *   guarantee, never shown to `main` or anyone, and no status of the matter;
 * - a link is a reference by id: a thread key, `<calendar id>/<event id>`, a
 *   Drive file id, a person id, or a memory path. `handler` names the agent
 *   that works it (R7);
 * - a thread, event or file sits in at most one open matter (R3). SQLite's
 *   partial index cannot read another table, so each link carries its
 *   matter's open flag, which `db.ts` writes in the same transaction as the
 *   matter's open, close and reopen. A closed matter keeps its links.
 *
 * Strands stay one level deep, and a project stays open while a strand is
 * (KTD13): rules across rows, which `db.ts` enforces.
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
