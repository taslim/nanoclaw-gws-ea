import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatch } from '../../cli/dispatch.js';
import type { CallerContext, ResponseFrame } from '../../cli/frame.js';
import { commandGuard, lookup } from '../../cli/registry.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import type { AgentGroup } from '../../types.js';
import '../gws-ea-profile/index.js';
import '../gws-ea-people/index.js';
import { addPerson } from '../gws-ea-people/db.js';
import '../gws-ea-inbox/index.js';
import { createThread } from '../gws-ea-inbox/thread-map.js';
import { getMatter, listOpenMatters, type Matter, type Placed } from './db.js';
import './index.js';

const VERBS = ['open', 'place', 'update', 'close', 'get', 'list'] as const;

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
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  await runMigrations(await initTestDb());
  for (const candidate of [main, other]) {
    await createAgentGroup(candidate);
    await ensureContainerConfig(candidate.id);
    await updateContainerConfigScalars(candidate.id, { cli_scope: 'global' });
  }
  await updateContainerConfigScalars(main.id, { timezone: 'Africa/Lagos' });
  // The canonical main, as the profile module's reconcile records it.
  await getDb().run('UPDATE gws_ea_profile SET main_agent_group_id = ? WHERE singleton = 1', main.id);
  await createThread('gmail-thread-a', NOW, THREAD_A);
  await createThread('gmail-thread-b', NOW, THREAD_B);
  remy = (await addPerson({ name: 'Remy Vance', level: 'known', source: 'principal', basis: 'Acme buyer.' })).id;
});

afterEach(async () => {
  vi.useRealTimers();
  await closeDb();
});

describe('GWS-EA matters ncl resource', () => {
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
    expect(await data(run(`matters-get-${id}`, {}))).toEqual(await getMatter(id));

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
    expect(await data(run('matters-get', { id }))).toMatchObject({ open: false, outcome: 'Signed on the 9th.' });
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

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['no next look', {}, /next look.*--look or --look-cron/i],
    ['two kinds of next look', { look: '2026-10-14T09:00', 'look-cron': '0 9 * * 1' }, /either --look or --look-cron/i],
    ['a next look in the past', { look: '2026-10-09T09:00' }, /--look must be in the future/i],
    ['a next look that is not a time', { look: 'next Tuesday' }, /--look must be a date and time/i],
    ['a date with no time', { look: '2026-10-14' }, /--look must be a date and time/i],
    ['a cron expression that is not one', { 'look-cron': 'every monday' }, /--look-cron/i],
    ['a cron expression with seconds', { 'look-cron': '0 0 9 * * 1' }, /five fields/i],
    ['a look that repeats every hour', { 'look-cron': '0 * * * *' }, /more than 4 times a day/i],
    ['a look that never comes', { 'look-cron': '0 9 30 2 *' }, /--look-cron/i],
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

  it('places a piece nowhere: no matter opens, and the answer names where it was (AE2)', async () => {
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
    ['a person nowhere', { nowhere: true, person: 'p-000000000000' }, /only a thread, event or file/i],
    ['no matter and not nowhere', { thread: THREAD_A }, /--id.*or --nowhere/],
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

  it('answers with ids and data, and nothing worded for the principal (R6)', async () => {
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
    await keep(run('matters-get', { id: acme.matter.id }));
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
