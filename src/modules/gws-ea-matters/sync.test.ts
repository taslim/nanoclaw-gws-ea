/**
 * The daily sync (KTD6): one recurring task in main's conversation, before
 * the principal's day starts, whose pre-task script wakes main every day to look
 * ahead and read what has waited for it; and `ncl matters today`, the script of a morning rundown
 * the principal asks for. Driven through `ncl matters` and the host's pass
 * against main's real session mailbox, on a fixed Monday in New York; Google
 * is in memory and must never be read.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  root: `/tmp/nanoclaw-test-gws-ea-matters-sync-${process.pid}-${Math.random().toString(36).slice(2)}`,
}));

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: fixture.root,
  GROUPS_DIR: `${fixture.root}/groups`,
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
import { isContainerRunning } from '../../container-runner.js';
import type { CallerContext, ResponseFrame } from '../../cli/frame.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { reconcileSession } from '../../reconcile-session.js';
import { withExistingMailboxSession, writeSessionMessage } from '../../session-manager.js';
import '../gws-ea-inbox/index.js';
import { FakeGmailThreads } from '../gws-ea-inbox/testing/fake-gmail-threads.js';
import { createThread, recordThreadAddresses, recordThreadMessage } from '../gws-ea-inbox/thread-map.js';
import '../gws-ea-people/index.js';
import { setSchedulingPreference } from '../gws-ea-preferences/db.js';
import '../gws-ea-preferences/index.js';
import '../gws-ea-profile/index.js';
import { writeNoteForMain } from '../gws-ea-profile/main-note.js';
import { createScheduledTask, prepareScheduledTask } from '../scheduling/create.js';
import type { Matter, Placed } from './db.js';
import './index.js';
import { keepMattersOnTime } from './loop.js';
import {
  answerOccurrence,
  liveTaskRows,
  MAIN,
  mainSession,
  postAnswer,
  printed,
  runnerReads,
  runOccurrence,
  seedMain,
  taskContent,
  taskRows,
  type TaskRow,
} from './testing/main-conversation.js';

const DATA_DIR = fixture.root;
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

async function open(title: string, look: Record<string, string>, links: Record<string, string> = {}): Promise<Matter> {
  return (await data<Placed>(run('matters-open', { title, 'open-loop': 'What happens next.', ...look, ...links })))
    .matter;
}

/** The live occurrences of the sync series. */
async function syncs(): Promise<TaskRow[]> {
  return liveTaskRows(await mainSession()).filter((row) => row.series_id.startsWith('gws-ea-daily-sync-'));
}

function localClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: ZONE, hour: 'numeric', minute: '2-digit' });
}

/** A note for main that wakes nothing, as the host writes one. */
async function note(id: string, text: string): Promise<void> {
  expect(await writeNoteForMain({ id, timestamp: new Date().toISOString(), text, wake: false })).toBe('written');
}

let gmail: FakeGmailThreads;
let scratch: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(MONDAY_6AM));
  vi.mocked(isContainerRunning).mockReturnValue(false);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-ea-matters-sync-'));
  gmail = new FakeGmailThreads();
  google.gmail = gmail;
  await runMigrations(await initTestDb());
  await seedMain(ZONE);
  await createThread('gmail-thread-a', MONDAY_6AM, THREAD);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await closeDb();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('the daily sync', () => {
  it("comes at 07:00 in main's time zone while the principal has no working hours, its gate as its script", async () => {
    await keepMattersOnTime();

    const [sync] = await syncs();
    expect(await syncs()).toHaveLength(1);
    expect(sync).toMatchObject({ status: 'pending', recurrence: '0 7 * * *' });
    expect(localClock(sync.process_after)).toBe('7:00 AM');
    expect(taskContent(sync).script).toBe('ncl matters sync');
    // What needs the principal reaches them as one message for their morning.
    expect(taskContent(sync).prompt).toContain('one message');
    // The next pass keeps the same series.
    await keepMattersOnTime();
    expect(await syncs()).toEqual([sync]);
  });

  it('comes an hour before the earliest working-hours start, and follows the working hours when they change', async () => {
    const basis = 'Said so.';
    const workingHours = (weekday: 'mon' | 'tue', start: string) =>
      setSchedulingPreference({
        kind: 'working-hours',
        weekday,
        hours: { start, end: '17:00' },
        source: 'principal',
        basis,
      });
    await workingHours('mon', '09:00');
    await workingHours('tue', '08:15');
    await setSchedulingPreference({ kind: 'working-hours', weekday: 'sat', hours: 'off', source: 'principal', basis });

    await keepMattersOnTime();
    const [before] = await syncs();
    expect(before).toMatchObject({ recurrence: '15 7 * * *' });
    expect(localClock(before.process_after)).toBe('7:15 AM');

    await workingHours('tue', '06:30');
    await keepMattersOnTime();
    const [after] = await syncs();
    expect(await syncs()).toHaveLength(1);
    expect(after).toMatchObject({ recurrence: '30 5 * * *' });
    // Today's run keeps its time; the new hours take over from tomorrow.
    expect(after.process_after).toBe(before.process_after);
    expect(after.series_id).not.toBe(before.series_id);
    expect(taskRows(await mainSession()).find((row) => row.id === before.id)?.status).toBe('cancelled');
  });

  it('wakes main on a quiet day without inventing an unread note', async () => {
    const quiet = await run('matters-sync', {});
    expect(quiet).toMatchObject({ ok: true, data: { wakeAgent: true, data: [] } });
    expect(await runnerReads(printed(quiet), scratch)).toEqual({ wakeAgent: true, data: [] });
  });

  it.each([
    { scheduledFrom: MONDAY_6AM, runAt: '2026-10-12T11:00:00.000Z', startsWeek: true },
    // Already Monday in UTC, but the occurrence was due Sunday in New York.
    { scheduledFrom: '2026-10-11T10:00:00.000Z', runAt: '2026-10-12T03:30:00.000Z', startsWeek: false },
    // Monday's occurrence remains Monday's, even when the host runs it after midnight.
    { scheduledFrom: MONDAY_6AM, runAt: '2026-10-13T04:30:00.000Z', startsWeek: true },
    // Sunday afternoon: Monday's occurrence is pending but not due, so a call now starts nothing.
    { scheduledFrom: '2026-10-11T18:00:00.000Z', runAt: '2026-10-11T18:00:00.000Z', startsWeek: false },
  ])(
    'uses the occurrence in the principal zone for the week cue: $runAt',
    async ({ scheduledFrom, runAt, startsWeek }) => {
      vi.setSystemTime(new Date(scheduledFrom));
      await keepMattersOnTime();
      vi.setSystemTime(new Date(runAt));
      const verdict = await data<{ wakeAgent: boolean; data: string[] }>(run('matters-sync', {}));
      expect(verdict.wakeAgent).toBe(true);
      expect(verdict.data.some((line) => line.includes('starts the week'))).toBe(startsWeek);
      expect(verdict.data.some((line) => line.includes('note'))).toBe(false);
    },
  );

  it('lists later looks and a morning rundown so main can combine what needs the principal', async () => {
    vi.setSystemTime(new Date('2026-10-12T08:00:00.000Z'));
    const alreadyDue = await open('Earlier look', { look: '2026-10-12T05:00' });
    vi.setSystemTime(new Date(MONDAY_6AM));
    const later = await open('Prepare for the Acme review', { look: '2026-10-12T14:00' });
    await open('Tomorrow lunch', { look: '2026-10-13T12:00' });
    await createScheduledTask(
      MAIN,
      prepareScheduledTask({
        name: 'morning rundown',
        prompt: 'Their requested morning rundown.',
        script: 'ncl matters today',
        processAfter: '2026-10-12T07:30',
        timezone: ZONE,
      }),
      { session: await mainSession() },
    );
    const verdict = await data<{ wakeAgent: boolean; data: string[] }>(run('matters-sync', {}));
    expect(verdict.data).toContain('Later looks today:');
    expect(verdict.data).toContain(`- ${later.id}, Oct 12, 2026, 2:00 PM: Prepare for the Acme review`);
    expect(verdict.data.join('\n')).not.toContain(alreadyDue.id);
    expect(verdict.data.join('\n')).not.toContain('Tomorrow lunch');
    expect(verdict.data).toContain('Morning rundown: Oct 12, 2026, 7:30 AM.');
    expect(gmail.reads).toEqual([]);
  });

  it.each([
    { changed: 'prompt', runAt: MONDAY_6AM },
    { changed: 'prompt', runAt: '2026-10-12T15:00:00.000Z' },
    { changed: 'script', runAt: MONDAY_6AM },
    // The host was down across midnight: yesterday's occurrence never ran, and still runs now.
    { changed: 'prompt', runAt: '2026-10-13T12:30:00.000Z' },
  ])('replaces a changed $changed on one pass at $runAt without losing its run', async ({ changed, runAt }) => {
    await keepMattersOnTime();
    const [release] = await syncs();
    const content = taskContent(release);
    const main = await mainSession();
    // Store a task from an older release, rather than mutate a due occurrence through the task API.
    await withExistingMailboxSession(MAIN, main.id, (mailbox) => mailbox.cancelTask(release.series_id));
    const old = await createScheduledTask(
      MAIN,
      prepareScheduledTask({
        name: 'gws-ea daily sync',
        prompt: changed === 'prompt' ? 'An older release prompt.' : content.prompt,
        script: changed === 'script' ? 'ncl matters today' : content.script,
        recurrence: '0 7 * * *',
        processAfter: release.process_after,
        timezone: ZONE,
      }),
      { session: main },
    );
    vi.setSystemTime(new Date(runAt));
    await keepMattersOnTime();
    const [replacement] = await syncs();
    expect(await syncs()).toHaveLength(1);
    expect(replacement.series_id).not.toBe(old.row.seriesId);
    expect(replacement.process_after).toBe(release.process_after);
    expect(taskContent(replacement)).toEqual(content);
    await keepMattersOnTime();
    expect(await syncs()).toEqual([replacement]);
  });

  it.each(['completed', 'script-skip:error'] as const)(
    'leaves an old release answered %s to the sweep, then upgrades its next occurrence without running today again',
    async (answer) => {
      const main = await mainSession();
      const old = await createScheduledTask(
        MAIN,
        prepareScheduledTask({
          name: 'gws-ea daily sync',
          prompt: 'An older release prompt.',
          script: 'ncl matters sync',
          recurrence: '0 7 * * *',
          processAfter: '2026-10-12T07:00',
          timezone: ZONE,
        }),
        { session: main },
      );
      vi.setSystemTime(new Date('2026-10-12T12:00:00.000Z'));
      // The runner answered, but the host has not read the answer yet, as just after a restart.
      postAnswer(main, old.row.id, answer);
      await keepMattersOnTime();
      expect((await syncs()).map((row) => row.id)).toEqual([old.row.id]);
      // Once read, the row is the sweep's to re-arm; the pass leaves it.
      await withExistingMailboxSession(MAIN, main.id, (mailbox) =>
        mailbox.applyProcessingAcks(mailbox.getTerminalProcessingAcks()),
      );
      await keepMattersOnTime();
      expect(await syncs()).toEqual([]);
      // The sweep re-arms the old release's clock, and the next pass replaces that successor.
      await reconcileSession(main.id);
      expect(taskRows(main).find((row) => row.id === old.row.id)).toMatchObject({
        status: answer === 'completed' ? 'completed' : 'failed',
        recurrence: null,
      });
      await keepMattersOnTime();
      const [replacement] = await syncs();
      expect(await syncs()).toHaveLength(1);
      expect(taskContent(replacement).prompt).not.toBe('An older release prompt.');
      expect(replacement.process_after).toBe('2026-10-13T11:00:00.000Z');
      expect(taskRows(main).filter((row) => row.recurrence !== null)).toEqual([replacement]);
      await reconcileSession(main.id);
      await keepMattersOnTime();
      expect(await syncs()).toEqual([replacement]);
    },
  );

  it('lets a due sync already running finish once before upgrading its next occurrence', async () => {
    const main = await mainSession();
    const old = await createScheduledTask(
      MAIN,
      prepareScheduledTask({
        name: 'gws-ea daily sync',
        prompt: 'An older release prompt.',
        script: 'ncl matters sync',
        recurrence: '0 7 * * *',
        processAfter: '2026-10-12T07:00',
        timezone: ZONE,
      }),
      { session: main },
    );
    vi.setSystemTime(new Date('2026-10-12T11:01:00.000Z'));
    vi.mocked(isContainerRunning).mockReturnValue(true);
    await keepMattersOnTime();
    expect((await syncs()).map((row) => row.id)).toEqual([old.row.id]);
    expect(taskContent((await syncs())[0]).prompt).toBe('An older release prompt.');
    postAnswer(main, old.row.id, 'completed');
    vi.mocked(isContainerRunning).mockReturnValue(false);
    await keepMattersOnTime();
    expect((await syncs()).map((row) => row.id)).toEqual([old.row.id]);
    await reconcileSession(main.id);
    await keepMattersOnTime();
    const [next] = await syncs();
    expect(await syncs()).toHaveLength(1);
    expect(next.process_after).toBe('2026-10-13T11:00:00.000Z');
    expect(taskContent(next).prompt).not.toBe('An older release prompt.');
    await reconcileSession(main.id);
    expect(await syncs()).toEqual([next]);
  });

  it('reads no note from a pending tool reply, but reports a readable note alongside it', async () => {
    const main = await mainSession();
    const reply = JSON.stringify({ action: 'cli_response', requestId: 'old-request', ok: true, data: [] });
    await writeSessionMessage(main.agent_group_id, main.id, {
      id: 'stale-tool-reply',
      kind: 'system',
      timestamp: MONDAY_6AM,
      platformId: null,
      channelType: null,
      threadId: null,
      content: reply,
      processAfter: null,
      recurrence: null,
      trigger: false,
    });

    expect(await data(run('matters-sync', {}))).toEqual({ wakeAgent: true, data: [] });
    await note('readable-note', 'Calendar access needs attention.');
    expect(await data(run('matters-sync', {}))).toEqual({
      wakeAgent: true,
      data: ['A note you have not read comes with this.'],
    });
    await answerOccurrence(main, 'readable-note', 'completed');
    expect(await data(run('matters-sync', {}))).toEqual({ wakeAgent: true, data: [] });
    expect(
      await withExistingMailboxSession(main.agent_group_id, main.id, (mailbox) =>
        mailbox.getInboundRecords({ status: 'pending' }),
      ),
    ).toMatchObject([{ id: 'stale-tool-reply', kind: 'system', content: reply }]);
  });

  it('reports unread notes while they wait, then still wakes main without a note line', async () => {
    await note('note-calendar', 'Calendar access to the work calendar dropped to free/busy only.');
    expect(await data(run('matters-sync', {}))).toEqual({
      wakeAgent: true,
      data: ['A note you have not read comes with this.'],
    });
    await note('note-unsigned', 'Gmail could not confirm an email in their name came from them.');
    const waking = await run('matters-sync', {});
    expect(waking).toMatchObject({
      ok: true,
      data: { wakeAgent: true, data: ['2 notes you have not read come with this.'] },
    });
    expect(await runnerReads(printed(waking), scratch)).toEqual({
      wakeAgent: true,
      data: ['2 notes you have not read come with this.'],
    });

    // main's next turn reads both.
    const main = await mainSession();
    await answerOccurrence(main, 'note-calendar', 'completed');
    await answerOccurrence(main, 'note-unsigned', 'completed');
    expect(await data(run('matters-sync', {}))).toEqual({ wakeAgent: true, data: [] });
  });

  it('wakes main for each thread waiting to be placed: who its mail carried, when the latest came, and its Gmail thread (R27)', async () => {
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

    expect(await data(run('matters-sync', {}))).toEqual({
      wakeAgent: true,
      data: [
        'Threads waiting to be placed:',
        `- ${THREAD}: noel@acme.example, remy@acme.example; latest mail Oct 12, 2026, 5:30 AM; Gmail thread gmail-thread-a`,
      ],
    });
    expect(gmail.reads).toEqual([]);
  });
});

describe('today, for a morning rundown the principal asks for', () => {
  it("lists today's looks and the matters handed back without one, reading nothing live", async () => {
    gmail.put('gmail-thread-a', { id: 'a1', from: 'Juno Hale <juno@acme.example>', at: MONDAY_6AM, subject: 'Hi' });
    // Opened before the look that comes earlier, so the list's order is by when each comes.
    const standup = await open('Weekly step back on the office move', { 'look-cron': '0 16 * * 1' });
    vi.setSystemTime(new Date(Date.parse(MONDAY_6AM) + 60_000));
    const acme = await open('Acme renewal', { look: '2026-10-12T14:00' }, { thread: THREAD });
    await open('Lunch with Noel Archer', { look: '2026-10-13T12:00' });
    // A look that ran with no new one set: the host hands it back at the sync.
    const lease = await open('Lease', { look: '2026-10-12T06:10' });
    await runOccurrence(
      await mainSession(),
      liveTaskRows(await mainSession()).find((row) => row.series_id === lease.look_task_id)!.id,
      'completed',
    );
    await keepMattersOnTime();

    const today = await run('matters-today', {});
    expect(today).toMatchObject({
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
    expect(await runnerReads(printed(today), scratch)).toEqual({
      wakeAgent: true,
      data: expect.arrayContaining(['Looks today:', `- ${lease.id}: Lease`]),
    });
  });

  it('still wakes main on a quiet day, with each section empty', async () => {
    const today = await run('matters-today', {});
    const quiet = [
      'Looks today: none.',
      'Handed back without a next look: none.',
      'Threads waiting to be placed: none.',
    ];
    expect(today).toMatchObject({ ok: true, data: { wakeAgent: true, data: quiet } });
    expect(await runnerReads(printed(today), scratch)).toEqual({ wakeAgent: true, data: quiet });
  });
});
