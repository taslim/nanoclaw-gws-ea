/**
 * What the host suggests for a new piece in no open matter: the
 * open matters that share its sender, by address or organization through
 * person records, a reply chain with one of their threads, or the event one
 * of their threads booked, each with why. Only a sender Gmail verified
 * counts: mail cannot claim a matter any more than it can claim a level.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import type { SenderVerdict } from '../gws-ea-inbox/authentication.js';
import '../gws-ea-inbox/index.js';
import { createThread, recordThreadMessage } from '../gws-ea-inbox/thread-map.js';
import { recordThreadBooking } from '../gws-ea-meetings/thread-calendar.js';
import { addPerson } from '../gws-ea-people/db.js';
import '../gws-ea-people/index.js';
import { addPrincipalAddress } from '../gws-ea-profile/db.js';
import '../gws-ea-profile/index.js';
import { candidatesFor, renderCandidates, verifiedSender, type NewPiece } from './candidates.js';
import { closeMatter, openMatter, type LinkRef } from './db.js';
import './index.js';

const NOW = '2026-10-10T17:00:00.000Z';
const MORGAN = 'morgan@ellery.example';
const ASSISTANT = 'assistant@ellery.example';
const THREAD_QUOTE = 'mail-8d1f2c34-5b6a-4e7f-9a01-23456789abcd';
const THREAD_NEW = 'mail-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const KICKOFF = `${MORGAN}/kickoff1`;

let juno: string;
let remy: string;
let sam: string;

async function person(name: string, address: string): Promise<string> {
  return (await addPerson({ name, level: 'known', source: 'principal', basis: 'Test.', identity: `email:${address}` }))
    .id;
}

async function open(title: string, links: readonly LinkRef[], parentId?: string): Promise<string> {
  vi.setSystemTime(Date.now() + 1_000);
  const opened = await openMatter({
    title,
    openLoop: 'Keep it moving.',
    links,
    ...(parentId === undefined ? {} : { parentId }),
  });
  return opened.matter.id;
}

function authenticated(address: string): SenderVerdict {
  return { kind: 'authenticated', address };
}

function thread(from: SenderVerdict, answers: readonly string[] = []): NewPiece {
  return { kind: 'thread', reference: THREAD_NEW, from: verifiedSender(from), answers };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  await runMigrations(await initTestDb());
  await getDb().run('UPDATE gws_ea_profile SET assistant_workspace_email = ? WHERE singleton = 1', ASSISTANT);
  await addPrincipalAddress(MORGAN);
  juno = await person('Juno Hale', 'juno@acme.example');
  remy = await person('Remy Vance', 'remy@acme.example');
  sam = await person('Sam Okafor', 'sam.okafor@gmail.com');
  await createThread('g-quote', NOW, THREAD_QUOTE);
  await createThread('g-new', NOW, THREAD_NEW);
});

afterEach(async () => {
  vi.useRealTimers();
  await closeDb();
});

describe('suggesting open matters for a new piece', () => {
  it('suggests the matter that links someone at the same organization as a verified sender', async () => {
    const acme = await open('Acme renewal', [{ kind: 'person', reference: juno }]);
    await open('Offsite', [{ kind: 'person', reference: sam }]);

    expect(await candidatesFor(thread(authenticated('noel@acme.example')))).toEqual([
      { id: acme, title: 'Acme renewal', project: null, reasons: ['same organization'] },
    ]);
  });

  it('names the same person apart from their colleagues, ranking by the strongest reason, then the latest change', async () => {
    const lunch = await open('Lunch with Remy', [{ kind: 'person', reference: remy }]);
    const acme = await open('Acme renewal', [
      { kind: 'person', reference: juno },
      { kind: 'person', reference: remy },
    ]);
    // The newest, but it shares only Remy's organization.
    const offsite = await open('Acme offsite', [{ kind: 'person', reference: juno }]);

    expect(await candidatesFor(thread(authenticated('remy@acme.example')))).toEqual([
      { id: acme, title: 'Acme renewal', project: null, reasons: ['same person', 'same organization'] },
      { id: lunch, title: 'Lunch with Remy', project: null, reasons: ['same person'] },
      { id: offsite, title: 'Acme offsite', project: null, reasons: ['same organization'] },
    ]);
  });

  it('suggests nothing by a free-mail domain, or by the principal’s own organization', async () => {
    await open('Offsite', [{ kind: 'person', reference: sam }]);
    const colleague = await person('Noel Archer', 'noel@ellery.example');
    await open('Board pack', [{ kind: 'person', reference: colleague }]);

    expect(await candidatesFor(thread(authenticated('someone.else@gmail.com')))).toEqual([]);
    expect(await candidatesFor(thread(authenticated('remy.vance@ellery.example')))).toEqual([]);
    // The same person still counts at a free-mail address.
    expect(await candidatesFor(thread(authenticated('sam.okafor@gmail.com')))).toMatchObject([
      { title: 'Offsite', reasons: ['same person'] },
    ]);
  });

  it('suggests nothing for a sender Gmail could not verify, whatever it claims', async () => {
    await recordThreadMessage(
      { threadKey: THREAD_QUOTE, side: 'outside', gmailMessageId: 'g-1', rfcMessageId: '<quote-1@acme.example>' },
      NOW,
    );
    await open('Acme renewal', [
      { kind: 'person', reference: juno },
      { kind: 'thread', reference: THREAD_QUOTE },
    ]);
    const claims: SenderVerdict = {
      kind: 'unauthenticated',
      address: 'juno@acme.example',
      reason: 'no-aligned-pass',
    };

    expect(await candidatesFor(thread(claims, ['<quote-1@acme.example>']))).toEqual([]);
  });

  it('suggests the matter of a thread a verified reply answers', async () => {
    await recordThreadMessage(
      { threadKey: THREAD_QUOTE, side: 'outside', gmailMessageId: 'g-1', rfcMessageId: '<quote-1@acme.example>' },
      NOW,
    );
    const account = await open('Acme account', []);
    const quote = await open('Revised quote', [{ kind: 'thread', reference: THREAD_QUOTE }], account);

    expect(
      await candidatesFor(
        thread(authenticated('accounts@billing.example'), ['<unknown-1@acme.example>', '<quote-1@acme.example>']),
      ),
    ).toEqual([
      { id: quote, title: 'Revised quote', project: { id: account, title: 'Acme account' }, reasons: ['reply chain'] },
    ]);
  });

  it('suggests the matter whose thread booked an invitation', async () => {
    const acme = await open('Acme kickoff', [{ kind: 'thread', reference: THREAD_QUOTE }]);
    await recordThreadBooking({ threadKey: THREAD_QUOTE, calendarId: MORGAN, eventId: 'kickoff1', bookedAt: NOW });

    expect(await candidatesFor({ kind: 'event', reference: KICKOFF, from: 'juno@acme.example' })).toEqual([
      { id: acme, title: 'Acme kickoff', project: null, reasons: ['booking'] },
    ]);
  });

  it('never suggests a closed matter', async () => {
    const acme = await open('Acme renewal', [{ kind: 'person', reference: juno }]);
    await closeMatter({ id: acme, outcome: 'Signed.' });

    expect(await candidatesFor(thread(authenticated('juno@acme.example')))).toEqual([]);
  });
});

describe('who Gmail verified', () => {
  it.each<[string, SenderVerdict, string | undefined]>([
    ['the principal', { kind: 'principal', address: MORGAN }, MORGAN],
    ['an authenticated sender', authenticated('juno@acme.example'), 'juno@acme.example'],
    [
      'an unverified sender',
      { kind: 'unauthenticated', address: 'juno@acme.example', reason: 'no-aligned-pass' },
      undefined,
    ],
    ["Google's calendar notification", { kind: 'calendar-notification' }, undefined],
    [
      "Google's Docs and Drive notification",
      { kind: 'workspace-notification', address: 'comments-noreply@docs.google.com' },
      undefined,
    ],
  ])('names %s', (_label, verdict, address) => {
    expect(verifiedSender(verdict)).toBe(address);
  });
});

describe('the suggestions as main reads them', () => {
  it('gives each with its reason, a strand with its project', () => {
    expect(
      renderCandidates([
        {
          id: 'm-111111111111',
          title: 'Revised quote',
          project: { id: 'm-222222222222', title: 'Acme account' },
          reasons: ['reply chain'],
        },
        {
          id: 'm-333333333333',
          title: 'Lunch with Remy',
          project: null,
          reasons: ['same person', 'same organization'],
        },
      ]),
    ).toBe(
      [
        'Open matters it may belong to:',
        '- m-111111111111: Revised quote, a strand of m-222222222222: Acme account (reply chain)',
        '- m-333333333333: Lunch with Remy (same person, same organization)',
      ].join('\n'),
    );
    expect(renderCandidates([])).toBe(
      'Open matters it may belong to: none shares a person, an organization, a reply chain or a booking with it.',
    );
  });
});
