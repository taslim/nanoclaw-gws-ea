/**
 * The thread map (KTD2): stable `mail-…` keys that exist before Gmail has a
 * thread, each side's messages, the addresses a thread may be written to,
 * and the ledger that sends each email once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import './index.js';
import {
  attachGmailThread,
  createThread,
  deleteSends,
  findSend,
  findThreadFor,
  getThread,
  insertPendingSend,
  recordSent,
  recordThreadAddresses,
  recordThreadMessage,
  threadAddresses,
  threadMessages,
  visibleMessageIds,
  type SendScope,
} from './thread-map.js';

const AT = '2026-10-04T12:00:00.000Z';
const LATER = '2026-10-04T12:05:00.000Z';

beforeEach(async () => {
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
});

describe('resolving a message to its thread', () => {
  it('finds the thread by its Gmail thread, and by a Message-ID it answers once a changed subject split the Gmail thread', async () => {
    const thread = await createThread('g-acme', AT);
    await recordThreadMessage(
      { threadKey: thread.threadKey, side: 'outside', gmailMessageId: 'm-1', rfcMessageId: '<m1@acme.test>' },
      AT,
    );

    expect(await findThreadFor({ gmailThreadId: 'g-acme', inReplyTo: [], references: [] })).toEqual(thread);
    expect(
      await findThreadFor({
        gmailThreadId: 'g-renamed',
        inReplyTo: ['<m1@acme.test>'],
        references: ['<m1@acme.test>'],
      }),
    ).toEqual(thread);
    expect(
      await findThreadFor({
        gmailThreadId: 'g-renamed',
        inReplyTo: [],
        references: ['<m1@acme.test>', '<x@else.test>'],
      }),
    ).toEqual(thread);
    expect(
      await findThreadFor({ gmailThreadId: 'g-unknown', inReplyTo: ['<x@else.test>'], references: [] }),
    ).toBeUndefined();
  });

  it('prefers the message answered over older References', async () => {
    const older = await createThread('g-older', AT);
    const newer = await createThread('g-newer', AT);
    await recordThreadMessage(
      { threadKey: older.threadKey, side: 'outside', gmailMessageId: 'm-old', rfcMessageId: '<old@acme.test>' },
      AT,
    );
    await recordThreadMessage(
      { threadKey: newer.threadKey, side: 'outside', gmailMessageId: 'm-new', rfcMessageId: '<new@acme.test>' },
      AT,
    );

    const found = await findThreadFor({
      gmailThreadId: 'g-split',
      inReplyTo: ['<new@acme.test>'],
      references: ['<old@acme.test>', '<new@acme.test>'],
    });
    expect(found?.threadKey).toBe(newer.threadKey);
    // With no In-Reply-To, References count from the newest back.
    const byReferences = await findThreadFor({
      gmailThreadId: 'g-split',
      inReplyTo: [],
      references: ['<old@acme.test>', '<new@acme.test>'],
    });
    expect(byReferences?.threadKey).toBe(newer.threadKey);
  });

  it('records a message once, however often it is recorded', async () => {
    const thread = await createThread('g-acme', AT);
    const message = {
      threadKey: thread.threadKey,
      side: 'outside',
      gmailMessageId: 'm-1',
      rfcMessageId: '<m1@acme.test>',
    } as const;
    await recordThreadMessage(message, AT);
    await recordThreadMessage(message, LATER);

    expect(await visibleMessageIds(thread.threadKey, 'outside')).toEqual(['<m1@acme.test>']);
  });
});

describe('a thread main hands over', () => {
  it('has a key before Gmail has a thread, and gains its Gmail thread on the first send', async () => {
    const thread = await createThread(null, AT);
    expect(thread.threadKey).toMatch(/^mail-[A-Za-z0-9-]{1,80}$/u);
    expect(thread.gmailThreadId).toBeNull();
    const scope: SendScope = { threadKey: thread.threadKey, side: 'outside' };

    await insertPendingSend({ id: 'send-1', scope, contentHash: 'hash-1', rfcMessageId: '<a1@juno.test>' }, AT);
    // A reply can arrive before the send is recorded: it already resolves.
    expect(
      (await findThreadFor({ gmailThreadId: 'g-first', inReplyTo: ['<a1@juno.test>'], references: [] }))?.threadKey,
    ).toBe(thread.threadKey);

    await recordSent(
      { id: 'send-1', scope },
      { gmailMessageId: 'gm-a1', gmailThreadId: 'g-first', rfcMessageId: '<a1@juno.test>' },
      LATER,
    );

    expect((await getThread(thread.threadKey))?.gmailThreadId).toBe('g-first');
    expect((await findThreadFor({ gmailThreadId: 'g-first', inReplyTo: [], references: [] }))?.threadKey).toBe(
      thread.threadKey,
    );
    expect(await threadMessages(thread.threadKey, 'outside')).toEqual([
      { threadKey: thread.threadKey, side: 'outside', gmailMessageId: 'gm-a1', rfcMessageId: '<a1@juno.test>' },
    ]);
  });

  it('keeps the Gmail thread it has, and never takes one another thread holds', async () => {
    const first = await createThread(null, AT);
    const other = await createThread('g-other', AT);

    expect(await attachGmailThread(first.threadKey, 'g-other')).toBe(false);
    expect(await attachGmailThread(first.threadKey, 'g-first')).toBe(true);
    expect(await attachGmailThread(first.threadKey, 'g-later')).toBe(false);

    expect((await getThread(first.threadKey))?.gmailThreadId).toBe('g-first');
    expect((await getThread(other.threadKey))?.gmailThreadId).toBe('g-other');
  });

  it('started from Chat, replied to with a changed subject, and answered, stays one thread throughout', async () => {
    const thread = await createThread(null, AT);
    const scope: SendScope = { threadKey: thread.threadKey, side: 'outside' };
    const resolve = async (gmailThreadId: string, inReplyTo: string, references: readonly string[]) =>
      (await findThreadFor({ gmailThreadId, inReplyTo: [inReplyTo], references }))?.threadKey;

    // The first email.
    await insertPendingSend({ id: 'send-1', scope, contentHash: 'hash-1', rfcMessageId: '<a1@juno.test>' }, AT);
    await recordSent(
      { id: 'send-1', scope },
      { gmailMessageId: 'gm-a1', gmailThreadId: 'g-1', rfcMessageId: '<a1@juno.test>' },
      AT,
    );
    await deleteSends(scope, 'hash-1', 'sent');

    // Remy answers under a new subject: Gmail starts another thread.
    expect(await resolve('g-2', '<a1@juno.test>', ['<a1@juno.test>'])).toBe(thread.threadKey);
    await recordThreadMessage(
      { threadKey: thread.threadKey, side: 'outside', gmailMessageId: 'gm-t1', rfcMessageId: '<t1@friend.test>' },
      AT,
    );
    expect((await threadMessages(thread.threadKey, 'outside')).map((message) => message.gmailMessageId)).toEqual([
      'gm-a1',
      'gm-t1',
    ]);

    // The assistant answers in Remy's Gmail thread.
    await insertPendingSend({ id: 'send-2', scope, contentHash: 'hash-2', rfcMessageId: '<a2@juno.test>' }, LATER);
    await recordSent(
      { id: 'send-2', scope },
      { gmailMessageId: 'gm-a2', gmailThreadId: 'g-2', rfcMessageId: '<a2@juno.test>' },
      LATER,
    );
    await deleteSends(scope, 'hash-2', 'sent');

    expect(await resolve('g-2', '<a2@juno.test>', ['<a1@juno.test>', '<t1@friend.test>', '<a2@juno.test>'])).toBe(
      thread.threadKey,
    );
    expect(await resolve('g-1', '<a1@juno.test>', [])).toBe(thread.threadKey);
    expect((await getThread(thread.threadKey))?.gmailThreadId).toBe('g-1');
    expect(await visibleMessageIds(thread.threadKey, 'outside')).toEqual([
      '<a1@juno.test>',
      '<t1@friend.test>',
      '<a2@juno.test>',
    ]);
  });
});

describe("each side's messages", () => {
  it("leave out messages the other side's readers cannot see", async () => {
    const { threadKey } = await createThread('g-acme', AT);
    const record = (side: 'principal' | 'outside', id: string) =>
      recordThreadMessage({ threadKey, side, gmailMessageId: id, rfcMessageId: `<${id}@mail.test>` }, AT);
    const ids = async (side: 'principal' | 'outside') =>
      (await threadMessages(threadKey, side)).map((message) => message.gmailMessageId);

    expect(await ids('outside')).toEqual([]);
    await record('outside', 'acme-1');
    // The principal writes to the assistant alone, in Acme's Gmail thread.
    await record('principal', 'note-1');

    expect(await ids('outside')).toEqual(['acme-1']);
    expect(await ids('principal')).toEqual(['note-1']);

    await record('outside', 'acme-2');
    expect(await ids('outside')).toEqual(['acme-1', 'acme-2']);
    expect(await ids('principal')).toEqual(['note-1']);

    expect(await visibleMessageIds(threadKey, 'outside')).toEqual(['<acme-1@mail.test>', '<acme-2@mail.test>']);
    expect(await visibleMessageIds(threadKey, 'principal')).toEqual(['<note-1@mail.test>']);
  });
});

describe("a thread's addresses", () => {
  it('include every address its messages carried, plus those main named, each with how it came', async () => {
    const { threadKey } = await createThread('g-acme', AT);

    await recordThreadAddresses(threadKey, ['Pat@Acme.test', 'jane@acme.test'], 'message', AT);
    await recordThreadAddresses(threadKey, ['pat@acme.test'], 'message', LATER);
    await recordThreadAddresses(threadKey, ['remy@friend.test', 'jane@acme.test'], 'main', LATER);

    expect(await threadAddresses(threadKey)).toEqual([
      { address: 'jane@acme.test', source: 'message' },
      { address: 'pat@acme.test', source: 'message' },
      { address: 'jane@acme.test', source: 'main' },
      { address: 'remy@friend.test', source: 'main' },
    ]);
    await expect(recordThreadAddresses(threadKey, ['not an address'], 'main', AT)).rejects.toThrow(
      'Not an email address',
    );
  });
});

describe('the send ledger', () => {
  it('finds an in-flight send of the same words until delivery records it, then forgets it', async () => {
    const { threadKey } = await createThread('g-acme', AT);
    const scope: SendScope = { threadKey, side: 'outside' };
    expect(await findSend(scope, 'hash-1')).toBeUndefined();

    await insertPendingSend({ id: 'send-1', scope, contentHash: 'hash-1', rfcMessageId: '<a1@juno.test>' }, AT);
    expect(await findSend(scope, 'hash-1')).toEqual({
      id: 'send-1',
      scope,
      contentHash: 'hash-1',
      rfcMessageId: '<a1@juno.test>',
      state: 'pending',
      gmailMessageId: null,
    });

    await recordSent(
      { id: 'send-1', scope },
      { gmailMessageId: 'gm-a1', gmailThreadId: 'g-acme', rfcMessageId: '<a1@juno.test>' },
      LATER,
    );
    expect(await findSend(scope, 'hash-1')).toMatchObject({ state: 'sent', gmailMessageId: 'gm-a1' });

    await deleteSends(scope, 'hash-1', 'pending');
    expect(await findSend(scope, 'hash-1')).toMatchObject({ state: 'sent' });
    await deleteSends(scope, 'hash-1', 'sent');
    expect(await findSend(scope, 'hash-1')).toBeUndefined();
  });

  it("keeps each side's sends apart: the same words to the principal are not the outside reply", async () => {
    const { threadKey } = await createThread('g-acme', AT);
    await insertPendingSend(
      {
        id: 'send-principal',
        scope: { threadKey, side: 'principal' },
        contentHash: 'hash-thanks',
        rfcMessageId: '<p1@juno.test>',
      },
      AT,
    );

    expect(await findSend({ threadKey, side: 'outside' }, 'hash-thanks')).toBeUndefined();
    await recordSent(
      { id: 'send-principal', scope: { threadKey, side: 'principal' } },
      { gmailMessageId: 'gm-p1', gmailThreadId: 'g-acme', rfcMessageId: '<p1@juno.test>' },
      LATER,
    );
    expect(await visibleMessageIds(threadKey, 'principal')).toEqual(['<p1@juno.test>']);
    expect(await visibleMessageIds(threadKey, 'outside')).toEqual([]);
  });
});
