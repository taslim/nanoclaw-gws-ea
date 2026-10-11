/**
 * Notes for main carry their matter (KTD11, R11): each open matter a note's
 * pieces sit in comes with it, rendered live once and stamped with when its
 * links were read, and a new invitation, share or comment in no open matter
 * brings the open matters it may belong to (KTD10). What cannot be read is
 * left out, and the note is written all the same.
 *
 * Driven through the real note writers into main's real session; Google is
 * in memory.
 */
import fs from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-test-gws-ea-main-note',
  GROUPS_DIR: '/tmp/nanoclaw-test-gws-ea-main-note/groups',
}));

vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn().mockResolvedValue(true) }));

/** Google as the host's own clients reach it, in memory: each test gets its own. */
const google = vi.hoisted(() => ({
  gmail: undefined as unknown,
  calendar: undefined as unknown,
  drive: undefined as unknown,
}));
vi.mock('../gws-ea-inbox/gmail-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gws-ea-inbox/gmail-api.js')>()),
  createGmailApi: () => ({
    getThread: (id: string) =>
      (google.gmail as import('../gws-ea-inbox/testing/fake-gmail-threads.js').FakeGmailThreads).getThread(id),
  }),
}));
vi.mock('../gws-ea-meetings/calendar-api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../gws-ea-meetings/calendar-api.js')>();
  const { delegatingCalendarApi } = await import('../gws-ea-meetings/testing/fake-calendar.js');
  return {
    ...actual,
    createMeetingsCalendarApi: () =>
      delegatingCalendarApi(() => google.calendar as import('../gws-ea-meetings/calendar-api.js').MeetingsCalendarApi),
  };
});
vi.mock('../gws-ea-workspace/drive-api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../gws-ea-workspace/drive-api.js')>();
  const { delegatingDriveApi } = await import('../gws-ea-workspace/testing/fake-drive.js');
  return {
    ...actual,
    createDriveApi: () => delegatingDriveApi(() => google.drive as import('../gws-ea-workspace/drive-api.js').DriveApi),
  };
});
// The real renderer, which a test can make fail once.
vi.mock('../gws-ea-matters/render.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../gws-ea-matters/render.js')>();
  return { ...actual, renderMatter: vi.fn(actual.renderMatter) };
});

import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { formatLocalTime } from '../../timezone.js';
import '../gws-ea-inbox/index.js';
import { writeCalendarNote } from '../gws-ea-inbox/route-mail.js';
import { FakeGmailThreads } from '../gws-ea-inbox/testing/fake-gmail-threads.js';
import { createThread } from '../gws-ea-inbox/thread-map.js';
import { closeMatter, getMatter, openMatter, type LinkRef, type Matter } from '../gws-ea-matters/db.js';
import '../gws-ea-matters/index.js';
import { mainConversation } from '../gws-ea-matters/looks.js';
import { renderMatter } from '../gws-ea-matters/render.js';
import { mainSession, seedMain } from '../gws-ea-matters/testing/main-conversation.js';
import { FakeCalendar } from '../gws-ea-meetings/testing/fake-calendar.js';
import { addPerson } from '../gws-ea-people/db.js';
import '../gws-ea-people/index.js';
import { writeWorkspaceNote, type WorkspaceNotice } from '../gws-ea-workspace/notices.js';
import { FakeDrive } from '../gws-ea-workspace/testing/fake-drive.js';
import { addPrincipalAddress } from './db.js';
import './index.js';
import { noteNames, resolveMainConversation, writeNoteForMain, type NotePiece } from './main-note.js';

const DATA_DIR = '/tmp/nanoclaw-test-gws-ea-main-note';
const ZONE = 'America/New_York';
const NOW = '2026-10-10T17:00:00.000Z';
const MORGAN = 'morgan@ellery.example';
const ASSISTANT = 'assistant@ellery.example';
const JUNO = 'juno@acme.example';
const REMY = 'remy@acme.example';
const NOEL = 'noel@archer.example';
const THREAD_JUNO = 'mail-8d1f2c34-5b6a-4e7f-9a01-23456789abcd';
const THREAD_REMY = 'mail-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const RENEWAL_CALL = 'renewalcall1';
const INVITATION = 'acmeinvite1';
const DINNER = 'dinner1';
const CALENDAR_CLOSING = 'Read each event from the calendar before you act on it.';

let gmail: FakeGmailThreads;
let calendar: FakeCalendar;
let drive: FakeDrive;
let juno: string;

/** An event on Morgan's calendar, as a matter links it and a note names it. */
function event(eventId: string): LinkRef & NotePiece {
  return { kind: 'event', reference: `${MORGAN}/${eventId}` };
}

function thread(threadKey: string): LinkRef & NotePiece {
  return { kind: 'thread', reference: threadKey };
}

async function open(title: string, links: readonly LinkRef[]): Promise<Matter> {
  vi.setSystemTime(Date.now() + 1_000);
  return (await openMatter({ title, openLoop: 'Morgan wants it settled this week.', links })).matter;
}

/** A matter as main reads it now, the random ids in its untrusted frames made stable. */
async function rendered(matter: Matter): Promise<string> {
  const current = await getMatter(matter.id);
  if (current === undefined) throw new Error(`${matter.id} is gone`);
  return stable(await renderMatter(current));
}

function stable(text: string): string {
  return text.replace(/ id="[0-9a-f]{16}"/gu, ' id="…"');
}

/** The notes in main's conversation, oldest first, as main reads them. */
async function notes(): Promise<string[]> {
  const session = await mainSession();
  const db = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  const rows = db.prepare("SELECT content FROM messages_in WHERE kind = 'chat' ORDER BY seq").all() as Array<{
    content: string;
  }>;
  db.close();
  return rows.map((row) => stable((JSON.parse(row.content) as { text: string }).text));
}

async function onlyNote(): Promise<string> {
  const [note, ...others] = await notes();
  expect(others).toEqual([]);
  if (note === undefined) throw new Error('main has no note');
  return note;
}

function times(text: string, part: string): number {
  return text.split(part).length - 1;
}

function note(text: string, pieces: readonly NotePiece[]) {
  return writeNoteForMain({
    id: `note-${Math.random().toString(36).slice(2)}`,
    timestamp: NOW,
    text,
    wake: false,
    pieces,
  });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  gmail = new FakeGmailThreads();
  calendar = new FakeCalendar();
  drive = new FakeDrive(ASSISTANT);
  for (const account of [MORGAN, JUNO, REMY]) drive.addAccount(account);
  google.gmail = gmail;
  google.calendar = calendar;
  google.drive = drive;
  await runMigrations(await initTestDb());
  await seedMain(ZONE);
  await getDb().run(
    `UPDATE gws_ea_profile SET principal_display_name = 'Morgan Ellery', assistant_workspace_email = ? WHERE singleton = 1`,
    ASSISTANT,
  );
  await addPrincipalAddress(MORGAN);
  juno = (
    await addPerson({
      name: 'Juno Hale',
      level: 'active',
      source: 'principal',
      basis: 'Acme account lead.',
      identity: `email:${JUNO}`,
    })
  ).id;
  await createThread('g-juno', NOW, THREAD_JUNO);
  await createThread('g-remy', NOW, THREAD_REMY);
  gmail.put('g-juno', { id: 'j1', from: `Juno Hale <${JUNO}>`, at: '2026-10-09T15:00:00.000Z', subject: 'Renewal' });
  calendar.put({
    calendarId: MORGAN,
    id: RENEWAL_CALL,
    status: 'confirmed',
    organizer: { email: JUNO },
    summary: 'Acme renewal call',
    start: { dateTime: '2026-10-14T14:00:00.000Z' },
    end: { dateTime: '2026-10-14T14:30:00.000Z' },
    attendees: [
      { email: MORGAN, responseStatus: 'accepted' },
      { email: JUNO, responseStatus: 'accepted', organizer: true },
    ],
  });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.mocked(renderMatter).mockClear();
  await closeDb();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('a note about a piece of an open matter (KTD11, R11)', () => {
  it('carries the matter, its links read live, stamped with when they were read', async () => {
    const acme = await open('Acme renewal', [
      thread(THREAD_JUNO),
      event(RENEWAL_CALL),
      { kind: 'person', reference: juno },
    ]);

    await writeCalendarNote(
      [{ gmailMessageId: 'n-1', notice: { calendarId: MORGAN, eventId: RENEWAL_CALL, change: 'changed' } }],
      calendar,
      new Date(NOW),
    );

    const text = await onlyNote();
    expect(text).toBe(
      `Google Calendar reports a change:\n- An event changed (event ${RENEWAL_CALL} on calendar ${MORGAN})\n${CALENDAR_CLOSING}\n\n` +
        (await rendered(acme)),
    );
    expect(text).toContain(`Matter ${acme.id}, open: Acme renewal\nLinks read ${formatLocalTime(NOW, ZONE)}.`);
    // Read live: the event's time and Juno's answer as Calendar holds them now.
    expect(text).toMatch(new RegExp(`- event ${MORGAN}/${RENEWAL_CALL}: [^\\n]*accepted: [^\\n]*Juno Hale`, 'u'));
  });

  it('renders each matter once, however many of its pieces the note names', async () => {
    calendar.put({
      calendarId: MORGAN,
      id: DINNER,
      status: 'confirmed',
      organizer: { email: MORGAN },
      start: { dateTime: '2026-10-12T23:00:00.000Z' },
      end: { dateTime: '2026-10-13T01:00:00.000Z' },
    });
    const acme = await open('Acme renewal', [thread(THREAD_JUNO), event(RENEWAL_CALL)]);
    const dinner = await open("Juno's dinner", [event(DINNER)]);

    await note('Three changes.', [event(RENEWAL_CALL), thread(THREAD_JUNO), event(DINNER), event(RENEWAL_CALL)]);

    expect(await onlyNote()).toBe(`Three changes.\n\n${await rendered(acme)}\n\n${await rendered(dinner)}`);
  });

  it('carries a strand with its project, and a piece in a closed matter carries nothing', async () => {
    const account = await open('Acme account', [thread(THREAD_JUNO)]);
    const strand = (
      await openMatter({
        title: 'Acme renewal',
        openLoop: 'Book the call.',
        links: [event(RENEWAL_CALL)],
        parentId: account.id,
      })
    ).matter;
    const lunch = await open('Lunch with Remy', [thread(THREAD_REMY)]);
    await closeMatter({ id: lunch.id, outcome: 'Had lunch.' });

    await note('Two changes.', [event(RENEWAL_CALL), thread(THREAD_REMY)]);

    const text = await onlyNote();
    expect(text).toBe(`Two changes.\n\n${await rendered(strand)}`);
    expect(text).toContain(`Project ${account.id}: Acme account`);
    expect(text).not.toContain(lunch.id);
  });
});

describe('a note about pieces in no open matter', () => {
  it('is written as it was, a new piece suggesting nothing unless Google verified who it came from', async () => {
    const lunch = await open('Lunch with Remy', [thread(THREAD_REMY)]);
    await closeMatter({ id: lunch.id, outcome: 'Had lunch.' });
    await open('Acme renewal', [{ kind: 'person', reference: juno }]);

    await note('Nothing to carry.', [
      thread(THREAD_REMY),
      event(DINNER),
      // An invitation whose organizer nobody verified claims nothing, whoever it names.
      { ...event(INVITATION), arrival: { from: undefined } },
      // A verified sender who shares nothing with any open matter.
      { ...event('noelparty1'), arrival: { from: NOEL } },
    ]);

    expect(await onlyNote()).toBe('Nothing to carry.');
  });

  it("carries the open matters Juno's new invitation may belong to, with why (F1)", async () => {
    const acme = await open('Acme renewal', [thread(THREAD_JUNO), { kind: 'person', reference: juno }]);
    calendar.put({
      calendarId: MORGAN,
      id: INVITATION,
      status: 'confirmed',
      organizer: { email: JUNO },
      start: { dateTime: '2026-10-15T14:00:00.000Z' },
      end: { dateTime: '2026-10-15T14:30:00.000Z' },
    });

    await writeCalendarNote(
      [{ gmailMessageId: 'n-1', notice: { calendarId: MORGAN, eventId: INVITATION, change: 'created' } }],
      calendar,
      new Date(NOW),
    );

    expect(await onlyNote()).toBe(
      `Google Calendar reports a change:\n- A new event (event ${INVITATION} on calendar ${MORGAN})\n${CALENDAR_CLOSING}\n\n` +
        `Event ${MORGAN}/${INVITATION} is in no open matter.\n` +
        'Open matters it may belong to:\n' +
        `- ${acme.id}: Acme renewal (same person)`,
    );
  });

  it('suggests nothing for an event that only changed, or a new one Calendar names no organizer of', async () => {
    await open('Acme renewal', [{ kind: 'person', reference: juno }]);

    await writeCalendarNote(
      [
        { gmailMessageId: 'n-1', notice: { calendarId: MORGAN, eventId: RENEWAL_CALL, change: 'changed' } },
        // Gone from Calendar by the time the note is written.
        { gmailMessageId: 'n-2', notice: { calendarId: MORGAN, eventId: INVITATION, change: 'created' } },
      ],
      calendar,
      new Date(NOW),
    );

    expect(await onlyNote()).toBe(
      'Google Calendar reports 2 changes:\n' +
        `- An event changed (event ${RENEWAL_CALL} on calendar ${MORGAN})\n` +
        `- A new event (event ${INVITATION} on calendar ${MORGAN})\n${CALENDAR_CLOSING}`,
    );
  });

  it('is written without suggestions while Calendar cannot name the organizer', async () => {
    await open('Acme renewal', [{ kind: 'person', reference: juno }]);
    calendar.failure = new Error('Calendar is down');

    await writeCalendarNote(
      [{ gmailMessageId: 'n-1', notice: { calendarId: MORGAN, eventId: INVITATION, change: 'created' } }],
      calendar,
      new Date(NOW),
    );

    expect(await onlyNote()).toBe(
      `Google Calendar reports a change:\n- A new event (event ${INVITATION} on calendar ${MORGAN})\n${CALENDAR_CLOSING}`,
    );
  });
});

describe('Docs and Drive activity', () => {
  it("carries a commented file's matter, and the matters a file shared new may belong to", async () => {
    const plan = drive.shareWithAssistant({ name: 'Renewal plan', owner: JUNO, role: 'writer', sharedAt: NOW });
    const pricing = drive.shareWithAssistant({ name: 'Pricing', owner: JUNO, role: 'reader', sharedAt: NOW });
    const acme = await open('Acme renewal', [
      { kind: 'file', reference: plan },
      { kind: 'person', reference: juno },
    ]);
    const notice = (activity: WorkspaceNotice['activity'], fileId: string, actor: string): WorkspaceNotice => ({
      activity,
      fileId,
      fileCount: 1,
      actor: { address: actor, displayName: 'Someone' },
      toAssistant: true,
      receivedAt: new Date(NOW),
    });

    await writeWorkspaceNote(
      [
        { gmailMessageId: 'w-1', notice: notice('comment', plan, REMY) },
        { gmailMessageId: 'w-2', notice: notice('share', pricing, JUNO) },
      ],
      drive,
      new Date(NOW),
    );

    const text = await onlyNote();
    expect(text).toMatch(/^Google Docs and Drive report activity on files you can see:\n/u);
    expect(times(text, `Matter ${acme.id}, open: Acme renewal`)).toBe(1);
    // The commented file's matter, then the shared file's suggestion, after the note's own words.
    expect(text.slice(text.indexOf(`\n\nMatter ${acme.id}`))).toBe(
      `\n\n${await rendered(acme)}\n\n` +
        `File ${pricing} is in no open matter.\nOpen matters it may belong to:\n- ${acme.id}: Acme renewal (same person)`,
    );
  });
});

describe('what cannot be read', () => {
  it('leaves out a matter whose render fails, and writes the note all the same', async () => {
    calendar.put({
      calendarId: MORGAN,
      id: DINNER,
      status: 'confirmed',
      organizer: { email: MORGAN },
      start: { dateTime: '2026-10-12T23:00:00.000Z' },
      end: { dateTime: '2026-10-13T01:00:00.000Z' },
    });
    const acme = await open('Acme renewal', [event(RENEWAL_CALL)]);
    const dinner = await open("Juno's dinner", [event(DINNER)]);
    vi.mocked(renderMatter).mockRejectedValueOnce(new Error('The people store is locked'));

    expect(await note('Two changes.', [event(RENEWAL_CALL), event(DINNER)])).toBe('written');

    const text = await onlyNote();
    expect(text).toBe(`Two changes.\n\n${await rendered(dinner)}`);
    expect(text).not.toContain(acme.id);
  });
});

describe('a matter a note names by id, and what a note records for the host (KTD12)', () => {
  it('carries the matter after its pieces’ own, and keeps both beside its words, for a failed turn to name again', async () => {
    const acme = await open('Acme renewal', [thread(THREAD_JUNO)]);
    const lunch = await open('Lunch with Remy Vance', [thread(THREAD_REMY)]);

    await writeNoteForMain({
      id: 'note-named',
      timestamp: NOW,
      text: 'Two things.',
      wake: false,
      pieces: [thread(THREAD_JUNO)],
      matters: [lunch.id, acme.id],
    });

    expect(await onlyNote()).toBe(`Two things.\n\n${await rendered(acme)}\n\n${await rendered(lunch)}`);
    const session = await mainSession();
    const db = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
    const row = db.prepare("SELECT content FROM messages_in WHERE id = 'note-named'").get() as { content: string };
    db.close();
    expect(noteNames(row.content)).toEqual({ pieces: [thread(THREAD_JUNO)], matters: [lunch.id, acme.id] });
  });

  it('reads a new piece back with who Google verified it came from', () => {
    const invitation = { ...event(INVITATION), arrival: { from: JUNO, answers: ['<j1@acme.example>'] } };
    const unverified = { ...thread(THREAD_REMY), arrival: { from: undefined } };

    expect(noteNames(JSON.stringify({ text: 'New.', pieces: [invitation, unverified] }))).toEqual({
      pieces: [invitation, unverified],
      matters: [],
    });
  });

  it('reads nothing from content that records nothing, or records it malformed', () => {
    for (const content of [
      JSON.stringify({ text: 'Morgan wrote this.', sender: 'Morgan Ellery', senderId: 'users/morgan' }),
      JSON.stringify({ text: 'x', pieces: [{ kind: 'person', reference: 'p-1' }, { kind: 'thread' }], matters: [7] }),
      'not json',
    ]) {
      expect(noteNames(content)).toEqual({ pieces: [], matters: [] });
    }
  });
});

describe("main's one conversation", () => {
  it('is the session every note is written to and every look comes back in', async () => {
    const conversation = await resolveMainConversation();
    if (typeof conversation === 'string') throw new Error(`No conversation: ${conversation}`);
    expect(conversation.session.id).toBe((await mainSession()).id);
    expect(conversation.directMessage.id).toBe('mg-dm');
    expect((await mainConversation())?.id).toBe(conversation.session.id);
  });

  it('names what is missing before main or the principal is set', async () => {
    await getDb().run('UPDATE gws_ea_profile SET main_agent_group_id = NULL WHERE singleton = 1');
    expect(await resolveMainConversation()).toBe('no-main');
    expect(await mainConversation()).toBeUndefined();
    expect(await note('Nobody reads this.', [thread(THREAD_JUNO)])).toBe('no-main');
  });
});
