import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const MIGRATE = path.resolve(import.meta.dirname, 'migrate.ts');
const TSX_LOADER = path.resolve(import.meta.dirname, '../node_modules/tsx/dist/loader.mjs');

describe('scripts/migrate.ts', () => {
  it('migrates the composed SQLite central database without loading WhatsApp transport', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-migrate-script-'));
    try {
      const loader = path.join(cwd, 'reject-whatsapp.mjs');
      fs.writeFileSync(
        loader,
        `export function resolve(specifier, context, nextResolve) {
          if (specifier.startsWith('@whiskeysockets/baileys'))
            throw new Error('Migration loaded the WhatsApp transport');
          return nextResolve(specifier, context);
        }`,
      );
      const preload = `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)});`;
      const result = spawnSync(
        process.execPath,
        ['--import', TSX_LOADER, '--import', `data:text/javascript,${encodeURIComponent(preload)}`, MIGRATE],
        {
          cwd,
          encoding: 'utf8',
          timeout: 30_000,
          killSignal: 'SIGKILL',
        },
      );

      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Central DB migrations are current.');
      const dbPath = path.join(cwd, 'data', 'v2.db');
      const db = new Database(dbPath, { readonly: true });
      const row = db.prepare('SELECT COUNT(*) AS count FROM schema_version').get() as { count: number };
      const capabilitiesMigration = db
        .prepare("SELECT name FROM schema_version WHERE name = 'module:capabilities:container-config-capabilities'")
        .get() as { name: string } | undefined;
      const profileMigration = db
        .prepare("SELECT name FROM schema_version WHERE name = 'module:gws-ea-profile:create-profile'")
        .get() as { name: string } | undefined;
      const profileTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gws_ea_profile'")
        .get() as { name: string } | undefined;
      db.close();
      expect(row.count).toBeGreaterThan(0);
      expect(capabilitiesMigration?.name).toBe('module:capabilities:container-config-capabilities');
      expect(profileMigration?.name).toBe('module:gws-ea-profile:create-profile');
      expect(profileTable?.name).toBe('gws_ea_profile');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 35_000);
});
