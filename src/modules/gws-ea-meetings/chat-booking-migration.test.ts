import Database from 'better-sqlite3';
import { expect, it } from 'vitest';

import { SqliteDriver } from '../../db/drivers/sqlite.js';
import { getRegisteredMigrations, runMigrations } from '../../db/migrations/index.js';
import './index.js';
import { chatBookingRequestsMigration } from './chat-booking-migration.js';

it('keeps pending mutations and their index while adding initial bookings to the recovery ledger', async () => {
  const db = new SqliteDriver(new Database(':memory:'));
  try {
    await db.exec(`
      CREATE TABLE sessions(id TEXT PRIMARY KEY);
      CREATE TABLE messaging_groups(id TEXT PRIMARY KEY);
      INSERT INTO sessions(id) VALUES('session');
      INSERT INTO messaging_groups(id) VALUES('chat');
    `);
    await runMigrations(db, [chatBookingRequestsMigration]);
    await db.run(
      'INSERT INTO gws_ea_chat_booking_requests(session_id,request_id,action,fingerprint,request_json,messaging_group_id,calendar_id,event_id,start_at,end_at,applied,result_json,reported,answered,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      'session',
      'change-request',
      'change',
      'fingerprint',
      '{"title":"Venue visit"}',
      'chat',
      'calendar',
      'event',
      '2026-10-20T12:00:00.000Z',
      '2026-10-20T12:30:00.000Z',
      1,
      '{"booking":"event"}',
      0,
      0,
      '2026-10-18T12:00:00.000Z',
    );
    const before = await db.all('SELECT * FROM gws_ea_chat_booking_requests');
    const migrations = getRegisteredMigrations().filter((migration) =>
      migration.name.startsWith('module:gws-ea-meetings:'),
    );
    await runMigrations(db, migrations);
    await runMigrations(db, migrations);
    expect(await db.all('SELECT * FROM gws_ea_chat_booking_requests')).toEqual(before);
    await expect(
      db.run(`
      INSERT INTO gws_ea_chat_booking_requests(session_id,request_id,action,fingerprint,request_json,messaging_group_id,calendar_id,event_id,start_at,end_at,created_at)
      SELECT session_id,'book-request','book',fingerprint,request_json,messaging_group_id,calendar_id,event_id,start_at,end_at,created_at
      FROM gws_ea_chat_booking_requests WHERE request_id='change-request'
    `),
    ).resolves.toEqual({ changes: 1 });
    expect(
      await db.get("SELECT sql FROM sqlite_master WHERE type='index' AND name='gws_ea_chat_booking_requests_pending'"),
    ).toEqual({
      sql: 'CREATE INDEX gws_ea_chat_booking_requests_pending ON gws_ea_chat_booking_requests(answered,created_at)',
    });
    expect(await db.all('PRAGMA foreign_key_check')).toEqual([]);
  } finally {
    await db.close();
  }
});
