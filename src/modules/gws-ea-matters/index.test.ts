import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-test-gws-ea-matters-index',
  GROUPS_DIR: '/tmp/nanoclaw-test-gws-ea-matters-index/groups',
}));

/** Google as the host's own clients reach it, in memory: each test gets its own. */
const google = vi.hoisted(() => ({ gmail: undefined as unknown, calendar: undefined as unknown }));
vi.mock('../gws-ea-inbox/gmail-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gws-ea-inbox/gmail-api.js')>()),
  createGmailApi: () => ({
    getThread: (id: string) =>
      (google.gmail as import('../gws-ea-inbox/testing/fake-gmail-threads.js').FakeGmailThreads).getThread(id),
  }),
}));
vi.mock('../gws-ea-meetings/calendar-api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../gws-ea-meetings/calendar-api.js')>();
  const { delegatingCalendarApi } = await import('../gws-ea-meetings/testing/fake-calendar.js');
  return {
    ...actual,
    createMeetingsCalendarApi: () =>
      delegatingCalendarApi(() => google.calendar as import('../gws-ea-meetings/calendar-api.js').MeetingsCalendarApi),
  };
});

import { dispatch } from '../../cli/dispatch.js';
import type { CallerContext, ResponseFrame } from '../../cli/frame.js';
import { commandGuard, lookup } from '../../cli/registry.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { closeDb, createAgentGroup, createMessagingGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import type { AgentGroup } from '../../types.js';
import '../gws-ea-profile/index.js';
import '../gws-ea-privacy/index.js';
import '../gws-ea-whereabouts/index.js';
import '../gws-ea-people/index.js';
import { addPerson } from '../gws-ea-people/db.js';
import '../gws-ea-inbox/index.js';
import { FakeGmailThreads } from '../gws-ea-inbox/testing/fake-gmail-threads.js';
import { createThread } from '../gws-ea-inbox/thread-map.js';
import { FakeCalendar } from '../gws-ea-meetings/testing/fake-calendar.js';
import { getMatter, listOpenMatters, type Matter, type Placed } from './db.js';
import './index.js';
import { seedMain } from './testing/main-conversation.js';

const VERBS = ['open', 'place', 'update', 'close', 'get', 'look', 'sync', 'today', 'list'] as const;
const DATA_DIR = '/tmp/nanoclaw-test-gws-ea-matters-index';

const NOW = '2026-10-10T12:00:00.000Z';
const THREAD_A = 'mail-8d1f2c34-5b6a-4e7f-9a01-23456789abcd';
const THREAD_B = 'mail-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const EVENT = 'morgan@example.test/7k3q9v1m2n4p6r8s0t2u4v6a8b';

function group(id: string, name: string): AgentGroup {
  return { id, name, folder: id, agent_provider: null, created_at: NOW };
}

const main = group('ag-main', 'main');
const other = group('ag-other', 'external-email');

function agent(agentGroupId: string): CallerContext {
  return { caller: 'agent', sessionId: `sess-${agentGroupId}`, agentGroupId, messagingGroupId: 'mg-dm' };
}

const HOST: CallerContext = { caller: 'host' };
const MAIN_CALLER = agent(main.id);

function run(command: string, args: Record<string, unknown>, ctx: CallerContext = MAIN_CALLER): Promise<ResponseFrame> {
  return dispatch({ id: command, command, args }, ctx);
}

async function data<T>(response: Promise<ResponseFrame>): Promise<T> {
  const settled = await response;
  if (!settled.ok) throw new Error(`Command failed: ${JSON.stringify(settled.error)}`);
  return settled.data as T;
}

function refused(message: RegExp) {
  return { ok: false, error: { message: expect.stringMatching(message) } };
}

let remy: string;

beforeEach(async () => {
  google.gmail = new FakeGmailThreads();
  google.calendar = new FakeCalendar();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  // The canonical main, as the profile module's reconcile records it, with the conversation its looks come back to.
  await seedMain('Africa/Lagos');
  await createAgentGroup(other);
  await ensureContainerConfig(other.id);
  await updateContainerConfigScalars(other.id, { cli_scope: 'global' });
  await createThread('gmail-thread-a', NOW, THREAD_A);
  await createThread('gmail-thread-b', NOW, THREAD_B);
  remy = (await addPerson({ name: 'Remy Vance', level: 'known', source: 'principal', basis: 'Acme buyer.' })).id;
});

afterEach(async () => {
  vi.useRealTimers();
  await closeDb();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('GWS-EA matters ncl resource', () => {
  it('links the same chat to two matters through native place, and unlinks only the named matter', async () => {
    await createMessagingGroup({
      id: 'mg-trip',
      channel_type: 'whatsapp',
      platform_id: 'trip@g.us',
      name: 'Lake trip',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: NOW,
    });
    await getDb().exec(`CREATE TABLE gws_ea_chats (
      messaging_group_id TEXT PRIMARY KEY, state TEXT NOT NULL, serving_agent_group_id TEXT NOT NULL
    );
    CREATE TABLE gws_ea_chat_members (messaging_group_id TEXT NOT NULL, person_id TEXT);`);
    await getDb().run("INSERT INTO gws_ea_chats VALUES ('mg-trip', 'connected', 'ag-other')");
    const first = await data<Placed>(
      run('matters-open', {
        title: 'Dinner Thursday',
        'open-loop': 'Book dinner.',
        look: '2026-10-14T09:00',
      }),
    );
    const second = await data<Placed>(
      run('matters-open', {
        title: 'Lake trip',
        'open-loop': 'Plan the trip.',
        look: '2026-10-14T09:00',
      }),
    );
    for (const matter of [first.matter, second.matter]) {
      expect(await data(run('matters-place', { id: matter.id, chat: 'mg-trip' }))).toMatchObject({
        matter: { links: [{ kind: 'chat', reference: 'mg-trip' }] },
        moved: [],
      });
    }
    await data(run('matters-update', { id: first.matter.id, unlink: 'chat:mg-trip' }));
    expect((await getMatter(first.matter.id))?.links).toEqual([]);
    expect((await getMatter(second.matter.id))?.links).toMatchObject([{ kind: 'chat', reference: 'mg-trip' }]);
  });

  it('registers its own verbs as open, guarded matters commands, and no generic create or delete', () => {
    for (const verb of VERBS) {
      const command = lookup(`matters-${verb}`);
      expect(command, verb).toMatchObject({ access: 'open', resource: 'matters', action: `matters.${verb}` });
      expect(command?.hostOnly, verb).toBeFalsy();
      expect(commandGuard(`matters-${verb}`).action).toBe(`matters.${verb}`);
    }
    for (const generic of ['create', 'delete']) expect(lookup(`matters-${generic}`), generic).toBeUndefined();
  });

  it('lets main keep a matter through ncl, from open to close and back', async () => {
    const opened = await data<Placed>(
      run('matters-open', {
        title: 'Acme renewal',
        'open-loop': 'Morgan wants it signed by Friday. Waiting on the redlines.',
        look: '2026-10-14T09:00',
        thread: THREAD_A,
        event: EVENT,
        person: remy,
        memory: 'memory/acme.md',
      }),
    );
    const id = opened.matter.id;
    expect(opened).toMatchObject({
      matter: {
        title: 'Acme renewal',
        open: true,
        links: [
          { kind: 'thread', reference: THREAD_A },
          { kind: 'event', reference: EVENT },
          { kind: 'person', reference: remy },
          { kind: 'memory', reference: 'memory/acme.md' },
        ],
      },
      moved: [],
    });
    // `ncl matters get <id>` arrives dash-joined with the id as its tail.
    expect(await data(run(`matters-get-${id}`, {}))).toContain(`Matter ${id}, open: Acme renewal`);

    const offsite = await data<Placed>(
      run('matters-open', { title: 'Team offsite', 'open-loop': 'Pick a venue.', 'look-cron': '0 9 * * 1' }),
    );
    // Several references of a kind are comma-separated.
    expect(
      await data(run(`matters-place-${offsite.matter.id}`, { thread: `${THREAD_A}, ${THREAD_B}`, person: remy })),
    ).toMatchObject({
      matter: { links: [{ reference: THREAD_A }, { reference: THREAD_B }, { reference: remy }] },
      moved: [{ kind: 'thread', reference: THREAD_A, from: id }],
    });

    expect(
      await data(
        run('matters-update', {
          id,
          'open-loop': 'Redlines are back; Remy signs Thursday.',
          unlink: `person:${remy},memory:memory/acme.md`,
        }),
      ),
    ).toMatchObject({ open_loop: 'Redlines are back; Remy signs Thursday.', links: [{ kind: 'event' }] });

    expect(await data(run('matters-close', { id, outcome: 'Signed on the 9th.' }))).toMatchObject({
      open: false,
      outcome: 'Signed on the 9th.',
    });
    expect(await data(run('matters-get', { id }))).toMatch(
      /^Matter m-[0-9a-f]{12}, closed .*\nOutcome: Signed on the 9th\.$/msu,
    );
    expect(await data(run('matters-list', {}))).toEqual([
      { id: offsite.matter.id, title: 'Team offsite', open_loop: 'Pick a venue.', strands: [] },
    ]);
    expect(await data(run('matters-list', { closed: true }))).toEqual([
      { id, title: 'Acme renewal', outcome: 'Signed on the 9th.', parent_id: null, closed_at: NOW },
    ]);

    // Rewording a closed matter leaves it closed; a next look reopens it.
    expect(await data(run('matters-update', { id, title: 'Acme renewal 2027' }))).toMatchObject({ open: false });
    expect(await data(run('matters-update', { id, look: '2026-11-02T09:00:00+01:00' }))).toMatchObject({
      title: 'Acme renewal 2027',
      open: true,
      outcome: null,
    });
  });

  it('keeps strands one level deep, and a project open while a strand is', async () => {
    const look = { look: '2026-10-20T09:00' };
    const project = await data<Placed>(
      run('matters-open', { title: 'Office move', 'open-loop': 'Moving by December.', ...look }),
    );
    const lease = await data<Placed>(
      run('matters-open', { title: 'Lease', 'open-loop': 'Sign it.', parent: project.matter.id, ...look }),
    );
    const acme = await data<Placed>(run('matters-open', { title: 'Acme', 'open-loop': 'Renew.', ...look }));

    expect(
      await run('matters-open', { title: 'Keys', 'open-loop': 'Collect.', parent: lease.matter.id, ...look }),
    ).toMatchObject(refused(/one level/));
    expect(await run('matters-update', { id: project.matter.id, parent: acme.matter.id })).toMatchObject(
      refused(/has strands/),
    );
    expect(await run('matters-close', { id: project.matter.id, outcome: 'Moved.' })).toMatchObject(
      refused(/open strands/),
    );
    expect(await data(run('matters-update', { id: lease.matter.id, parent: '' }))).toMatchObject({ parent_id: null });
    expect(await data(run('matters-close', { id: project.matter.id, outcome: 'Moved.' }))).toMatchObject({
      open: false,
    });
  });

  // Each flag reaches the parser, whose every refusal `next-look.test.ts` covers.
  it.each<[string, Record<string, unknown>, RegExp]>([
    ['no next look', {}, /next look.*--look or --look-cron/i],
    ['two kinds of next look', { look: '2026-10-14T09:00', 'look-cron': '0 9 * * 1' }, /either --look or --look-cron/i],
    ['a next look in the past', { look: '2026-10-09T09:00' }, /--look must be in the future/i],
    ['a look that repeats every hour', { 'look-cron': '0 * * * *' }, /more than 4 times a day/i],
  ])('refuses to open a matter with %s', async (_label, look, message) => {
    expect(await run('matters-open', { title: 'Acme renewal', 'open-loop': 'Renew.', ...look })).toMatchObject(
      refused(message),
    );
    expect(await listOpenMatters()).toEqual([]);
  });

  it('checks a next look on update before it changes anything', async () => {
    const acme = await data<Placed>(
      run('matters-open', { title: 'Acme renewal', 'open-loop': 'Renew.', look: '2026-10-14T09:00' }),
    );
    expect(
      await run('matters-update', { id: acme.matter.id, title: 'Acme', 'look-cron': '*/5 * * * *' }),
    ).toMatchObject(refused(/more than 4 times a day/));
    expect(await run('matters-update', { id: acme.matter.id })).toMatchObject(refused(/nothing to change/i));
    expect(await getMatter(acme.matter.id)).toMatchObject({ title: 'Acme renewal' });
  });

  it('places a piece nowhere: no matter opens, and the answer names where it was', async () => {
    expect(await data(run('matters-place', { nowhere: true, thread: THREAD_B }))).toEqual({
      nowhere: [{ kind: 'thread', reference: THREAD_B, from: null }],
    });
    expect(await listOpenMatters()).toEqual([]);
    expect(await data(run('matters-list', { closed: true }))).toEqual([]);

    const acme = await data<Placed>(
      run('matters-open', { title: 'Acme', 'open-loop': 'Renew.', look: '2026-10-14T09:00', thread: THREAD_A }),
    );
    expect(await data(run('matters-place', { nowhere: true, thread: THREAD_A }))).toEqual({
      nowhere: [{ kind: 'thread', reference: THREAD_A, from: acme.matter.id }],
    });
    expect(await getMatter(acme.matter.id)).toMatchObject({ links: [] });
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['a matter and nowhere at once', { id: 'm-000000000000', nowhere: true, thread: THREAD_A }, /--nowhere/],
    ['a person nowhere', { nowhere: true, person: 'p-000000000000' }, /only a thread, event, file or job/i],
    ['no matter and not nowhere', { thread: THREAD_A }, /--id.*or --nowhere.*new matter.*ncl matters open/],
    ['nothing to place', { id: 'm-000000000000' }, /at least one/i],
    ['an unknown flag', { id: 'm-000000000000', link: THREAD_A }, /unknown flag --link/],
  ])('refuses to place %s', async (_label, args, message) => {
    expect(await run('matters-place', args)).toMatchObject(refused(message));
  });

  it('refuses an unlink that is not kind:reference', async () => {
    const acme = await data<Placed>(
      run('matters-open', { title: 'Acme', 'open-loop': 'Renew.', look: '2026-10-14T09:00', person: remy }),
    );
    expect(await run('matters-update', { id: acme.matter.id, unlink: remy })).toMatchObject(refused(/kind:reference/));
    expect(await run('matters-update', { id: acme.matter.id, unlink: `status:${remy}` })).toMatchObject(
      refused(/kind:reference/),
    );
  });

  it('answers with ids and data, and nothing worded for the principal', async () => {
    const words = new Set(['Acme renewal', 'Renew the contract.', 'Signed.', 'Acme', 'Lease', 'Sign it.']);
    const answers: unknown[] = [];
    const keep = async <T>(response: Promise<ResponseFrame>): Promise<T> => {
      const answer = await data<T>(response);
      answers.push(answer);
      return answer;
    };
    const acme = await keep<Placed>(
      run('matters-open', {
        title: 'Acme renewal',
        'open-loop': 'Renew the contract.',
        look: '2026-10-14T09:00',
        thread: THREAD_A,
        event: EVENT,
        person: remy,
        memory: 'memory/acme.md',
      }),
    );
    const lease = await keep<Placed>(
      run('matters-open', {
        title: 'Lease',
        'open-loop': 'Sign it.',
        look: '2026-10-14T09:00',
        parent: acme.matter.id,
      }),
    );
    await keep(run('matters-place', { id: lease.matter.id, thread: THREAD_A }));
    await keep(run('matters-place', { nowhere: true, thread: THREAD_B }));
    await keep(run('matters-update', { id: acme.matter.id, title: 'Acme' }));
    await keep(run('matters-list', {}));
    await keep(run('matters-close', { id: lease.matter.id, outcome: 'Signed.' }));
    await keep(run('matters-list', { closed: true }));

    const strings: string[] = [];
    const collect = (value: unknown): void => {
      if (typeof value === 'string') strings.push(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value !== null && typeof value === 'object') Object.values(value).forEach(collect);
    };
    answers.forEach(collect);
    // Every string is main's own words, a reference main gave, or an id, a kind or a timestamp.
    const shapes = [
      /^m-[0-9a-f]{12}$/,
      /^look-m-[0-9a-f]{12}-[0-9a-f]{4}$/,
      /^(thread|event|file|person|memory)$/,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    ];
    const references = new Set([THREAD_A, THREAD_B, EVENT, remy, 'memory/acme.md']);
    expect(strings.length).toBeGreaterThan(20);
    for (const value of strings) {
      const isData = words.has(value) || references.has(value) || shapes.some((shape) => shape.test(value));
      expect(isData, value).toBe(true);
    }
    expect(answers.every((answer) => typeof answer === 'object' && answer !== null)).toBe(true);
  });

  it('reads a matter through ncl with each link as Google says it is now, and prints that view', async () => {
    const gmail = google.gmail as FakeGmailThreads;
    const calendar = google.calendar as FakeCalendar;
    gmail.put('gmail-thread-a', {
      id: 'a1',
      from: 'Remy Vance <remy@acme.example>',
      at: '2026-10-10T09:30:00.000Z',
      subject: 'Renewal',
      snippet: 'Redlines attached.',
    });
    calendar.put({
      calendarId: 'morgan@example.test',
      id: '7k3q9v1m2n4p6r8s0t2u4v6a8b',
      status: 'confirmed',
      start: { dateTime: '2026-10-14T15:00:00+01:00' },
      end: { dateTime: '2026-10-14T16:00:00+01:00' },
      attendees: [{ email: 'remy@acme.example', responseStatus: 'declined' }],
    });
    const acme = await data<Placed>(
      run('matters-open', {
        title: 'Acme renewal',
        'open-loop': 'Wants it signed by Friday.',
        look: '2026-10-14T09:00',
        thread: THREAD_A,
        event: EVENT,
        person: remy,
      }),
    );
    const id = acme.matter.id;

    const response = await run('matters-get', { id });
    const view = await data<string>(Promise.resolve(response));
    expect(view.replace(/ id="[0-9a-f]{16}"/gu, '')).toBe(
      [
        `Matter ${id}, open: Acme renewal`,
        'Links read Oct 10, 2026, 1:00 PM.',
        'Open loop:',
        'Wants it signed by Friday.',
        'Next look: Oct 14, 2026, 9:00 AM.',
        'Links:',
        `- thread ${THREAD_A}: latest Oct 10, 2026, 10:30 AM, from them: waiting on us`,
        '<<<EXTERNAL_UNTRUSTED_CONTENT>>>',
        'Source: gmail',
        '---',
        'Subject: Renewal',
        'From: Remy Vance <remy@acme.example>',
        'Excerpt: Redlines attached.',
        '<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>',
        `- event ${EVENT}: Oct 14, 2026, 3:00 PM to 4:00 PM; confirmed; declined: remy@acme.example`,
        `- person ${remy}: Remy Vance`,
      ].join('\n'),
    );
    // Both clients print the view as it is.
    expect(response).toMatchObject({ ok: true, human: view });

    // Nothing Google said is kept: the next read says what Google says then.
    gmail.put('gmail-thread-a', {
      id: 'a2',
      from: 'Morgan <morgan@example.test>',
      at: '2026-10-10T11:00:00.000Z',
      sent: true,
    });
    expect(await data(run('matters-get', { id }))).toContain(
      `- thread ${THREAD_A}: latest Oct 10, 2026, 12:00 PM, sent by the assistant: waiting on them`,
    );
    expect(gmail.reads).toEqual(['gmail-thread-a', 'gmail-thread-a']);
  });

  it('refuses every agent but main every verb, even with global CLI scope, and group-scoped agents at the guard', async () => {
    const acme = await data<Placed>(
      run('matters-open', { title: 'Acme', 'open-loop': 'Renew.', look: '2026-10-14T09:00', person: remy }),
    );
    const id = acme.matter.id;
    const attempts: ReadonlyArray<readonly [(typeof VERBS)[number], Record<string, unknown>]> = [
      ['open', { title: 'Lunch with Noel Archer', 'open-loop': 'Find a day.', look: '2026-10-14T09:00' }],
      ['place', { id, thread: THREAD_A }],
      ['update', { id, title: 'Renamed' }],
      ['close', { id, outcome: 'Done.' }],
      ['get', { id }],
      ['look', { id }],
      ['sync', {}],
      ['today', {}],
      ['list', {}],
    ];
    expect(attempts.map(([verb]) => verb)).toEqual([...VERBS]);

    for (const [verb, args] of attempts) {
      expect(await run(`matters-${verb}`, args, agent(other.id)), verb).toMatchObject(refused(/only to main/i));
    }
    expect(await run('matters-place', { nowhere: true, thread: THREAD_A }, agent(other.id))).toMatchObject(
      refused(/only to main/i),
    );
    await updateContainerConfigScalars(other.id, { cli_scope: 'group' });
    for (const [verb, args] of attempts) {
      expect(await run(`matters-${verb}`, args, agent(other.id)), verb).toMatchObject({
        ok: false,
        error: { code: 'forbidden' },
      });
    }
    expect(await getMatter(id)).toEqual(acme.matter);
    expect((await listOpenMatters()).map((matter) => matter.id)).toEqual([id]);
  });

  it('lets the operator use the same verbs as the host caller', async () => {
    const opened = await data<Placed>(
      run('matters-open', { title: 'Acme', 'open-loop': 'Renew.', look: '2026-10-14T09:00' }, HOST),
    );
    expect(await data<Matter[]>(run('matters-list', {}, HOST))).toMatchObject([{ id: opened.matter.id }]);
  });
});

describe('matter planning facts', () => {
  it('keeps planning facts separate from the next check-in and shows them in get and today', async () => {
    const opened = await data<Placed>(
      run('matters-open', {
        title: 'Renew passport',
        'open-loop': 'Morgan will sign the form.',
        look: '2026-10-10T18:00:00+01:00',
        due: '2026-12-31',
        'needs-minutes': 15,
        place: 'Berkeley office',
      }),
    );
    expect(opened.matter).toMatchObject({
      due_at: '2026-12-31',
      needs_minutes: 15,
      place: 'Berkeley office',
      deferrals: 0,
    });
    expect(await getMatter(opened.matter.id)).toMatchObject({
      due_at: '2026-12-31',
      needs_minutes: 15,
      place: 'Berkeley office',
    });
    const read = await data<string>(run('matters-get', { id: opened.matter.id }));
    expect(read).toContain('15 minutes');
    expect(read).toContain('Berkeley office');
    expect(read).toContain('2026-12-31');
    const today = await data<{ data: string[] }>(run('matters-today', {}));
    expect(today.data.join('\n')).toContain('15 minutes');
    expect(today.data.join('\n')).toContain('Berkeley office');
    const changed = await data<Matter>(
      run('matters-update', { id: opened.matter.id, due: '', place: '', 'needs-minutes': 0 }),
    );
    expect(changed).toMatchObject({ due_at: null, place: null, needs_minutes: 0 });
  });

  it('counts repeated check-ins without progress and resets only when the open loop changes', async () => {
    const opened = await data<Placed>(
      run('matters-open', {
        title: 'Registration',
        'open-loop': 'Waiting for Morgan to choose.',
        look: '2026-10-14T09:00:00+01:00',
      }),
    );
    for (const day of [15, 16, 17])
      await data(run('matters-update', { id: opened.matter.id, look: `2026-10-${day}T09:00:00+01:00` }));
    expect(await getMatter(opened.matter.id)).toMatchObject({ deferrals: 3 });
    await data(run('matters-update', { id: opened.matter.id, 'open-loop': 'Waiting for Morgan to choose.' }));
    expect(await getMatter(opened.matter.id)).toMatchObject({ deferrals: 3 });
    await data(
      run('matters-update', {
        id: opened.matter.id,
        'open-loop': 'Morgan chose the course; submit the form.',
        look: '2026-10-18T09:00:00+01:00',
      }),
    );
    expect(await getMatter(opened.matter.id)).toMatchObject({ deferrals: 0 });
  });
});
