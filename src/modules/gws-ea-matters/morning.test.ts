/**
 * The morning (KTD6, R16, R17): one recurring task in main's conversation,
 * before the principal's day starts, whose pre-task script prints the brief.
 * Driven through `ncl matters morning` and the host's pass against main's
 * real session mailbox, on a fixed Monday in New York; Google is in memory
 * and must never be read.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-test-gws-ea-matters-morning',
  GROUPS_DIR: '/tmp/nanoclaw-test-gws-ea-matters-morning/groups',
}));

vi.mock('../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-runner.js')>()),
  isContainerRunning: vi.fn(() => false),
}));

vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn().mockResolvedValue(true) }));

const google = vi.hoisted(() => ({ gmail: undefined as unknown }));
vi.mock('../gws-ea-inbox/gmail-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gws-ea-inbox/gmail-api.js')>()),
  createGmailApi: () => ({
    getThread: (id: string) =>
      (google.gmail as import('../gws-ea-inbox/testing/fake-gmail-threads.js').FakeGmailThreads).getThread(id),
  }),
}));

import { dispatch } from '../../cli/dispatch.js';
import type { CallerContext, ResponseFrame } from '../../cli/frame.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import '../gws-ea-inbox/index.js';
import { FakeGmailThreads } from '../gws-ea-inbox/testing/fake-gmail-threads.js';
import { createThread, recordThreadAddresses, recordThreadMessage } from '../gws-ea-inbox/thread-map.js';
import '../gws-ea-people/index.js';
import { setSchedulingPreference } from '../gws-ea-preferences/db.js';
import '../gws-ea-preferences/index.js';
import '../gws-ea-profile/index.js';
import type { Matter, Placed } from './db.js';
import './index.js';
import { keepMattersOnTime } from './loop.js';
import {
  liveTaskRows,
  MAIN,
  mainSession,
  printed,
  runnerReads,
  runOccurrence,
  seedMain,
  taskContent,
  taskRows,
  type TaskRow,
} from './testing/main-conversation.js';

const DATA_DIR = '/tmp/nanoclaw-test-gws-ea-matters-morning';
const ZONE = 'America/New_York';
/** Monday 12 October 2026, 6:00 AM in New York. */
const MONDAY_6AM = '2026-10-12T10:00:00.000Z';
const THREAD = 'mail-8d1f2c34-5b6a-4e7f-9a01-23456789abcd';
const MAIN_CALLER: CallerContext = {
  caller: 'agent',
  sessionId: 'sess-main',
  agentGroupId: MAIN,
  messagingGroupId: 'mg-dm',
};

function run(command: string, args: Record<string, unknown>): Promise<ResponseFrame> {
  return dispatch({ id: command, command, args }, MAIN_CALLER);
}

async function data<T>(response: Promise<ResponseFrame>): Promise<T> {
  const settled = await response;
  if (!settled.ok) throw new Error(`Command failed: ${JSON.stringify(settled.error)}`);
  return settled.data as T;
}

function refused(message: RegExp) {
  return { ok: false, error: { message: expect.stringMatching(message) } };
}

async function open(title: string, look: Record<string, string>, links: Record<string, string> = {}): Promise<Matter> {
  return (await data<Placed>(run('matters-open', { title, 'open-loop': 'What happens next.', ...look, ...links })))
    .matter;
}

/** The live occurrences of the morning series. */
async function mornings(): Promise<TaskRow[]> {
  return liveTaskRows(await mainSession()).filter((row) => row.series_id.startsWith('gws-ea-morning-'));
}

function localClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: ZONE, hour: 'numeric', minute: '2-digit' });
}

let gmail: FakeGmailThreads;
let scratch: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(MONDAY_6AM));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-ea-matters-morning-'));
  gmail = new FakeGmailThreads();
  google.gmail = gmail;
  await runMigrations(await initTestDb());
  await seedMain(ZONE);
  await createThread('gmail-thread-a', MONDAY_6AM, THREAD);
});

afterEach(async () => {
  vi.useRealTimers();
  await closeDb();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('the morning', () => {
  it("comes at 07:30 in main's time zone while the principal has no working hours, its brief as its script", async () => {
    expect(await data(run('matters-morning', {}))).toEqual({
      at: '07:30',
      timezone: ZONE,
      next: '2026-10-12T11:30:00.000Z',
    });

    const [morning] = await mornings();
    expect(await mornings()).toHaveLength(1);
    expect(morning).toMatchObject({ status: 'pending', recurrence: '30 7 * * *' });
    expect(localClock(morning.process_after)).toBe('7:30 AM');
    expect(taskContent(morning).script).toBe('ncl matters morning --brief');
    // Asked again, it is the same morning.
    expect(await data(run('matters-morning', {}))).toMatchObject({ at: '07:30' });
    expect(await mornings()).toEqual([morning]);
  });

  it('comes 30 minutes before the earliest working-hours start', async () => {
    const basis = 'Said so.';
    await setSchedulingPreference({
      kind: 'working-hours',
      weekday: 'mon',
      hours: { start: '09:00', end: '17:00' },
      source: 'principal',
      basis,
    });
    await setSchedulingPreference({
      kind: 'working-hours',
      weekday: 'tue',
      hours: { start: '08:15', end: '16:00' },
      source: 'principal',
      basis,
    });
    await setSchedulingPreference({ kind: 'working-hours', weekday: 'sat', hours: 'off', source: 'principal', basis });

    await keepMattersOnTime();
    const [morning] = await mornings();
    expect(morning).toMatchObject({ recurrence: '45 7 * * *' });
    expect(localClock(morning.process_after)).toBe('7:45 AM');
  });

  it('moves with --at, leaving one morning, and refuses a time that is not a 24-hour HH:MM', async () => {
    await keepMattersOnTime();
    const [before] = await mornings();

    const moved = await run('matters-morning', { at: '06:45' });
    expect(moved).toMatchObject({
      ok: true,
      data: { at: '06:45', timezone: ZONE, next: '2026-10-12T10:45:00.000Z' },
      human: '06:45 in America/New_York, next Oct 12, 2026, 6:45 AM',
    });
    const [after] = await mornings();
    expect(await mornings()).toHaveLength(1);
    expect(after).toMatchObject({ recurrence: '45 6 * * *' });
    expect(after.series_id).not.toBe(before.series_id);
    expect(taskRows(await mainSession()).find((row) => row.id === before.id)?.status).toBe('cancelled');

    for (const at of ['6:45', '24:00', '06:60', 'dawn']) {
      expect(await run('matters-morning', { at }), at).toMatchObject(refused(/--at must be a time of day/));
    }
    expect(await run('matters-morning', { at: '06:30', brief: true })).toMatchObject(refused(/give one/));
    expect(await mornings()).toEqual([after]);
  });

  it("briefs today's looks and the matters handed back without one, reading nothing live", async () => {
    gmail.put('gmail-thread-a', { id: 'a1', from: 'Juno Hale <juno@acme.example>', at: MONDAY_6AM, subject: 'Hi' });
    // Opened before the look that comes earlier, so the brief's order is by when each comes.
    const standup = await open('Weekly step back on the office move', { 'look-cron': '0 16 * * 1' });
    vi.setSystemTime(new Date(Date.parse(MONDAY_6AM) + 60_000));
    const acme = await open('Acme renewal', { look: '2026-10-12T14:00' }, { thread: THREAD });
    await open('Lunch with Noel Archer', { look: '2026-10-13T12:00' });
    // A look that ran with no new one set: the host hands it back at the morning.
    const lease = await open('Lease', { look: '2026-10-12T06:10' });
    await runOccurrence(
      await mainSession(),
      liveTaskRows(await mainSession()).find((row) => row.series_id === lease.look_task_id)!.id,
      'completed',
    );
    await keepMattersOnTime();

    const brief = await run('matters-morning', { brief: true });
    expect(brief).toMatchObject({
      ok: true,
      data: {
        wakeAgent: true,
        data: [
          'Looks today:',
          `- ${acme.id}, Oct 12, 2026, 2:00 PM: Acme renewal`,
          `- ${standup.id}, Oct 12, 2026, 4:00 PM: Weekly step back on the office move`,
          'Handed back without a next look:',
          `- ${lease.id}: Lease`,
          'Threads waiting to be placed: none.',
        ],
      },
    });
    expect(gmail.reads).toEqual([]);
    expect(await runnerReads(printed(brief), scratch)).toEqual({
      wakeAgent: true,
      data: expect.arrayContaining(['Looks today:', `- ${lease.id}: Lease`]),
    });
  });

  it('still wakes main on a quiet day, with each section empty', async () => {
    const brief = await run('matters-morning', { brief: true });
    expect(brief).toMatchObject({
      ok: true,
      data: {
        wakeAgent: true,
        data: ['Looks today: none.', 'Handed back without a next look: none.', 'Threads waiting to be placed: none.'],
      },
    });
    expect(await runnerReads(printed(brief), scratch)).toEqual({
      wakeAgent: true,
      data: ['Looks today: none.', 'Handed back without a next look: none.', 'Threads waiting to be placed: none.'],
    });
  });

  it('lists each thread waiting to be placed: who its mail carried, when the latest came, and its Gmail thread (R27)', async () => {
    await recordThreadMessage(
      { threadKey: THREAD, side: 'outside', gmailMessageId: 'g-1' },
      '2026-10-12T08:15:00.000Z',
    );
    await recordThreadMessage(
      { threadKey: THREAD, side: 'outside', gmailMessageId: 'g-2' },
      '2026-10-12T09:30:00.000Z',
    );
    await recordThreadAddresses(THREAD, ['remy@acme.example', 'noel@acme.example'], 'message', MONDAY_6AM);
    await recordThreadAddresses(THREAD, ['jane@partner.example'], 'written', MONDAY_6AM);
    // A thread only the principal and the assistant are on waits for no placement.
    await createThread('gmail-thread-b', MONDAY_6AM, 'mail-principal-only');
    await recordThreadMessage(
      { threadKey: 'mail-principal-only', side: 'principal', gmailMessageId: 'p-1' },
      MONDAY_6AM,
    );

    const brief = await run('matters-morning', { brief: true });

    expect(brief).toMatchObject({
      ok: true,
      data: {
        wakeAgent: true,
        data: [
          'Looks today: none.',
          'Handed back without a next look: none.',
          'Threads waiting to be placed:',
          `- ${THREAD}: noel@acme.example, remy@acme.example; latest mail Oct 12, 2026, 5:30 AM; Gmail thread gmail-thread-a`,
        ],
      },
    });
    expect(gmail.reads).toEqual([]);
  });
});
