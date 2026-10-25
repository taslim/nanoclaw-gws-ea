/**
 * A matter's next look: one slot, held by one scheduled
 * task that comes back as a turn of main's conversation, whose pre-task
 * script presents the matter read live. Driven through `ncl matters` against
 * main's real session mailbox; Google is in memory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-test-gws-ea-matters-looks',
  GROUPS_DIR: '/tmp/nanoclaw-test-gws-ea-matters-looks/groups',
}));

/** Google as the host's own clients reach it, in memory: each test gets its own. */
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
import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { findTaskSessions } from '../../db/sessions.js';
import '../gws-ea-inbox/index.js';
import { FakeGmailThreads } from '../gws-ea-inbox/testing/fake-gmail-threads.js';
import { createThread } from '../gws-ea-inbox/thread-map.js';
import '../gws-ea-people/index.js';
import '../gws-ea-preferences/index.js';
import '../gws-ea-profile/index.js';
import { getMatter, listOpenMatters, type Matter, type Placed } from './db.js';
import './index.js';
import {
  liveTaskRows,
  MAIN,
  mainSession,
  printed,
  runnerReads,
  seedMain,
  taskContent,
  taskRows,
} from './testing/main-conversation.js';

const DATA_DIR = '/tmp/nanoclaw-test-gws-ea-matters-looks';
const ZONE = 'America/New_York';
const DAY = 24 * 60 * 60 * 1000;
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

/** A time `days` from now, to the minute, with its UTC offset. */
function inDays(days: number): string {
  return new Date(Math.floor((Date.now() + days * DAY) / 60_000) * 60_000).toISOString();
}

async function open(title: string, look: Record<string, string>, links: Record<string, string> = {}): Promise<Matter> {
  return (await data<Placed>(run('matters-open', { title, 'open-loop': 'What happens next.', ...look, ...links })))
    .matter;
}

/** The live look tasks in main's conversation, by series. */
async function liveLooks(): Promise<string[]> {
  return [...new Set(liveTaskRows(await mainSession()).map((row) => row.series_id))];
}

let gmail: FakeGmailThreads;
let scratch: string;

beforeEach(async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-ea-matters-looks-'));
  gmail = new FakeGmailThreads();
  google.gmail = gmail;
  await runMigrations(await initTestDb());
  await seedMain(ZONE);
  await createThread('gmail-thread-a', new Date().toISOString(), THREAD);
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("a matter's next look", () => {
  it("opens with exactly one task, in main's conversation, naming only the matter; moving it leaves one", async () => {
    const first = inDays(3);
    const acme = await open('Acme renewal', { look: first });
    const main = await mainSession();

    const [look] = liveTaskRows(main);
    expect(liveTaskRows(main)).toHaveLength(1);
    expect(acme.look_task_id).toBe(look.series_id);
    expect(look).toMatchObject({ status: 'pending', recurrence: null });
    expect(Date.parse(look.process_after)).toBe(Date.parse(first));
    const content = taskContent(look);
    expect(content.script).toBe(`ncl matters look ${acme.id}`);
    expect(content.prompt).toContain(acme.id);
    expect(content.prompt).toContain('Act on it, then set its next look or close it.');
    // The title comes from the live render, never from the task.
    expect(content.prompt).not.toContain('Acme');
    // A turn of main's conversation, never a task session of its own.
    expect(await findTaskSessions(MAIN)).toEqual([]);

    const second = inDays(5);
    const moved = await data<Matter>(run('matters-update', { id: acme.id, look: second }));
    const live = liveTaskRows(main);
    expect(live).toHaveLength(1);
    expect(moved.look_task_id).toBe(live[0].series_id);
    expect(live[0].series_id).not.toBe(look.series_id);
    expect(Date.parse(live[0].process_after)).toBe(Date.parse(second));
    expect(taskRows(main).find((row) => row.id === look.id)?.status).toBe('cancelled');

    // A repeating look replaces it the same way.
    const yearly = await data<Matter>(run('matters-update', { id: acme.id, 'look-cron': '0 9 14 3 *' }));
    expect(liveTaskRows(main)).toMatchObject([{ series_id: yearly.look_task_id, recurrence: '0 9 14 3 *' }]);
  });

  it('ends with the matter: closing cancels it, and a look for a closed or forgotten matter stays silent', async () => {
    const acme = await open('Acme renewal', { look: inDays(3) });
    const closed = await data<Matter>(run('matters-close', { id: acme.id, outcome: 'Signed.' }));

    expect(closed.look_task_id).toBeNull();
    expect((await getMatter(acme.id))?.look_task_id).toBeNull();
    expect(await liveLooks()).toEqual([]);
    expect(taskRows(await mainSession())).toMatchObject([{ series_id: acme.look_task_id, status: 'cancelled' }]);

    const silent = await run('matters-look', { id: acme.id });
    expect(silent).toMatchObject({ ok: true, data: { wakeAgent: false }, human: '{"wakeAgent":false}' });
    expect(await data(run('matters-look', { id: 'm-000000000000' }))).toEqual({ wakeAgent: false });
    expect(gmail.reads).toEqual([]);
  });

  it('presents the matter as its sources say it is when the look comes, not when it was set', async () => {
    gmail.put('gmail-thread-a', {
      id: 'a1',
      from: 'Juno Hale <juno@acme.example>',
      at: new Date(Date.now() - DAY).toISOString(),
      subject: 'Renewal',
      snippet: 'Redlines attached.',
    });
    const acme = await open('Acme renewal', { look: inDays(3) }, { thread: THREAD });
    gmail.put(
      'gmail-thread-a',
      {
        id: 'a1',
        from: 'Juno Hale <juno@acme.example>',
        at: new Date(Date.now() - DAY).toISOString(),
        subject: 'Renewal',
        snippet: 'Redlines attached.',
      },
      {
        id: 'a2',
        from: 'Juno Hale <juno@acme.example>',
        at: new Date(Date.now() - 60_000).toISOString(),
        subject: 'Re: Renewal',
        snippet: 'We can sign Thursday.',
      },
    );

    const verdict = await data<{ wakeAgent: boolean; data: string[] }>(run('matters-look', { id: acme.id }));
    expect(verdict.wakeAgent).toBe(true);
    expect(verdict.data[0]).toBe(`Matter ${acme.id}, open: Acme renewal`);
    expect(verdict.data).toContain('Excerpt: We can sign Thursday.');
    expect(gmail.reads).toEqual(['gmail-thread-a']);
  });

  it("prints a verdict the runner's pre-task script contract reads as one", async () => {
    const acme = await open('Acme renewal', { look: inDays(3) });

    const open_ = await run('matters-look', { id: acme.id });
    expect(await runnerReads(printed(open_), scratch)).toEqual({
      wakeAgent: true,
      data: expect.arrayContaining([`Matter ${acme.id}, open: Acme renewal`, 'What happens next.']),
    });

    await run('matters-close', { id: acme.id, outcome: 'Signed.' });
    expect(await runnerReads(printed(await run('matters-look', { id: acme.id })), scratch)).toEqual({
      wakeAgent: false,
    });
  });

  it('never replaces a repeating look with a one-off, which is a matter of its own', async () => {
    const birthday = await open("Juno's birthday", { 'look-cron': '0 9 7 3 *' });

    expect(await run('matters-update', { id: birthday.id, look: inDays(2) })).toMatchObject(
      refused(/repeats on "0 9 7 3 \*".*open a separate matter/),
    );
    expect(await liveLooks()).toEqual([birthday.look_task_id]);
    expect(await getMatter(birthday.id)).toMatchObject({ look_task_id: birthday.look_task_id });

    // Its words still change, and a one-off look replaces a one-off one.
    expect(await data(run('matters-update', { id: birthday.id, title: "Juno Hale's birthday" }))).toMatchObject({
      look_task_id: birthday.look_task_id,
    });
    const lunch = await open('Lunch with Noel Archer', { look: inDays(2) });
    const moved = await data<Matter>(run('matters-update', { id: lunch.id, look: inDays(4) }));
    expect((await liveLooks()).sort()).toEqual([birthday.look_task_id, moved.look_task_id].sort());
  });

  it('reopens a closed matter with one look', async () => {
    const acme = await open('Acme renewal', { look: inDays(3) });
    await run('matters-close', { id: acme.id, outcome: 'Signed.' });

    const reopened = await data<Matter>(run('matters-update', { id: acme.id, look: inDays(30) }));
    expect(reopened).toMatchObject({ open: true });
    expect(await liveLooks()).toEqual([reopened.look_task_id]);
  });

  it('refuses to open a matter while there is no conversation with the principal for its look to come back to', async () => {
    await getDb().run('DELETE FROM gws_ea_principal_users');

    expect(await run('matters-open', { title: 'Acme', 'open-loop': 'Renew.', look: inDays(3) })).toMatchObject(
      refused(/conversation with the principal/),
    );
    expect(await listOpenMatters()).toEqual([]);
  });
});
