import fs from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-test-gws-ea-anchors',
  GROUPS_DIR: '/tmp/nanoclaw-test-gws-ea-anchors/groups',
}));
vi.mock('../../container-runner.js', async (original) => ({
  ...(await original<typeof import('../../container-runner.js')>()),
  isContainerRunning: () => false,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn().mockResolvedValue(true) }));

import { dispatch } from '../../cli/dispatch.js';
import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { inboundDbPath, outboundDbPath } from '../../mailbox/sqlite/paths.js';
import { reconcileSession } from '../../reconcile-session.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import '../gws-ea-profile/index.js';
import '../gws-ea-people/index.js';
import '../gws-ea-inbox/index.js';
import '../gws-ea-preferences/index.js';
import '../gws-ea-privacy/index.js';
import '../gws-ea-whereabouts/index.js';
import { addStay, dismissStay } from '../gws-ea-whereabouts/db.js';
import { createScheduledTask, prepareScheduledTask } from '../scheduling/create.js';
import './index.js';
import '../../cli/resources/tasks.js';
import { getTimeAnchor } from './anchors.js';
import { keepMattersOnTime } from './loop.js';
import { MAIN, closeRuns, mainSession, seedMain, liveTaskRows } from './testing/main-conversation.js';

const DATA = '/tmp/nanoclaw-test-gws-ea-anchors';
const HOME = 'America/Los_Angeles';
// Nov 1, 13:00 Pacific (daylight time until Nov 7); Brussels is on winter time.
const NOW = '2032-11-01T20:00:00.000Z';

async function task(id: string, at: string) {
  const session = await mainSession();
  await createScheduledTask(
    MAIN,
    prepareScheduledTask({ name: id, prompt: 'Morgan’s reminder.', processAfter: at, timezone: HOME }),
    { id, session },
  );
  return id;
}
/** As main sets a repeating reminder: the cron alone, its first run derived on the home clock. */
async function repeating(id: string, recurrence: string) {
  const session = await mainSession();
  await createScheduledTask(
    MAIN,
    prepareScheduledTask({ name: id, prompt: 'Morgan’s reminder.', recurrence, timezone: HOME }),
    { id, session },
  );
  return id;
}
async function retimeNotes(id: string) {
  return withExistingMailboxSession(MAIN, (await mainSession()).id, (mailbox) =>
    mailbox.getInboundRecords().filter((row) => row.kind === 'chat' && row.content.includes(`task ${id}:`)),
  );
}
async function at(id: string): Promise<string | undefined> {
  return liveTaskRows(await mainSession()).find((row) => row.series_id === id)?.process_after;
}
async function complete(id: string): Promise<void> {
  const session = await mainSession();
  const row = liveTaskRows(session).find((entry) => entry.series_id === id);
  if (!row) throw new Error(`No occurrence of ${id}`);
  vi.setSystemTime(new Date(row.process_after));
  const db = new Database(inboundDbPath(MAIN, session.id));
  try {
    db.prepare("UPDATE messages_in SET status='completed' WHERE id=?").run(row.id);
  } finally {
    db.close();
  }
  await reconcileSession(session.id);
}
async function stay(zone: string, start = '2032-11-02', end = '2032-11-05') {
  return addStay({ locality: zone.split('/').at(-1) ?? zone, zone, start, end, source: 'said', certainty: 'certain' });
}
async function clock(mode: 'fixed' | 'local', id: string) {
  return dispatch(
    { id: mode, command: `clock-${mode}`, args: { task: id } },
    { caller: 'agent', agentGroupId: MAIN, sessionId: (await mainSession()).id, messagingGroupId: 'mg-dm' },
  );
}
beforeEach(async () => {
  fs.rmSync(DATA, { recursive: true, force: true });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  await runMigrations(await initTestDb());
  await seedMain(HOME);
  await getDb().run('UPDATE gws_ea_profile SET principal_timezone=? WHERE singleton=1', HOME);
});
afterEach(async () => {
  vi.useRealTimers();
  await closeDb();
  fs.rmSync(DATA, { recursive: true, force: true });
});

describe('local task anchors through the native matters loop and core recurrence', () => {
  it('starts a newly created local cron after creation when today’s local clock has already passed', async () => {
    vi.setSystemTime(new Date('2032-11-02T01:00:00Z'));
    await stay('Asia/Tokyo');
    const session = await mainSession();
    await createScheduledTask(
      MAIN,
      prepareScheduledTask({
        name: 'new daily reminder',
        prompt: 'Morgan’s reminder.',
        recurrence: '0 9 * * *',
        timezone: HOME,
      }),
      { id: 'new-local-cron', session },
    );
    await keepMattersOnTime();
    expect(await at('new-local-cron')).toBe('2032-11-03T00:00:00.000Z');
  });
  it('starts an edited local cron after the edit instead of reviving this morning’s occurrence', async () => {
    vi.setSystemTime(new Date('2032-11-01T21:00:00Z'));
    await stay('Asia/Tokyo');
    const session = await mainSession();
    await createScheduledTask(
      MAIN,
      prepareScheduledTask({
        name: 'evening reminder',
        prompt: 'Morgan’s reminder.',
        recurrence: '0 18 * * *',
        timezone: HOME,
      }),
      { id: 'edited-local-cron', session },
    );
    await keepMattersOnTime();
    vi.setSystemTime(new Date('2032-11-02T01:00:00Z'));
    const changed = await dispatch(
      { id: 'edit-local-cron', command: 'tasks-update', args: { id: 'edited-local-cron', recurrence: '0 9 * * *' } },
      { caller: 'agent', agentGroupId: MAIN, sessionId: session.id, messagingGroupId: 'mg-dm' },
    );
    expect(changed.ok).toBe(true);
    await keepMattersOnTime();
    expect(await at('edited-local-cron')).toBe('2032-11-03T00:00:00.000Z');
  });
  it.each([
    ['Europe/Brussels', '2032-11-02T08:00:00.000Z', '2032-11-03T08:00:00.000Z'],
    ['Asia/Tokyo', '2032-11-02T00:00:00.000Z', '2032-11-03T00:00:00.000Z'],
    ['Pacific/Honolulu', '2032-11-02T19:00:00.000Z', '2032-11-03T19:00:00.000Z'],
  ])(
    'keeps daily 09:00 exactly once on each local day in %s and restores home on return',
    async (zone, first, second) => {
      const id = await repeating('daily-reminder', '0 9 * * *');
      await keepMattersOnTime();
      await stay(zone);
      await keepMattersOnTime();
      expect(await at(id)).toBe(first);
      await complete(id);
      await keepMattersOnTime();
      expect(await at(id)).toBe(second);
      await keepMattersOnTime();
      expect(await at(id)).toBe(second);
      for (const expected of [3, 4, 5]) {
        expect(new Date((await at(id)) ?? '').getUTCDate()).toBe(expected);
        await complete(id);
        await keepMattersOnTime();
      }
      expect(await at(id)).toBe('2032-11-06T16:00:00.000Z');
    },
  );

  it('keeps the later first run main gave a daily series, without a re-time', async () => {
    const session = await mainSession();
    await createScheduledTask(
      MAIN,
      prepareScheduledTask({
        name: 'daily from later',
        prompt: 'Morgan’s reminder.',
        processAfter: '2032-11-20T09:00-08:00',
        recurrence: '0 9 * * *',
        timezone: HOME,
      }),
      { id: 'daily-from-later', session },
    );
    await keepMattersOnTime();
    expect(await at('daily-from-later')).toBe('2032-11-20T17:00:00.000Z');
    expect(await retimeNotes('daily-from-later')).toEqual([]);
  });

  it('keeps a time written in UTC at its instant, read on the clock in effect then', async () => {
    const id = await task('utc-reminder', '2032-11-05T17:00:00Z');
    await keepMattersOnTime();
    await keepMattersOnTime();
    expect(await at(id)).toBe('2032-11-05T17:00:00.000Z');
    expect(await getTimeAnchor((await mainSession()).id, id)).toMatchObject({ originalZone: HOME });
  });

  it('starts a cron set on a Brussels morning at that morning’s local time', async () => {
    await stay('Europe/Brussels', '2032-11-01', '2032-11-05');
    vi.setSystemTime(new Date('2032-11-02T06:00:00Z'));
    const id = await repeating('brussels-morning', '0 9 * * *');
    expect(await at(id)).toBe('2032-11-02T16:00:00.000Z');
    await keepMattersOnTime();
    expect(await at(id)).toBe('2032-11-02T08:00:00.000Z');
  });

  it('does not run the same local date twice when travelling west after Pacific 09:00', async () => {
    const id = await repeating('westward', '0 9 * * *');
    await keepMattersOnTime();
    await complete(id);
    await stay('Pacific/Honolulu', '2032-11-02T17:00:00Z', '2032-11-06');
    await keepMattersOnTime();
    expect(await at(id)).toBe('2032-11-03T19:00:00.000Z');
  });

  it('preserves the resolved home 09:00 of a one-off set in Brussels for after return', async () => {
    await stay('Europe/Brussels');
    vi.setSystemTime(new Date('2032-11-03T06:00:00Z'));
    const id = await task('after-return', '2032-11-07T09:00-08:00');
    await keepMattersOnTime();
    expect(await at(id)).toBe('2032-11-07T17:00:00.000Z');
  });

  it('restores the original zone instant when fixed after a one-off has re-timed', async () => {
    const id = await task('fixed-original', '2032-11-03T09:00');
    await keepMattersOnTime();
    await stay('Europe/Brussels');
    await keepMattersOnTime();
    expect(await at(id)).toBe('2032-11-03T08:00:00.000Z');
    expect(await clock('fixed', id)).toMatchObject({ ok: true });
    expect(await at(id)).toBe('2032-11-03T16:00:00.000Z');
    expect(await clock('local', id)).toMatchObject({ ok: true });
    expect(await at(id)).toBe('2032-11-03T08:00:00.000Z');
  });

  it('moves pending items home when a stay is dismissed and leaves fixed items untouched', async () => {
    const local = await task('local-reminder', '2032-11-03T09:00');
    const fixed = await task('fixed-reminder', '2032-11-03T09:00');
    expect(await clock('fixed', fixed)).toMatchObject({ ok: true });
    await keepMattersOnTime();
    const trip = await stay('Asia/Tokyo');
    await keepMattersOnTime();
    expect(await at(local)).toBe('2032-11-03T00:00:00.000Z');
    expect(await at(fixed)).toBe('2032-11-03T16:00:00.000Z');
    await dismissStay({ id: trip.id, reason: 'Morgan is staying home.' });
    await keepMattersOnTime();
    expect(await at(local)).toBe('2032-11-03T16:00:00.000Z');
  });

  it('re-anchors a same-row main edit at its new wall time instead of undoing it', async () => {
    const id = await task('edited-reminder', '2032-11-03T09:00');
    await keepMattersOnTime();
    await stay('Europe/Brussels');
    await keepMattersOnTime();
    vi.setSystemTime(new Date('2032-11-02T12:00:00Z'));
    const edited = await dispatch(
      { id: 'edit-time', command: 'tasks-update', args: { id, 'process-after': '2032-11-03T11:30+01:00' } },
      { caller: 'host' },
    );
    expect(edited).toMatchObject({ ok: true });
    await keepMattersOnTime();
    expect(await at(id)).toBe('2032-11-03T10:30:00.000Z');
    await stay('Asia/Tokyo', '2032-11-03', '2032-11-03');
    await keepMattersOnTime();
    expect(await at(id)).toBe('2032-11-03T02:30:00.000Z');
  });

  it('keeps claimed occurrences and the host close and morning identities outside generic retiming', async () => {
    const id = await task('claimed-reminder', '2032-11-03T09:00');
    await task('gws-ea-close-aaaa', '2032-11-03T09:00');
    await task('gws-ea-morning-bbbb', '2032-11-03T09:00');
    await keepMattersOnTime();
    const session = await mainSession();
    const db = new Database(outboundDbPath(MAIN, session.id));
    try {
      db.prepare('INSERT INTO processing_ack (message_id,status,status_changed) VALUES (?,?,?)').run(
        id,
        'processing',
        new Date().toISOString(),
      );
    } finally {
      db.close();
    }
    await stay('Asia/Tokyo');
    await keepMattersOnTime();
    for (const key of [id, 'gws-ea-close-aaaa', 'gws-ea-morning-bbbb'])
      expect(await at(key)).toBe('2032-11-03T16:00:00.000Z');
  });

  it('waits out settling before moving a future row to due-now and reports old/new times once on the next wake', async () => {
    const id = await task('missed-local', '2032-11-02T09:00');
    await keepMattersOnTime();
    vi.setSystemTime(new Date('2032-11-02T10:00:00Z'));
    await stay('Europe/Brussels');
    await keepMattersOnTime();
    expect(await at(id)).toBe('2032-11-02T16:00:00.000Z');
    vi.setSystemTime(new Date('2032-11-02T10:03:00Z'));
    await keepMattersOnTime();
    expect(await at(id)).toBe('2032-11-02T10:03:00.000Z');
    await keepMattersOnTime();
    const notes = await withExistingMailboxSession(MAIN, (await mainSession()).id, (mailbox) =>
      mailbox.getInboundRecords().filter((row) => row.kind === 'chat' && row.content.includes('missed-local')),
    );
    expect(notes).toHaveLength(1);
    expect(notes?.[0]?.content).toContain('9:00 AM');
    expect(notes?.[0]?.content).toContain('Europe/Brussels');
  });
  it('lists each pending local task inside the new stay, excluding fixed and host-owned moments', async () => {
    const local = await task('preview-local', '2032-11-03T09:00');
    const fixed = await task('preview-fixed', '2032-11-03T09:00');
    await task('preview-after', '2032-11-09T09:00');
    await clock('fixed', fixed);
    await task('gws-ea-close-aaaa', '2032-11-03T09:00');
    await keepMattersOnTime();
    const response = await dispatch(
      {
        id: 'trip',
        command: 'whereabouts-stay-add',
        args: {
          locality: 'Brussels',
          zone: 'Europe/Brussels',
          start: '2032-11-02',
          end: '2032-11-05',
          source: 'said',
          certainty: 'certain',
        },
      },
      { caller: 'host' },
    );
    expect(response).toMatchObject({ ok: true });
    if (!response.ok) throw new Error('stay add failed');
    expect((response.data as { pending_local_items: unknown }).pending_local_items).toEqual([
      { task: local, at: '2032-11-03T16:00:00.000Z', zone: HOME },
    ]);
    expect(await at(local)).toBe('2032-11-03T16:00:00.000Z');
  });

  it('keeps other host guarantees running when the anchor step fails', async () => {
    await task('broken-cron', '2032-11-03T09:00');
    const session = await mainSession();
    await withExistingMailboxSession(MAIN, session.id, (mailbox) =>
      mailbox.updateTask('broken-cron', { recurrence: 'broken' }),
    );
    const stray = await task('look-m-0123456789ab-abcd', '2032-11-03T09:00');
    await keepMattersOnTime();
    expect(await closeRuns()).toHaveLength(1);
    expect(await at(stray)).toBeUndefined();
  });
  it('creates and updates fixed looks natively, and interprets a local look on its future trip day', async () => {
    const create = await dispatch(
      {
        id: 'fixed-look',
        command: 'matters-open',
        args: { title: 'Juno’s dinner', 'open-loop': 'Check the booking.', look: '2032-11-03T09:00', fixed: true },
      },
      { caller: 'host' },
    );
    if (!create.ok) throw new Error(JSON.stringify(create.error));
    const placed = create.data as import('./db.js').Placed;
    const id = placed.matter.look_task_id;
    if (id === null) throw new Error('Look was not created');
    await stay('Europe/Brussels');
    await keepMattersOnTime();
    expect(await at(id)).toBe('2032-11-03T16:00:00.000Z');
    const changed = await dispatch(
      { id: 'update-look', command: 'matters-update', args: { id: placed.matter.id, look: '2032-11-04T09:00' } },
      { caller: 'host' },
    );
    if (!changed.ok) throw new Error(JSON.stringify(changed.error));
    const matter = changed.data as import('./db.js').Matter;
    if (matter.look_task_id === null) throw new Error('Updated look was not created');
    expect(await at(matter.look_task_id)).toBe('2032-11-04T08:00:00.000Z');
    await keepMattersOnTime();
    expect(await at(matter.look_task_id)).toBe('2032-11-04T08:00:00.000Z');
  });
  it('keeps the original moment through a prompt-only edit and fixes the next cron after its last run', async () => {
    const id = await repeating('prompt-edit', '0 9 * * *');
    await keepMattersOnTime();
    await stay('Europe/Brussels');
    await keepMattersOnTime();
    const session = await mainSession();
    await withExistingMailboxSession(MAIN, session.id, (mailbox) =>
      mailbox.updateTask(id, { prompt: 'Morgan’s revised reminder wording.' }),
    );
    await keepMattersOnTime();
    expect(await clock('fixed', id)).toMatchObject({ ok: true });
    expect(await at(id)).toBe('2032-11-02T16:00:00.000Z');
    await complete(id);
    expect(await clock('fixed', id)).toMatchObject({ ok: true });
    expect(await at(id)).toBe('2032-11-03T16:00:00.000Z');
  });
  it('reports each actual re-time when local and fixed are toggled more than once', async () => {
    const id = await task('clock-toggles', '2032-11-03T09:00');
    await keepMattersOnTime();
    await stay('Europe/Brussels');
    await keepMattersOnTime();
    await clock('fixed', id);
    await clock('local', id);
    await keepMattersOnTime();
    const notes = await withExistingMailboxSession(MAIN, (await mainSession()).id, (mailbox) =>
      mailbox.getInboundRecords().filter((row) => row.kind === 'chat' && row.content.includes('clock-toggles')),
    );
    expect(notes).toHaveLength(3);
    expect(new Set(notes?.map((row) => row.id)).size).toBe(3);
  });
  it('keeps the cron calendar date when a monthly local reminder re-arms across a trip', async () => {
    const id = await repeating('monthly-local', '0 9 3 * *');
    await keepMattersOnTime();
    await stay('Asia/Tokyo');
    await keepMattersOnTime();
    expect(await at(id)).toBe('2032-11-03T00:00:00.000Z');
    await complete(id);
    await keepMattersOnTime();
    expect(await at(id)).toBe('2032-12-03T17:00:00.000Z');
    expect(liveTaskRows(await mainSession()).find((row) => row.series_id === id)?.recurrence).toBe('0 9 3 * *');
  });
  it('opens a matter on an event with a local look, anchoring its wall time and a Z time in the zone in effect', async () => {
    const trip = await stay('Europe/Brussels');
    const event = 'morgan@example.test/7k3q9v1m2n4p6r8s0t2u4v6a8b';
    const open = async (look: string, title: string) => {
      const response = await dispatch(
        { id: title, command: 'matters-open', args: { title, 'open-loop': 'Confirm the table.', look, event } },
        { caller: 'host' },
      );
      if (!response.ok) throw new Error(JSON.stringify(response.error));
      const { matter } = response.data as import('./db.js').Placed;
      if (matter.look_task_id === null) throw new Error('Look was not placed');
      return { matter, look: matter.look_task_id };
    };
    const local = await open('2032-11-03T09:00', 'Dinner with Juno');
    const utc = await open('2032-11-04T08:00:00Z', 'Lunch with Remy');
    expect(await at(local.look)).toBe('2032-11-03T08:00:00.000Z');
    expect(await at(utc.look)).toBe('2032-11-04T08:00:00.000Z');
    const session = await mainSession();
    for (const id of [local.look, utc.look])
      expect(await getTimeAnchor(session.id, id)).toMatchObject({
        originalZone: 'Europe/Brussels',
        wall: { hour: 9, minute: 0 },
        fixed: false,
      });
    const linked = await dispatch(
      { id: 'get', command: 'matters-get', args: { id: utc.matter.id } },
      { caller: 'host' },
    );
    expect(JSON.stringify(linked)).toContain('7k3q9v1m2n4p6r8s0t2u4v6a8b');
    await keepMattersOnTime();
    expect(await at(local.look)).toBe('2032-11-03T08:00:00.000Z');
    await dismissStay({ id: trip.id, reason: 'Morgan stayed home.' });
    await keepMattersOnTime();
    expect(await at(local.look)).toBe('2032-11-03T16:00:00.000Z');
    expect(await at(utc.look)).toBe('2032-11-04T16:00:00.000Z');
  });

  it('refuses a look, local or fixed, while the zone in effect for it is unknown', async () => {
    await getDb().run('UPDATE gws_ea_profile SET principal_timezone=NULL WHERE singleton=1');
    const input = { title: 'Juno’s booking', 'open-loop': 'Check the confirmation.', look: '2032-11-03T09:00' };
    for (const args of [input, { ...input, look: '2032-11-03T09:00+01:00', fixed: true }])
      expect(await dispatch({ id: 'unknown-look', command: 'matters-open', args }, { caller: 'host' })).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining('zone in effect for this look is unknown') },
      });
  });

  it('corrects each core re-arm during a trip silently, reporting only the move of a time main saw', async () => {
    const id = await repeating('trip-daily', '0 9 * * *');
    await keepMattersOnTime();
    await stay('Europe/Brussels');
    await keepMattersOnTime();
    expect(await at(id)).toBe('2032-11-02T08:00:00.000Z');
    for (const expected of ['2032-11-03T08:00:00.000Z', '2032-11-04T08:00:00.000Z', '2032-11-05T08:00:00.000Z']) {
      await complete(id);
      await keepMattersOnTime();
      expect(await at(id)).toBe(expected);
    }
    const notes = await retimeNotes(id);
    expect(notes).toHaveLength(1);
    expect(notes?.[0]?.content).toContain('Europe/Brussels');
  });

  it('keeps a daily reminder made a one-off during a trip at its local time there', async () => {
    const id = await repeating('one-off-now', '0 9 * * *');
    await keepMattersOnTime();
    await stay('Europe/Brussels');
    await keepMattersOnTime();
    expect(await at(id)).toBe('2032-11-02T08:00:00.000Z');
    vi.setSystemTime(new Date('2032-11-01T23:30:00Z'));
    const changed = await dispatch(
      { id: 'one-shot', command: 'tasks-update', args: { id, recurrence: 'none' } },
      { caller: 'host' },
    );
    expect(changed).toMatchObject({ ok: true });
    await keepMattersOnTime();
    await keepMattersOnTime();
    expect(await at(id)).toBe('2032-11-02T08:00:00.000Z');
  });

  it('forgets an anchor once its series has nothing left to run, and not while a re-arm is due', async () => {
    const session = await mainSession();
    const once = await task('one-off-done', '2032-11-03T09:00');
    const daily = await repeating('daily-kept', '0 9 * * *');
    expect(await clock('fixed', daily)).toMatchObject({ ok: true });
    await keepMattersOnTime();
    const db = new Database(inboundDbPath(MAIN, session.id));
    try {
      db.prepare("UPDATE messages_in SET status='completed' WHERE series_id IN (?, ?)").run(once, daily);
    } finally {
      db.close();
    }
    await keepMattersOnTime();
    expect(await getTimeAnchor(session.id, once)).toBeUndefined();
    expect(await getTimeAnchor(session.id, daily)).toMatchObject({ fixed: true });
  });
});
