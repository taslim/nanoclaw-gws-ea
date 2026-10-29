/**
 * The inbox's migrations, squashed. Both live assistants applied
 * an earlier chain under today's names (`testing/earlier-chain.ts`). The
 * runner skips a name already applied and ignores one it no longer
 * registers, so a fresh install builds today's tables directly, and an
 * install on the earlier chain only drops what scheduling no longer uses.
 */
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DATA_DIR } from '../../config.js';
import type { DbDriver } from '../../db/driver.js';
import { sqliteRaw } from '../../db/drivers/sqlite.js';
import { closeDb, createMessagingGroup, initSqliteTestDb } from '../../db/index.js';
import { getRegisteredMigrations, runMigrations, type Migration } from '../../db/migrations/index.js';
import '../index.js';
import { getBooking } from '../gws-ea-meetings/bookings-db.js';
import { bookingsMigration } from '../gws-ea-meetings/bookings-migration.js';
import { setThreadBookingCalendar } from '../gws-ea-meetings/thread-calendar.js';
import { countSenderMessage, replacePrincipalCalendars, settleMessage, updateInboxState } from './db.js';
import { recordPollSuccess } from './health.js';
import { INBOX_PLATFORM_ID, PRINCIPAL_PLATFORM_ID } from './runtime.js';
import { EARLIER_INBOX_CHAIN } from './testing/earlier-chain.js';
import {
  createThread,
  findSend,
  insertPendingSend,
  recordSent,
  recordThreadAddresses,
  recordThreadFile,
  recordThreadMessage,
  threadAccount,
  threadPlacement,
  type SendScope,
} from './thread-map.js';

const CREATE_INBOX = 'module:gws-ea-inbox:create-inbox';
const EMAIL_CHANNEL = 'module:gws-ea-inbox:email-channel';
const DROP_THREAD_HOLDS = 'module:gws-ea-inbox:drop-thread-holds';
const RELATIVE_FILE_PATHS = 'module:gws-ea-inbox:relative-file-paths';
const UNSIGNED_NOTICES = 'module:gws-ea-inbox:unsigned-notices';
const CALENDAR_ACCESS = 'module:gws-ea-inbox:calendar-access';
const THREAD_ACCOUNTS = 'module:gws-ea-inbox:thread-accounts';
const THREAD_PLACEMENT = 'module:gws-ea-inbox:thread-placement';
const THREAD_AUTHENTICATION = 'module:gws-ea-inbox:thread-sender-authentication';

/** The inbox's tables and its thread map's after the squash, with none of the scheduling tables the earlier chain dropped. */
const INBOX_TABLES = [
  'gws_ea_inbox_calendars',
  'gws_ea_inbox_messages',
  'gws_ea_inbox_sender_counts',
  'gws_ea_inbox_state',
  'gws_ea_thread_addresses',
  'gws_ea_thread_files',
  'gws_ea_thread_messages',
  'gws_ea_thread_sends',
  'gws_ea_threads',
];

/** Every table the inbox's migrations leave: `INBOX_TABLES` and those later migrations add. */
const ALL_INBOX_TABLES = [...INBOX_TABLES, 'gws_ea_inbox_unsigned_notices', 'gws_ea_inbox_calendar_access'].sort();

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

const AT = '2026-10-07T09:00:00.000Z';
const THREAD = 'mail-quarterly-review';
const GMAIL_THREAD = 'gt-quarterly-review';
const CALENDAR = 'morgan@northwind.example';
const OUTSIDE: SendScope = { threadKey: THREAD, side: 'outside' };

afterEach(async () => {
  await closeDb();
});

/** An install that applied the earlier chain: every other migration as today, the earlier chain for the inbox's. */
function earlierRelease(): Migration[] {
  return getRegisteredMigrations().flatMap((migration) => {
    if (migration.name === bookingsMigration.name) return [];
    if (migration.name === CREATE_INBOX) return [...EARLIER_INBOX_CHAIN];
    return migration.name.startsWith('module:gws-ea-inbox:') ? [] : [migration];
  });
}

async function freshInstall(): Promise<DbDriver> {
  const db = await initSqliteTestDb();
  await runMigrations(db);
  return db;
}

async function updatedInstall(): Promise<DbDriver> {
  const db = await initSqliteTestDb();
  await runMigrations(db, earlierRelease());
  await runMigrations(db);
  return db;
}

async function appliedNames(db: DbDriver): Promise<string[]> {
  return (await db.all<{ name: string }>('SELECT name FROM schema_version ORDER BY version')).map((row) => row.name);
}

interface SchemaEntry {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
}

/**
 * Every table and index with its definition. `ALTER TABLE … ADD COLUMN`
 * splices its column into the stored definition with spacing of its own, so
 * whitespace is normalized.
 */
function schemaOf(db: DbDriver): SchemaEntry[] {
  return (
    sqliteRaw(db)
      .prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name')
      .all() as SchemaEntry[]
  ).map((entry) => ({
    ...entry,
    sql:
      entry.sql === null
        ? null
        : entry.sql
            .replace(/\s+/gu, ' ')
            .replace(/\s*([(),])\s*/gu, '$1')
            .trim(),
  }));
}

/** Every table of the inbox, its thread map, or the meetings store that was. */
function inboxTables(db: DbDriver): string[] {
  return schemaOf(db)
    .filter((entry) => entry.type === 'table' && /^gws_ea_(inbox|thread|meeting)/u.test(entry.name))
    .map((entry) => entry.name);
}

function rowsOf(db: DbDriver): Record<string, unknown[]> {
  const raw = sqliteRaw(db);
  return Object.fromEntries(
    INBOX_TABLES.map((table) => [table, raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
  );
}

/** Work the earlier release wrote, through today's code: a row in every `INBOX_TABLES` table. */
async function writeSlice4Work(db: DbDriver): Promise<void> {
  for (const [id, platformId] of [
    ['mg-inbox', INBOX_PLATFORM_ID],
    ['mg-principal', PRINCIPAL_PLATFORM_ID],
  ] as const) {
    await createMessagingGroup({
      id,
      channel_type: 'email',
      platform_id: platformId,
      name: id,
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: AT,
    });
  }
  await updateInboxState({ messaging_group_id: 'mg-inbox', principal_messaging_group_id: 'mg-principal' });
  await recordPollSuccess(AT);
  await settleMessage('g-1', 'outside', AT);
  await countSenderMessage('juno@acme.example', AT);
  await replacePrincipalCalendars([CALENDAR], AT);

  await createThread(GMAIL_THREAD, AT, THREAD);
  await recordThreadMessage(
    { threadKey: THREAD, side: 'outside', gmailMessageId: 'g-1', rfcMessageId: '<q1@acme.example>' },
    AT,
  );
  await recordThreadAddresses(THREAD, ['juno@acme.example'], 'message', AT);
  await recordThreadFile(
    THREAD,
    {
      sha256: 'a'.repeat(64),
      fileName: 'agenda.pdf',
      hostPath: path.join(DATA_DIR, 'v2-sessions', 'ag-external', 'sess-1', 'inbox', 'handoff-1', 'agenda.pdf'),
    },
    AT,
  );
  await insertPendingSend({ id: 'send-1', scope: OUTSIDE, contentHash: 'hash-1', rfcMessageId: '<s1@n.example>' }, AT);
  await recordSent(
    { id: 'send-1', scope: OUTSIDE },
    { gmailMessageId: 'g-2', gmailThreadId: GMAIL_THREAD, rfcMessageId: '<s1@n.example>' },
    AT,
  );
  await insertPendingSend({ id: 'send-2', scope: OUTSIDE, contentHash: 'hash-2', rfcMessageId: '<s2@n.example>' }, AT);
  await setThreadBookingCalendar(THREAD, CALENDAR);
  await db.run(
    'INSERT INTO gws_ea_thread_bookings(thread_key,calendar_id,event_id,booked_at) VALUES(?,?,?,?)',
    THREAD,
    CALENDAR,
    'evt-review',
    AT,
  );
}

describe('the inbox migrations', () => {
  it("keeps the inbox's migrations in order and registers chat booking recovery separately", () => {
    const names = getRegisteredMigrations()
      .map((migration) => migration.name)
      .filter((name) => name.startsWith('module:gws-ea-inbox:'));
    expect(names).toEqual([
      CREATE_INBOX,
      EMAIL_CHANNEL,
      DROP_THREAD_HOLDS,
      RELATIVE_FILE_PATHS,
      UNSIGNED_NOTICES,
      CALENDAR_ACCESS,
      THREAD_ACCOUNTS,
      THREAD_PLACEMENT,
      THREAD_AUTHENTICATION,
    ]);
    expect(
      getRegisteredMigrations()
        .map((migration) => migration.name)
        .filter((name) => name.startsWith('module:gws-ea-meetings:')),
    ).toEqual([
      'module:gws-ea-meetings:chat-booking-requests',
      'module:gws-ea-meetings:chat-booking-reports',
      bookingsMigration.name,
      'module:gws-ea-meetings:week-acknowledgements',
      'module:gws-ea-meetings:calendar-write-log',
      'module:gws-ea-meetings:pending-calendar-changes',
      'module:gws-ea-meetings:booking-write-windows',
    ]);
  });

  it('are portable: async, and free of every banned construct', () => {
    for (const migration of getRegisteredMigrations().filter((m) => m.name.startsWith('module:gws-ea-inbox:'))) {
      expect(migration.sqliteOnly, migration.name).not.toBe(true);
      expect(migration.up.constructor.name, migration.name).toBe('AsyncFunction');
    }
    const source = fs.readFileSync(new URL('./migration.ts', import.meta.url), 'utf8');
    for (const banned of BANNED_PORTABLE_SQL) expect(source, String(banned)).not.toMatch(banned);
  });
});

describe('squashed migrations', () => {
  it('give a fresh install the schema of an install updated from the earlier chain', async () => {
    const fresh = schemaOf(await freshInstall());
    expect(schemaOf(await updatedInstall())).toEqual(fresh);
  });

  it.each([
    ['a fresh install', freshInstall],
    ['an install updated from the earlier chain', updatedInstall],
  ])('leave %s only the inbox tables, and none of the dropped scheduling tables', async (_install, install) => {
    expect(inboxTables(await install())).toEqual(ALL_INBOX_TABLES);
  });

  it('update an install on the earlier chain by dropping the holds, keeping every inbox row, each thread with no account yet and handed over', async () => {
    const db = await initSqliteTestDb();
    await runMigrations(db, earlierRelease());
    await writeSlice4Work(db);
    const before = rowsOf(db);
    const earlier = await appliedNames(db);

    await runMigrations(db);

    expect((await appliedNames(db)).slice(earlier.length)).toEqual([
      DROP_THREAD_HOLDS,
      RELATIVE_FILE_PATHS,
      UNSIGNED_NOTICES,
      CALENDAR_ACCESS,
      THREAD_ACCOUNTS,
      THREAD_PLACEMENT,
      THREAD_AUTHENTICATION,
      bookingsMigration.name,
    ]);
    for (const table of INBOX_TABLES) expect(before[table], table).not.toEqual([]);
    expect(rowsOf(db)).toEqual({
      ...before,
      gws_ea_thread_addresses: before.gws_ea_thread_addresses.map((address) => ({
        ...(address as object),
        sender_authenticated: 0,
      })),
      gws_ea_threads: before.gws_ea_threads.map((thread) => ({
        ...(thread as object),
        account: null,
        account_at: null,
        placement: 'nowhere',
        released: 1,
        placement_note: null,
      })),
    });
    // A retry still finds its send in flight, and the thread still owns its booking.
    expect(await findSend(OUTSIDE, 'hash-2')).toMatchObject({ id: 'send-2', state: 'pending' });
    expect(await getBooking({ kind: 'thread', key: THREAD }, 'evt-review')).toMatchObject({ calendarId: CALENDAR });
  });
});

describe('relative-file-paths', () => {
  it("keeps each handed file by its place in the data directory, rewriting only an earlier release's absolute path into it", async () => {
    const db = await initSqliteTestDb();
    await runMigrations(
      db,
      getRegisteredMigrations().filter((migration) => migration.name !== RELATIVE_FILE_PATHS),
    );
    await createThread(GMAIL_THREAD, AT, THREAD);
    const recorded: ReadonlyArray<readonly [before: string, after: string]> = [
      // Through the checkout an earlier release ran from.
      [
        '/Users/operator/gws-ea/nanoclaw/data/v2-sessions/ag-external/sess-1/inbox/handoff-1/agenda.pdf',
        'v2-sessions/ag-external/sess-1/inbox/handoff-1/agenda.pdf',
      ],
      // The data directory is the last one the path passes through.
      [
        '/srv/data/v2-sessions/data/v2-sessions/ag-external/sess-2/inbox/handoff-2/notes.txt',
        'v2-sessions/ag-external/sess-2/inbox/handoff-2/notes.txt',
      ],
      ...[
        'v2-sessions/ag-external/sess-3/inbox/handoff-3/deck.pdf',
        '/files/agenda.pdf',
        'copies/data/v2-sessions/ag-external/sess-4/inbox/handoff-4/plan.pdf',
      ].map((unchanged) => [unchanged, unchanged] as const),
    ];
    for (const [index, [hostPath]] of recorded.entries()) {
      await db.run(
        'INSERT INTO gws_ea_thread_files (thread_key, sha256, file_name, host_path, handed_at) VALUES (?, ?, ?, ?, ?)',
        THREAD,
        String(index).repeat(64),
        `file-${index}`,
        hostPath,
        AT,
      );
    }

    await runMigrations(db);

    const rows = await db.all<{ host_path: string }>('SELECT host_path FROM gws_ea_thread_files ORDER BY sha256');
    expect(rows.map((row) => row.host_path)).toEqual(recorded.map(([, after]) => after));
  });
});

describe('thread-accounts', () => {
  it('holds no account on any thread until one is left, and never an empty one or one without its time', async () => {
    const db = await freshInstall();
    await createThread(GMAIL_THREAD, AT, THREAD);
    expect(await threadAccount(THREAD)).toBeUndefined();

    for (const [account, at] of [
      ['', AT],
      ['Waiting on Juno.', null],
      [null, AT],
    ] as const) {
      await expect(
        db.run('UPDATE gws_ea_threads SET account = ?, account_at = ? WHERE thread_key = ?', account, at, THREAD),
        `${String(account)} at ${String(at)}`,
      ).rejects.toThrow(/CHECK constraint failed/u);
    }
    expect(await threadAccount(THREAD)).toBeUndefined();
  });
});

describe('thread-placement', () => {
  it("hands over every thread an earlier release had, external-email's already, and holds each new one until main places it", async () => {
    const db = await initSqliteTestDb();
    await runMigrations(
      db,
      getRegisteredMigrations().filter((migration) => migration.name !== THREAD_PLACEMENT),
    );
    await createThread(GMAIL_THREAD, AT, THREAD);

    await runMigrations(db);

    expect(await threadPlacement(THREAD)).toEqual({ placement: 'nowhere', released: true });
    await createThread('gt-new', AT, 'mail-new');
    expect(await threadPlacement('mail-new')).toEqual({ placement: 'unplaced', released: false });
  });

  it('never holds a thread handed over before main placed it, nor a placement it does not know', async () => {
    const db = await freshInstall();
    await createThread(GMAIL_THREAD, AT, THREAD);

    for (const [placement, released] of [
      ['unplaced', 1],
      ['somewhere', 0],
    ] as const) {
      await expect(
        db.run(
          'UPDATE gws_ea_threads SET placement = ?, released = ? WHERE thread_key = ?',
          placement,
          released,
          THREAD,
        ),
        `${placement}, released ${released}`,
      ).rejects.toThrow(/CHECK constraint failed/u);
    }
    expect(await threadPlacement(THREAD)).toEqual({ placement: 'unplaced', released: false });
  });
});
