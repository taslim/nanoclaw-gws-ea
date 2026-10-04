/**
 * The email channel's migration (KTD10): the inbox registers it after every
 * earlier inbox and meetings table exists, and it is portable like every
 * migration written after the async boundary.
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { getRegisteredMigrations, runMigrations } from '../../db/migrations/index.js';
import '../index.js';
import { gwsEaInboxEmailChannelMigration } from './migration-email-channel.js';

/** The banned constructs of `src/db/migrations/portability.test.ts`, which covers built-in migrations only. */
const BANNED_PORTABLE_SQL = [
  /\bPRAGMA\b/i,
  /\bsqlite_master\b/i,
  /\bINSERT\s+OR\b/i,
  /\browid\b/i,
  /\bdatetime\s*\(/i,
  /\bstrftime\s*\(/i,
  /\bIS\s+\?/i,
];

const THREAD_TABLES = [
  'gws_ea_threads',
  'gws_ea_thread_messages',
  'gws_ea_thread_addresses',
  'gws_ea_thread_files',
  'gws_ea_thread_sends',
  'gws_ea_thread_holds',
  'gws_ea_thread_bookings',
];

describe('the email channel migration', () => {
  it('is registered by the inbox after its own store and the three meetings migrations, in that order', () => {
    const names = getRegisteredMigrations().map((migration) => migration.name);
    const expected = [
      'module:gws-ea-inbox:create-inbox',
      'module:gws-ea-meetings:create-meetings',
      'module:gws-ea-meetings:calendar-actions',
      'module:gws-ea-meetings:rooms',
      'module:gws-ea-inbox:email-channel',
    ];
    const start = names.indexOf(expected[0]!);
    expect(names.slice(start, start + expected.length)).toEqual(expected);
    expect(names.filter((name) => /^module:gws-ea-(inbox|meetings):/u.test(name))).toEqual(expected);
  });

  it('is async and its source carries none of the banned constructs', () => {
    expect(gwsEaInboxEmailChannelMigration.up.constructor.name).toBe('AsyncFunction');
    const source = fs.readFileSync(new URL('./migration-email-channel.ts', import.meta.url), 'utf8');
    for (const banned of BANNED_PORTABLE_SQL) expect(source, String(banned)).not.toMatch(banned);
  });

  describe('on a fresh install', () => {
    beforeEach(async () => {
      await runMigrations(await initTestDb());
    });

    afterEach(async () => {
      await closeDb();
    });

    it('creates every thread table', async () => {
      const db = getDb();
      expect(
        await db.get('SELECT name FROM schema_version WHERE name = ?', 'module:gws-ea-inbox:email-channel'),
      ).toBeDefined();
      for (const table of THREAD_TABLES) expect(await db.hasTable(table), table).toBe(true);
    });

    it('gives a thread no booking calendar until main names one', async () => {
      const db = getDb();
      const at = '2026-10-04T12:00:00.000Z';
      await db.run(
        'INSERT INTO gws_ea_threads (thread_key, gmail_thread_id, created_at) VALUES (?, NULL, ?)',
        'mail-a',
        at,
      );
      expect(await db.get('SELECT booking_calendar_id FROM gws_ea_threads WHERE thread_key = ?', 'mail-a')).toEqual({
        booking_calendar_id: null,
      });
      await expect(
        db.run("UPDATE gws_ea_threads SET booking_calendar_id = '' WHERE thread_key = ?", 'mail-a'),
      ).rejects.toThrow(/CHECK/i);
    });

    it('keeps a hold recorded while its thread is: the record is how its event is released', async () => {
      const db = getDb();
      const at = '2026-10-04T12:00:00.000Z';
      await db.run(
        'INSERT INTO gws_ea_threads (thread_key, gmail_thread_id, created_at) VALUES (?, NULL, ?)',
        'mail-a',
        at,
      );
      await db.run(
        `INSERT INTO gws_ea_thread_holds (thread_key, calendar_id, event_id, start_at, end_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        'mail-a',
        'principal@example.test',
        'hold1',
        '2026-10-06T15:00:00.000Z',
        '2026-10-06T15:30:00.000Z',
        '2026-10-07T12:00:00.000Z',
      );
      await expect(db.run('DELETE FROM gws_ea_threads WHERE thread_key = ?', 'mail-a')).rejects.toThrow(/FOREIGN KEY/i);
      await expect(
        db.run(
          'INSERT INTO gws_ea_threads (thread_key, gmail_thread_id, created_at) VALUES (?, NULL, ?)',
          'thread-b',
          at,
        ),
      ).rejects.toThrow(/CHECK/i);
    });
  });
});
