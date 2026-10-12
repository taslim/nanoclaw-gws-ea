/**
 * A matter as `main` reads it (KTD5, R4, R11, R30): its words, its next look
 * in the principal's time zone, its project and strands, and each link read
 * live from Gmail, Calendar and Drive every time, each read held to its own
 * deadline. Nothing a source says is stored; anyone forgotten is named by
 * neither name nor address; what someone else wrote arrives framed as
 * untrusted.
 *
 * Google is in memory (`FakeGmailThreads`, `FakeCalendar`, `FakeDrive`), and
 * main's conversation is a real session with a real scheduled task.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-test-gws-ea-matters-render',
}));

import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { createSession, getSession } from '../../db/sessions.js';
import { createScheduledTask, prepareScheduledTask } from '../scheduling/create.js';
import { initSessionFolder } from '../../session-manager.js';
import { GOOGLE_GRANT_FILE_ENV } from '../gws-ea-google/grant.js';
import { GoogleApiError } from '../gws-ea-inbox/gmail-api.js';
import '../gws-ea-inbox/index.js';
import { FakeGmailThreads } from '../gws-ea-inbox/testing/fake-gmail-threads.js';
import { createThread } from '../gws-ea-inbox/thread-map.js';
import { FakeCalendar } from '../gws-ea-meetings/testing/fake-calendar.js';
import { addPerson, recordForgottenFingerprints } from '../gws-ea-people/db.js';
import { createFingerprintKey, FINGERPRINT_KEY_FILE_NAME, identityFingerprint } from '../gws-ea-people/fingerprint.js';
import '../gws-ea-people/index.js';
import { addPrincipalAddress } from '../gws-ea-profile/db.js';
import '../gws-ea-profile/index.js';
import { FakeDrive } from '../gws-ea-workspace/testing/fake-drive.js';
import {
  closeMatter,
  getMatter,
  listOpenMatters,
  openMatter,
  recordLookTask,
  type LinkRef,
  type Matter,
} from './db.js';
import './index.js';
import type { LiveSources } from './live.js';
import { renderMatter, renderOpenList } from './render.js';

const DATA_DIR = '/tmp/nanoclaw-test-gws-ea-matters-render';
const ZONE = 'America/New_York';
const NOW = '2026-10-10T17:00:00.000Z';
const READ_AT = 'Links read Oct 10, 2026, 1:00 PM.';

const MAIN = 'ag-main';
const MORGAN = 'morgan@ellery.example';
const ASSISTANT = 'assistant@ellery.example';
const JUNO = 'juno@acme.example';
const REMY = 'remy@acme.example';
const NOEL = 'noel@archer.example';

const THREAD_JUNO = 'mail-8d1f2c34-5b6a-4e7f-9a01-23456789abcd';
const THREAD_REMY = 'mail-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const THREAD_NOEL = 'mail-5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9';
const THREAD_UNSENT = 'mail-1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
const KICKOFF = `${MORGAN}/kickoff1`;
const DINNER = `${MORGAN}/dinner1`;

let secretsDir: string;
let juno: string;
let remy: string;

/** Google as the host's tokens reach it, in memory, and a matter's sources over it. */
function world() {
  const gmail = new FakeGmailThreads();
  const calendar = new FakeCalendar();
  const drive = new FakeDrive(ASSISTANT);
  drive.addAccount(JUNO);
  drive.addAccount(MORGAN);
  const sources: LiveSources = { gmail, calendar, drive };
  return { gmail, calendar, drive, sources };
}

/** Open a matter a second after the last, so order by time is the order opened. */
async function open(title: string, openLoop: string, links: readonly LinkRef[] = [], parentId?: string) {
  vi.setSystemTime(Date.now() + 1_000);
  return (await openMatter({ title, openLoop, links, ...(parentId === undefined ? {} : { parentId }) })).matter;
}

async function fresh(matter: Matter): Promise<Matter> {
  const current = await getMatter(matter.id);
  if (!current) throw new Error(`${matter.id} is gone`);
  return current;
}

/** A matter's view, the random ids in its untrusted frames made stable. */
async function view(matter: Matter, sources: LiveSources): Promise<string> {
  return (await renderMatter(await fresh(matter), sources)).replace(/ id="[0-9a-f]{16}"/gu, ' id="…"');
}

function framed(source: string, ...lines: readonly string[]): string {
  return [
    '<<<EXTERNAL_UNTRUSTED_CONTENT id="…">>>',
    `Source: ${source}`,
    '---',
    ...lines,
    '<<<END_EXTERNAL_UNTRUSTED_CONTENT id="…">>>',
  ].join('\n');
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-ea-matters-secrets-'));
  vi.stubEnv(GOOGLE_GRANT_FILE_ENV, path.join(secretsDir, 'google-grant.json'));
  await runMigrations(await initTestDb());
  await createAgentGroup({ id: MAIN, name: 'main', folder: MAIN, agent_provider: null, created_at: NOW });
  await ensureContainerConfig(MAIN);
  await updateContainerConfigScalars(MAIN, { timezone: ZONE });
  await getDb().run(
    `UPDATE gws_ea_profile SET main_agent_group_id = ?, principal_display_name = 'Morgan Ellery',
       assistant_workspace_email = ? WHERE singleton = 1`,
    MAIN,
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
  remy = (
    await addPerson({
      name: 'Remy Vance',
      level: 'known',
      source: 'principal',
      basis: 'Acme buyer.',
      identity: `email:${REMY}`,
    })
  ).id;
  await createThread('g-juno', NOW, THREAD_JUNO);
  await createThread('g-remy', NOW, THREAD_REMY);
  await createThread('g-noel', NOW, THREAD_NOEL);
  await createThread(null, NOW, THREAD_UNSENT);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await closeDb();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.rmSync(secretsDir, { recursive: true, force: true });
});

describe('a matter as main reads it', () => {
  it("says whose turn each thread is, by the latest message Gmail holds, in the principal's time zone", async () => {
    const { gmail, sources } = world();
    gmail.put(
      'g-juno',
      { id: 'j1', from: `Assistant <${ASSISTANT}>`, at: '2026-10-09T20:15:00.000Z', sent: true },
      {
        id: 'j2',
        from: `Juno Hale <${JUNO}>`,
        at: '2026-10-10T14:02:00.000Z',
        subject: 'Re: Revised quote',
        snippet: 'Here it is, 4% lower than last year&#39;s.',
      },
      { id: 'j3', from: `Assistant <${ASSISTANT}>`, at: '2026-10-10T15:00:00.000Z', draft: true },
    );
    gmail.put('g-remy', {
      id: 'r1',
      from: `Assistant <${ASSISTANT}>`,
      at: '2026-10-09T20:15:00.000Z',
      subject: 'Kickoff',
      snippet: 'Remy, does Tuesday at 3 work?',
      sent: true,
    });
    const acme = await open('Acme renewal', 'Morgan wants it signed by Friday.\nWaiting on the redlines.', [
      { kind: 'thread', reference: THREAD_JUNO },
      { kind: 'thread', reference: THREAD_REMY },
    ]);

    expect(await view(acme, sources)).toBe(
      [
        `Matter ${acme.id}, open: Acme renewal`,
        READ_AT,
        'Open loop:',
        'Morgan wants it signed by Friday.',
        'Waiting on the redlines.',
        'Next look: none pending.',
        'Links:',
        `- thread ${THREAD_JUNO}: latest Oct 10, 2026, 10:02 AM, from them: waiting on us`,
        framed(
          'gmail',
          'Subject: Re: Revised quote',
          `From: Juno Hale <${JUNO}>`,
          "Excerpt: Here it is, 4% lower than last year's.",
        ),
        `- thread ${THREAD_REMY}: latest Oct 9, 2026, 4:15 PM, sent by the assistant: waiting on them`,
        framed('gmail', 'Subject: Kickoff', `From: Assistant <${ASSISTANT}>`, 'Excerpt: Remy, does Tuesday at 3 work?'),
      ].join('\n'),
    );
  });

  it("counts the principal's own message as ours, and a thread with nothing sent yet as just that", async () => {
    const { gmail, sources } = world();
    gmail.put('g-juno', { id: 'j1', from: `Morgan Ellery <${MORGAN}>`, at: '2026-10-10T13:00:00.000Z' });
    const acme = await open('Acme renewal', 'Renew.', [
      { kind: 'thread', reference: THREAD_JUNO },
      { kind: 'thread', reference: THREAD_UNSENT },
    ]);
    const rendered = await view(acme, sources);
    expect(rendered).toContain(
      `- thread ${THREAD_JUNO}: latest Oct 10, 2026, 9:00 AM, from Morgan Ellery's address: waiting on them`,
    );
    expect(rendered).toContain(`- thread ${THREAD_UNSENT}: nothing sent yet`);
  });

  it('reads the sent message from Gmail on every look, and stores nothing it read (AE7)', async () => {
    const { gmail, sources } = world();
    gmail.put('g-juno', { id: 'j1', from: `Juno Hale <${JUNO}>`, at: '2026-10-09T14:00:00.000Z' });
    const acme = await open('Acme renewal', 'Get the revised quote.', [{ kind: 'thread', reference: THREAD_JUNO }]);
    const stored = async () => [
      await getDb().all('SELECT * FROM gws_ea_matters ORDER BY id'),
      await getDb().all('SELECT * FROM gws_ea_matter_links ORDER BY matter_id, kind, reference'),
      await getDb().all('SELECT * FROM gws_ea_threads ORDER BY thread_key'),
    ];
    const before = await stored();

    expect(await view(acme, sources)).toContain('from them: waiting on us');
    gmail.put(
      'g-juno',
      { id: 'j1', from: `Juno Hale <${JUNO}>`, at: '2026-10-09T14:00:00.000Z' },
      {
        id: 'j2',
        from: `Assistant <${ASSISTANT}>`,
        at: '2026-10-10T16:30:00.000Z',
        snippet: 'Juno, could you send the revised quote?',
        sent: true,
      },
    );
    const after = await view(acme, sources);
    expect(after).toContain(
      `- thread ${THREAD_JUNO}: latest Oct 10, 2026, 12:30 PM, sent by the assistant: waiting on them`,
    );
    expect(after).toContain('Excerpt: Juno, could you send the revised quote?');
    expect(gmail.reads).toEqual(['g-juno', 'g-juno']);
    expect(await stored()).toEqual(before);
  });

  it("shows an event's time, whether it stands, and each guest's answer, by name where the principal keeps one", async () => {
    const { calendar, sources } = world();
    calendar.put({
      calendarId: MORGAN,
      id: 'kickoff1',
      status: 'confirmed',
      start: { dateTime: '2026-10-14T15:00:00-04:00' },
      end: { dateTime: '2026-10-14T16:00:00-04:00' },
      attendees: [
        { email: MORGAN, responseStatus: 'accepted', self: true },
        { email: REMY, responseStatus: 'declined' },
        { email: JUNO, responseStatus: 'accepted' },
        { email: NOEL, responseStatus: 'needsAction' },
        { email: ASSISTANT, responseStatus: 'tentative' },
        { email: 'room-4@resource.calendar.google.com', responseStatus: 'accepted', resource: true },
      ],
    });
    calendar.put({
      calendarId: MORGAN,
      id: 'dinner1',
      status: 'cancelled',
      start: { date: '2026-10-16' },
      end: { date: '2026-10-17' },
      attendees: [{ email: REMY, responseStatus: 'accepted' }],
    });
    const acme = await open('Acme renewal', 'Renew.', [
      { kind: 'event', reference: KICKOFF },
      { kind: 'event', reference: DINNER },
    ]);
    const rendered = await view(acme, sources);
    expect(rendered).toContain(
      `- event ${KICKOFF}: Oct 14, 2026, 3:00 PM to 4:00 PM; confirmed; declined: Remy Vance; maybe: the assistant; accepted: Morgan Ellery, Juno Hale; no answer yet: ${NOEL}`,
    );
    expect(rendered).toContain(`- event ${DINNER}: Oct 16, 2026, all day; cancelled`);
  });

  it("shows a file's latest change and who made it, and the open comments for the assistant", async () => {
    const { drive, sources } = world();
    const budget = drive.shareWithAssistant({ name: 'Q4 budget', owner: JUNO, role: 'commenter' });
    drive.edit(budget, JUNO, '2026-10-09T19:30:00.000Z');
    drive.comment(budget, {
      id: 'c-1',
      content: `+${ASSISTANT} can you check the totals?`,
      resolved: false,
      modifiedTime: '2026-10-10T13:00:00.000Z',
      assigneeEmailAddress: ASSISTANT,
    });
    drive.comment(budget, { id: 'c-2', content: 'Fixed the typo.', resolved: true, assigneeEmailAddress: ASSISTANT });
    drive.comment(budget, { id: 'c-3', content: 'Nice.', resolved: false, mentionedEmailAddresses: [MORGAN] });
    const notes = drive.shareWithAssistant({ name: 'Notes', owner: MORGAN, role: 'writer' });
    drive.edit(notes, MORGAN, '2026-10-10T12:00:00.000Z');
    const acme = await open('Acme renewal', 'Renew.', [
      { kind: 'file', reference: budget },
      { kind: 'file', reference: notes },
    ]);

    const rendered = await view(acme, sources);
    expect(rendered).toContain(
      [
        `- file ${budget}: changed Oct 9, 2026, 3:30 PM by Juno Hale; 1 open comment for the assistant, the latest Oct 10, 2026, 9:00 AM`,
        framed('drive', 'Title: Q4 budget', `Comment: +${ASSISTANT} can you check the totals?`),
      ].join('\n'),
    );
    expect(rendered).toContain(
      `- file ${notes}: changed Oct 10, 2026, 8:00 AM by Morgan Ellery; no open comments for the assistant`,
    );
  });

  it("says when a file's comments could not be read, and nothing of those Drive does not show the assistant", async () => {
    const { drive, sources } = world();
    const budget = drive.shareWithAssistant({ name: 'Q4 budget', owner: JUNO, role: 'reader' });
    drive.edit(budget, JUNO, '2026-10-09T19:30:00.000Z');
    const acme = await open('Acme renewal', 'Renew.', [{ kind: 'file', reference: budget }]);

    drive.failNext('listComments', new GoogleApiError(503, 'Google refused the comments: Backend Error'));
    expect(await view(acme, sources)).toContain(
      `- file ${budget}: changed Oct 9, 2026, 3:30 PM by Juno Hale; comments: couldn't read just now`,
    );
    drive.failNext(
      'listComments',
      new GoogleApiError(403, 'Google refused the comments: Insufficient permissions', {
        reason: 'insufficientFilePermissions',
      }),
    );
    expect(await view(acme, sources)).toContain(`- file ${budget}: changed Oct 9, 2026, 3:30 PM by Juno Hale\n`);
  });

  it('renders a read that fails, or misses its deadline, as unread, and the rest of the matter all the same', async () => {
    const { gmail, calendar, sources } = world();
    calendar.put({
      calendarId: MORGAN,
      id: 'kickoff1',
      status: 'confirmed',
      start: { dateTime: '2026-10-14T15:00:00-04:00' },
      end: { dateTime: '2026-10-14T16:00:00-04:00' },
    });
    const acme = await open('Acme renewal', 'Renew.', [
      { kind: 'thread', reference: THREAD_JUNO },
      { kind: 'event', reference: KICKOFF },
    ]);

    gmail.failNext(new GoogleApiError(503, 'Google refused /gmail/v1/users/me/threads/g-juno: Backend Error'));
    const failed = await view(acme, sources);
    expect(failed).toContain(`- thread ${THREAD_JUNO}: couldn't read just now`);
    expect(failed).toContain(`- event ${KICKOFF}: Oct 14, 2026, 3:00 PM to 4:00 PM; confirmed`);

    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date(NOW));
    const begun = gmail.stallNext();
    const late = view(acme, sources);
    await begun;
    await vi.advanceTimersByTimeAsync(4_999);
    let settled = false;
    void late.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const rendered = await late;
    expect(rendered).toContain(`- thread ${THREAD_JUNO}: couldn't read just now`);
    expect(rendered).toContain(`- event ${KICKOFF}: Oct 14, 2026, 3:00 PM to 4:00 PM; confirmed`);
  });

  it('names no one the principal had forgotten, by name or address', async () => {
    const { gmail, calendar, sources } = world();
    const key = await createFingerprintKey(path.join(secretsDir, FINGERPRINT_KEY_FILE_NAME));
    await recordForgottenFingerprints([
      { fingerprint: identityFingerprint(key, `email:${NOEL}`), forgotten_at: NOW },
      // Juno's record is still here, as a snapshot restore leaves one.
      { fingerprint: identityFingerprint(key, `email:${JUNO}`), forgotten_at: NOW },
    ]);
    gmail.put('g-noel', {
      id: 'n1',
      from: `Noel Archer <${NOEL}>`,
      at: '2026-10-10T14:02:00.000Z',
      subject: 'Lunch with Noel',
      snippet: 'Noel here, are we still on?',
    });
    calendar.put({
      calendarId: MORGAN,
      id: 'kickoff1',
      status: 'confirmed',
      start: { dateTime: '2026-10-14T15:00:00-04:00' },
      end: { dateTime: '2026-10-14T16:00:00-04:00' },
      attendees: [
        { email: NOEL, responseStatus: 'declined' },
        { email: REMY, responseStatus: 'accepted' },
      ],
    });
    const lunch = await open('Lunch', 'Find a day.', [
      { kind: 'thread', reference: THREAD_NOEL },
      { kind: 'event', reference: KICKOFF },
      { kind: 'person', reference: juno },
    ]);

    const rendered = await view(lunch, sources);
    expect(rendered).toContain(
      `- thread ${THREAD_NOEL}: latest Oct 10, 2026, 10:02 AM, from someone forgotten: waiting on us\n- event`,
    );
    expect(rendered).toContain('declined: someone forgotten; accepted: Remy Vance');
    expect(rendered).toContain(`- person ${juno}: someone forgotten`);
    for (const named of ['Noel', NOEL, 'archer', 'Juno', JUNO]) expect(rendered).not.toContain(named);
  });

  it("shows the account external-email left on a thread under it, as external-email's words (AE10)", async () => {
    const { gmail, sources } = world();
    gmail.put('g-remy', { id: 'r1', from: `Remy Vance <${REMY}>`, at: '2026-10-10T14:00:00.000Z' });
    const acme = await open('Acme renewal', 'Renew.', [{ kind: 'thread', reference: THREAD_REMY }]);
    await getDb().run(
      "UPDATE gws_ea_matter_links SET handler = 'external-email' WHERE matter_id = ? AND reference = ?",
      acme.id,
      THREAD_REMY,
    );
    const accounts: LiveSources = {
      ...sources,
      threadAccount: async (threadKey) =>
        threadKey === THREAD_REMY
          ? { text: "Acme's budget is frozen until Q1. Remy will confirm in January.", at: '2026-10-10T15:00:00.000Z' }
          : undefined,
    };

    expect(await view(acme, accounts)).toContain(
      [
        `- thread ${THREAD_REMY}: latest Oct 10, 2026, 10:00 AM, from them: waiting on us`,
        framed('gmail', `From: Remy Vance <${REMY}>`),
        '  handled by external-email; its account, Oct 10, 2026, 11:00 AM:',
        framed('external-email', "Acme's budget is frozen until Q1. Remy will confirm in January."),
      ].join('\n'),
    );
    const unaccounted = await view(acme, sources);
    expect(unaccounted).toContain('  handled by external-email');
    expect(unaccounted).not.toContain('its account');
  });

  it("shows a strand its project's open loop and a line for each other strand, and a project its strands (R30)", async () => {
    const { sources } = world();
    const account = await open('Acme account', 'Keep Acme through renewal.\nBudget decision in Q1.');
    const renewal = await open('Renewal', 'Signed by Friday.', [], account.id);
    const legal = await open('Legal review', 'Redlines back Monday.', [], account.id);
    const kickoff = await open('Kickoff', 'Book it.', [], account.id);
    await closeMatter({ id: kickoff.id, outcome: 'Held on the 2nd.' });

    expect(await view(renewal, sources)).toBe(
      [
        `Matter ${renewal.id}, open: Renewal`,
        READ_AT,
        'Open loop:',
        'Signed by Friday.',
        'Next look: none pending.',
        `Project ${account.id}: Acme account`,
        'Its open loop:',
        'Keep Acme through renewal.',
        'Budget decision in Q1.',
        'Its other strands:',
        `- ${legal.id}, open: Legal review`,
        `- ${kickoff.id}, closed: Kickoff`,
        'Links: none.',
      ].join('\n'),
    );
    expect(await view(account, sources)).toContain(
      [
        'Strands:',
        `- ${renewal.id}, open: Renewal`,
        `- ${legal.id}, open: Legal review`,
        `- ${kickoff.id}, closed: Kickoff`,
      ].join('\n'),
    );
  });

  it('renders a closed matter with its outcome, people by name, memory by path, and what no source knows', async () => {
    const { gmail, sources } = world();
    const acme = await open('Acme renewal', 'Renew.', [
      { kind: 'thread', reference: THREAD_JUNO },
      { kind: 'event', reference: `${MORGAN}/gone1` },
      { kind: 'file', reference: 'file-unknown' },
      { kind: 'person', reference: remy },
      { kind: 'memory', reference: 'memory/clients/acme.md' },
    ]);
    await closeMatter({ id: acme.id, outcome: 'Signed on the 9th.' });

    expect(await view(acme, sources)).toBe(
      [
        `Matter ${acme.id}, closed Oct 10, 2026, 1:00 PM: Acme renewal`,
        READ_AT,
        'Open loop:',
        'Renew.',
        'Outcome: Signed on the 9th.',
        'Links:',
        `- thread ${THREAD_JUNO}: no longer in Gmail`,
        `- event ${MORGAN}/gone1: not on the calendar`,
        '- file file-unknown: gone, or not shared with the assistant',
        `- person ${remy}: Remy Vance`,
        '- memory memory/clients/acme.md',
      ].join('\n'),
    );
    expect(gmail.reads).toEqual(['g-juno']);
  });

  it("gives the next look in the principal's time zone, as main's scheduled task holds it", async () => {
    const { sources } = world();
    await createSession({
      id: 'sess-main',
      agent_group_id: MAIN,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: NOW,
    });
    initSessionFolder(MAIN, 'sess-main');
    const session = await getSession('sess-main');
    if (!session) throw new Error('No session');
    const once = await createScheduledTask(
      MAIN,
      prepareScheduledTask({ prompt: 'Look at the matter.', processAfter: '2026-10-14T09:00', timezone: ZONE }),
      { session },
    );
    const weekly = await createScheduledTask(
      MAIN,
      prepareScheduledTask({ prompt: 'Step back.', recurrence: '0 9 * * 1', timezone: ZONE }),
      { session },
    );
    const acme = await open('Acme renewal', 'Renew.');
    const office = await open('Office move', 'By December.');
    await recordLookTask(acme.id, once.row.id);
    await recordLookTask(office.id, weekly.row.id);

    expect(await view(acme, sources)).toContain('Next look: Oct 14, 2026, 9:00 AM.');
    expect(await view(office, sources)).toContain('Next look: Oct 12, 2026, 9:00 AM, repeating on "0 9 * * 1".');

    // During the look itself its occurrence is still pending at a time now past: a one-off
    // leaves nothing after it, and a repeating look is next due on its following date.
    vi.setSystemTime(new Date('2026-10-14T13:05:00.000Z'));
    expect(await view(acme, sources)).toContain('Next look: none pending.');
    expect(await view(office, sources)).toContain('Next look: Oct 19, 2026, 9:00 AM, repeating on "0 9 * * 1".');
  });
});

describe('the open list', () => {
  it("gives each open matter's title and open loop, its strands under their project", async () => {
    const account = await open('Acme account', 'Keep Acme through renewal.');
    const renewal = await open('Renewal', 'Signed by Friday.\nRedlines first.', [], account.id);
    const offsite = await open('Team offsite', 'Pick a venue.');
    const closed = await open('Old', 'Done.');
    await closeMatter({ id: closed.id, outcome: 'Done.' });

    expect(renderOpenList(await listOpenMatters())).toBe(
      [
        'Open matters:',
        `- ${offsite.id}: Team offsite`,
        '  Pick a venue.',
        `- ${account.id}: Acme account`,
        '  Keep Acme through renewal.',
        `  - ${renewal.id}: Renewal`,
        '    Signed by Friday.',
        '    Redlines first.',
      ].join('\n'),
    );
    expect(renderOpenList([])).toBe('Open matters: none.');
  });
});
