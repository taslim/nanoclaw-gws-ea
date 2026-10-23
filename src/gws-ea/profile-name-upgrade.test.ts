import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { installProfileNameInput, profileNameInputFingerprint } from './profile-name-upgrade.js';
import type { ProfileNameMigrationInput } from './profile-name-migration.js';
import { readProfileNameInput } from './profile-name-upgrade.js';
import { assistant, cli, machine, nextRelease, removeTemporaryRoots, world } from './testing/cutover-fixture.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  await removeTemporaryRoots();
});

const input: ProfileNameMigrationInput = {
  schema_version: 1,
  instance_id: '12345678-1234-4234-8234-123456789012',
  previous: { assistant_display_name: 'Robin Wu', principal_display_name: 'Mary Ann Lee' },
  assistant: { firstName: 'Robin', lastName: 'Wu' },
  principal: { firstName: 'Mary Ann', lastName: 'Lee' },
};

async function legacy() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'profile-name-upgrade-'));
  roots.push(root);
  const file = path.join(root, 'v2.db');
  const db = new Database(file);
  db.exec(`CREATE TABLE gws_ea_profile (singleton INTEGER PRIMARY KEY, assistant_display_name TEXT, principal_display_name TEXT);
    INSERT INTO gws_ea_profile VALUES (1, 'Robin Wu', 'Mary Ann Lee');`);
  db.close();
  return file;
}

describe('explicit name upgrade input', () => {
  it('stages exact components in a disposable table without changing legacy identity', async () => {
    const file = await legacy();
    installProfileNameInput(file, input);
    installProfileNameInput(file, input);
    const db = new Database(file);
    try {
      expect(db.prepare('SELECT * FROM gws_ea_profile').get()).toEqual({ singleton: 1, ...input.previous });
      const row = db.prepare('SELECT payload FROM gws_ea_profile_name_input WHERE singleton = 1').get() as {
        payload: string;
      };
      expect(JSON.parse(row.payload)).toEqual(input);
    } finally {
      db.close();
    }
  });

  it('refuses missing or stale components before writing migration input', async () => {
    const file = await legacy();
    expect(() => installProfileNameInput(file, undefined)).toThrow(/names prepare/u);
    expect(() =>
      installProfileNameInput(file, { ...input, previous: { ...input.previous, principal_display_name: 'Old name' } }),
    ).toThrow(/stale/u);
    const db = new Database(file);
    try {
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'gws_ea_profile_name_input'").get(),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('binds proof to component boundaries even when display names are identical', () => {
    expect(profileNameInputFingerprint(input)).not.toBe(
      profileNameInputFingerprint({ ...input, principal: { firstName: 'Mary', lastName: 'Ann Lee' } }),
    );
  });

  it('retains explicit components across native command retries without changing live data', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const file = path.join(runtime.state_root, 'data', 'v2.db');
    const next = await nextRelease(host);
    const driver = cli(host, world(runtime), next, runtime);
    const args = [
      'names',
      'prepare',
      '--id',
      runtime.instance_id,
      '--assistant-first-name',
      'Robin',
      '--assistant-last-name',
      'Wu',
      '--principal-first-name',
      'Mary Ann',
      '--principal-last-name',
      'Lee',
      '--json',
    ];
    expect(await driver.run(args), driver.err.join('\n')).toBe(1);
    expect(JSON.parse(driver.out.at(-1) ?? '{}')).toMatchObject({
      error: { code: 'profile_names_current' },
      next_actions: [{ kind: 'command', argv: ['gws-ea', ...args.slice(0, -1)] }],
    });
    let failures = 0;
    let before: unknown;
    const interactive = cli(host, world(runtime), next, runtime, {
      onFailure: async () => {
        failures += 1;
        const db = new Database(file);
        try {
          db.exec(`ALTER TABLE gws_ea_profile ADD COLUMN assistant_display_name TEXT;
            ALTER TABLE gws_ea_profile ADD COLUMN principal_display_name TEXT;
            UPDATE gws_ea_profile SET assistant_display_name='Robin Wu',principal_display_name='Mary Ann Lee';`);
          before = db.prepare('SELECT * FROM gws_ea_profile').get();
        } finally {
          db.close();
        }
        return 'retry';
      },
    });
    expect(await interactive.run(args.slice(0, -1)), interactive.err.join('\n')).toBe(0);
    expect(failures).toBe(1);
    expect(await readProfileNameInput(host.paths, runtime.instance_id)).toEqual({
      ...input,
      instance_id: runtime.instance_id,
    });
    const read = new Database(file, { readonly: true });
    try {
      expect(read.prepare('SELECT * FROM gws_ea_profile').get()).toEqual(before);
    } finally {
      read.close();
    }
    expect(await driver.run(args), driver.err.join('\n')).toBe(0);
    expect(JSON.parse(driver.out.at(-1) ?? '{}')).toMatchObject({ changed: false });
  }, 60_000);
});
