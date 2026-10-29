import { afterEach, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../../db/connection.js';
import { getRegisteredMigrations, runMigrations } from '../../db/migrations/index.js';
import './index.js';

afterEach(closeDb);

it('adds native sender provenance without authenticating any previously carried thread address', async () => {
  const db = await initTestDb();
  const name = 'module:gws-ea-inbox:thread-sender-authentication';
  await runMigrations(
    db,
    getRegisteredMigrations().filter((migration) => migration.name !== name),
  );
  await db.run("INSERT INTO gws_ea_threads(thread_key,created_at) VALUES('mail-juno',?)", '2026-10-20T12:00:00.000Z');
  await db.run(
    "INSERT INTO gws_ea_thread_addresses(thread_key,address,source,recorded_at) VALUES('mail-juno','juno@outside.example','message',?)",
    '2026-10-20T12:00:00.000Z',
  );
  await runMigrations(db);
  expect(await db.get('SELECT sender_authenticated FROM gws_ea_thread_addresses')).toEqual({ sender_authenticated: 0 });
  await expect(db.run('UPDATE gws_ea_thread_addresses SET sender_authenticated=2')).rejects.toThrow();
});
