import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  root: `/tmp/gws-ea-u9-morning-${process.pid}-${Math.random().toString(36).slice(2)}`,
}));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: fixture.root,
  GROUPS_DIR: `${fixture.root}/groups`,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn().mockResolvedValue(true) }));
vi.mock('../../container-runner.js', async (original) => ({
  ...(await original<typeof import('../../container-runner.js')>()),
  isContainerRunning: () => false,
}));
import { dispatch } from '../../cli/dispatch.js';
import { closeDb, getDb, initDb, runMigrations } from '../../db/index.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { requestWake } from '../../request-wake.js';
import '../gws-ea-inbox/index.js';
import '../gws-ea-people/index.js';
import '../gws-ea-preferences/index.js';
import '../gws-ea-profile/index.js';
import { setSchedulingPreference } from '../gws-ea-preferences/db.js';
import { writeNoteForMain, noteCarriesNewFact, type NoteKind } from '../gws-ea-profile/main-note.js';
import { addStay } from '../gws-ea-whereabouts/db.js';
import './index.js';
import { keepMorning, morningVerdict } from './morning.js';
import type { Matter, Placed } from './db.js';
import { getMatter } from './db.js';
import {
  answerOccurrence,
  liveTaskRows,
  mainSession,
  MAIN,
  printed,
  runnerReads,
  seedMain,
  taskRows,
} from './testing/main-conversation.js';

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2032-10-12T09:00:00Z'));
  fs.rmSync(fixture.root, { force: true, recursive: true });
  fs.mkdirSync(fixture.root, { recursive: true });
  await runMigrations(await initDb(`${fixture.root}/central.db`, { role: 'test' }));
  await seedMain('America/Los_Angeles');
  vi.mocked(requestWake).mockClear();
});
afterEach(async () => {
  vi.useRealTimers();
  await closeDb();
  fs.rmSync(fixture.root, { force: true, recursive: true });
});
async function mornings() {
  return liveTaskRows(await mainSession()).filter((row) => row.id.startsWith('gws-ea-morning-'));
}
async function note(id: string, kind?: NoteKind) {
  await writeNoteForMain({
    id,
    text: 'Same text, different writer metadata.',
    timestamp: new Date().toISOString(),
    wake: false,
    ...(kind ? { noteKind: kind } : {}),
  });
}

describe('R41 durable morning gate', () => {
  it('writes a quiet per-date decision without a task, session or model wake, and a fresh invocation keeps it', async () => {
    const main = await mainSession();
    const before = await getSessionsByAgentGroup(MAIN);
    for (const kind of ['host-receipt', 'clock-retimed', 'unplaced-thread'] as const) await note(kind, kind);
    vi.setSystemTime(new Date('2032-10-12T14:00:00Z'));
    await keepMorning(main);
    expect(await mornings()).toEqual([]);
    expect((await getSessionsByAgentGroup(MAIN)).map((session) => session.id)).toEqual(
      before.map((session) => session.id),
    );
    expect(requestWake).not.toHaveBeenCalled();
    expect(await getDb().all('SELECT day,task_id,created FROM gws_ea_morning_decisions')).toEqual([
      { day: '2032-10-12', task_id: null, created: 1 },
    ]);
    // There is no process-local gate: later work cannot change the durable decision for this date.
    await closeDb();
    await initDb(`${fixture.root}/central.db`, { role: 'test' });
    await note('later-new-fact');
    await keepMorning(main);
    expect(await mornings()).toEqual([]);
  });

  it('creates exactly one conversational morning for an unread fact, regardless of receipt-like wording', async () => {
    await note('fact');
    vi.setSystemTime(new Date('2032-10-12T14:00Z'));
    await keepMorning(await mainSession());
    await keepMorning(await mainSession());
    const [row] = await mornings();
    expect(await mornings()).toHaveLength(1);
    expect(JSON.parse(row.content)).toMatchObject({ inConversation: true });
    expect(row.process_after).toBe('2032-10-12T14:00:00.000Z');
    expect(noteCarriesNewFact(JSON.stringify({ text: 'host receipt clock re-timed', sender: 'system' }))).toBe(true);
  });

  it('runs an hour before that weekday’s start and uses 07:00 without working hours', async () => {
    await note('work');
    await setSchedulingPreference({
      kind: 'working-hours',
      weekday: 'tue',
      hours: { start: '09:30', end: '17:00' },
      source: 'principal',
      basis: 'Morgan said so.',
    });
    vi.setSystemTime(new Date('2032-10-12T15:29Z'));
    await keepMorning(await mainSession());
    expect(await mornings()).toEqual([]);
    vi.setSystemTime(new Date('2032-10-12T15:30Z'));
    await keepMorning(await mainSession());
    expect((await mornings())[0].process_after).toBe('2032-10-12T15:30:00.000Z');
  });

  it('runs at 10:00 on a day off whose protected morning lasts until 10:00', async () => {
    await note('day-off-work');
    await setSchedulingPreference({
      kind: 'working-hours',
      weekday: 'tue',
      hours: 'off',
      source: 'principal',
      basis: 'Morgan said so.',
    });
    await setSchedulingPreference({
      kind: 'protected-window',
      weekdays: ['tue'],
      start: '00:00',
      end: '10:00',
      source: 'principal',
      basis: 'Keep the morning free.',
    });
    vi.setSystemTime(new Date('2032-10-12T16:59Z'));
    await keepMorning(await mainSession());
    expect(await mornings()).toEqual([]);
    vi.setSystemTime(new Date('2032-10-12T17:00Z'));
    await keepMorning(await mainSession());
    expect((await mornings())[0].process_after).toBe('2032-10-12T17:00:00.000Z');
  });

  it.each(['update', 'close'] as const)(
    'keeps the shared morning pending for the other matter after one matter is %s',
    async (change) => {
      const main = await mainSession();
      const caller = { caller: 'agent' as const, sessionId: main.id, agentGroupId: MAIN, messagingGroupId: 'mg-dm' };
      const held: Matter[] = [];
      for (const title of ['Departure brief', 'Juno’s meeting brief']) {
        const answer = await dispatch(
          { id: title, command: 'matters-open', args: { title, open_loop: 'Prepare the brief.', look: 'morning' } },
          caller,
        );
        if (!answer.ok) throw new Error(JSON.stringify(answer.error));
        held.push((answer.data as Placed).matter);
      }
      vi.setSystemTime(new Date('2032-10-12T14:00Z'));
      await keepMorning(main);
      const [morning] = await mornings();
      expect((await getMatter(held[1].id))?.look_task_id).toBe(morning.id);
      const changed = await dispatch(
        {
          id: 'change-held',
          command: `matters-${change}`,
          args:
            change === 'close'
              ? { id: held[0].id, outcome: 'Already handled.' }
              : { id: held[0].id, look: '2032-10-12T12:00' },
        },
        caller,
      );
      expect(changed.ok).toBe(true);
      expect((await mornings()).map((row) => row.id)).toEqual([morning.id]);
      const verdict = await morningVerdict('2032-10-12');
      expect(verdict).toMatchObject({
        wakeAgent: true,
        data: ['Morning 2032-10-12 in America/Los_Angeles.', `- ${held[1].id}: Juno’s meeting brief`],
      });
      const frame = await dispatch(
        { id: 'run-morning', command: 'matters-morning', args: { date: '2032-10-12' } },
        caller,
      );
      const scratch = fs.mkdtempSync(`${fixture.root}/morning-script-`);
      expect(await runnerReads(printed(frame), scratch)).toEqual(verdict);
      await answerOccurrence(main, morning.id, 'completed');
      expect(taskRows(main).find((row) => row.id === morning.id)?.status).toBe('completed');
    },
  );

  it('holds --look morning from 02:00 Pacific for the New York morning after landing at JFK', async () => {
    await addStay({
      locality: 'New York',
      zone: 'America/New_York',
      start: '2032-10-12T10:00Z',
      end: '2032-10-14',
      source: 'said',
      certainty: 'certain',
    });
    const main = await mainSession();
    const response = await dispatch(
      {
        id: 'morning-look',
        command: 'matters-open',
        args: { title: 'Departure brief', open_loop: 'Prepare the next leg.', look: 'morning' },
      },
      { caller: 'agent', sessionId: main.id, agentGroupId: MAIN, messagingGroupId: 'mg-dm' },
    );
    expect(response.ok).toBe(true);
    expect(await mornings()).toEqual([]);
    vi.setSystemTime(new Date('2032-10-12T10:59Z'));
    await keepMorning(main);
    expect(await mornings()).toEqual([]);
    vi.setSystemTime(new Date('2032-10-12T11:00Z'));
    await keepMorning(main);
    expect(await mornings()).toHaveLength(1);
    expect((await mornings())[0].process_after).toBe('2032-10-12T11:00:00.000Z');
    expect(await morningVerdict('2032-10-12')).toMatchObject({
      wakeAgent: true,
      data: expect.arrayContaining([expect.stringContaining('Departure brief')]),
    });
    expect(
      await withExistingMailboxSession(MAIN, main.id, (mailbox) =>
        mailbox
          .getInboundRecords({ status: 'pending' })
          .filter((item) => item.kind === 'task' && item.id.startsWith('look-')),
      ),
    ).toEqual([]);
  });
});
