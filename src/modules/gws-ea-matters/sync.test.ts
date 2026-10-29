/**
 * The close and its dedicated native session, driven through real task,
 * ledger, delivery and note boundaries. Google stays in memory.
 */
import fs from 'node:fs';
import Database from 'better-sqlite3';
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
  killContainer: vi.fn((_id: string, _reason: string, onExit?: () => void) => onExit?.()),
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
import { deliverSessionMessages, setDeliveryAdapter } from '../../delivery.js';
import { outboundDbPath } from '../../mailbox/sqlite/paths.js';
import { isContainerRunning, killContainer } from '../../container-runner.js';
import type { CallerContext, ResponseFrame } from '../../cli/frame.js';
import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { getSession, getSessionsByAgentGroup } from '../../db/sessions.js';
import { requestWake } from '../../request-wake.js';
import { recordCloseLedger, getOpenCloseRun, lastCompletedClose } from './close-runs.js';
import { keepClose, closeSchedules, closeVerdict, finishClose, forgetSundaySnapshot } from './sync.js';
import { addStay, setEventTravel } from '../gws-ea-whereabouts/db.js';
import { sessionDir, withExistingMailboxSession, writeSessionMessage } from '../../session-manager.js';
import '../gws-ea-inbox/index.js';
import { FakeGmailThreads } from '../gws-ea-inbox/testing/fake-gmail-threads.js';
import { createThread } from '../gws-ea-inbox/thread-map.js';
import '../gws-ea-people/index.js';
import '../gws-ea-preferences/index.js';
import '../gws-ea-profile/index.js';
import { writeNoteForMain } from '../gws-ea-profile/main-note.js';
import * as mainNotes from '../gws-ea-profile/main-note.js';
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
  const schedule = (await closeSchedules()).at(-1);
  if (!schedule) throw new Error('No close schedule');
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
  await recordCloseLedger(id, sessionId, { from: null, through: new Date().toISOString(), writes: [] });
}

function queueCloseWrite(session: import('../../types.js').Session, requestId: string, title: string): void {
  const db = new Database(outboundDbPath(MAIN, session.id));
  db.prepare("INSERT INTO messages_out (id,timestamp,kind,content) VALUES (?,?,'system',?)").run(
    requestId,
    new Date().toISOString(),
    JSON.stringify({
      action: 'cli_request',
      requestId,
      command: 'matters-open',
      args: { title, open_loop: 'Prepare the brief.', look: '2032-10-12T12:00' },
    }),
  );
  db.close();
}

let gmail: FakeGmailThreads;
let scratch: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(MONDAY_6AM));
  vi.mocked(isContainerRunning).mockReturnValue(false);
  vi.mocked(killContainer)
    .mockReset()
    .mockImplementation((_id, _reason, onExit) => onExit?.());
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
    expect(await closeSchedules()).toHaveLength(1);
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
    expect(printed(response)).not.toContain(row.process_after);
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

  it('retains a quiet report after a note-write interruption without making it a second wake', async () => {
    await keepMattersOnTime();
    const session = await closeSession();
    const row = await closeRow();
    vi.setSystemTime(new Date(row.process_after));
    await closeVerdict(session.id, row.id);
    await capture(row.id, session.id);
    // The note already crossed the native boundary before completion was recorded.
    await getDb().run(
      'UPDATE gws_ea_close_schedule SET report_text=?,report_notify=0 WHERE id=?',
      'Quiet close.',
      row.id,
    );
    await writeNoteForMain({
      id: `close-report-${row.id}`,
      timestamp: new Date().toISOString(),
      text: 'Quiet close.',
      wake: false,
      noteKind: 'host-receipt',
    });
    vi.mocked(requestWake).mockClear();
    await finishClose(session.id, row.id, 'Do not replace the recorded decision.', true);
    expect(requestWake).not.toHaveBeenCalled();
    expect((await closeSchedules())[0]).toMatchObject({ report_text: 'Quiet close.', report_notify: 0 });
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
    expect((await closeSchedules()).at(-1)?.scheduled_at).toBe('2026-10-14T01:00:00.000Z');
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

  it('closes and stops only the expired close before a successor starts, refusing its stale outbound writes', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    setDeliveryAdapter({ deliver: send });
    const main = await mainSession();
    await keepMattersOnTime();
    const previous = await closeSession();
    const row = await closeRow();
    vi.setSystemTime(new Date(row.process_after));
    await closeVerdict(previous.id, row.id);
    queueCloseWrite(previous, 'valid-close-write', 'Current close write');
    await deliverSessionMessages(previous);
    expect(await getDb().get('SELECT id FROM gws_ea_matters WHERE title=?', 'Current close write')).toBeDefined();
    vi.mocked(isContainerRunning).mockImplementation((id) => id === previous.id || id === main.id);
    await keepMattersOnTime();
    const next = await closeRow();
    const nextSession = await closeSession();
    vi.setSystemTime(new Date(next.process_after));
    let stopped: (() => void) | undefined;
    vi.mocked(killContainer).mockImplementation((_id, _reason, onExit) => {
      stopped = onExit;
    });
    const starting = closeVerdict(nextSession.id, next.id);
    await vi.waitFor(() =>
      expect(killContainer).toHaveBeenCalledWith(previous.id, 'gws-ea-close-retired', expect.any(Function)),
    );
    expect(await getSession(previous.id)).toMatchObject({ status: 'closed' });
    expect(await getOpenCloseRun(previous.id)).toBeUndefined();
    expect(await getOpenCloseRun(nextSession.id)).toBeUndefined();
    queueCloseWrite(previous, 'stale-close-write', 'Stale close write');
    await deliverSessionMessages(previous);
    expect(await getDb().get('SELECT id FROM gws_ea_matters WHERE title=?', 'Stale close write')).toBeUndefined();
    expect(await getSession(main.id)).toMatchObject({ status: 'active' });
    stopped?.();
    expect((await starting).wakeAgent).toBe(true);
    expect(await getOpenCloseRun(nextSession.id)).toMatchObject({ id: next.id });
    expect(vi.mocked(killContainer).mock.calls.map(([id]) => id)).toEqual([previous.id]);
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps an expired session fenced and the successor unstarted if its stop fails, then resumes cleanup', async () => {
    await keepMattersOnTime();
    const previous = await closeSession();
    const row = await closeRow();
    vi.setSystemTime(new Date(row.process_after));
    await closeVerdict(previous.id, row.id);
    vi.mocked(isContainerRunning).mockImplementation((id) => id === previous.id);
    await keepMattersOnTime();
    const next = await closeRow();
    const nextSession = await closeSession();
    vi.setSystemTime(new Date(next.process_after));
    vi.mocked(killContainer).mockImplementation(() => {
      throw new Error('Native stop unavailable');
    });
    await expect(closeVerdict(nextSession.id, next.id)).rejects.toThrow('Native stop unavailable');
    expect(await getSession(previous.id)).toMatchObject({ status: 'closed' });
    expect(await getOpenCloseRun(nextSession.id)).toBeUndefined();
    vi.mocked(killContainer).mockImplementation((_id, _reason, onExit) => onExit?.());
    expect((await closeVerdict(nextSession.id, next.id)).wakeAgent).toBe(true);
  });

  it('finishes an admitted report before retiring its session and opening the successor', async () => {
    await keepMattersOnTime();
    const previous = await closeSession();
    const row = await closeRow();
    vi.setSystemTime(new Date(row.process_after));
    await closeVerdict(previous.id, row.id);
    await capture(row.id, previous.id);
    vi.mocked(isContainerRunning).mockImplementation((id) => id === previous.id);
    await keepMattersOnTime();
    const next = await closeRow();
    const nextSession = await closeSession();
    vi.setSystemTime(new Date(next.process_after));
    let entered!: () => void;
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: string[] = [];
    const nativeWrite = mainNotes.writeNoteForMain;
    vi.spyOn(mainNotes, 'writeNoteForMain').mockImplementation(async (note) => {
      if (note.id === `close-report-${row.id}`) {
        entered();
        await proceed;
      }
      const written = await nativeWrite(note);
      events.push('report');
      return written;
    });
    const finishing = finishClose(previous.id, row.id, 'The first close’s report.');
    await writing;
    const starting = closeVerdict(nextSession.id, next.id).then((value) => {
      events.push('successor');
      return value;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    const settled = await Promise.allSettled([finishing, starting]);
    expect(settled.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(events).toEqual(['report', 'successor']);
    expect(await getSession(previous.id)).toMatchObject({ status: 'closed' });
    expect(await getOpenCloseRun(nextSession.id)).toMatchObject({ id: next.id });
  });

  it('never recreates or opens the mailbox of a retired historical close', async () => {
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
    await expect(finishClose(session.id, row.id)).rejects.toThrow('captured day ledger');
    await expect(finishClose((await mainSession()).id, row.id)).rejects.toThrow('captured day ledger');
  });

  it('retires an unclaimed daily sync, but lets a claimed old run finish first', async () => {
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
    await keepMattersOnTime();
    expect(liveTaskRows(main).find((item) => item.id === old.row.id)?.status).toBe('pending');
    postAnswer(main, old.row.id, 'completed');
    vi.mocked(isContainerRunning).mockReturnValue(false);
    await keepMattersOnTime();
    expect(liveTaskRows(main).filter((item) => item.series_id.startsWith('gws-ea-daily-sync'))).toEqual([]);
    expect(
      (await getSessionsByAgentGroup(MAIN)).filter((item) => item.thread_id?.startsWith('system:gws-ea-close:')),
    ).toHaveLength(1);
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

  it('forgets the latest Sunday snapshot without reading memory contents', async () => {
    const directory = path.join(DATA_DIR, 'groups', MAIN, 'sunday-memory-latest');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'juno.md'), 'Juno facts');
    await forgetSundaySnapshot();
    expect(fs.existsSync(directory)).toBe(false);
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
