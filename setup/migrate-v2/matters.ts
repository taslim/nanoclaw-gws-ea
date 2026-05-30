/**
 * Migrate v1 matters (`store/messages.db`) into v2's central DB + per-matter
 * context files at `groups/main/matters/<id>.md`.
 *
 * v1 stored matters as one row with TEXT columns for `artifacts` (JSON
 * `[{type, id}, ...]`), `context` (freeform), and `tracking_file`. v2 splits
 * this into a slim header row, normalized `matter_artifacts`, and a file.
 *
 * Translations:
 *   - artifact `email_thread`    → `gmail_thread_id`
 *   - artifact `calendar_event`  → `gcal_id`
 *   - artifact `doc`             → `gdocs_id`
 *   - `tracking_file` content is appended under a `## Tracking notes
 *     (migrated from v1)` section so nothing is lost.
 *
 * v1 ids are preserved. Refuses to run if v2 already has matter rows unless
 * `--force` is passed. Usage: `pnpm exec tsx setup/migrate-v2/matters.ts
 * [--v1-db <path>] [--dry-run] [--force]`.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR, GROUPS_DIR } from '../../src/config.js';
import { getAgentGroupByFolder } from '../../src/db/agent-groups.js';
import { getDb, initDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { log } from '../../src/log.js';
import { MATTER_STATUSES } from '../../src/types.js';

const MAIN_FOLDER = 'main';
const MATTERS_DIR = path.resolve(GROUPS_DIR, MAIN_FOLDER, 'matters');
const TRACKING_HEADER = '## Tracking notes (migrated from v1)';

const ARTIFACT_TYPE_MAP: Record<string, string> = {
  email_thread: 'gmail_thread_id',
  calendar_event: 'gcal_id',
  doc: 'gdocs_id',
};

const STATUS_SET = new Set<string>(MATTER_STATUSES);

interface V1Matter {
  id: number;
  title: string;
  status: string;
  artifacts: string | null;
  context: string | null;
  tracking_file: string | null;
  updated_at: string;
}

interface V1Artifact {
  type: string;
  id: string;
}

interface CliArgs {
  v1Db: string;
  dryRun: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let v1Db = '';
  let dryRun = false;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--force') force = true;
    else if (a === '--v1-db') {
      const next = argv[i + 1];
      if (!next) throw new Error('--v1-db requires a path argument');
      v1Db = next;
      i++;
    } else if (a.startsWith('--v1-db=')) {
      v1Db = a.slice('--v1-db='.length);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!v1Db) {
    const envPath = process.env.NANOCLAW_V1_PATH;
    if (!envPath) {
      throw new Error('Missing v1 path: pass --v1-db <path>, or set NANOCLAW_V1_PATH.');
    }
    v1Db = path.join(envPath, 'store', 'messages.db');
  }
  return { v1Db, dryRun, force };
}

function parseArtifacts(raw: string | null): V1Artifact[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`artifacts column not an array: ${trimmed.slice(0, 60)}`);
  }
  return parsed.map((entry) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof (entry as Record<string, unknown>).type !== 'string' ||
      typeof (entry as Record<string, unknown>).id !== 'string'
    ) {
      throw new Error(`artifact entry missing type/id: ${JSON.stringify(entry)}`);
    }
    return entry as V1Artifact;
  });
}

function readTrackingFile(file: string): string | null {
  const candidates = [
    path.resolve(GROUPS_DIR, MAIN_FOLDER, 'notes', file),
    path.resolve(GROUPS_DIR, MAIN_FOLDER, file),
  ];
  for (const candidate of candidates) {
    try {
      return fs.readFileSync(candidate, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  const v1Root = process.env.NANOCLAW_V1_PATH;
  if (!v1Root) return null;
  const v1Candidates = [
    path.join(v1Root, 'groups', 'main', 'notes', file),
    path.join(v1Root, 'groups', 'main', file),
  ];
  for (const candidate of v1Candidates) {
    try {
      return fs.readFileSync(candidate, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return null;
}

function buildContextBody(
  context: string | null,
  trackingFile: string | null,
): { body: string; trackingMissing: string | null } {
  const parts: string[] = [];
  if (context && context.trim().length > 0) parts.push(context.trim());

  let trackingMissing: string | null = null;
  if (trackingFile && trackingFile.trim().length > 0) {
    const content = readTrackingFile(trackingFile.trim());
    if (content && content.trim().length > 0) {
      parts.push(`${TRACKING_HEADER}\n\n${content.trim()}`);
    } else {
      trackingMissing = trackingFile.trim();
    }
  }

  return { body: parts.join('\n\n'), trackingMissing };
}

interface MigrationStats {
  mattersInserted: number;
  artifactsInserted: number;
  artifactsSkippedDuplicate: number;
  contextFilesWritten: number;
  trackingMissing: Array<{ matterId: number; file: string }>;
  unknownArtifactTypes: Array<{ matterId: number; type: string; id: string }>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const v1Path = args.v1Db;

  if (!fs.existsSync(v1Path)) {
    throw new Error(`v1 DB not found at ${v1Path}. Pass --v1-db <path> or set NANOCLAW_V1_PATH.`);
  }

  const v1Db = new Database(v1Path, { readonly: true });
  try {
    const v1Matters = v1Db
      .prepare(
        `SELECT id, title, status, artifacts, context, tracking_file, updated_at
         FROM matters ORDER BY id ASC`,
      )
      .all() as V1Matter[];

    log.info('Read v1 matters', { count: v1Matters.length, v1Path });

    if (args.dryRun) {
      const summary = v1Matters.map((m) => ({
        id: m.id,
        title: m.title,
        status: STATUS_SET.has(m.status) ? m.status : `${m.status} (unknown — will archive)`,
        artifacts: parseArtifacts(m.artifacts).length,
        contextBytes: (m.context ?? '').length,
        trackingFile: m.tracking_file ?? null,
      }));
      log.info('Dry run — no writes', { matters: summary });
      return;
    }

    initDb(path.join(DATA_DIR, 'v2.db'));
    runMigrations(getDb());

    const mainAg = getAgentGroupByFolder(MAIN_FOLDER);
    if (!mainAg) {
      throw new Error(
        `Agent group "${MAIN_FOLDER}" not found in v2.db. Run /init-first-agent before migrate-matters so the context files have a home.`,
      );
    }

    const v2 = getDb();
    const existingCount = (v2.prepare('SELECT COUNT(*) AS n FROM matters').get() as { n: number }).n;
    if (existingCount > 0 && !args.force) {
      throw new Error(
        `v2 matters table has ${existingCount} rows already. Pass --force to merge anyway (existing rows are left untouched; v1 ids that collide will fail).`,
      );
    }

    const stats: MigrationStats = {
      mattersInserted: 0,
      artifactsInserted: 0,
      artifactsSkippedDuplicate: 0,
      contextFilesWritten: 0,
      trackingMissing: [],
      unknownArtifactTypes: [],
    };

    const insertMatter = v2.prepare(
      `INSERT INTO matters (id, title, description, status, updated_at)
       VALUES (@id, @title, NULL, @status, @updated_at)`,
    );
    const insertArtifact = v2.prepare(
      `INSERT OR IGNORE INTO matter_artifacts (matter_id, artifact_type, artifact_id, linked_at)
       VALUES (@matter_id, @artifact_type, @artifact_id, @linked_at)`,
    );

    fs.mkdirSync(MATTERS_DIR, { recursive: true });

    const tx = v2.transaction(() => {
      for (const m of v1Matters) {
        const status = STATUS_SET.has(m.status) ? m.status : 'archived';
        insertMatter.run({
          id: m.id,
          title: m.title,
          status,
          updated_at: m.updated_at,
        });
        stats.mattersInserted++;

        const artifacts = parseArtifacts(m.artifacts);
        for (const a of artifacts) {
          const v2Type = ARTIFACT_TYPE_MAP[a.type];
          if (!v2Type) {
            stats.unknownArtifactTypes.push({ matterId: m.id, type: a.type, id: a.id });
            continue;
          }
          const result = insertArtifact.run({
            matter_id: m.id,
            artifact_type: v2Type,
            artifact_id: a.id,
            linked_at: m.updated_at,
          });
          if (result.changes === 1) stats.artifactsInserted++;
          else stats.artifactsSkippedDuplicate++;
        }

        const { body, trackingMissing } = buildContextBody(m.context, m.tracking_file);
        if (trackingMissing) {
          stats.trackingMissing.push({ matterId: m.id, file: trackingMissing });
        }
        if (body.length > 0) {
          fs.writeFileSync(path.join(MATTERS_DIR, `${m.id}.md`), body + '\n');
          stats.contextFilesWritten++;
        }
      }

      // Bump AUTOINCREMENT past the highest migrated id so future inserts
      // don't collide with the preserved v1 ids.
      const maxId = v1Matters.reduce((acc, m) => Math.max(acc, m.id), 0);
      if (maxId > 0) {
        const existing = v2
          .prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'matters'`)
          .get() as { seq: number } | undefined;
        if (existing) {
          if (maxId > existing.seq) {
            v2.prepare(`UPDATE sqlite_sequence SET seq = @seq WHERE name = 'matters'`).run({
              seq: maxId,
            });
          }
        } else {
          v2.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES ('matters', @seq)`).run({
            seq: maxId,
          });
        }
      }
    });
    tx();

    log.info('Matter migration complete', {
      ...stats,
      mattersDir: MATTERS_DIR,
    });

    if (stats.unknownArtifactTypes.length > 0) {
      log.warn(
        'Unmapped artifact types — review and link manually with `link_artifact`:',
        { unknown: stats.unknownArtifactTypes },
      );
    }
    if (stats.trackingMissing.length > 0) {
      log.warn(
        'Tracking files referenced but not found on disk — context migrated without them:',
        { missing: stats.trackingMissing },
      );
    }
  } finally {
    v1Db.close();
  }
}

main().catch((err) => {
  log.error('migrate-matters failed', { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
