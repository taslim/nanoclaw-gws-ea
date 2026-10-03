/**
 * Nothing private reaches anyone but the principal (R24, R37, KTD7).
 *
 * Drives the real delivery path, the real ncl dispatcher, and the real
 * approvals flow against a real central DB and real session DBs. Only the
 * container runner and the wake are mocked.
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-gws-ea-privacy',
    GROUPS_DIR: '/tmp/nanoclaw-test-gws-ea-privacy/groups',
  };
});

vi.mock('../../container-runner.js', () => ({
  getContainerStartedAtMs: vi.fn(() => Date.now()),
  isContainerRunning: vi.fn(() => false),
  killContainer: vi.fn(),
  wakeContainer: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn().mockResolvedValue(true) }));

import { dispatch } from '../../cli/dispatch.js';
import type { CallerContext } from '../../cli/frame.js';
import { lookup } from '../../cli/registry.js';
import { getDb } from '../../db/connection.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
import {
  deliverSessionMessages,
  OutboundRefusedError,
  setDeliveryAdapter,
  type ChannelDeliveryAdapter,
} from '../../delivery.js';
import { inboundDbPath, outboundDbPath } from '../../mailbox/sqlite/paths.js';
import { resolveSession } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { handleApprovalsResponse } from '../approvals/response-handler.js';
import { addPrincipalAddress, bindVerifiedPrincipalUser } from '../gws-ea-profile/db.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { upsertUser } from '../permissions/db/users.js';
import '../gws-ea-profile/index.js';
import {
  audienceForAddresses,
  checkOutbound,
  listPrivateValues,
  MAX_REFUSALS_PER_THREAD,
  registerRecipientResolver,
  THREAD_STOPPED_SIGNAL,
} from './index.js';

const TEST_DIR = '/tmp/nanoclaw-test-gws-ea-privacy';
const PRINCIPAL = 'gchat:users/principal';
const DM = { channelType: 'gchat', platformId: 'gchat:spaces/dm' } as const;
const THREAD = { channelType: 'email', platformId: 'email:thread-1' } as const;
const OTHER_THREAD = { channelType: 'email', platformId: 'email:thread-2' } as const;
const HOME = '123 Main Street, Springfield';
const HOME_LABEL = 'Home';

interface Sent {
  channelType: string;
  platformId: string;
  threadId: string | null;
  kind: string;
  content: string;
}

let sent: Sent[];
let guarded: ChannelDeliveryAdapter;
let main: Session;
let external: Session;
let externalOther: Session;

function now(): string {
  return new Date().toISOString();
}

/** The channel: records every send that passed the guards; throws for the ones `fails` picks. */
function channel(fails: (send: Sent) => boolean = () => false): void {
  guarded = setDeliveryAdapter({
    async deliver(channelType, platformId, threadId, kind, content) {
      const send = { channelType, platformId, threadId, kind, content };
      if (fails(send)) throw new Error('channel unavailable');
      sent.push(send);
      return 'platform-message';
    },
  });
}

function texts(): string[] {
  return sent.map((send) => (JSON.parse(send.content) as { text?: string }).text ?? '');
}

function agent(session: Session): CallerContext {
  return {
    caller: 'agent',
    sessionId: session.id,
    agentGroupId: session.agent_group_id,
    messagingGroupId: session.messaging_group_id ?? '',
  };
}

const HOST: CallerContext = { caller: 'host' };

function run(command: string, args: Record<string, unknown>, ctx: CallerContext = HOST) {
  return dispatch({ id: command, command, args }, ctx);
}

/** A row the agent queued for delivery. */
function queue(
  session: Session,
  row: {
    id: string;
    content: Record<string, unknown>;
    route: { channelType: string; platformId: string };
    threadId?: string | null;
  },
): void {
  const db = new Database(outboundDbPath(session.agent_group_id, session.id));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, content)
     VALUES (?, ?, 'chat', ?, ?, ?, ?)`,
  ).run(row.id, now(), row.route.platformId, row.route.channelType, row.threadId ?? null, JSON.stringify(row.content));
  db.close();
}

interface InboundRow {
  channel_type: string | null;
  platform_id: string | null;
  content: string;
}

function inbound(session: Session): InboundRow[] {
  const path = inboundDbPath(session.agent_group_id, session.id);
  if (!fs.existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  const rows = db
    .prepare('SELECT channel_type, platform_id, content FROM messages_in ORDER BY seq')
    .all() as InboundRow[];
  db.close();
  return rows;
}

/** What the host told the agent as a system note. */
function notes(session: Session): string[] {
  return inbound(session)
    .map((row) => JSON.parse(row.content) as { sender?: string; text?: string })
    .filter((content) => content.sender === 'system')
    .map((content) => content.text ?? '');
}

async function pendingApprovals(): Promise<PendingApproval[]> {
  return getDb().all<PendingApproval>('SELECT * FROM pending_approvals ORDER BY created_at');
}

async function addHome(): Promise<string> {
  const response = await run('private-values-add', { label: HOME_LABEL, kind: 'address', value: HOME }, agent(main));
  if (!response.ok) throw new Error(response.error.message);
  return (response.data as { id: string }).id;
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  sent = [];
  channel();

  for (const [id, name] of [
    ['ag-main', 'main'],
    ['ag-external', 'external-email'],
    ['ag-other', 'research'],
  ] as const) {
    await createAgentGroup({ id, name, folder: name, agent_provider: null, created_at: now() });
    await ensureContainerConfig(id);
    await updateContainerConfigScalars(id, { cli_scope: 'global' });
  }
  for (const [id, route, isGroup] of [
    ['mg-dm', DM, 0],
    ['mg-email', THREAD, 0],
    ['mg-email-2', OTHER_THREAD, 0],
  ] as const) {
    await createMessagingGroup({
      id,
      channel_type: route.channelType,
      platform_id: route.platformId,
      name: id,
      is_group: isGroup,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
  }
  await upsertUser({ id: PRINCIPAL, kind: 'gchat', display_name: 'Pat', created_at: now() });
  await bindVerifiedPrincipalUser(PRINCIPAL, now());
  await upsertUserDm({ user_id: PRINCIPAL, channel_type: 'gchat', messaging_group_id: 'mg-dm', resolved_at: now() });
  await getDb().run('UPDATE gws_ea_profile SET main_agent_group_id = ? WHERE singleton = 1', 'ag-main');
  await addPrincipalAddress('pat@example.com');

  main = (await resolveSession('ag-main', 'mg-dm', null, 'agent-shared')).session;
  external = (await resolveSession('ag-external', 'mg-email', null, 'shared')).session;
  externalOther = (await resolveSession('ag-external', 'mg-email-2', null, 'shared')).session;
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('private values in ncl', () => {
  it('registers no generic verb, which would skip the main-only check and the removal card', () => {
    for (const generic of ['get', 'create', 'update', 'delete']) {
      expect(lookup(`private-values-${generic}`), generic).toBeUndefined();
    }
  });

  it('lets main add and list values, and treats another spelling of one as held', async () => {
    const id = await addHome();
    const again = await run(
      'private-values-add',
      { label: 'Home again', kind: 'address', value: '123 MAIN ST., springfield' },
      agent(main),
    );
    expect(again).toMatchObject({ ok: true, data: { id, added: false, label: HOME_LABEL } });

    expect(await run('private-values-list', {}, agent(main))).toMatchObject({
      ok: true,
      data: [{ id, label: HOME_LABEL, kind: 'address', value: HOME }],
    });
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['an unknown kind', { label: 'Car', kind: 'plate', value: 'ABC 1234' }, /--kind must be one of/],
    ['a value too short to check', { label: 'Condition', kind: 'other', value: 'IBS' }, /at least 4 letters or digits/],
    ['a phone number without enough digits', { label: 'Phone', kind: 'phone', value: '555-01' }, /7 to 15 digits/],
    ['an email value that is no address', { label: 'Mail', kind: 'email', value: 'pat at home' }, /email address/],
    ['a label over one line', { label: 'Home\nAddress', kind: 'address', value: HOME }, /Label must be one line/],
  ])('refuses %s', async (_label, args, message) => {
    expect(await run('private-values-add', args, agent(main))).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(message) },
    });
    expect(await listPrivateValues()).toEqual([]);
  });

  it('refuses every agent but main, even one with global CLI scope', async () => {
    await addHome();
    for (const [command, args] of [
      ['private-values-list', {}],
      ['private-values-add', { label: 'Phone', kind: 'phone', value: '+1 415 555 0134' }],
      ['private-values-remove', { id: 'pv-anything' }],
    ] as const) {
      expect(await run(command, args, agent(external)), command).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/only to main/i) },
      });
    }
    await updateContainerConfigScalars('ag-other', { cli_scope: 'group' });
    const research = (await resolveSession('ag-other', 'mg-dm', null, 'shared')).session;
    expect(await run('private-values-list', {}, agent(research))).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(await listPrivateValues()).toHaveLength(1);
  });
});

describe('removing a private value', () => {
  it("holds main's removal for the principal's card, and removes the value once the principal approves", async () => {
    const id = await addHome();

    const response = await run('private-values-remove', { id }, agent(main));
    expect(response).toMatchObject({ ok: true, data: { id, status: 'awaiting-principal' } });
    expect(await listPrivateValues()).toHaveLength(1);

    const [approval] = await pendingApprovals();
    expect(approval).toMatchObject({ action: 'private_value_remove', approver_user_id: PRINCIPAL });
    const [card] = sent;
    expect(card).toMatchObject({ ...DM, threadId: null });
    expect(JSON.parse(card.content)).toMatchObject({
      type: 'ask_question',
      questionId: approval.approval_id,
      question: expect.stringContaining(`"${HOME_LABEL}"`),
    });

    // Nobody but the named principal can decide it.
    await handleApprovalsResponse({
      questionId: approval.approval_id,
      value: 'approve',
      userId: 'gchat:users/someone-else',
      channelType: DM.channelType,
      platformId: DM.platformId,
      threadId: null,
    });
    expect(await listPrivateValues()).toHaveLength(1);

    await handleApprovalsResponse({
      questionId: approval.approval_id,
      value: 'approve',
      userId: PRINCIPAL,
      channelType: DM.channelType,
      platformId: DM.platformId,
      threadId: null,
    });
    expect(await listPrivateValues()).toEqual([]);
    expect(await pendingApprovals()).toEqual([]);
    expect(notes(main).at(-1)).toMatch(/removed/i);
  });

  it('keeps the value when the principal rejects the card', async () => {
    const id = await addHome();
    await run('private-values-remove', { id }, agent(main));
    const [approval] = await pendingApprovals();

    await handleApprovalsResponse({
      questionId: approval.approval_id,
      value: 'reject',
      userId: PRINCIPAL,
      channelType: DM.channelType,
      platformId: DM.platformId,
      threadId: null,
    });
    expect(await listPrivateValues()).toHaveLength(1);
    expect(notes(main).at(-1)).toMatch(/rejected/i);
  });

  it('keeps the value when the clicker is no longer the verified principal, though another one is', async () => {
    const id = await addHome();
    await run('private-values-remove', { id }, agent(main));
    const [approval] = await pendingApprovals();
    const successor = 'gchat:users/principal-later';
    await upsertUser({ id: successor, kind: 'gchat', display_name: 'Pat', created_at: now() });
    await bindVerifiedPrincipalUser(successor, now());
    await upsertUserDm({ user_id: successor, channel_type: 'gchat', messaging_group_id: 'mg-dm', resolved_at: now() });
    await getDb().run('DELETE FROM gws_ea_principal_users WHERE user_id = ?', PRINCIPAL);

    await handleApprovalsResponse({
      questionId: approval.approval_id,
      value: 'approve',
      userId: PRINCIPAL,
      channelType: DM.channelType,
      platformId: DM.platformId,
      threadId: null,
    });
    expect(await listPrivateValues()).toHaveLength(1);
    expect(notes(main).at(-1)).toMatch(/only the principal can confirm/);
  });

  it('lets the operator remove a value directly, and refuses an unknown one', async () => {
    const id = await addHome();
    expect(await run('private-values-remove', { id })).toMatchObject({ ok: true, data: { removed: { id } } });
    expect(await listPrivateValues()).toEqual([]);
    expect(await run('private-values-remove', { id }, agent(main))).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/No private value/) },
    });
    expect(await pendingApprovals()).toEqual([]);
  });
});

describe('the audience check on delivery', () => {
  it('refuses a reply that quotes the home address to a counterpart, and sends the rewritten one (AE6)', async () => {
    await addHome();
    queue(external, {
      id: 'reply-1',
      route: THREAD,
      content: { text: 'Happy to meet at 123 Main St, Springfield on Thursday.' },
    });
    await deliverSessionMessages(external);

    expect(sent).toEqual([]);
    const [refusal] = notes(external);
    expect(refusal).toMatch(/^Your message was not sent: .*address/);
    expect(refusal).not.toMatch(/main|springfield|home/i);

    queue(external, {
      id: 'reply-2',
      route: THREAD,
      content: { text: 'Thursday works. Could we meet at a cafe near you instead?' },
    });
    await deliverSessionMessages(external);
    expect(texts()).toEqual(['Thursday works. Could we meet at a cafe near you instead?']);
  });

  it("sends the same address to the principal's own direct message", async () => {
    await addHome();
    queue(main, { id: 'dm-1', route: DM, content: { text: 'They asked to meet at 123 Main St, Springfield.' } });
    await deliverSessionMessages(main);
    expect(texts()).toEqual(['They asked to meet at 123 Main St, Springfield.']);
  });

  it('refuses a value split across two messages in one thread, but not across two threads', async () => {
    await addHome();
    queue(external, { id: 'part-1', route: THREAD, content: { text: 'We could meet at 123' } });
    queue(external, { id: 'part-2', route: THREAD, content: { text: 'Main Street if that suits.' } });
    await deliverSessionMessages(external);
    expect(texts()).toEqual(['We could meet at 123']);
    expect(notes(external)).toEqual([expect.stringMatching(/^Your message was not sent: .*address/)]);

    queue(externalOther, { id: 'other-1', route: OTHER_THREAD, content: { text: 'Main Street if that suits.' } });
    await deliverSessionMessages(externalOther);
    expect(texts()).toEqual(['We could meet at 123', 'Main Street if that suits.']);
  });

  it('refuses a private value in a subject line', async () => {
    await addHome();
    queue(external, {
      id: 'subject-1',
      route: THREAD,
      content: { subject: 'Meeting at 123 Main St', text: 'See you.' },
    });
    await deliverSessionMessages(external);
    expect(sent).toEqual([]);
  });

  it('stops a thread after repeated refusals, signals main once, and leaves other threads alone', async () => {
    await addHome();
    for (let attempt = 1; attempt <= MAX_REFUSALS_PER_THREAD; attempt++) {
      queue(external, { id: `leak-${attempt}`, route: THREAD, content: { text: `Try ${attempt}: 123 Main St` } });
      await deliverSessionMessages(external);
    }
    expect(sent).toEqual([]);
    const refusals = notes(external);
    expect(refusals).toHaveLength(MAX_REFUSALS_PER_THREAD);
    expect(refusals.at(-1)).toMatch(/stopped/);

    const signals = inbound(main).filter(
      (row) => (JSON.parse(row.content) as { signal?: { type?: string } }).signal?.type === THREAD_STOPPED_SIGNAL,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ channel_type: DM.channelType, platform_id: DM.platformId });
    const signal = JSON.parse(signals[0].content) as { text: string; signal: Record<string, unknown> };
    expect(signal.signal).toMatchObject({ kind: 'address', refusals: MAX_REFUSALS_PER_THREAD });
    expect(signal.text).not.toMatch(/main st|springfield|home/i);

    queue(external, { id: 'clean-after-stop', route: THREAD, content: { text: 'Is Thursday still good?' } });
    await deliverSessionMessages(external);
    expect(sent).toEqual([]);
    expect(notes(external).at(-1)).toMatch(/^Your message was not sent: this conversation is stopped/);
    expect(inbound(main).filter((row) => row.content.includes(THREAD_STOPPED_SIGNAL))).toHaveLength(1);

    queue(externalOther, { id: 'elsewhere', route: OTHER_THREAD, content: { text: 'Is Thursday still good?' } });
    await deliverSessionMessages(externalOther);
    expect(texts()).toEqual(['Is Thursday still good?']);
  });

  it('judges a retried send without its own earlier attempt', async () => {
    await addHome();
    let failures = 1;
    channel(() => failures-- > 0);
    // Alone it holds no value; read twice in a row it would spell "123 Main St".
    queue(external, { id: 'retry-1', route: THREAD, content: { text: 'St. Patrick day works; I am near 123 Main' } });
    await deliverSessionMessages(external);
    expect(sent).toEqual([]);
    await deliverSessionMessages(external);
    expect(texts()).toEqual(['St. Patrick day works; I am near 123 Main']);
    expect(notes(external)).toEqual([]);
  });

  it('passes unrelated text, and passes everything while the store is empty', async () => {
    queue(external, { id: 'empty-store', route: THREAD, content: { text: 'Meet at 123 Main St?' } });
    await deliverSessionMessages(external);
    await addHome();
    queue(external, { id: 'unrelated', route: THREAD, content: { text: 'Tuesday at 3pm in room 12 works.' } });
    await deliverSessionMessages(external);
    expect(texts()).toEqual(['Meet at 123 Main St?', 'Tuesday at 3pm in room 12 works.']);
  });

  it('judges a mail channel by its final recipients', async () => {
    await addHome();
    const recipients = new Map<string, readonly string[]>([
      ['mailtest:to-principal', ['Pat@Example.com']],
      ['mailtest:to-both', ['pat@example.com', 'sam@acme.test']],
    ]);
    registerRecipientResolver('mailtest', (send) => recipients.get(send.platformId) ?? []);
    const content = JSON.stringify({ text: 'Meet at 123 Main St' });

    await guarded.deliver('mailtest', 'mailtest:to-principal', null, 'chat', content);
    await expect(guarded.deliver('mailtest', 'mailtest:to-both', null, 'chat', content)).rejects.toBeInstanceOf(
      OutboundRefusedError,
    );
    await expect(guarded.deliver('mailtest', 'mailtest:nobody', null, 'chat', content)).rejects.toBeInstanceOf(
      OutboundRefusedError,
    );
    expect(sent.map((send) => send.platformId)).toEqual(['mailtest:to-principal']);
  });
});

describe('the shared check', () => {
  it.each([
    ['an event title', ['Lunch at 123 Main St', '', '', '']],
    ['a location', ['Lunch', '123 Main St, Springfield', '', '']],
    ['a description', ['Lunch', '', 'Park behind 123 Main Street', '']],
    ['an attendee comment', ['Lunch', '', '', 'I live at 123 main st']],
  ])('refuses a private value in %s', async (_label, fields) => {
    await addHome();
    expect(await checkOutbound(fields, 'others')).toMatchObject({ allowed: false, kind: 'address' });
  });

  it('names each kind and never the value or its label', async () => {
    await run('private-values-add', { label: 'Cell', kind: 'phone', value: '+1 415 555 0134' }, agent(main));
    await run('private-values-add', { label: 'Gmail', kind: 'email', value: 'pat.home@gmail.com' }, agent(main));
    await run('private-values-add', { label: 'Health', kind: 'other', value: 'kidney transplant' }, agent(main));
    for (const [text, kind] of [
      ['call 415-555-0134', 'phone number'],
      ['write to pat.home@gmail.com', 'email address'],
      ['after the kidney transplant', 'private detail'],
    ] as const) {
      const verdict = await checkOutbound(text, 'others');
      expect(verdict.allowed, text).toBe(false);
      if (!verdict.allowed) {
        expect(verdict.reason).toContain(kind);
        expect(verdict.reason).not.toMatch(/415|0134|pat\.home|gmail|kidney|cell|health/i);
      }
    }
  });

  it('passes anything for the principal, unrelated text, and everything while the store is empty', async () => {
    expect(await checkOutbound('123 Main Street', 'others')).toEqual({ allowed: true });
    await addHome();
    expect(await checkOutbound('123 Main Street', 'principal')).toEqual({ allowed: true });
    expect(await checkOutbound(['Lunch', 'Cafe Rosa', 'Bring the slides'], 'others')).toEqual({ allowed: true });
  });

  it("counts only the principal's own addresses as the principal", async () => {
    expect(await audienceForAddresses(['PAT@example.com'])).toBe('principal');
    expect(await audienceForAddresses(['pat@example.com', 'sam@acme.test'])).toBe('others');
    expect(await audienceForAddresses(['p.a.t@example.com'])).toBe('others');
    expect(await audienceForAddresses([])).toBe('others');
  });
});
