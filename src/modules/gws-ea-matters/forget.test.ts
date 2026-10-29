/**
 * Forgetting a person across matters: they leave every
 * matter's links and the accounts on its threads, a matter kept only for
 * them goes with its look, and main is asked to rewrite every matter whose
 * pieces or words may name them. A look never shows them again.
 *
 * Driven through `ncl people forget` and `ncl matters` as main, with the
 * real forget hooks, main's real session mailbox, and the host's sweep after
 * a snapshot restore. Google is in memory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-test-gws-ea-matters-forget',
  GROUPS_DIR: '/tmp/nanoclaw-test-gws-ea-matters-forget/groups',
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

import { dispatch } from '../../cli/dispatch.js';
import type { CallerContext, ResponseFrame } from '../../cli/frame.js';
import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { GOOGLE_GRANT_FILE_ENV } from '../gws-ea-google/grant.js';
import '../gws-ea-inbox/index.js';
import { FakeGmailThreads } from '../gws-ea-inbox/testing/fake-gmail-threads.js';
import { createThread, recordThreadAddresses, setThreadAccount, threadAccount } from '../gws-ea-inbox/thread-map.js';
import { FakeCalendar } from '../gws-ea-meetings/testing/fake-calendar.js';
import { addPerson } from '../gws-ea-people/db.js';
import { createFingerprintKey, FINGERPRINT_KEY_FILE_NAME, identityFingerprint } from '../gws-ea-people/fingerprint.js';
import { peopleForgetHandoffFile, writePeopleForgetHandoff } from '../gws-ea-people/forget-handoff.js';
import { sweepForgetHandoff } from '../gws-ea-people/forget-sweep.js';
import '../gws-ea-people/index.js';
import { addPrincipalAddress } from '../gws-ea-profile/db.js';
import '../gws-ea-profile/index.js';
import { FakeDrive } from '../gws-ea-workspace/testing/fake-drive.js';
import { getMatter, setLinkHandler, type Matter, type Placed } from './db.js';
import { forgetFromMatters } from './forget.js';
import './index.js';
import type { ScriptVerdict } from './looks.js';
import { liveTaskRows, MAIN, mainSession, seedMain } from './testing/main-conversation.js';

const DATA_DIR = '/tmp/nanoclaw-test-gws-ea-matters-forget';
const ZONE = 'America/New_York';
const NOW = '2026-10-10T17:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;

const MORGAN = 'morgan@ellery.example';
const ASSISTANT = 'assistant@ellery.example';
const JUNO = 'juno@acme.example';
const REMY = 'remy@acme.example';
const NOEL = 'noel@archer.example';

const THREAD_JUNO = 'mail-8d1f2c34-5b6a-4e7f-9a01-23456789abcd';
const THREAD_REMY = 'mail-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const THREAD_NOEL = 'mail-5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9';
const KICKOFF = `${MORGAN}/kickoff1`;
const STANDUP = `${MORGAN}/standup1`;
const INTRO = `${MORGAN}/intro1`;
const JUNO_FILE = 'memory/people/juno-hale.md';
const YEARLY = '0 9 7 3 *';

const MAIN_CALLER: CallerContext = {
  caller: 'agent',
  sessionId: 'sess-main',
  agentGroupId: MAIN,
  messagingGroupId: 'mg-dm',
};

/** What `ncl people forget` answers. */
interface Forgotten {
  readonly forgotten: string;
  readonly name: string;
  readonly identities: readonly string[];
  readonly rewrite: readonly string[];
}

let gmail: FakeGmailThreads;
let calendar: FakeCalendar;
let drive: FakeDrive;
let secretsDir: string;
let juno: string;
let remy: string;

function run(command: string, args: Record<string, unknown>): Promise<ResponseFrame> {
  return dispatch({ id: command, command, args }, MAIN_CALLER);
}

async function data<T>(response: Promise<ResponseFrame>): Promise<T> {
  const settled = await response;
  if (!settled.ok) throw new Error(`Command failed: ${JSON.stringify(settled.error)}`);
  return settled.data as T;
}

/** A time `days` from now, to the minute. */
function inDays(days: number): string {
  return new Date(Math.floor((Date.now() + days * DAY) / 60_000) * 60_000).toISOString();
}

/** Open a matter as main does, looked at in three days unless `more` gives it a repeating look. */
async function open(title: string, links: Record<string, string>, more: Record<string, string> = {}): Promise<Matter> {
  const look = 'look-cron' in more ? {} : { look: inDays(3) };
  return (
    await data<Placed>(run('matters-open', { title, 'open-loop': 'What happens next.', ...look, ...more, ...links }))
  ).matter;
}

async function close(matter: Matter, outcome: string): Promise<void> {
  await data(run('matters-close', { id: matter.id, outcome }));
}

function forget(personId: string): Promise<Forgotten> {
  return data<Forgotten>(run('people-forget', { id: personId }));
}

/** The look tasks still to come in main's conversation, by series. */
async function liveLooks(): Promise<string[]> {
  return [...new Set(liveTaskRows(await mainSession()).map((row) => row.series_id))].sort();
}

function rewriteOf(...matters: readonly Matter[]): string[] {
  return matters.map((matter) => `matter ${matter.id}`).sort();
}

/** The notes in main's conversation, oldest first. */
async function notes(): Promise<string[]> {
  const session = await mainSession();
  const db = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  try {
    const rows = db.prepare("SELECT content FROM messages_in WHERE kind = 'chat' ORDER BY seq").all() as Array<{
      content: string;
    }>;
    return rows.map((row) => (JSON.parse(row.content) as { text: string }).text);
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA_DIR, 'gws-ea'), { recursive: true, mode: 0o700 });
  secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-ea-matters-forget-secrets-'));
  vi.stubEnv(GOOGLE_GRANT_FILE_ENV, path.join(secretsDir, 'google-grant.json'));
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
    `UPDATE gws_ea_profile SET principal_first_name = 'Morgan', principal_last_name = 'Ellery', assistant_workspace_email = ? WHERE singleton = 1`,
    ASSISTANT,
  );
  await addPrincipalAddress(MORGAN);
  const keep = async (name: string, address: string) =>
    (await addPerson({ name, level: 'active', source: 'principal', basis: 'Works with Morgan.', identity: address }))
      .id;
  juno = await keep('Juno Hale', `email:${JUNO}`);
  remy = await keep('Remy Vance', `email:${REMY}`);
  await keep('Noel Archer', `email:${NOEL}`);

  for (const [gmailThread, threadKey, people] of [
    ['g-juno', THREAD_JUNO, [JUNO, MORGAN]],
    ['g-remy', THREAD_REMY, [REMY, MORGAN]],
    ['g-noel', THREAD_NOEL, [NOEL, MORGAN]],
  ] as const) {
    await createThread(gmailThread, NOW, threadKey);
    await recordThreadAddresses(threadKey, people, 'message', NOW);
  }
  gmail.put('g-juno', { id: 'j1', from: `Juno Hale <${JUNO}>`, at: '2026-10-09T15:00:00.000Z', subject: 'Quote' });
  gmail.put('g-remy', {
    id: 'r1',
    from: `Remy Vance <${REMY}>`,
    at: '2026-10-09T16:00:00.000Z',
    subject: 'Kickoff',
    snippet: 'Tuesday works for us.',
  });
  calendar.put({
    calendarId: MORGAN,
    id: 'kickoff1',
    status: 'confirmed',
    start: { dateTime: '2026-10-14T19:00:00.000Z' },
    end: { dateTime: '2026-10-14T20:00:00.000Z' },
    attendees: [
      { email: MORGAN, responseStatus: 'accepted', self: true },
      { email: REMY, responseStatus: 'accepted' },
      { email: JUNO, responseStatus: 'tentative' },
    ],
  });
  calendar.put({
    calendarId: MORGAN,
    id: 'intro1',
    status: 'confirmed',
    start: { dateTime: '2026-10-15T19:00:00.000Z' },
    end: { dateTime: '2026-10-15T19:30:00.000Z' },
    organizer: { email: MORGAN },
    attendees: [
      { email: MORGAN, responseStatus: 'accepted', self: true },
      { email: NOEL, responseStatus: 'needsAction' },
    ],
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await closeDb();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.rmSync(secretsDir, { recursive: true, force: true });
});

describe('forgetting a person across matters', () => {
  it('takes Juno off every matter, and deletes the matters kept only for her with their looks', async () => {
    const birthday = await open("Juno's birthday", { person: juno, memory: JUNO_FILE }, { 'look-cron': YEARLY });
    const callBack = await open('Call back', { person: juno });
    const acme = await open('Acme renewal', { person: `${juno},${remy}`, thread: THREAD_REMY });
    expect(await liveLooks()).toHaveLength(3);

    const answer = await forget(juno);

    expect(await getMatter(birthday.id)).toBeUndefined();
    expect(await getMatter(callBack.id)).toBeUndefined();
    expect(await liveLooks()).toEqual([acme.look_task_id]);
    expect((await getMatter(acme.id))?.links).toMatchObject([
      { kind: 'thread', reference: THREAD_REMY },
      { kind: 'person', reference: remy },
    ]);
    expect(
      await getDb().all("SELECT matter_id FROM gws_ea_matter_links WHERE kind = 'person' AND reference = ?", juno),
    ).toEqual([]);
    // What is deleted is not put to main; what keeps a trace of her is.
    expect(answer).toMatchObject({ forgotten: juno, name: 'Juno Hale', rewrite: rewriteOf(acme) });
  });

  it('keeps a project kept only for her while one of its strands stays, and deletes one whose strands go with it', async () => {
    const wedding = await open('Wedding', { person: juno });
    const gift = await open('Gift', { person: juno }, { parent: wedding.id });
    const party = await open('Engagement party', { person: juno });
    const venue = await open('Venue', { thread: THREAD_NOEL }, { parent: party.id });

    const answer = await forget(juno);

    expect(await getMatter(gift.id)).toBeUndefined();
    expect(await getMatter(wedding.id)).toBeUndefined();
    expect(await getMatter(party.id)).toMatchObject({ links: [], strands: [{ id: venue.id, open: true }] });
    expect(await getMatter(venue.id)).toMatchObject({ parent_id: party.id, open: true });
    expect(answer.rewrite).toEqual(rewriteOf(party));
  });

  it('names for main every matter, open or closed, whose pieces or words may name her, and update rewrites a closed one without reopening it', async () => {
    const lunch = await open('Lunch with Juno', { memory: 'memory/places/mesa.md' });
    await close(lunch, 'Booked Friday at Mesa.');
    const quote = await open('Quote', { thread: THREAD_JUNO });
    const kickoff = await open('Kickoff', { event: KICKOFF });
    const budget = await open('Q4 budget', {
      file: drive.shareWithAssistant({ name: 'Q4 budget', owner: JUNO, role: 'commenter' }),
    });
    const offsite = await open('Offsite', {}, { 'open-loop': `Venue ideas go to ${JUNO} by Friday.` });
    const standup = await open('Standup', { event: STANDUP });
    const intro = await open('Noel intro', { thread: THREAD_NOEL, event: INTRO });
    // A link the host could not read may be hers: main is asked to look.
    const read = calendar.getEvent.bind(calendar);
    vi.spyOn(calendar, 'getEvent').mockImplementation(async (calendarId, eventId) => {
      if (eventId === 'standup1') throw new Error('Calendar is unavailable');
      return read(calendarId, eventId);
    });

    const answer = await forget(juno);

    expect([...answer.rewrite].sort()).toEqual(rewriteOf(lunch, quote, kickoff, budget, offsite, standup));
    expect(answer.rewrite).not.toContain(`matter ${intro.id}`);

    const looks = await liveLooks();
    const rewritten = await data<Matter>(
      run('matters-update', { id: lunch.id, title: 'Lunch', outcome: 'Booked Friday at Mesa with a friend.' }),
    );
    expect(rewritten).toMatchObject({
      title: 'Lunch',
      outcome: 'Booked Friday at Mesa with a friend.',
      open: false,
      look_task_id: null,
    });
    expect(await liveLooks()).toEqual(looks);
  });

  it('clears the account on each thread she was on, and on every thread of a matter that linked her', async () => {
    await open('Acme renewal', { person: juno, thread: THREAD_REMY });
    await open('Quote', { thread: THREAD_JUNO });
    await open('Noel intro', { thread: THREAD_NOEL });
    await setThreadAccount(THREAD_REMY, 'Remy has the redlines; Juno Hale signs on Friday.', NOW);
    await setThreadAccount(THREAD_JUNO, 'Asked Juno for the revised quote.', NOW);
    await setThreadAccount(THREAD_NOEL, 'Noel proposed Thursday.', NOW);

    await forget(juno);

    expect(await threadAccount(THREAD_REMY)).toBeUndefined();
    expect(await threadAccount(THREAD_JUNO)).toBeUndefined();
    expect(await threadAccount(THREAD_NOEL)).toEqual({ text: 'Noel proposed Thursday.', at: NOW });
  });

  it('never shows her name or address in a look once she is forgotten', async () => {
    const budget = drive.shareWithAssistant({ name: 'Q4 budget', owner: MORGAN, role: 'writer' });
    drive.edit(budget, JUNO, '2026-10-09T19:30:00.000Z');
    const acme = await open('Acme renewal', {
      person: `${juno},${remy}`,
      thread: `${THREAD_JUNO},${THREAD_REMY}`,
      event: KICKOFF,
      file: budget,
    });
    await setLinkHandler({ kind: 'thread', reference: THREAD_REMY }, 'external-email');
    await setThreadAccount(THREAD_REMY, 'Juno Hale asked Remy for the signed quote.', NOW);
    const look = async () => {
      const verdict = await data<ScriptVerdict>(run('matters-look', { id: acme.id }));
      expect(verdict.wakeAgent).toBe(true);
      return (verdict.data ?? []).join('\n');
    };
    const before = await look();
    expect(before).toContain('Juno Hale asked Remy for the signed quote.');
    expect(before).toContain(JUNO);

    await forget(juno);

    const after = await look();
    expect(after).not.toMatch(/juno/iu);
    expect(after).toContain('someone forgotten');
    expect(after).toContain('Remy Vance');
  });

  it('changes nothing when it runs again for the same person', async () => {
    await open("Juno's birthday", { person: juno, memory: JUNO_FILE }, { 'look-cron': YEARLY });
    await open('Acme renewal', { person: `${juno},${remy}`, thread: THREAD_REMY });
    await setThreadAccount(THREAD_REMY, 'Remy has the redlines.', NOW);
    const person = { id: juno, handles: [`email:${JUNO}`] };
    const state = async () => ({
      matters: await getDb().all('SELECT * FROM gws_ea_matters ORDER BY id'),
      links: await getDb().all('SELECT * FROM gws_ea_matter_links ORDER BY matter_id, kind, reference'),
      threads: await getDb().all('SELECT * FROM gws_ea_threads ORDER BY thread_key'),
      looks: await liveLooks(),
    });

    await forgetFromMatters(person);
    const once = await state();
    await forgetFromMatters(person);

    expect(once.looks).toHaveLength(1);
    expect(await state()).toEqual(once);
  });

  it('forgets her across matters again after a snapshot restore brought her back, and asks main to rewrite them again', async () => {
    // The restored state, from before the forget: Juno, her matters and her links are all back.
    const birthday = await open("Juno's birthday", { person: juno, memory: JUNO_FILE }, { 'look-cron': YEARLY });
    const lunch = await open('Lunch with Juno', { thread: THREAD_REMY });
    await close(lunch, 'Booked Friday at Mesa.');
    const key = await createFingerprintKey(path.join(secretsDir, FINGERPRINT_KEY_FILE_NAME));
    const handoff = peopleForgetHandoffFile(DATA_DIR);
    await writePeopleForgetHandoff(handoff, {
      fingerprints: [{ fingerprint: identityFingerprint(key, `email:${JUNO}`), forgotten_at: NOW }],
    });

    await sweepForgetHandoff(handoff);

    expect(await getMatter(birthday.id)).toBeUndefined();
    expect(await liveLooks()).toEqual([]);
    const [note, ...others] = await notes();
    expect(others).toEqual([]);
    expect(note).toContain('Juno Hale');
    expect(note).toContain(`matter ${lunch.id}`);
    expect(note).not.toContain(birthday.id);
    expect(fs.existsSync(handoff)).toBe(false);
  });
});

it('lists a matter whose place names the person for main to rewrite', async () => {
  const visit = await open('Site visit', {}, { place: "Juno Hale's office" });
  const answer = await forget(juno);
  expect(answer.rewrite).toContain(`matter ${visit.id}`);
});
