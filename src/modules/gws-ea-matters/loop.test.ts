/**
 * The host's guarantees for matters (KTD7, R13, R14, R16, R24, AE3): every
 * open matter has exactly one look still to come, a closed one none, the
 * morning always exists, and a failed repeating look comes back the next
 * morning. Driven through `ncl` and the real sweep against main's real
 * session mailbox, on the real clock, as SQLite's `now` decides what is due.
 */
import { CronExpressionParser } from 'cron-parser';
import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-test-gws-ea-matters-loop',
  GROUPS_DIR: '/tmp/nanoclaw-test-gws-ea-matters-loop/groups',
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
import { reconcileSession } from '../../reconcile-session.js';
import '../gws-ea-inbox/index.js';
import '../gws-ea-people/index.js';
import '../gws-ea-preferences/index.js';
import '../gws-ea-profile/index.js';
import { createScheduledTask, prepareScheduledTask } from '../scheduling/create.js';
import { getMatter, markLookFailed, type Matter, type Placed } from './db.js';
import './index.js';
import { lookSeries } from './looks.js';
import { keepMattersOnTime, runMattersLoop } from './loop.js';
import {
  answerOccurrence,
  liveTaskRows,
  MAIN,
  mainSession,
  runOccurrence,
  seedMain,
  taskRows,
  type TaskRow,
} from './testing/main-conversation.js';

const DATA_DIR = '/tmp/nanoclaw-test-gws-ea-matters-loop';
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

async function mornings(): Promise<TaskRow[]> {
  return liveTaskRows(await mainSession()).filter((row) => row.series_id.startsWith('gws-ea-morning-'));
}

/** When the morning next comes, as its series holds it. */
async function nextMorning(): Promise<string> {
  const [morning] = await mornings();
  return morning.process_after;
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
  it("gives a matter whose look ran with no new one a look at the next morning, once main's container is idle (AE3)", async () => {
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
    expect(Date.parse((await liveRow(handedBack)).process_after)).toBe(Date.parse(await nextMorning()));
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

  it('lets a yearly look re-arm itself after it runs, as the same one look (R24)', async () => {
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

  it('keeps the morning and a yearly look as they are through a pass between their run and the sweep arming the next', async () => {
    const birthday = await open("Juno Hale's birthday", { 'look-cron': YEARLY });
    await keepMattersOnTime();
    const [morning] = await mornings();
    const main = await mainSession();

    // The sweep has read the runner's answers, and waits on waking main for other mail before it arms what repeats.
    await answerOccurrence(main, (await liveRow(birthday.look_task_id)).id, 'completed');
    await answerOccurrence(main, morning.id, 'completed');
    await keepMattersOnTime();
    await reconcileSession(main.id);
    await keepMattersOnTime();

    expect(await looksByMatter()).toEqual(new Map([[birthday.id, [birthday.look_task_id]]]));
    expect(await fresh(birthday)).toMatchObject({ look_task_id: birthday.look_task_id });
    expect((await mornings()).map((row) => row.series_id)).toEqual([morning.series_id]);
  });

  it('brings a failed yearly look back at the next morning, and its date for next year stays', async () => {
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
    expect(Date.parse(retry.process_after)).toBe(Date.parse(await nextMorning()));
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
    // The morning hands the matter back, and main then makes its look yearly.
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

  it('creates the morning when the host starts, again after it is cancelled, and at the time main moved it to after the sweep pauses it', async () => {
    const controller = new AbortController();
    const loop = runMattersLoop(controller.signal);
    await vi.waitFor(async () => expect(await mornings()).toHaveLength(1));
    controller.abort();
    await loop;
    const [first] = await mornings();
    expect(first).toMatchObject({ recurrence: '30 7 * * *' });

    await data(run('tasks-cancel', { id: first.series_id }));
    await keepMattersOnTime();
    const [second] = await mornings();
    expect(await mornings()).toHaveLength(1);
    expect(second.series_id).not.toBe(first.series_id);

    // main moves it while the principal travels; then eight failed runs in a row, and the sweep pauses the series.
    await data(run('matters-morning', { at: '06:45' }));
    const [moved] = await mornings();
    const main = await mainSession();
    for (let failures = 0; failures < 8; failures++) {
      await runOccurrence(main, (await liveRow(moved.series_id)).id, 'script-skip:error');
    }
    expect(await liveRow(moved.series_id)).toMatchObject({ status: 'paused' });

    await keepMattersOnTime();
    const [third] = (await mornings()).filter((row) => row.status === 'pending');
    expect(await mornings()).toEqual([third]);
    expect(third).toMatchObject({ recurrence: '45 6 * * *' });
    expect(third.series_id).not.toBe(moved.series_id);
  });
});
