/**
 * The host's guarantees for matters: every
 * open matter has exactly one look still to come, a closed one none, the
 * evening close always exists, and a failed repeating look comes back at the
 * next close. Driven through `ncl` and the real sweep against main's real
 * session mailbox, on the real clock, as SQLite's `now` decides what is due.
 */
import { CronExpressionParser } from 'cron-parser';
import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  root: `/tmp/gws-ea-u9-loop-${process.pid}-${Math.random().toString(36).slice(2)}`,
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

import { dispatch } from '../../cli/dispatch.js';
import type { CallerContext, ResponseFrame } from '../../cli/frame.js';
import '../../cli/resources/tasks.js';
import { isContainerRunning } from '../../container-runner.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { getSession } from '../../db/sessions.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { reconcileSession } from '../../reconcile-session.js';
import '../gws-ea-inbox/index.js';
import '../gws-ea-people/index.js';
import '../gws-ea-preferences/index.js';
import '../gws-ea-profile/index.js';
import { createScheduledTask, prepareScheduledTask } from '../scheduling/create.js';
import { getMatter, markLookFailed, type Matter, type Placed } from './db.js';
import './index.js';
import { lookSeries } from './looks.js';
import { keepMattersOnTime } from './loop.js';
import {
  answerOccurrence,
  closeRuns,
  liveTaskRows,
  MAIN,
  mainSession,
  runOccurrence,
  seedMain,
  taskRows,
  type TaskRow,
} from './testing/main-conversation.js';

const DATA_DIR = fixture.root;
const ZONE = 'America/New_York';
const DAY = 24 * 60 * 60 * 1000;
const YEARLY = '0 9 14 3 *';
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

function inDays(days: number): string {
  return new Date(Math.floor((Date.now() + days * DAY) / 60_000) * 60_000).toISOString();
}

async function open(title: string, look: Record<string, string>): Promise<Matter> {
  return (await data<Placed>(run('matters-open', { title, 'open-loop': 'What happens next.', ...look }))).matter;
}

async function fresh(matter: Matter): Promise<Matter> {
  const current = await getMatter(matter.id);
  if (!current) throw new Error(`${matter.id} is gone`);
  return current;
}

/** The live occurrence of a series in main's conversation. */
async function liveRow(seriesId: string | null): Promise<TaskRow> {
  const row = liveTaskRows(await mainSession()).find((candidate) => candidate.series_id === seriesId);
  if (!row) throw new Error(`No live occurrence of ${String(seriesId)}`);
  return row;
}

/** Each matter's live look series in main's conversation. */
async function looksByMatter(): Promise<Map<string, string[]>> {
  const looks = new Map<string, string[]>();
  for (const series of new Set(liveTaskRows(await mainSession()).map((row) => row.series_id))) {
    const look = lookSeries(series);
    if (look !== undefined) looks.set(look.matterId, [...(looks.get(look.matterId) ?? []), series]);
  }
  return looks;
}

async function syncs(): Promise<TaskRow[]> {
  const rows: TaskRow[] = [];
  for (const schedule of await closeRuns()) {
    const session = await getSession(schedule.session_id);
    if (session) rows.push(...liveTaskRows(session));
  }
  return rows;
}

/** When the evening close next comes, as its series holds it. */
async function nextClose(): Promise<string> {
  const [sync] = await syncs();
  return sync.process_after;
}

beforeEach(async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  vi.mocked(isContainerRunning).mockReturnValue(false);
  await runMigrations(await initTestDb());
  await seedMain(ZONE);
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("the host's guarantees for matters", () => {
  it("gives a matter whose look ran with no new one a look at the next close, once main's container is idle", async () => {
    const acme = await open('Acme renewal', { look: inDays(3) });
    const main = await mainSession();
    await runOccurrence(main, (await liveRow(acme.look_task_id)).id, 'completed');

    vi.mocked(isContainerRunning).mockReturnValue(true);
    await keepMattersOnTime();
    expect(await looksByMatter()).toEqual(new Map());
    expect(await fresh(acme)).toMatchObject({ look_task_id: acme.look_task_id });

    vi.mocked(isContainerRunning).mockReturnValue(false);
    await keepMattersOnTime();
    const handedBack = (await fresh(acme)).look_task_id;
    expect(await looksByMatter()).toEqual(new Map([[acme.id, [handedBack]]]));
    expect(lookSeries(handedBack ?? '')).toEqual({ matterId: acme.id, handedBack: true });
    expect(Date.parse((await liveRow(handedBack)).process_after)).toBe(Date.parse(await nextClose()));
  });

  it('replaces a look cancelled or paused through ncl tasks, cancelling the paused one', async () => {
    const acme = await open('Acme renewal', { look: inDays(3) });
    const lunch = await open('Lunch with Noel Archer', { look: inDays(4) });
    await data(run('tasks-cancel', { id: acme.look_task_id }));
    await data(run('tasks-pause', { id: lunch.look_task_id }));

    await keepMattersOnTime();

    const looks = await looksByMatter();
    expect(looks.get(acme.id)).toEqual([(await fresh(acme)).look_task_id]);
    expect(looks.get(lunch.id)).toEqual([(await fresh(lunch)).look_task_id]);
    expect((await fresh(lunch)).look_task_id).not.toBe(lunch.look_task_id);
    const paused = taskRows(await mainSession()).find((row) => row.series_id === lunch.look_task_id);
    expect(paused?.status).toBe('cancelled');
  });

  it('lets a yearly look re-arm itself after it runs, as the same one look', async () => {
    const birthday = await open("Juno Hale's birthday", { 'look-cron': YEARLY });
    const main = await mainSession();
    await runOccurrence(main, (await liveRow(birthday.look_task_id)).id, 'completed');

    await keepMattersOnTime();

    expect(await looksByMatter()).toEqual(new Map([[birthday.id, [birthday.look_task_id]]]));
    expect(await fresh(birthday)).toMatchObject({ look_task_id: birthday.look_task_id });
    const next = await liveRow(birthday.look_task_id);
    expect(next).toMatchObject({ recurrence: YEARLY });
    expect(next.process_after).toBe(CronExpressionParser.parse(YEARLY, { tz: ZONE }).next().toISOString());
  });

  it('leaves a yearly look to core re-arming while the completed close gets one next evening', async () => {
    const birthday = await open("Juno Hale's birthday", { 'look-cron': YEARLY });
    await keepMattersOnTime();
    const [close] = await syncs();
    await answerOccurrence(await mainSession(), (await liveRow(birthday.look_task_id)).id, 'completed');
    await keepMattersOnTime();
    await reconcileSession((await mainSession()).id);
    await keepMattersOnTime();
    expect(await looksByMatter()).toEqual(new Map([[birthday.id, [birthday.look_task_id]]]));
    expect((await syncs()).map((row) => row.id)).toEqual([close.id]);
  });

  it('brings a failed yearly look back at the next close, and its date for next year stays', async () => {
    const birthday = await open("Juno Hale's birthday", { 'look-cron': YEARLY });
    const main = await mainSession();
    await runOccurrence(main, (await liveRow(birthday.look_task_id)).id, 'script-skip:error');
    const nextYear = CronExpressionParser.parse(YEARLY, { tz: ZONE }).next().toISOString();
    expect((await liveRow(birthday.look_task_id)).process_after).toBe(nextYear);

    // Not while main's container runs.
    vi.mocked(isContainerRunning).mockReturnValue(true);
    await keepMattersOnTime();
    expect((await liveRow(birthday.look_task_id)).process_after).toBe(nextYear);

    vi.mocked(isContainerRunning).mockReturnValue(false);
    await keepMattersOnTime();
    const retry = await liveRow(birthday.look_task_id);
    expect(retry).toMatchObject({ recurrence: YEARLY });
    expect(Date.parse(retry.process_after)).toBe(Date.parse(await nextClose()));
    // One extra run: another pass leaves it as it is.
    await keepMattersOnTime();
    expect(liveTaskRows(main).filter((row) => row.series_id === birthday.look_task_id)).toEqual([retry]);

    await runOccurrence(main, retry.id, 'completed');
    await keepMattersOnTime();
    expect((await liveRow(birthday.look_task_id)).process_after).toBe(nextYear);
    expect(await looksByMatter()).toEqual(new Map([[birthday.id, [birthday.look_task_id]]]));
  });

  it('keeps a yearly look on its date when the failed run was of a look it replaced', async () => {
    const birthday = await open("Juno Hale's birthday", { look: inDays(3) });
    const main = await mainSession();
    // The one-off look's turn fails: the runner settles its row as done, and the notices module marks the matter.
    await runOccurrence(main, (await liveRow(birthday.look_task_id)).id, 'completed');
    await markLookFailed(birthday.id, new Date().toISOString());
    // The sync hands the matter back, and main then makes its look yearly.
    await keepMattersOnTime();
    expect(lookSeries((await fresh(birthday)).look_task_id ?? '')).toEqual({ matterId: birthday.id, handedBack: true });
    await data(run('matters-update', { id: birthday.id, 'look-cron': YEARLY }));

    await keepMattersOnTime();

    expect(await liveRow((await fresh(birthday)).look_task_id)).toMatchObject({
      recurrence: YEARLY,
      process_after: CronExpressionParser.parse(YEARLY, { tz: ZONE }).next().toISOString(),
    });
  });

  it('cancels any other look naming a matter, and every look naming a closed one, even while main works', async () => {
    const acme = await open('Acme renewal', { look: inDays(3) });
    const lease = await open('Lease', { look: inDays(3) });
    await data(run('matters-close', { id: lease.id, outcome: 'Signed.' }));
    const main = await mainSession();
    const stray = async (name: string): Promise<string> =>
      (
        await createScheduledTask(
          MAIN,
          prepareScheduledTask({ name, prompt: 'Stray.', processAfter: inDays(2), timezone: ZONE }),
          { session: main },
        )
      ).row.id;
    await stray(`look ${acme.id}`);
    await stray(`back ${lease.id}`);
    const board = await stray('Prepare the board pack');

    vi.mocked(isContainerRunning).mockReturnValue(true);
    await keepMattersOnTime();

    expect(await looksByMatter()).toEqual(new Map([[acme.id, [acme.look_task_id]]]));
    expect(liveTaskRows(main).map((row) => row.series_id)).toContain(board);
  });

  it('leaves each open matter exactly one look after any sequence, and a closed one none', async () => {
    const acme = await open('Acme renewal', { look: inDays(3) });
    const birthday = await open("Juno Hale's birthday", { 'look-cron': YEARLY });
    const lunch = await open('Lunch with Noel Archer', { look: inDays(2) });
    const lease = await open('Lease', { look: inDays(5) });
    const main = await mainSession();

    await run('matters-update', { id: acme.id, look: inDays(6) });
    await run('matters-update', { id: acme.id, look: inDays(7) });
    await runOccurrence(main, (await liveRow(lunch.look_task_id)).id, 'completed');
    await data(run('tasks-cancel', { id: birthday.look_task_id }));
    await data(run('tasks-pause', { id: (await fresh(acme)).look_task_id }));
    await run('matters-close', { id: lease.id, outcome: 'Signed.' });
    await run('matters-update', { id: lease.id, look: inDays(9) });
    await run('matters-close', { id: lease.id, outcome: 'Signed again.' });

    await keepMattersOnTime();

    const looks = await looksByMatter();
    for (const matter of [acme, birthday, lunch]) {
      expect(looks.get(matter.id), matter.title).toEqual([(await fresh(matter)).look_task_id]);
    }
    expect(looks.has(lease.id)).toBe(false);
    expect([...looks.keys()].sort()).toEqual([acme.id, birthday.id, lunch.id].sort());
  });

  it.each(['cancel', 'pause'] as const)(
    'keeps one pending evening close after %s without modifying core recurrence',
    async (change) => {
      await keepMattersOnTime();
      const [first] = await syncs();
      expect(first.recurrence).toBeNull();
      const schedule = (await closeRuns()).find((row) => row.id === first.id)!;
      const session = (await getSession(schedule.session_id))!;
      await withExistingMailboxSession(MAIN, session.id, (mailbox) =>
        change === 'cancel' ? mailbox.cancelTask(first.id) : mailbox.pauseTask(first.id),
      );
      await keepMattersOnTime();
      expect(await syncs()).toHaveLength(1);
      expect((await syncs())[0].id).not.toBe(first.id);
      expect((await syncs())[0].process_after).toBe(first.process_after);
    },
  );
});
