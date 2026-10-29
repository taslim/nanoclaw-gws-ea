/**
 * The close and its dedicated native session, driven through real task,
 * ledger, delivery and note boundaries. Google stays in memory.
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
import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { getSession } from '../../db/sessions.js';
import { requestWake } from '../../request-wake.js';
import { recordCloseLedger, getOpenCloseRun, lastCompletedClose } from './close-runs.js';
import { cancelDailySync, keepClose, closeVerdict, finishClose, forgetSundaySnapshot } from './sync.js';
import { addStay, setEventTravel } from '../gws-ea-whereabouts/db.js';
import { sessionDir, withExistingMailboxSession, writeSessionMessage } from '../../session-manager.js';
import '../gws-ea-inbox/index.js';
import { FakeGmailThreads } from '../gws-ea-inbox/testing/fake-gmail-threads.js';
import { createThread } from '../gws-ea-inbox/thread-map.js';
import '../gws-ea-people/index.js';
import '../gws-ea-preferences/index.js';
import '../gws-ea-profile/index.js';
import { writeNoteForMain } from '../gws-ea-profile/main-note.js';
import { createScheduledTask, prepareScheduledTask } from '../scheduling/create.js';
import type { Matter, Placed } from './db.js';
import './index.js';
import { keepMattersOnTime } from './loop.js';
import {
  answerOccurrence,
  closeRuns,
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

async function closeSession(): Promise<import('../../types.js').Session> {
  const schedule = (await closeRuns()).at(-1);
  if (!schedule) throw new Error('No close run');
  const session = await getSession(schedule.session_id);
  if (!session) throw new Error('No close session');
  return session;
}
async function closeRow(): Promise<TaskRow> {
  const rows = liveTaskRows(await closeSession());
  if (!rows[0]) throw new Error('No close task');
  return rows[0];
}
async function capture(id: string, sessionId: string): Promise<void> {
  await recordCloseLedger(id, sessionId, { from: null, through: new Date().toISOString(), writes: [], inbound: {} });
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

describe('the evening close', () => {
  it('uses one native conversational system session, leaving the principal conversation independent', async () => {
    const main = await mainSession();
    await keepMattersOnTime();
    const close = await closeSession();
    const row = await closeRow();
    expect(close).toMatchObject({ messaging_group_id: null, thread_id: `system:gws-ea-close:${row.id}` });
    expect(JSON.parse(row.content)).toMatchObject({ inConversation: true });
    expect(row).toMatchObject({ recurrence: null, process_after: '2026-10-13T01:00:00.000Z' });
    expect(liveTaskRows(main).filter((item) => item.series_id.startsWith('gws-ea-close-'))).toEqual([]);
    const isolated = await createScheduledTask(
      MAIN,
      prepareScheduledTask({ prompt: 'A native isolated task.', processAfter: '2026-10-13T01:00Z' }),
    );
    expect(JSON.parse(isolated.row.content).inConversation).toBeUndefined();
    await keepMattersOnTime();
    expect(await closeRuns()).toHaveLength(1);
    // A principal message keeps the normal conversation route while this close awaits background results.
    await writeSessionMessage(MAIN, main.id, {
      id: 'principal-during-close',
      kind: 'chat',
      timestamp: MONDAY_6AM,
      content: JSON.stringify({ text: 'Move lunch to noon.', sender: 'Morgan', senderId: 'morgan' }),
      trigger: true,
    });
    expect(
      await withExistingMailboxSession(MAIN, main.id, (mailbox) =>
        mailbox.getInboundRecords({ status: 'pending' }).map((item) => item.id),
      ),
    ).toContain('principal-during-close');
    expect(
      await withExistingMailboxSession(MAIN, close.id, (mailbox) => mailbox.getInboundRecords().map((item) => item.id)),
    ).not.toContain('principal-during-close');
  });

  it('arms its task with the evening script, which the runner runs before the turn', async () => {
    await keepMattersOnTime();
    const row = await closeRow();
    expect(taskContent(row)).toMatchObject({
      script: `ncl matters evening --run ${row.id}`,
      prompt: expect.stringContaining(`Close-run: ${row.id}.`),
    });
  });

  it('answers a close that is not due yet with no wake, and leaves it pending', async () => {
    await keepMattersOnTime();
    const session = await closeSession();
    const row = await closeRow();
    expect(Date.parse(row.process_after)).toBeGreaterThan(Date.now());
    expect(await closeVerdict(session.id, row.id)).toEqual({ wakeAgent: false, data: [] });
    expect((await closeRuns()).at(-1)).toMatchObject({ id: row.id, state: 'pending', started_at: null });
    expect(await getOpenCloseRun(session.id)).toBeUndefined();
  });

  it('leaves main a quiet report as a host receipt that wakes nothing', async () => {
    await keepMattersOnTime();
    const session = await closeSession();
    const row = await closeRow();
    vi.setSystemTime(new Date(row.process_after));
    await closeVerdict(session.id, row.id);
    await capture(row.id, session.id);
    vi.mocked(requestWake).mockClear();
    await finishClose(session.id, row.id, 'Quiet close; nothing needs Morgan tonight.');
    expect(requestWake).not.toHaveBeenCalled();
    const [report] =
      (await withExistingMailboxSession(MAIN, (await mainSession()).id, (mailbox) =>
        mailbox.getInboundRecords().filter((item) => item.id === `close-report-${row.id}`),
      )) ?? [];
    expect(report).toMatchObject({ trigger: false });
    expect(JSON.parse(report.content)).toMatchObject({
      text: 'Quiet close; nothing needs Morgan tonight.',
      noteKind: 'host-receipt',
    });
  });

  it('reports eleven hours of lateness after the host misses the evening', async () => {
    await keepMattersOnTime();
    const session = await closeSession();
    const row = await closeRow();
    vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
    const response = await dispatch(
      { id: 'evening', command: 'matters-evening', args: { run: row.id } },
      { ...MAIN_CALLER, sessionId: session.id },
    );
    expect(response).toMatchObject({
      ok: true,
      data: { wakeAgent: true, data: expect.arrayContaining([expect.stringContaining('11 hours late')]) },
    });
    expect(await runnerReads(printed(response), scratch)).toMatchObject({ wakeAgent: true });
    expect(printed(response)).toContain('scheduled Oct 12, 2026, 9:00 PM New York time');
    expect(printed(response)).toContain('Day ledger: everything so far; no close has completed yet.');
    expect(printed(response)).not.toContain(row.process_after);
  });

  it('leaves hand-backs to main’s own looks at the close, listing none in the close verdict', async () => {
    const lease = await open('Lease', { look: '2026-10-12T06:10' });
    const main = await mainSession();
    await runOccurrence(main, liveTaskRows(main).find((row) => row.series_id === lease.look_task_id)!.id, 'completed');
    await keepMattersOnTime();
    const session = await closeSession();
    const row = await closeRow();
    vi.setSystemTime(new Date(row.process_after));
    const verdict = await closeVerdict(session.id, row.id);
    expect(verdict.wakeAgent).toBe(true);
    expect(JSON.stringify(verdict.data)).not.toContain(lease.id);
  });

  it('re-times an unclaimed close after a new stay, but leaves a claimed close in place', async () => {
    vi.setSystemTime(new Date('2032-10-12T10:00:00Z'));
    await keepMattersOnTime();
    const first = await closeRow();
    await addStay({
      locality: 'Tokyo',
      zone: 'Asia/Tokyo',
      start: '2032-10-12T12:00Z',
      end: '2032-10-12',
      source: 'said',
      certainty: 'certain',
    });
    await keepMattersOnTime();
    const moved = await closeRow();
    expect(moved.id).toBe(first.id);
    expect(moved.process_after).toBe('2032-10-12T12:00:00.000Z');
    vi.setSystemTime(new Date(moved.process_after));
    const session = await closeSession();
    await closeVerdict(session.id, moved.id);
    vi.mocked(isContainerRunning).mockImplementation((id) => id === session.id);
    await addStay({
      locality: 'Sydney',
      zone: 'Australia/Sydney',
      start: '2032-10-12T12:01Z',
      end: '2032-10-12T14:00Z',
      source: 'said',
      certainty: 'certain',
    });
    await keepMattersOnTime();
    expect(taskRows(session).find((item) => item.id === first.id)?.process_after).toBe(moved.process_after);
    expect(await getOpenCloseRun(session.id)).toMatchObject({ id: first.id, state: 'open' });
  });

  it('accepts done after the first acknowledgment while background agents still run, then sends one chosen report on retry', async () => {
    await keepMattersOnTime();
    const session = await closeSession();
    const row = await closeRow();
    vi.setSystemTime(new Date(row.process_after));
    await closeVerdict(session.id, row.id);
    await capture(row.id, session.id);
    postAnswer(session, row.id, 'completed');
    vi.mocked(isContainerRunning).mockImplementation((id) => id === session.id);
    await keepMattersOnTime();
    expect(await getOpenCloseRun(session.id)).toMatchObject({ id: row.id });
    const wake = vi.mocked(requestWake);
    wake.mockClear();
    expect(await finishClose(session.id, row.id, 'Morgan needs to choose the departure.', true)).toMatchObject({
      state: 'completed',
    });
    expect(await finishClose(session.id, row.id, 'A changed retry must not send again.', true)).toMatchObject({
      state: 'completed',
    });
    const reports = await withExistingMailboxSession(MAIN, (await mainSession()).id, (mailbox) =>
      mailbox.getInboundRecords().filter((item) => item.id === `close-report-${row.id}`),
    );
    expect(reports).toHaveLength(1);
    expect(JSON.parse(reports![0].content)).toMatchObject({ text: 'Morgan needs to choose the departure.' });
    expect(wake).toHaveBeenCalledTimes(1);
    expect(await lastCompletedClose()).toMatchObject({ id: row.id, ledger_through_at: new Date().toISOString() });
  });

  it('keeps a quiet report written before an interruption, without a second note or a wake', async () => {
    await keepMattersOnTime();
    const session = await closeSession();
    const row = await closeRow();
    vi.setSystemTime(new Date(row.process_after));
    await closeVerdict(session.id, row.id);
    await capture(row.id, session.id);
    // The note already crossed the native boundary before completion was recorded.
    await writeNoteForMain({
      id: `close-report-${row.id}`,
      timestamp: new Date().toISOString(),
      text: 'Quiet close.',
      wake: false,
      noteKind: 'host-receipt',
    });
    vi.mocked(requestWake).mockClear();
    expect(await finishClose(session.id, row.id, 'A changed retry.', true)).toMatchObject({ state: 'completed' });
    expect(requestWake).not.toHaveBeenCalled();
    const reports = await withExistingMailboxSession(MAIN, (await mainSession()).id, (mailbox) =>
      mailbox.getInboundRecords().filter((item) => item.id === `close-report-${row.id}`),
    );
    expect(reports?.map((item) => (JSON.parse(item.content) as { text: string }).text)).toEqual(['Quiet close.']);
  });

  it('fails an acked close only after its container exits, and keeps the ledger window', async () => {
    await keepMattersOnTime();
    const session = await closeSession();
    const row = await closeRow();
    vi.setSystemTime(new Date(row.process_after));
    await closeVerdict(session.id, row.id);
    await capture(row.id, session.id);
    postAnswer(session, row.id, 'completed');
    await keepMattersOnTime();
    expect(await getOpenCloseRun(session.id)).toBeUndefined();
    expect(await getDb().get('SELECT state FROM gws_ea_close_runs WHERE id=?', row.id)).toEqual({ state: 'failed' });
    expect(await lastCompletedClose()).toBeUndefined();
    expect((await closeRuns()).at(-1)?.scheduled_at).toBe('2026-10-14T01:00:00.000Z');
    expect(await getSession(session.id)).toMatchObject({ status: 'closed' });
  });

  it('does not let an old live container starve the next due close', async () => {
    await keepMattersOnTime();
    const session = await closeSession();
    const row = await closeRow();
    vi.setSystemTime(new Date(row.process_after));
    await closeVerdict(session.id, row.id);
    postAnswer(session, row.id, 'completed');
    vi.mocked(isContainerRunning).mockImplementation((id) => id === session.id);
    await keepMattersOnTime();
    const next = await closeRow();
    const nextSession = await closeSession();
    vi.setSystemTime(new Date(next.process_after));
    await keepMattersOnTime();
    expect(await getOpenCloseRun(session.id)).toBeUndefined();
    expect((await closeVerdict(nextSession.id, next.id)).wakeAgent).toBe(true);
  });

  it('never recreates or opens the mailbox of a completed close', async () => {
    await keepMattersOnTime();
    const previous = await closeSession();
    const row = await closeRow();
    vi.setSystemTime(new Date(row.process_after));
    await closeVerdict(previous.id, row.id);
    await capture(row.id, previous.id);
    await finishClose(previous.id, row.id, 'Quiet close.');
    await keepMattersOnTime();
    expect(await getSession(previous.id)).toMatchObject({ status: 'closed' });
    const history = await lastCompletedClose();
    const next = await closeRow();
    fs.rmSync(sessionDir(MAIN, previous.id), { force: true, recursive: true });
    await keepMattersOnTime();
    expect(fs.existsSync(sessionDir(MAIN, previous.id))).toBe(false);
    expect((await closeRow()).id).toBe(next.id);
    expect(await lastCompletedClose()).toEqual(history);
  });

  it('re-times an unclaimed overdue New York close to tonight’s Los Angeles clock', async () => {
    vi.setSystemTime(new Date('2026-10-11T23:00Z'));
    await keepMattersOnTime();
    const previous = await closeSession();
    const row = await closeRow();
    expect(row.process_after).toBe('2026-10-12T01:00:00.000Z');
    vi.setSystemTime(new Date('2026-10-12T01:01Z'));
    await addStay({
      locality: 'Los Angeles',
      zone: 'America/Los_Angeles',
      start: '2026-10-12T00:00Z',
      end: '2026-10-13',
      source: 'said',
      certainty: 'certain',
    });
    await keepMattersOnTime();
    expect((await closeRow()).process_after).toBe('2026-10-12T04:00:00.000Z');
    expect(taskRows(previous).find((item) => item.id === row.id)?.status).toBe('cancelled');
    expect(await getOpenCloseRun(previous.id)).toBeUndefined();
  });

  it('keeps an overdue close’s original moment when an unrelated travel estimate changes', async () => {
    await keepMattersOnTime();
    const row = await closeRow();
    vi.setSystemTime(new Date('2026-10-13T12:00Z'));
    await setEventTravel({ eventId: 'work-review', mode: 'walk', minutes: 20, source: 'learned' });
    await keepMattersOnTime();
    expect((await closeRow()).id).toBe(row.id);
    expect((await closeRow()).process_after).toBe(row.process_after);
  });

  it('requires the ledger and matching open run before completing', async () => {
    await keepMattersOnTime();
    const session = await closeSession();
    const row = await closeRow();
    vi.setSystemTime(new Date(row.process_after));
    await closeVerdict(session.id, row.id);
    await expect(finishClose(session.id, row.id)).rejects.toThrow('after ncl day has been read');
    await expect(finishClose((await mainSession()).id, row.id)).rejects.toThrow('after ncl day has been read');
  });

  it('cancels the retired daily-sync series, whatever its occurrence is doing', async () => {
    const main = await mainSession();
    const old = await createScheduledTask(
      MAIN,
      prepareScheduledTask({
        name: 'gws-ea daily sync',
        prompt: 'Old sync',
        recurrence: '0 7 * * *',
        processAfter: MONDAY_6AM,
      }),
      { session: main },
    );
    vi.mocked(isContainerRunning).mockImplementation((id) => id === main.id);
    await cancelDailySync();
    expect(liveTaskRows(main).filter((item) => item.series_id === old.row.seriesId)).toEqual([]);
  });

  it.each([
    { name: 'SFO to NRT', from: 'America/Los_Angeles', to: 'Asia/Tokyo', arrival: '2026-11-01T07:00Z' },
    { name: 'NRT to SFO', from: 'Asia/Tokyo', to: 'America/Los_Angeles', arrival: '2026-11-01T18:00Z' },
    { name: 'SFO to SYD', from: 'America/Los_Angeles', to: 'Australia/Sydney', arrival: '2026-11-01T09:00Z' },
    { name: 'SYD to SFO', from: 'Australia/Sydney', to: 'America/Los_Angeles', arrival: '2026-11-01T14:00Z' },
  ])(
    '$name never loses the Sunday weekly pass, including when twelve-hour spacing skips Sunday evening',
    async ({ from, to, arrival }) => {
      vi.setSystemTime(new Date('2026-10-30T00:00Z'));
      await getDb().run('UPDATE gws_ea_profile SET principal_timezone=? WHERE singleton=1', from);
      await addStay({
        locality: to,
        zone: to,
        start: arrival,
        end: '2026-11-10',
        source: 'calendar',
        certainty: 'certain',
      });
      const passes: string[] = [];
      let previous: number | undefined;
      for (let index = 0; index < 6; index++) {
        await keepClose(await mainSession());
        const row = await closeRow();
        const session = await closeSession();
        const at = Date.parse(row.process_after);
        if (previous !== undefined) expect(at - previous).toBeGreaterThanOrEqual(12 * 60 * 60 * 1000);
        previous = at;
        vi.setSystemTime(new Date(at));
        const verdict = await closeVerdict(session.id, row.id);
        passes.push(...(verdict.data ?? []).filter((line) => line.startsWith('Weekly pass for Sunday 2026-11-01:')));
        await capture(row.id, session.id);
        await finishClose(session.id, row.id, 'Quiet close; no principal message needed.');
        await answerOccurrence(session, row.id, 'completed');
      }
      expect(passes).toHaveLength(1);
    },
  );

  it('takes the Sunday pass at a late Saturday close that actually runs on Sunday', async () => {
    vi.setSystemTime(new Date('2026-10-10T10:00Z'));
    await keepMattersOnTime();
    const session = await closeSession();
    const row = await closeRow();
    vi.setSystemTime(new Date('2026-10-11T12:00Z'));
    expect((await closeVerdict(session.id, row.id)).data).toContain(
      'Weekly pass for Sunday 2026-10-11: the week and month ahead, stale open matters and consolidation. Snapshot memory before consolidation.',
    );
  });

  it('does not repeat Sunday work in a successor armed while Sunday’s close was still open', async () => {
    vi.setSystemTime(new Date('2026-10-11T10:00Z'));
    await keepMattersOnTime();
    const session = await closeSession();
    const row = await closeRow();
    vi.setSystemTime(new Date(row.process_after));
    await closeVerdict(session.id, row.id);
    await capture(row.id, session.id);
    vi.mocked(isContainerRunning).mockImplementation((id) => id === session.id);
    await keepMattersOnTime();
    const next = await closeRow();
    const nextSession = await closeSession();
    await finishClose(session.id, row.id, 'Sunday complete; nothing needs Morgan now.');
    vi.setSystemTime(new Date(next.process_after));
    expect((await closeVerdict(nextSession.id, next.id)).data?.some((line) => line.startsWith('Weekly pass'))).toBe(
      false,
    );
  });

  it('forgets the latest Sunday snapshot and the planning results without reading them', async () => {
    const snapshot = path.join(DATA_DIR, 'groups', MAIN, 'sunday-memory-latest');
    const runs = path.join(DATA_DIR, 'groups', MAIN, 'planning-runs');
    fs.mkdirSync(snapshot, { recursive: true });
    fs.writeFileSync(path.join(snapshot, 'juno.md'), 'Juno facts');
    fs.mkdirSync(runs, { recursive: true });
    fs.writeFileSync(path.join(runs, 'agent-1-look-back.md'), 'Close run: close-1\nJuno Hale asked for Friday.');
    await forgetSundaySnapshot();
    expect(fs.existsSync(snapshot)).toBe(false);
    expect(fs.existsSync(runs)).toBe(false);
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
