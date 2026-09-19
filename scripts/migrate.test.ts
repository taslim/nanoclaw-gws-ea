import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const MIGRATE = path.resolve(import.meta.dirname, 'migrate.ts');
const TSX_LOADER = path.resolve(import.meta.dirname, '../node_modules/tsx/dist/loader.mjs');

describe('scripts/migrate.ts', () => {
  it('migrates the composed SQLite central database', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-migrate-script-'));
    try {
      const result = spawnSync(process.execPath, ['--import', TSX_LOADER, MIGRATE], {
        cwd,
        encoding: 'utf8',
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Central DB migrations are current.');
      const dbPath = path.join(cwd, 'data', 'v2.db');
      const db = new Database(dbPath, { readonly: true });
      const row = db.prepare('SELECT COUNT(*) AS count FROM schema_version').get() as { count: number };
      const profileMigration = db
        .prepare("SELECT name FROM schema_version WHERE name = 'module:gws-ea-profile:create-profile'")
        .get() as { name: string } | undefined;
      const profileTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gws_ea_profile'")
        .get() as { name: string } | undefined;
      db.close();
      expect(row.count).toBeGreaterThan(0);
      expect(profileMigration?.name).toBe('module:gws-ea-profile:create-profile');
      expect(profileTable?.name).toBe('gws_ea_profile');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
