import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import '../gws-ea-profile/index.js';
import '../gws-ea-people/index.js';
import { addPerson } from '../gws-ea-people/db.js';
import '../gws-ea-inbox/index.js';
import { createThread, releaseThread, threadPlacement } from '../gws-ea-inbox/thread-map.js';
import {
  closeMatter,
  getMatter,
  listClosedMatters,
  listOpenMatters,
  openMatter,
  placeInMatter,
  placeNowhere,
  recordLookTask,
  setLinkHandler,
  updateMatter,
  type LinkRef,
  type Matter,
} from './db.js';
import './index.js';

const NOW = '2026-10-10T12:00:00.000Z';
const LATER = '2026-10-10T15:30:00.000Z';
const LATEST = '2026-10-11T08:00:00.000Z';

const THREAD_A = 'mail-8d1f2c34-5b6a-4e7f-9a01-23456789abcd';
const THREAD_B = 'mail-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const EVENT = 'morgan@example.test/7k3q9v1m2n4p6r8s0t2u4v6a8b';
const FILE = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-';

let juno: string;
let remy: string;

function at(time: string): void {
  vi.setSystemTime(new Date(time));
}

function thread(reference: string): LinkRef {
  return { kind: 'thread', reference };
}

function person(reference: string): LinkRef {
  return { kind: 'person', reference };
}

async function open(title: string, links: readonly LinkRef[] = [], parentId?: string): Promise<Matter> {
  return (await openMatter({ title, openLoop: `Keep ${title} moving.`, parentId, links })).matter;
}

async function linkHolders(kind: string, reference: string): Promise<string[]> {
  const rows = await getDb().all<{ readonly matter_id: string }>(
    'SELECT matter_id FROM gws_ea_matter_links WHERE kind = ? AND reference = ? ORDER BY matter_id',
    kind,
    reference,
  );
  return rows.map((row) => row.matter_id);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(NOW);
  await runMigrations(await initTestDb());
  await createThread('gmail-thread-a', NOW, THREAD_A);
  await createThread('gmail-thread-b', NOW, THREAD_B);
  juno = (await addPerson({ name: 'Juno Hale', level: 'active', source: 'principal', basis: 'Works with Morgan.' })).id;
  remy = (await addPerson({ name: 'Remy Vance', level: 'known', source: 'principal', basis: 'Acme buyer.' })).id;
});

afterEach(async () => {
  vi.useRealTimers();
  await closeDb();
});

describe('the matters schema', () => {
  it('holds planning facts separately from state, ownership and history', async () => {
    const columns = async (table: string) =>
      (await getDb().all<{ readonly name: string }>(`PRAGMA table_info(${table})`)).map((column) => column.name);

    expect(await columns('gws_ea_matters')).toEqual([
      'id',
      'title',
      'open_loop',
      'parent_id',
      'outcome',
      'look_task_id',
      // The host's own mark for a failed look, never shown to main: no status.
      'look_failed_at',
      'created_at',
      'updated_at',
      'closed_at',
      'due_at',
      'needs_minutes',
      'place',
      'deferrals',
    ]);
    expect(await columns('gws_ea_matter_links')).toEqual([
      'matter_id',
      'kind',
      'reference',
      'handler',
      'matter_open',
      'linked_at',
      'account',
      'account_at',
    ]);
  });

  it('lets a thread, event or file sit in one open matter at a time, and a person or memory file in any number', async () => {
    const db = getDb();
    const insertMatter = (id: string, closed: boolean) =>
      db.run(
        `INSERT INTO gws_ea_matters (id, title, open_loop, outcome, created_at, updated_at, closed_at)
         VALUES (?, 'Title', 'Loop', ?, ?, ?, ?)`,
        id,
        closed ? 'Done.' : null,
        NOW,
        NOW,
        closed ? NOW : null,
      );
    const insertLink = (matterId: string, kind: string, reference: string, open: boolean) =>
      db.run(
        `INSERT INTO gws_ea_matter_links (matter_id, kind, reference, matter_open, linked_at) VALUES (?, ?, ?, ?, ?)`,
        matterId,
        kind,
        reference,
        open ? 1 : 0,
        NOW,
      );
    await insertMatter('m-000000000001', false);
    await insertMatter('m-000000000002', false);
    await insertMatter('m-000000000003', true);

    for (const [kind, reference] of [
      ['thread', THREAD_A],
      ['event', EVENT],
      ['file', FILE],
    ] as const) {
      await insertLink('m-000000000001', kind, reference, true);
      await expect(insertLink('m-000000000002', kind, reference, true), kind).rejects.toThrow(/UNIQUE/);
      // A closed matter keeps its link as history beside the open one.
      await insertLink('m-000000000003', kind, reference, false);
    }
    for (const [kind, reference] of [
      ['person', juno],
      ['memory', 'memory/people/juno-hale.md'],
    ] as const) {
      await insertLink('m-000000000001', kind, reference, true);
      await insertLink('m-000000000002', kind, reference, true);
    }
    await expect(insertLink('m-000000000001', 'status', 'waiting', true)).rejects.toThrow(/CHECK/);
    // An open matter has no outcome, and a closed one always has one.
    await expect(
      db.run(
        `INSERT INTO gws_ea_matters (id, title, open_loop, outcome, created_at, updated_at) VALUES (?, 'T', 'L', 'Done.', ?, ?)`,
        'm-000000000004',
        NOW,
        NOW,
      ),
    ).rejects.toThrow(/CHECK/);
  });
});

describe('opening and placing', () => {
  it('opens a matter with its title, open loop and links, which get returns', async () => {
    const opened = await openMatter({
      title: '  Acme renewal  ',
      openLoop: 'Morgan wants the renewal signed by Friday.\n  Waiting on Remy for the redlines.  ',
      links: [
        thread(THREAD_A),
        { kind: 'event', reference: EVENT },
        { kind: 'file', reference: FILE },
        person(remy),
        { kind: 'memory', reference: 'memory/acme.md' },
      ],
    });

    expect(opened.moved).toEqual([]);
    expect(opened.matter).toEqual({
      id: expect.stringMatching(/^m-[0-9a-f]{12}$/),
      title: 'Acme renewal',
      open_loop: 'Morgan wants the renewal signed by Friday.\nWaiting on Remy for the redlines.',
      parent_id: null,
      open: true,
      outcome: null,
      look_task_id: null,
      due_at: null,
      needs_minutes: null,
      place: null,
      deferrals: 0,
      links: [
        { kind: 'thread', reference: THREAD_A, handler: null, linked_at: NOW },
        { kind: 'event', reference: EVENT, handler: null, linked_at: NOW },
        { kind: 'file', reference: FILE, handler: null, linked_at: NOW },
        { kind: 'person', reference: remy, handler: null, linked_at: NOW },
        { kind: 'memory', reference: 'memory/acme.md', handler: null, linked_at: NOW },
      ],
      strands: [],
      created_at: NOW,
      updated_at: NOW,
      closed_at: null,
    });
    expect(await getMatter(opened.matter.id)).toEqual(opened.matter);
    expect(await getMatter(` ${opened.matter.id} `)).toEqual(opened.matter);
    expect(await getMatter('m-000000000000')).toBeUndefined();
  });

  it('opens a matter with no links: a request in chat has nothing to link yet', async () => {
    const matter = await open('Book the dentist');
    expect(matter).toMatchObject({ title: 'Book the dentist', links: [], open: true });
  });

  it.each<[string, Parameters<typeof openMatter>[0], RegExp]>([
    ['a title on two lines', { title: 'Acme\nrenewal', openLoop: 'Loop.', links: [] }, /title must be one line/i],
    ['an empty title', { title: '  ', openLoop: 'Loop.', links: [] }, /title must be one line/i],
    ['an empty open loop', { title: 'Acme', openLoop: ' \n ', links: [] }, /open loop/i],
    ['an open loop that is an essay', { title: 'Acme', openLoop: 'x'.repeat(601), links: [] }, /open loop/i],
    ['a control character', { title: 'Acme', openLoop: 'Wait\u0007.', links: [] }, /open loop/i],
    ['a malformed thread key', { title: 'Acme', openLoop: 'L.', links: [thread('thread-1')] }, /thread/i],
    [
      'a thread the inbox does not know',
      { title: 'Acme', openLoop: 'L.', links: [thread('mail-ffffffff-ffff-4fff-8fff-ffffffffffff')] },
      /no email thread/i,
    ],
    ['a person with no record', { title: 'Acme', openLoop: 'L.', links: [person('p-000000000000')] }, /no person/i],
    ['a person by name', { title: 'Acme', openLoop: 'L.', links: [person('Remy Vance')] }, /person/i],
    [
      'an event without its calendar',
      { title: 'Acme', openLoop: 'L.', links: [{ kind: 'event', reference: '7k3q9v1m2n4p6r8s' }] },
      /event/i,
    ],
    [
      'a file by its URL',
      {
        title: 'Acme',
        openLoop: 'L.',
        links: [{ kind: 'file', reference: 'https://docs.google.com/document/d/1AbC/edit' }],
      },
      /file/i,
    ],
    [
      'a memory path outside memory',
      { title: 'Acme', openLoop: 'L.', links: [{ kind: 'memory', reference: 'instructions.prepend.md' }] },
      /memory/i,
    ],
    [
      'a memory path that climbs out',
      { title: 'Acme', openLoop: 'L.', links: [{ kind: 'memory', reference: 'memory/../secrets.md' }] },
      /memory/i,
    ],
  ])('refuses %s and writes nothing', async (_label, input, message) => {
    await expect(openMatter(input)).rejects.toThrow(message);
    expect(await listOpenMatters()).toEqual([]);
    expect(await getDb().get('SELECT COUNT(*) AS count FROM gws_ea_matter_links')).toEqual({ count: 0 });
  });

  it('stores references as ids in one spelling', async () => {
    const matter = await open('Board dinner', [
      { kind: 'event', reference: ' Morgan@Example.test/7k3q9v1m2n4p6r8s0t2u4v6a8b ' },
      { kind: 'memory', reference: '/workspace/agent/memory/people/juno-hale.md' },
      { kind: 'memory', reference: 'memory/people/juno-hale.md' },
      person(` ${juno} `),
      person(juno),
    ]);
    expect(matter.links.map(({ kind, reference }) => ({ kind, reference }))).toEqual([
      { kind: 'event', reference: EVENT },
      { kind: 'person', reference: juno },
      { kind: 'memory', reference: 'memory/people/juno-hale.md' },
    ]);
  });

  it('moves a thread placed elsewhere, with whoever works it, and the old matter no longer lists it', async () => {
    const acme = await open('Acme renewal', [thread(THREAD_A), person(remy)]);
    await getDb().run(
      `UPDATE gws_ea_matter_links SET handler = 'external-email' WHERE matter_id = ? AND kind = 'thread'`,
      acme.id,
    );
    at(LATER);
    const offsite = await open('Team offsite');

    const placed = await placeInMatter(offsite.id, [thread(THREAD_A), person(remy)]);

    expect(placed.moved).toEqual([{ kind: 'thread', reference: THREAD_A, from: acme.id }]);
    expect(placed.matter.links).toEqual([
      { kind: 'thread', reference: THREAD_A, handler: 'external-email', linked_at: LATER },
      { kind: 'person', reference: remy, handler: null, linked_at: LATER },
    ]);
    expect(placed.matter.updated_at).toBe(LATER);
    expect(await getMatter(acme.id)).toMatchObject({
      links: [{ kind: 'person', reference: remy }],
      updated_at: LATER,
    });
    expect(await linkHolders('thread', THREAD_A)).toEqual([offsite.id]);
  });

  it('opening a matter with a piece that sits in another open matter moves it', async () => {
    const acme = await open('Acme renewal', [{ kind: 'file', reference: FILE }]);
    const opened = await openMatter({
      title: 'Acme legal review',
      openLoop: 'Legal reads the contract.',
      links: [{ kind: 'file', reference: FILE }],
    });
    expect(opened.moved).toEqual([{ kind: 'file', reference: FILE, from: acme.id }]);
    expect((await getMatter(acme.id))?.links).toEqual([]);
  });

  it('links a person and a memory file to two matters at once, but never a thread', async () => {
    const memory = { kind: 'memory', reference: 'memory/people/juno-hale.md' } as const;
    const first = await open('Acme renewal', [person(juno), memory, thread(THREAD_A)]);
    const second = await open('Juno birthday', [person(juno), memory, thread(THREAD_A)]);

    expect(await linkHolders('person', juno)).toEqual([first.id, second.id].sort());
    expect(await linkHolders('memory', memory.reference)).toEqual([first.id, second.id].sort());
    expect(await linkHolders('thread', THREAD_A)).toEqual([second.id]);
  });

  it('changes nothing when a piece is placed again in its own matter', async () => {
    const acme = await open('Acme renewal', [thread(THREAD_A), person(remy)]);
    at(LATER);
    const placed = await placeInMatter(acme.id, [thread(THREAD_A), person(remy)]);
    expect(placed.moved).toEqual([]);
    expect(placed.matter).toEqual(acme);
  });

  it('refuses to place pieces in a closed matter or one that does not exist', async () => {
    const acme = await open('Acme renewal');
    await closeMatter({ id: acme.id, outcome: 'Signed.' });
    await expect(placeInMatter(acme.id, [thread(THREAD_A)])).rejects.toThrow(/closed/i);
    await expect(placeInMatter('m-000000000000', [thread(THREAD_A)])).rejects.toThrow(/no matter/i);
    await expect(placeInMatter(acme.id, [])).rejects.toThrow(/at least one/i);
    expect(await linkHolders('thread', THREAD_A)).toEqual([]);
  });

  it('places a piece nowhere: it leaves its open matter, opens none, and a closed matter keeps its history', async () => {
    const closed = await open('Last quarter close', [thread(THREAD_B)]);
    await closeMatter({ id: closed.id, outcome: 'Closed out.' });
    const acme = await open('Acme renewal', [thread(THREAD_A), { kind: 'event', reference: EVENT }]);

    at(LATER);
    expect(await placeNowhere([thread(THREAD_A), thread(THREAD_B), { kind: 'file', reference: FILE }])).toEqual([
      { kind: 'thread', reference: THREAD_A, from: acme.id },
      { kind: 'thread', reference: THREAD_B, from: null },
      { kind: 'file', reference: FILE, from: null },
    ]);

    expect(await getMatter(acme.id)).toMatchObject({
      links: [{ kind: 'event', reference: EVENT }],
      updated_at: LATER,
    });
    expect(await getMatter(closed.id)).toMatchObject({ links: [{ kind: 'thread', reference: THREAD_B }] });
    expect((await listOpenMatters()).map((matter) => matter.id)).toEqual([acme.id]);
  });

  it('places only pieces of work nowhere: a person or a memory file is unlinked from its matter instead', async () => {
    await expect(placeNowhere([person(juno)])).rejects.toThrow(/only a thread, event, file or job/i);
    await expect(placeNowhere([{ kind: 'memory', reference: 'memory/acme.md' }])).rejects.toThrow(
      /only a thread, event, file or job/i,
    );
    await expect(placeNowhere([])).rejects.toThrow(/at least one/i);
  });
});

describe("each thread's placement", () => {
  it('keeps a thread placed while an open matter holds it, nowhere once taken out or its matter closes, and holds its mail again once its matter closes', async () => {
    expect(await threadPlacement(THREAD_A)).toEqual({ placement: 'unplaced', released: false });
    const acme = await open('Acme renewal', [thread(THREAD_A)]);
    expect(await threadPlacement(THREAD_A)).toEqual({ placement: 'matter', released: false });
    // main hands it over, then moves it to another matter.
    await releaseThread(THREAD_A);
    const lisbon = await open('Lisbon offsite');
    await placeInMatter(lisbon.id, [thread(THREAD_A)]);
    expect(await threadPlacement(THREAD_A)).toEqual({ placement: 'matter', released: true });

    await placeNowhere([thread(THREAD_A)]);
    expect(await threadPlacement(THREAD_A)).toEqual({ placement: 'nowhere', released: true });
    await placeInMatter(acme.id, [thread(THREAD_A)]);
    await updateMatter({ id: acme.id, unlink: [thread(THREAD_A)] });
    expect(await threadPlacement(THREAD_A)).toEqual({ placement: 'nowhere', released: true });

    await placeInMatter(acme.id, [thread(THREAD_A)]);
    await closeMatter({ id: acme.id, outcome: 'Signed.' });
    expect(await threadPlacement(THREAD_A)).toEqual({ placement: 'nowhere', released: false });
    await updateMatter({ id: acme.id, reopen: true });
    expect(await threadPlacement(THREAD_A)).toEqual({ placement: 'matter', released: false });
    expect(await threadPlacement(THREAD_B)).toEqual({ placement: 'unplaced', released: false });
  });

  it('names external-email as working a thread main handed over as it joins a matter, and lets the bridge name it for one already there, never in a closed one', async () => {
    await placeNowhere([thread(THREAD_A)]);
    await releaseThread(THREAD_A);
    const acme = await open('Acme renewal', [thread(THREAD_A), thread(THREAD_B), person(juno)]);
    expect((await getMatter(acme.id))?.links.map((link) => [link.reference, link.handler])).toEqual([
      [THREAD_A, 'external-email'],
      [THREAD_B, null],
      [juno, null],
    ]);
    const earlier = 'mail-5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9';
    await createThread('gmail-thread-c', NOW, earlier);
    const lunch = await open('Lunch with Remy', [thread(earlier)]);
    await closeMatter({ id: lunch.id, outcome: 'Had lunch.' });

    await setLinkHandler(thread(THREAD_B), 'external-email');
    // In no open matter: the closed matter's link is history, and stays as it was.
    await setLinkHandler(thread(earlier), 'external-email');
    expect((await getMatter(acme.id))?.links.map((link) => link.handler)).toEqual([
      'external-email',
      'external-email',
      null,
    ]);
    expect((await getMatter(lunch.id))?.links.map((link) => link.handler)).toEqual([null]);
  });
});

describe('updating, closing and reopening', () => {
  it('closes a matter with its outcome; it stays readable, and a next look reopens it', async () => {
    const acme = await open('Acme renewal', [thread(THREAD_A), person(remy)]);

    at(LATER);
    const closed = await closeMatter({ id: acme.id, outcome: ' Signed on the 9th; memory has the terms. ' });
    expect(closed).toEqual({
      ...acme,
      open: false,
      outcome: 'Signed on the 9th; memory has the terms.',
      updated_at: LATER,
      closed_at: LATER,
    });
    expect(await getMatter(acme.id)).toEqual(closed);
    expect(await linkHolders('thread', THREAD_A)).toEqual([acme.id]);

    at(LATEST);
    const reopened = await updateMatter({ id: acme.id, reopen: true });
    expect(reopened).toEqual({ ...acme, updated_at: LATEST });
    // Its thread is in an open matter again, so it cannot be in a second one.
    const other = await open('Acme follow-up', [thread(THREAD_A)]);
    expect((await getMatter(acme.id))?.links.map((link) => link.kind)).toEqual(['person']);
    expect((await getMatter(other.id))?.links.map((link) => link.kind)).toEqual(['thread']);
  });

  it('rewrites a closed matter’s title, open loop and outcome without reopening it', async () => {
    const acme = await open('Acme renewal');
    await closeMatter({ id: acme.id, outcome: 'Signed.' });
    at(LATER);
    expect(
      await updateMatter({ id: acme.id, title: 'Acme renewal 2027', openLoop: 'Nothing left.', outcome: 'Signed.' }),
    ).toMatchObject({
      title: 'Acme renewal 2027',
      open_loop: 'Nothing left.',
      outcome: 'Signed.',
      open: false,
      closed_at: NOW,
      updated_at: LATER,
    });
  });

  it('rewrites an open matter’s title and open loop, and unlinks what no longer belongs', async () => {
    const acme = await open('Acme renewal', [thread(THREAD_A), person(remy), person(juno)]);
    at(LATER);
    const updated = await updateMatter({
      id: acme.id,
      title: 'Acme renewal, signed copy',
      openLoop: 'Countersigned copy to file.',
      unlink: [person(juno), thread(THREAD_A)],
    });
    expect(updated).toMatchObject({
      title: 'Acme renewal, signed copy',
      open_loop: 'Countersigned copy to file.',
      links: [{ kind: 'person', reference: remy }],
      updated_at: LATER,
    });
    await expect(updateMatter({ id: acme.id, unlink: [person(juno)] })).rejects.toThrow(/does not link/i);
  });

  it('keeps an open matter without an outcome, and closes a matter only once', async () => {
    const acme = await open('Acme renewal');
    await expect(updateMatter({ id: acme.id, outcome: 'Signed.' })).rejects.toThrow(/open matter has no outcome/i);
    await expect(closeMatter({ id: acme.id, outcome: '' })).rejects.toThrow(/outcome must be one line/i);
    await closeMatter({ id: acme.id, outcome: 'Signed.' });
    await expect(closeMatter({ id: acme.id, outcome: 'Signed again.' })).rejects.toThrow(/already closed/i);
    await expect(updateMatter({ id: acme.id, reopen: true, outcome: 'Signed.' })).rejects.toThrow(
      /open matter has no outcome/i,
    );
    expect(await getMatter(acme.id)).toMatchObject({ open: false, outcome: 'Signed.' });
  });

  it('changes a closed matter’s links and project only when it reopens', async () => {
    const project = await open('Office move');
    const acme = await open('Acme renewal', [person(remy)]);
    await closeMatter({ id: acme.id, outcome: 'Signed.' });
    await expect(updateMatter({ id: acme.id, unlink: [person(remy)] })).rejects.toThrow(/closed/i);
    await expect(updateMatter({ id: acme.id, parentId: project.id })).rejects.toThrow(/closed/i);
    expect(await updateMatter({ id: acme.id, reopen: true, parentId: project.id })).toMatchObject({
      open: true,
      parent_id: project.id,
    });
  });

  it('refuses to reopen a matter, naming the other one, when one of its pieces now sits in another open matter', async () => {
    const acme = await open('Acme renewal', [thread(THREAD_A), { kind: 'event', reference: EVENT }]);
    await closeMatter({ id: acme.id, outcome: 'Signed.' });
    const followUp = await open('Acme follow-up', [{ kind: 'event', reference: EVENT }]);

    await expect(updateMatter({ id: acme.id, reopen: true })).rejects.toThrow(
      new RegExp(`event ${EVENT} now sits in open matter ${followUp.id}`),
    );
    expect(await getMatter(acme.id)).toMatchObject({ open: false, outcome: 'Signed.' });
    expect(await linkHolders('thread', THREAD_A)).toEqual([acme.id]);
    // Its thread is still free to be placed: the closed matter's link is history.
    await placeInMatter(followUp.id, [thread(THREAD_A)]);
  });

  it('reopens a matter that lets go of the pieces now in another open matter in the same change', async () => {
    const acme = await open('Acme renewal', [{ kind: 'event', reference: EVENT }, person(remy)]);
    await closeMatter({ id: acme.id, outcome: 'Signed.' });
    const followUp = await open('Acme follow-up', [{ kind: 'event', reference: EVENT }]);

    expect(
      await updateMatter({ id: acme.id, reopen: true, unlink: [{ kind: 'event', reference: EVENT }] }),
    ).toMatchObject({ open: true, links: [{ kind: 'person', reference: remy }] });
    expect(await linkHolders('event', EVENT)).toEqual([followUp.id]);
  });

  it('refuses an update that changes nothing, and a matter that does not exist', async () => {
    const acme = await open('Acme renewal');
    await expect(updateMatter({ id: acme.id })).rejects.toThrow(/nothing to change/i);
    await expect(updateMatter({ id: 'm-000000000000', title: 'x' })).rejects.toThrow(/no matter/i);
    await expect(closeMatter({ id: 'm-000000000000', outcome: 'x' })).rejects.toThrow(/no matter/i);
    // Setting a next look on an open matter leaves the store as it is.
    expect(await updateMatter({ id: acme.id, reopen: true })).toEqual(acme);
  });
});

describe('strands', () => {
  it('opens strands one level under a project and lists them there', async () => {
    const project = await open('Office move', [{ kind: 'file', reference: FILE }]);
    at(LATER);
    const lease = await open('Lease', [thread(THREAD_A)], project.id);
    at(LATEST);
    const movers = await open('Movers', [], project.id);

    expect(lease.parent_id).toBe(project.id);
    expect((await getMatter(project.id))?.strands).toEqual([
      { id: lease.id, title: 'Lease', open: true },
      { id: movers.id, title: 'Movers', open: true },
    ]);
    expect(await listOpenMatters()).toEqual([
      {
        id: project.id,
        title: 'Office move',
        open_loop: 'Keep Office move moving.',
        strands: [
          { id: lease.id, title: 'Lease', open_loop: 'Keep Lease moving.' },
          { id: movers.id, title: 'Movers', open_loop: 'Keep Movers moving.' },
        ],
      },
    ]);
  });

  it('refuses a strand as a parent, and a project as a strand', async () => {
    const project = await open('Office move');
    const lease = await open('Lease', [], project.id);
    const acme = await open('Acme renewal');

    await expect(open('Lease signing', [], lease.id)).rejects.toThrow(/strand.*one level/i);
    await expect(updateMatter({ id: acme.id, parentId: lease.id })).rejects.toThrow(/strand.*one level/i);
    await expect(updateMatter({ id: project.id, parentId: acme.id })).rejects.toThrow(/has strands/i);
    await expect(updateMatter({ id: acme.id, parentId: acme.id })).rejects.toThrow(/own project/i);
    expect(await getMatter(acme.id)).toMatchObject({ parent_id: null });
    expect(await getMatter(project.id)).toMatchObject({ parent_id: null });
  });

  it('refuses a project that is closed or does not exist', async () => {
    const project = await open('Office move');
    await closeMatter({ id: project.id, outcome: 'Moved in.' });
    await expect(open('Lease', [], project.id)).rejects.toThrow(/closed/i);
    await expect(open('Lease', [], 'm-000000000000')).rejects.toThrow(/no matter/i);
    expect(await listOpenMatters()).toEqual([]);
  });

  it('makes a strand a matter of its own when its project is cleared', async () => {
    const project = await open('Office move');
    const lease = await open('Lease', [], project.id);
    expect(await updateMatter({ id: lease.id, parentId: null })).toMatchObject({ parent_id: null });
    expect((await getMatter(project.id))?.strands).toEqual([]);
  });

  it('refuses to close a project while a strand is open, and closes it once the strand has', async () => {
    const project = await open('Office move');
    const lease = await open('Lease', [], project.id);

    await expect(closeMatter({ id: project.id, outcome: 'Moved in.' })).rejects.toThrow(
      new RegExp(`open strand.*${lease.id}`),
    );
    await closeMatter({ id: lease.id, outcome: 'Lease signed.' });
    expect(await closeMatter({ id: project.id, outcome: 'Moved in.' })).toMatchObject({
      open: false,
      strands: [{ id: lease.id, title: 'Lease', open: false }],
    });
    // A strand comes back only under an open project.
    await expect(updateMatter({ id: lease.id, reopen: true })).rejects.toThrow(/project.*closed/i);
  });
});

describe('lists', () => {
  it('lists open matters most recently changed first, and closed matters most recently closed first', async () => {
    const acme = await open('Acme renewal');
    at(LATER);
    const offsite = await open('Team offsite');
    const dentist = await open('Book the dentist');
    await closeMatter({ id: dentist.id, outcome: 'Booked for the 14th.' });
    at(LATEST);
    await updateMatter({ id: acme.id, openLoop: 'Redlines back from Remy.' });
    const lunch = await open('Lunch with Noel');
    await closeMatter({ id: lunch.id, outcome: 'Moved to next month.' });

    expect((await listOpenMatters()).map((matter) => matter.title)).toEqual(['Acme renewal', 'Team offsite']);
    expect(await listOpenMatters()).toContainEqual({
      id: offsite.id,
      title: 'Team offsite',
      open_loop: 'Keep Team offsite moving.',
      strands: [],
    });
    expect(await listClosedMatters()).toEqual([
      { id: lunch.id, title: 'Lunch with Noel', outcome: 'Moved to next month.', parent_id: null, closed_at: LATEST },
      { id: dentist.id, title: 'Book the dentist', outcome: 'Booked for the 14th.', parent_id: null, closed_at: LATER },
    ]);
  });
});

describe("the next look's task", () => {
  it('records the task that is a matter’s next look, and clears it, as the clock and not a change of the matter', async () => {
    const acme = await open('Acme renewal');
    at(LATER);
    await recordLookTask(acme.id, 'look-m-1a2b-3c4d');
    expect(await getMatter(acme.id)).toMatchObject({ look_task_id: 'look-m-1a2b-3c4d', updated_at: NOW });
    await recordLookTask(acme.id, null);
    expect(await getMatter(acme.id)).toMatchObject({ look_task_id: null });
    await expect(recordLookTask('m-000000000000', 'look-x')).rejects.toThrow(/no matter/i);
  });
});
