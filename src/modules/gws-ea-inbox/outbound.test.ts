/**
 * Email to the people on a thread, and `email_send` for both agents (KTD1,
 * KTD5, KTD9; R61, R68, R75, R76; AE63, AE65).
 *
 * Drives the real router, delivery path, delivery actions, privacy guard,
 * thread map, and session DBs against an in-memory Gmail. Only the
 * container wake is mocked, and external-email's group pointer.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-test-gws-ea-outbound';
/** Beside the data directory, never in it. */
const OUTSIDE_DIR = '/tmp/nanoclaw-test-gws-ea-outbound-outside';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-gws-ea-outbound',
    GROUPS_DIR: '/tmp/nanoclaw-test-gws-ea-outbound/groups',
  };
});

vi.mock('../../container-runner.js', () => ({
  getContainerStartedAtMs: vi.fn(() => Date.now()),
  isContainerRunning: vi.fn(() => false),
  killContainer: vi.fn(),
  wakeContainer: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn().mockResolvedValue(true) }));

vi.mock('../gws-ea-external-email/index.js', () => ({
  getExternalEmailAgentGroupId: vi.fn(async () => 'ag-external'),
}));

/** The assistant's Drive and what a signed-out visit sees, for the link check (Slice 6 KTD5). */
const workspace = vi.hoisted(() => ({
  drive: undefined as unknown,
  visits: [] as string[],
}));
vi.mock('../gws-ea-workspace/drive-api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../gws-ea-workspace/drive-api.js')>();
  const { delegatingDriveApi } = await import('../gws-ea-workspace/testing/fake-drive.js');
  return {
    ...actual,
    createDriveApi: () =>
      delegatingDriveApi(() => workspace.drive as import('../gws-ea-workspace/drive-api.js').DriveApi),
  };
});
vi.mock('../gws-ea-workspace/probe.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gws-ea-workspace/probe.js')>()),
  // Nothing in these tests is public: a signed-out visit always meets a sign-in.
  probeLink: async ({ url }: { readonly url: string }) => {
    workspace.visits.push(url);
    return 'sign-in';
  },
}));

import type { ChannelSetup } from '../../channels/adapter.js';
import {
  createChannelDeliveryAdapter,
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import type { ResponseFrame } from '../../cli/frame.js';
import { getDb } from '../../db/connection.js';
import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
import { findSessionForAgent } from '../../db/sessions.js';
import { deliverSessionMessages, getDeliveryAction, setDeliveryAdapter } from '../../delivery.js';
import { inboundDbPath, outboundDbPath } from '../../mailbox/sqlite/paths.js';
import { routeInbound } from '../../router.js';
import { resolveSession, sessionDir } from '../../session-manager.js';
import type { Session } from '../../types.js';
import '../permissions/index.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { upsertUser } from '../permissions/db/users.js';
import '../gws-ea-profile/index.js';
import { addPrincipalAddress, bindVerifiedPrincipalUser } from '../gws-ea-profile/db.js';
import { addPrivateValue } from '../gws-ea-privacy/db.js';
import {
  createInbox,
  EMAIL_CHANNEL_DEFAULTS,
  EMAIL_SEND_ACTION,
  ensureInbox,
  ensurePrincipalConversation,
  GoogleApiError,
  INBOX_PLATFORM_ID,
  PRINCIPAL_PLATFORM_ID,
  type GmailApi,
  type GmailHistoryRecord,
  type GmailMessage,
  type GmailMessageRef,
  type Inbox,
} from './index.js';
import { emailMessagingGroupIds } from './db.js';
import { createThread, findThreadFor, getThread, recordThreadAddresses, threadMessages } from './thread-map.js';
import { LINKS_UNCHECKED } from '../gws-ea-workspace/link-access.js';
import { FakeDrive } from '../gws-ea-workspace/testing/fake-drive.js';

const JUNO = 'juno@assistant.example';
const PRINCIPAL = 'pat@principal.example';
const PRINCIPAL_USER = 'gchat:users/pat';
const SAM = 'sam@acme.example';
const SALES = 'sales@acme.example';
const JANE = 'jane@partner.example';
const REMY = 'remy@friends.example';
const STRANGER = 'someone@else.example';
const HOME = '12 Elm Road, Springfield';

// ---------------------------------------------------------------------------
// An in-memory Gmail
// ---------------------------------------------------------------------------

interface Header {
  readonly name: string;
  readonly value: string;
}

interface IncomingMail {
  readonly from: string;
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
  readonly subject?: string;
  readonly body?: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
  /** Gmail verified the principal's own domain sent it. */
  readonly principal?: boolean;
}

/** What Gmail received from `users.messages.send`, read the way a mail client reads it. */
interface SentMail {
  readonly id: string;
  readonly threadId: string;
  readonly headers: Header[];
  readonly to: string[];
  readonly cc: string[];
  readonly text: string;
  readonly html: string;
  readonly files: { readonly name: string; readonly data: Buffer }[];
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function header(headers: readonly Header[], name: string): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

interface Entity {
  readonly headers: Header[];
  readonly body: string;
}

function entity(source: string): Entity {
  const split = source.indexOf('\r\n\r\n');
  const head = source.slice(0, split).replace(/\r\n[ \t]+/g, ' ');
  const headers = head.split('\r\n').map((line) => {
    const colon = line.indexOf(':');
    return { name: line.slice(0, colon), value: line.slice(colon + 1).trim() };
  });
  return { headers, body: source.slice(split + 4) };
}

function leaves(part: Entity): Entity[] {
  const boundary = /boundary="([^"]+)"/.exec(header(part.headers, 'Content-Type') ?? '')?.[1];
  if (boundary === undefined) return [part];
  return part.body
    .split(`--${boundary}`)
    .slice(1, -1)
    .flatMap((piece) => leaves(entity(piece.replace(/^\r\n/, '').replace(/\r\n$/, ''))));
}

function bytesOf(part: Entity): Buffer {
  const encoding = header(part.headers, 'Content-Transfer-Encoding')?.toLowerCase();
  if (encoding === 'base64') return Buffer.from(part.body.replace(/\r\n/g, ''), 'base64');
  const joined = part.body.replace(/=\r\n/g, '');
  const bytes: number[] = [];
  for (let index = 0; index < joined.length; index += 1) {
    if (joined[index] === '=') {
      bytes.push(parseInt(joined.slice(index + 1, index + 3), 16));
      index += 2;
    } else bytes.push(joined.charCodeAt(index));
  }
  return Buffer.from(bytes);
}

function addresses(value: string | undefined): string[] {
  return value === undefined ? [] : value.split(',').map((address) => address.trim());
}

function readSent(raw: string): Omit<SentMail, 'id' | 'threadId'> {
  const message = entity(Buffer.from(raw, 'base64url').toString('utf8'));
  const parts = leaves(message);
  const textOf = (type: string) =>
    bytesOf(parts.find((part) => (header(part.headers, 'Content-Type') ?? '').startsWith(type)) ?? message)
      .toString('utf8')
      .replace(/\r\n/g, '\n');
  return {
    headers: message.headers,
    to: addresses(header(message.headers, 'To')),
    cc: addresses(header(message.headers, 'Cc')),
    text: textOf('text/plain'),
    html: textOf('text/html'),
    files: parts
      .filter((part) => (header(part.headers, 'Content-Disposition') ?? '').startsWith('attachment'))
      .map((part) => ({
        name: /filename="([^"]+)"/.exec(header(part.headers, 'Content-Disposition') ?? '')?.[1] ?? '',
        data: bytesOf(part),
      })),
  };
}

class FakeGmail implements GmailApi {
  historyId = 1000;
  readonly messages = new Map<string, GmailMessage>();
  readonly history: GmailHistoryRecord[] = [];
  readonly sent: SentMail[] = [];
  /**
   * Each entry fails one send with Gmail's `status`, or with the host stopping when there is none;
   * `accepted` means Gmail kept the message before the call failed.
   */
  readonly sendFailures: Array<{ readonly accepted: boolean; readonly status?: number }> = [];
  private next = 1;

  receive(mail: IncomingMail): string {
    const id = `m${this.next++}`;
    const threadId = mail.threadId ?? `t${this.next++}`;
    const domain = mail.from.slice(mail.from.lastIndexOf('@') + 1).replace('>', '');
    const auth = mail.principal
      ? `mx.google.com;\r\n dkim=pass header.i=@${domain} header.s=google header.b=a;\r\n dmarc=pass (p=REJECT) header.from=${domain}`
      : `mx.google.com;\r\n dkim=pass header.i=@${domain} header.s=s1 header.b=a;\r\n dmarc=pass (p=NONE) header.from=${domain}`;
    const headers: Header[] = [
      { name: 'Delivered-To', value: JUNO },
      { name: 'Authentication-Results', value: auth },
      { name: 'From', value: mail.from },
      { name: 'To', value: (mail.to ?? [JUNO]).join(', ') },
      ...(mail.cc ? [{ name: 'Cc', value: mail.cc.join(', ') }] : []),
      { name: 'Subject', value: mail.subject ?? 'Coffee?' },
      { name: 'Message-ID', value: mail.messageId ?? `<${id}@mail.example>` },
      ...(mail.inReplyTo ? [{ name: 'In-Reply-To', value: mail.inReplyTo }] : []),
      ...(mail.references ? [{ name: 'References', value: mail.references.join(' ') }] : []),
    ];
    this.messages.set(id, {
      id,
      threadId,
      labelIds: ['INBOX', 'UNREAD'],
      internalDate: String(Date.now()),
      payload: { mimeType: 'text/plain', headers, body: { data: b64(mail.body ?? 'Hi') } },
    });
    this.historyId += 1;
    this.history.push({
      id: String(this.historyId),
      messagesAdded: [{ message: { id, threadId, labelIds: ['INBOX', 'UNREAD'] } }],
    });
    return id;
  }

  async getProfile() {
    return { emailAddress: JUNO, historyId: String(this.historyId) };
  }

  async listHistory(input: { startHistoryId: string }) {
    const start = Number(input.startHistoryId);
    return { history: this.history.filter((r) => Number(r.id) > start), historyId: String(this.historyId) };
  }

  async getMessage(id: string) {
    return this.messages.get(id);
  }

  async listMessages(input: { q?: string; labelIds?: readonly string[]; maxResults: number }) {
    const byId = /^rfc822msgid:(.+)$/.exec(input.q ?? '');
    return [...this.messages.values()]
      .reverse()
      .filter((m) => !input.labelIds || input.labelIds.every((label) => m.labelIds?.includes(label)))
      .filter((m) => !byId || header(m.payload?.headers ?? [], 'Message-ID') === `<${byId[1]}>`)
      .slice(0, input.maxResults)
      .map((m): GmailMessageRef => ({ id: m.id, threadId: m.threadId }));
  }

  async getThread(id: string) {
    const messages = [...this.messages.values()].filter((m) => m.threadId === id);
    return messages.length > 0 ? messages : undefined;
  }

  async getAttachment(): Promise<string | undefined> {
    return undefined;
  }

  async send(input: { raw: string; threadId?: string }) {
    const failure = this.sendFailures.shift();
    if (failure && !failure.accepted) throw new GoogleApiError(failure.status ?? 400, 'unavailable');
    const id = `s${this.next++}`;
    const threadId = input.threadId ?? `t${this.next++}`;
    const mail = readSent(input.raw);
    this.messages.set(id, {
      id,
      threadId,
      labelIds: ['SENT'],
      internalDate: String(Date.now()),
      payload: {
        mimeType: 'multipart/alternative',
        headers: mail.headers,
        parts: [{ mimeType: 'text/plain', body: { data: b64(mail.text) } }],
      },
    });
    this.sent.push({ id, threadId, ...mail });
    if (failure?.status !== undefined) throw new GoogleApiError(failure.status, 'unavailable');
    if (failure) throw new Error('the host stopped after Gmail took the email');
    return { id, threadId };
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let gmail: FakeGmail;
let inbox: Inbox;
let main: Session;
let drive: FakeDrive;

function now(): string {
  return new Date().toISOString();
}

const hostSetup: ChannelSetup = {
  async onInbound(platformId, threadId, message) {
    await routeInbound({
      channelType: 'email',
      instance: 'email',
      platformId,
      threadId,
      message: {
        id: message.id,
        kind: message.kind,
        content: JSON.stringify(message.content),
        timestamp: message.timestamp,
        isMention: message.isMention,
        isGroup: message.isGroup,
        authenticatedSender: message.authenticatedSender,
      },
    });
  },
  onInboundEvent: () => undefined,
  onMetadata: () => undefined,
  onAction: () => undefined,
};

async function startInbox(): Promise<void> {
  await teardownChannelAdapters();
  inbox = createInbox({
    gmail,
    calendar: { list: async () => [], patchNotifications: async () => undefined },
    drive,
    sleep: async () => undefined,
  });
  registerChannelAdapter('email', { factory: () => inbox.adapter, defaults: EMAIL_CHANNEL_DEFAULTS });
  await initChannelAdapters(() => hostSetup);
  setDeliveryAdapter(createChannelDeliveryAdapter());
}

interface Row {
  readonly id: string;
  readonly platform_id: string | null;
  /** Absent from the host's answers to a request. */
  readonly text?: string;
  readonly signal?: { readonly type: string; readonly thread_id: string | null };
}

function rows(session: Session): Row[] {
  const file = inboundDbPath(session.agent_group_id, session.id);
  if (!fs.existsSync(file)) return [];
  const db = new Database(file, { readonly: true });
  const found = db.prepare('SELECT id, platform_id, content FROM messages_in ORDER BY seq').all() as Array<{
    id: string;
    platform_id: string | null;
    content: string;
  }>;
  db.close();
  return found.map(({ content, ...row }) => ({ ...row, ...(JSON.parse(content) as Omit<Row, 'id' | 'platform_id'>) }));
}

/** What the host told a session its message was not sent for. */
function refusals(session: Session): string[] {
  return rows(session)
    .map((row) => row.text ?? '')
    .filter((text) => text.startsWith('Your message was not sent:'));
}

function deliveryStatus(session: Session, id: string): string | undefined {
  const db = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  const row = db.prepare('SELECT status FROM delivered WHERE message_out_id = ?').get(id) as
    | { status: string }
    | undefined;
  db.close();
  return row?.status;
}

/** The thread a Gmail thread maps to. */
async function threadOf(gmailThreadId: string): Promise<string> {
  const thread = await findThreadFor({ gmailThreadId, inReplyTo: [], references: [] });
  if (!thread) throw new Error(`No thread holds Gmail thread ${gmailThreadId}`);
  return thread.threadKey;
}

async function threadSession(threadKey: string): Promise<Session> {
  const { inbox: inboxId } = await emailMessagingGroupIds();
  const session = await findSessionForAgent('ag-external', inboxId ?? '', threadKey);
  if (!session) throw new Error(`No external-email session for ${threadKey}`);
  return session;
}

/** Mail arrives in a Gmail thread and is routed; returns its thread and external-email's session for it. */
async function arrives(mail: IncomingMail & { readonly threadId: string }): Promise<{ key: string; session: Session }> {
  gmail.receive(mail);
  await inbox.tick();
  const key = await threadOf(mail.threadId);
  return { key, session: await threadSession(key) };
}

/** A thread main handed over to these people before Gmail has it, and external-email's session for it. */
async function handedOver(people: readonly string[]): Promise<{ key: string; session: Session }> {
  const { threadKey } = await createThread(null, now());
  await recordThreadAddresses(threadKey, people, 'main', now());
  const { inbox: inboxId } = await emailMessagingGroupIds();
  const { session } = await resolveSession('ag-external', inboxId ?? '', threadKey, 'per-thread');
  return { key: threadKey, session };
}

let outgoing = 0;

/** A row the agent wrote, as its final text or a tool writes it, delivered at once. */
async function queue(
  session: Session,
  row: { platformId: string; threadKey: string; content: Record<string, unknown>; files?: Record<string, Buffer> },
): Promise<string> {
  const id = `out-${++outgoing}`;
  for (const [name, data] of Object.entries(row.files ?? {})) {
    const dir = path.join(sessionDir(session.agent_group_id, session.id), 'outbox', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), data);
  }
  const db = new Database(outboundDbPath(session.agent_group_id, session.id));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, content)
     VALUES (?, ?, 'chat', ?, 'email', ?, ?)`,
  ).run(id, now(), row.platformId, row.threadKey, JSON.stringify(row.content));
  db.close();
  await deliverSessionMessages(session);
  return id;
}

/** external-email's final text in its thread. */
function reply(session: Session, threadKey: string, text: string): Promise<string> {
  return queue(session, { platformId: INBOX_PLATFORM_ID, threadKey, content: { text } });
}

/** An `email_send` request as the runner's tool writes it, with its files staged in the request's outbox. */
async function emailSend(
  session: Session,
  fields: Record<string, unknown>,
  files: Record<string, Buffer> = {},
  requestId = `act-send-${++outgoing}`,
): Promise<ResponseFrame> {
  for (const [name, data] of Object.entries(files)) {
    const dir = path.join(sessionDir(session.agent_group_id, session.id), 'outbox', requestId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), data);
  }
  const db = new Database(outboundDbPath(session.agent_group_id, session.id));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, content)
     VALUES (?, ?, 'system', NULL, NULL, NULL, ?)`,
  ).run(
    requestId,
    now(),
    JSON.stringify({
      ...fields,
      ...(Object.keys(files).length === 0 ? {} : { files: Object.keys(files) }),
      action: EMAIL_SEND_ACTION,
      requestId,
    }),
  );
  db.close();
  await deliverSessionMessages(session);
  return answerTo(session, requestId);
}

function answerTo(session: Session, requestId: string): ResponseFrame {
  const answer = rows(session).find((row) => row.id === `action-resp-${requestId}`) as
    | (Row & { frame?: ResponseFrame })
    | undefined;
  if (answer?.frame === undefined) throw new Error(`${requestId} was not answered`);
  return answer.frame;
}

function refusalOf(frame: ResponseFrame): string {
  if (frame.ok) throw new Error(`accepted: ${JSON.stringify(frame.data)}`);
  return frame.error.message;
}

/**
 * Hand a file over for a thread, as main's handoff records it: the host's
 * copy, by its SHA-256 and its place in the data directory (or wherever
 * `recorded` says); returns the copy's path.
 */
async function handFile(
  threadKey: string,
  name: string,
  data: Buffer,
  recorded = path.join('handed', threadKey, name),
): Promise<string> {
  const hostPath = path.resolve(TEST_DIR, recorded);
  fs.mkdirSync(path.dirname(hostPath), { recursive: true });
  fs.writeFileSync(hostPath, data);
  await getDb().run(
    'INSERT INTO gws_ea_thread_files (thread_key, sha256, file_name, host_path, handed_at) VALUES (?, ?, ?, ?, ?)',
    threadKey,
    createHash('sha256').update(data).digest('hex'),
    name,
    recorded,
    now(),
  );
  return hostPath;
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());

  for (const [id, name] of [
    ['ag-main', 'main'],
    ['ag-external', 'external-email'],
  ] as const) {
    await createAgentGroup({ id, name, folder: name, agent_provider: null, created_at: now() });
  }
  await createMessagingGroup({
    id: 'mg-dm',
    channel_type: 'gchat',
    platform_id: 'spaces/dm',
    name: 'dm',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await upsertUser({ id: PRINCIPAL_USER, kind: 'gchat', display_name: 'Pat', created_at: now() });
  await bindVerifiedPrincipalUser(PRINCIPAL_USER, now());
  await upsertUserDm({
    user_id: PRINCIPAL_USER,
    channel_type: 'gchat',
    messaging_group_id: 'mg-dm',
    resolved_at: now(),
  });
  await getDb().run(
    `UPDATE gws_ea_profile
        SET main_agent_group_id = ?, assistant_display_name = 'Juno', assistant_workspace_email = ?,
            principal_display_name = 'Pat', principal_timezone = 'America/New_York'
      WHERE singleton = 1`,
    'ag-main',
    JUNO,
  );
  await addPrincipalAddress(PRINCIPAL);
  await addPrivateValue({ label: 'Home', kind: 'address', value: HOME });

  // Everyone gets the same Drive permission id in every test, so an id the link check cached stays true.
  drive = new FakeDrive(JUNO);
  for (const person of [PRINCIPAL, SAM, SALES, JANE, REMY, STRANGER]) drive.addAccount(person);
  workspace.drive = drive;
  workspace.visits.length = 0;

  gmail = new FakeGmail();
  await ensureInbox('ag-external');
  await ensurePrincipalConversation('ag-main');
  await startInbox();
  main = (await resolveSession('ag-main', 'mg-dm', null, 'agent-shared')).session;
  await inbox.tick(); // the first poll takes Gmail's current history id
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  fs.rmSync(OUTSIDE_DIR, { recursive: true, force: true });
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

describe("external-email's reply", () => {
  it('goes to everyone the latest message placed, quoting it, and never touches a principal-only note (KTD5)', async () => {
    const { key, session } = await arrives({
      threadId: 'g-coffee',
      from: `Sam <${SAM}>`,
      cc: [JANE],
      messageId: '<s1@acme.example>',
      body: 'Can Pat meet next week?',
    });
    gmail.receive({
      threadId: 'g-coffee',
      from: `Jane <${JANE}>`,
      to: [JUNO, SAM],
      cc: [SALES],
      subject: 'Re: Coffee?',
      messageId: '<j1@partner.example>',
      inReplyTo: '<s1@acme.example>',
      references: ['<s1@acme.example>'],
      body: 'Adding our sales lead.',
    });
    gmail.receive({
      threadId: 'g-coffee',
      from: `Pat <${PRINCIPAL}>`,
      principal: true,
      subject: 'Re: Coffee?',
      messageId: '<p1@principal.example>',
      inReplyTo: '<j1@partner.example>',
      body: 'Between us: keep it short.',
    });
    await inbox.tick();
    expect(await threadMessages(key, 'principal')).toHaveLength(1);

    const id = await reply(session, key, 'Thursday at **10** works for Pat.\n\nBest,\nJuno');
    expect(deliveryStatus(session, id)).toBe('delivered');
    const [sent] = gmail.sent;
    expect(sent.to).toEqual([JANE, SAM]);
    expect(sent.cc).toEqual([SALES]);
    expect(header(sent.headers, 'Bcc')).toBeUndefined();
    expect(sent.threadId).toBe('g-coffee');
    expect(header(sent.headers, 'From')).toBe(`Juno <${JUNO}>`);
    expect(header(sent.headers, 'Subject')).toBe('Re: Coffee?');
    expect(header(sent.headers, 'In-Reply-To')).toBe('<j1@partner.example>');
    expect(header(sent.headers, 'References')).toBe('<s1@acme.example> <j1@partner.example>');
    expect(sent.text).toMatch(/Jane <jane@partner\.example> wrote:\n\n> Adding our sales lead\./u);
    // The plain part reads as typed; only the HTML part is formatted.
    expect(sent.text.slice(0, sent.text.indexOf('\n\n-- \n'))).toBe('Thursday at 10 works for Pat.\n\nBest,\nJuno');
    expect(sent.html).toContain('<strong>10</strong>');
    expect(sent.text.match(/-- \nJuno\nAssistant to Pat/gu)).toHaveLength(1);
    for (const part of [sent.text, sent.html, ...sent.headers.map((h) => h.value)]) {
      expect(part).not.toMatch(/keep it short|p1@principal/u);
    }
    expect((await threadMessages(key, 'outside')).at(-1)?.gmailMessageId).toBe(sent.id);

    // The next reply answers the assistant's own email: to the people it went to.
    await reply(session, key, 'The invitation is on its way.');
    expect(gmail.sent[1]).toMatchObject({ to: [JANE, SAM], cc: [SALES], threadId: 'g-coffee' });
    expect(header(gmail.sent[1].headers, 'In-Reply-To')).toBe(header(sent.headers, 'Message-ID'));
  });

  it('is refused in a thread with no email yet, naming email_send', async () => {
    const { key, session } = await handedOver([REMY]);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(deliveryStatus(session, await reply(session, key, 'Hi Remy'))).toBe('failed');
    }
    expect(gmail.sent).toEqual([]);
    expect(refusals(session)).toHaveLength(4);
    expect(refusals(session)[0]).toContain('email_send');
    expect(await emailSend(session, { subject: 'Thirty minutes with Pat', text: 'Hi Remy' })).toMatchObject({
      ok: true,
    });
  });

  it('quotes the message it answers whole, a private value its writer put there included', async () => {
    const { key, session } = await arrives({ threadId: 'g-1', from: SAM, body: `Is Pat still at ${HOME}?` });
    // The check reads what the assistant wrote; the quote shows its readers only what they already received.
    const id = await reply(session, key, 'Pat will be in touch about that.');
    expect(deliveryStatus(session, id)).toBe('delivered');
    expect(gmail.sent[0].text).toContain(`> Is Pat still at ${HOME}?`);
  });

  it('goes exactly once when Gmail took it but the call failed: the host finds it in Gmail', async () => {
    const { key, session } = await arrives({ threadId: 'g-1', from: SAM, body: 'Next week?' });
    gmail.sendFailures.push({ accepted: true });
    const id = await reply(session, key, 'Tuesday works.');
    expect(gmail.sent).toHaveLength(1);
    expect(deliveryStatus(session, id)).toBe('delivered');

    // The same words later are a new email.
    await reply(session, key, 'Tuesday works.');
    expect(gmail.sent).toHaveLength(2);
  });

  it('is reported sent on retry when Gmail took it before a stop, even when a check would now refuse it (G10)', async () => {
    const { key, session } = await arrives({ threadId: 'g-1', from: SAM, body: 'Next week?' });
    // Gmail keeps the email, but the call fails: delivery retries, and the send stays pending.
    gmail.sendFailures.push({ accepted: true, status: 400 });
    const id = await reply(session, key, 'Tuesday at the Bluebird office works.');
    expect(gmail.sent).toHaveLength(1);
    expect(deliveryStatus(session, id)).toBeUndefined();

    // The principal names a private detail that email holds, after Gmail took it.
    await addPrivateValue({ label: 'Office', kind: 'other', value: 'Bluebird office' });
    await deliverSessionMessages(session);
    expect(deliveryStatus(session, id)).toBe('delivered');
    expect(refusals(session)).toEqual([]);
    expect(gmail.sent).toHaveLength(1);
    expect((await threadMessages(key, 'outside')).at(-1)?.gmailMessageId).toBe(gmail.sent[0].id);
  });

  it("finds a thread's first email Gmail took before failing, though the thread has no Gmail thread yet", async () => {
    const { key, session } = await handedOver([REMY]);
    gmail.sendFailures.push({ accepted: true, status: 503 });
    const answer = await emailSend(session, { subject: 'Lunch', text: 'Lunch on Tuesday?' });
    expect(answer).toMatchObject({ ok: true, data: { thread_key: key } });
    expect(gmail.sent).toHaveLength(1);
    expect((await getThread(key))?.gmailThreadId).toBe(gmail.sent[0].threadId);
  });

  it('is answered from its record when Gmail took it but delivery never recorded it', async () => {
    const { key } = await arrives({ threadId: 'g-1', from: SAM, body: 'Next week?' });
    const message = { kind: 'chat', content: { text: 'Tuesday works.' } };
    const first = await inbox.adapter.deliver(INBOX_PLATFORM_ID, key, message);
    expect(await inbox.adapter.deliver(INBOX_PLATFORM_ID, key, message)).toBe(first);
    expect(gmail.sent).toHaveLength(1);
  });

  it.each([
    ['after Gmail kept it', [{ status: 503, accepted: true }]],
    ['before Gmail kept it', [{ status: 503, accepted: false }]],
    [
      'every try, Gmail keeping the last',
      [
        { status: 503, accepted: false },
        { status: 503, accepted: false },
        { status: 503, accepted: true },
      ],
    ],
  ])('backs off when Gmail fails %s, and goes exactly once', async (_when, failures) => {
    const { key, session } = await arrives({ threadId: 'g-1', from: SAM, body: 'Next week?' });
    gmail.sendFailures.push(...failures);
    const id = await reply(session, key, 'Tuesday works.');
    expect(gmail.sent).toHaveLength(1);
    expect(deliveryStatus(session, id)).toBe('delivered');
  });
});

// ---------------------------------------------------------------------------
// email_send
// ---------------------------------------------------------------------------

describe('email_send from external-email', () => {
  it('starts a thread main handed over, with its subject, to the people main named, and the answer comes back to it', async () => {
    const { key, session } = await handedOver([REMY]);
    const answer = await emailSend(session, {
      subject: 'Thirty minutes with Pat',
      text: 'Hi Remy,\n\nPat asked me to find thirty minutes with you.\n\nBest,\nJuno',
    });
    expect(answer).toMatchObject({ ok: true, data: { thread_key: key } });
    const [sent] = gmail.sent;
    expect(sent.to).toEqual([REMY]);
    expect(sent.cc).toEqual([]);
    expect(header(sent.headers, 'Subject')).toBe('Thirty minutes with Pat');
    expect(header(sent.headers, 'In-Reply-To')).toBeUndefined();
    expect(header(sent.headers, 'References')).toBeUndefined();
    expect(sent.text).not.toContain('wrote:');
    expect((await getThread(key))?.gmailThreadId).toBe(sent.threadId);

    gmail.receive({
      threadId: sent.threadId,
      from: REMY,
      subject: 'Re: Thirty minutes with Pat',
      inReplyTo: header(sent.headers, 'Message-ID'),
      body: 'Tuesday?',
    });
    await inbox.tick();
    expect(await threadOf(sent.threadId)).toBe(key);
    expect(rows(session).some((row) => row.text?.includes('Tuesday?'))).toBe(true);

    expect(refusalOf(await emailSend(session, { subject: 'Another subject', text: 'Tuesday it is.' }))).toMatch(
      /subject/u,
    );
    const other = await handedOver([REMY]);
    expect(refusalOf(await emailSend(other.session, { text: 'Hi again' }))).toMatch(/subject/u);
    expect(gmail.sent).toHaveLength(1);
  });

  it('sends to anyone a message put on the thread or main named, and refuses anyone else (AE63)', async () => {
    const { key, session } = await arrives({ threadId: 'g-1', from: SAM, cc: [JANE], body: 'Looping in Jane.' });
    gmail.receive({ threadId: 'g-1', from: SAM, body: 'Jane dropped off this one; please keep her posted.' });
    await inbox.tick();

    expect(
      await emailSend(session, { to: [SAM], cc: [JANE], text: 'Of course. Jane, Pat is free Tuesday.' }),
    ).toMatchObject({ ok: true });
    expect(gmail.sent[0]).toMatchObject({ to: [SAM], cc: [JANE], threadId: 'g-1' });
    expect(gmail.sent[0].text).toContain('please keep her posted');

    await recordThreadAddresses(key, [SALES], 'main', now());
    expect(await emailSend(session, { to: [SAM], cc: [SALES], text: 'Copying our sales lead.' })).toMatchObject({
      ok: true,
    });

    const stranger = refusalOf(await emailSend(session, { to: [SAM], cc: [STRANGER], text: 'Copying a colleague.' }));
    expect(stranger).toContain(STRANGER);
    expect(stranger).toMatch(/main/u);
    expect(refusalOf(await emailSend(session, { to: [JUNO], text: 'A note to myself.' }))).toMatch(/assistant/u);
    expect(refusalOf(await emailSend(session, { to: [], cc: [JANE], text: 'Jane, Pat is free Tuesday.' }))).toMatch(
      /someone on To/u,
    );
    expect(refusalOf(await emailSend(session, { thread_key: key, text: 'Hello.' }))).toMatch(/own thread/u);
    expect(gmail.sent).toHaveLength(2);
  });

  it.each([
    ['its words', { text: `Come by ${HOME} at noon.` }],
    ['its subject', { subject: 'Lunch at 12 Elm Road', text: 'See you there.' }],
    ['a link target', { text: 'Here are [directions](https://maps.example/?q=12&#32;Elm&#32;Road).' }],
  ])('refuses a private value in %s (AE65)', async (_where, fields) => {
    const { session } = await handedOver([REMY]);
    const reason = refusalOf(await emailSend(session, { subject: 'Lunch', ...fields }));
    expect(reason).toMatch(/private address/u);
    expect(reason).not.toMatch(/elm|springfield|home/iu);
    expect(gmail.sent).toEqual([]);
  });

  it('refuses a private value in the text of a file it sends, or among the people it names (R8)', async () => {
    const { key, session } = await handedOver([REMY]);
    const directions = Buffer.from(`Parking is behind ${HOME}.`);
    await handFile(key, 'Directions.txt', directions);
    const filed = refusalOf(
      await emailSend(session, { subject: 'Lunch', text: 'Directions attached.' }, { 'directions.txt': directions }),
    );
    expect(filed).toMatch(/private address/u);

    const personal = 'lena.ford@family.example';
    await addPrivateValue({ label: 'Lena at home', kind: 'email', value: personal });
    await recordThreadAddresses(key, [personal], 'main', now());
    const named = refusalOf(
      await emailSend(session, { subject: 'Lunch', to: [REMY], cc: [personal], text: 'Lunch on Tuesday?' }),
    );
    expect(named).toMatch(/private email address/u);

    for (const reason of [filed, named]) expect(reason).not.toMatch(/elm|springfield|lena\.ford/iu);
    expect(gmail.sent).toEqual([]);
  });

  it('leaves out the quote for someone the quoted message never reached when it holds a private value for them', async () => {
    await arrives({ threadId: 'g-1', from: SAM, cc: [JANE], body: 'Looping in Jane.' });
    // Sam writes on to the assistant alone.
    const { session } = await arrives({ threadId: 'g-1', from: SAM, body: `Is Pat still at ${HOME}?` });

    expect(await emailSend(session, { to: [SAM], cc: [JANE], text: 'Jane, Pat is free Tuesday.' })).toMatchObject({
      ok: true,
    });
    expect(gmail.sent[0]).toMatchObject({ to: [SAM], cc: [JANE], threadId: 'g-1' });
    expect(gmail.sent[0].text).toContain('Jane, Pat is free Tuesday.');
    expect(gmail.sent[0].text).not.toMatch(/Elm Road/u);
  });

  it('leaves out the quote for someone new when only its attribution holds a private value for them', async () => {
    await addPrivateValue({ label: 'Codename', kind: 'other', value: 'Project Bluebird' });
    const { key, session } = await arrives({ threadId: 'g-1', from: `Project Bluebird <${SAM}>`, body: 'Next week?' });
    await recordThreadAddresses(key, [JANE], 'main', now());
    expect(await emailSend(session, { to: [SAM], cc: [JANE], text: 'Jane, Pat is free Tuesday.' })).toMatchObject({
      ok: true,
    });
    expect(gmail.sent[0]).toMatchObject({ to: [SAM], cc: [JANE] });
    for (const part of [gmail.sent[0].text, gmail.sent[0].html]) expect(part).not.toMatch(/bluebird|wrote:/iu);

    // Sam received such a message, so a reply to Sam alone quotes it under its attribution.
    const other = await arrives({ threadId: 'g-2', from: `Project Bluebird <${SAM}>`, body: 'And lunch?' });
    await reply(other.session, other.key, 'Lunch works too.');
    expect(gmail.sent[1].text).toMatch(/Project Bluebird <sam@acme\.example> wrote:/u);
  });

  it("never shows someone new a thread's subject that holds a private value, naming only that it would", async () => {
    const { key, session } = await arrives({ threadId: 'g-1', from: SAM, subject: `Lunch at ${HOME}`, body: 'Noon?' });
    await recordThreadAddresses(key, [JANE], 'main', now());

    const reason = refusalOf(await emailSend(session, { to: [SAM], cc: [JANE], text: 'Jane, noon works for Pat.' }));
    expect(reason).toMatch(/subject or the people/u);
    expect(reason).not.toMatch(/elm|springfield|home/iu);
    expect(gmail.sent).toEqual([]);

    // Sam wrote that subject, so a reply to Sam carries it.
    await reply(session, key, 'Noon works for Pat.');
    expect(header(gmail.sent[0].headers, 'Subject')).toBe(`Re: Lunch at ${HOME}`);
  });

  it('attaches only a file main handed over for this thread, as the host holds it (KTD9)', async () => {
    const { key, session } = await handedOver([REMY]);
    const quote = Buffer.from('%PDF-1.4 the quote');
    const hostCopy = await handFile(key, 'Acme quote.pdf', quote);
    const elsewhere = await handedOver([REMY]);
    await handFile(elsewhere.key, 'Other.pdf', Buffer.from('another thread'));

    expect(
      await emailSend(session, { subject: 'Your quote', text: 'Attached.' }, { 'quote.pdf': quote }),
    ).toMatchObject({ ok: true });
    expect(gmail.sent[0].files).toEqual([{ name: 'Acme quote.pdf', data: quote }]);

    for (const data of [Buffer.from('a file nobody handed over'), Buffer.from('another thread')]) {
      expect(refusalOf(await emailSend(session, { text: 'And this.' }, { 'extra.pdf': data }))).toMatch(
        /not a file main handed over/u,
      );
    }

    // The checks read the bytes main handed over, so a host copy changed since then never goes.
    fs.writeFileSync(hostCopy, 'a different file');
    expect(refusalOf(await emailSend(session, { text: 'Attached again.' }, { 'quote.pdf': quote }))).toMatch(
      /changed after main handed it over/u,
    );
    expect(gmail.sent).toHaveLength(1);
  });

  it.each([
    ['a path that climbs out of it', path.relative(TEST_DIR, path.join(OUTSIDE_DIR, 'Acme quote.pdf'))],
    ['an absolute path elsewhere', path.join(OUTSIDE_DIR, 'Acme quote.pdf')],
  ])('never sends a host copy recorded outside the data directory: %s', async (_how, recorded) => {
    const { key, session } = await handedOver([REMY]);
    const quote = Buffer.from('%PDF-1.4 the quote');
    await handFile(key, 'Acme quote.pdf', quote, recorded);

    expect(
      refusalOf(await emailSend(session, { subject: 'Your quote', text: 'Attached.' }, { 'quote.pdf': quote })),
    ).toMatch(/The host's copy of Acme quote\.pdf is recorded outside the data directory/u);
    expect(gmail.sent).toEqual([]);
  });

  it('refuses a file it names but never staged, rather than sending without it', async () => {
    const { session } = await handedOver([REMY]);
    expect(
      refusalOf(await emailSend(session, { subject: 'Your quote', text: 'Attached.', files: ['quote.pdf'] })),
    ).toMatch(/staged with this request/u);
    expect(gmail.sent).toEqual([]);
  });

  it('sends nothing twice when a request is replayed after Gmail took it', async () => {
    const { key, session } = await handedOver([REMY]);
    const fields = { subject: 'Hello', text: 'Hi Remy', action: EMAIL_SEND_ACTION, requestId: 'act-replayed' };
    gmail.sendFailures.push({ accepted: true });
    const handle = getDeliveryAction(EMAIL_SEND_ACTION);
    if (!handle) throw new Error('email_send is not registered');
    await handle(fields, session);
    expect(gmail.sent).toHaveLength(1);
    await handle(fields, session); // the host replays the request after a restart
    expect(gmail.sent).toHaveLength(1);
    expect((await threadMessages(key, 'outside')).map((message) => message.gmailMessageId)).toEqual([gmail.sent[0].id]);

    // The same words in a new request are a new email.
    expect(await emailSend(session, { text: 'Hi Remy' })).toMatchObject({ ok: true });
    expect(gmail.sent).toHaveLength(2);
  });
});

describe("main's email_send", () => {
  it("writes to the principal in the thread main names: each forward in its own, a later outcome in its request's (KTD1)", async () => {
    for (const [threadId, subject] of [
      ['g-a', 'Fwd: Quote'],
      ['g-b', 'Fwd: Dinner'],
    ] as const) {
      gmail.receive({
        threadId,
        from: `Pat <${PRINCIPAL}>`,
        principal: true,
        subject,
        messageId: `<${threadId}@principal.example>`,
        body: 'Juno, reply to them.',
      });
    }
    await inbox.tick();
    const [a, b] = [await threadOf('g-a'), await threadOf('g-b')];

    expect(await emailSend(main, { thread_key: b, text: 'Declined, kindly.' })).toMatchObject({ ok: true });
    expect(await emailSend(main, { thread_key: a, text: 'I am on it.' })).toMatchObject({ ok: true });
    gmail.receive({
      threadId: 'g-c',
      from: `Pat <${PRINCIPAL}>`,
      principal: true,
      subject: 'Lunch',
      body: 'Book lunch.',
    });
    await inbox.tick();
    expect(await emailSend(main, { thread_key: a, text: 'They accepted.' })).toMatchObject({ ok: true });

    expect(gmail.sent.map((sent) => [sent.threadId, sent.to, header(sent.headers, 'In-Reply-To')])).toEqual([
      ['g-b', [PRINCIPAL], '<g-b@principal.example>'],
      ['g-a', [PRINCIPAL], '<g-a@principal.example>'],
      ['g-a', [PRINCIPAL], '<g-a@principal.example>'],
    ]);
  });

  it('is refused for an outside thread, and takes no subject or recipients', async () => {
    const { key } = await arrives({ threadId: 'g-sam', from: SAM, body: 'Hello' });
    expect(refusalOf(await emailSend(main, { thread_key: key, text: 'Hello Sam' }))).toBe(
      `Your email was not sent: there is no email from Pat in that thread for you to answer. (thread ${key})`,
    );
    gmail.receive({ threadId: 'g-pat', from: `Pat <${PRINCIPAL}>`, principal: true, body: 'Ping' });
    await inbox.tick();
    const own = await threadOf('g-pat');
    for (const extra of [{ subject: 'Hi' }, { to: [SAM] }, { cc: [PRINCIPAL] }]) {
      expect(await emailSend(main, { thread_key: own, text: 'Pong', ...extra })).toMatchObject({
        ok: false,
        error: { code: 'invalid-args' },
      });
    }
    expect(gmail.sent).toEqual([]);
  });

  it('carries the files main staged to the principal, by request or in a reply, and refuses one it never staged', async () => {
    gmail.receive({ threadId: 'g-pat', from: `Pat <${PRINCIPAL}>`, principal: true, body: 'Send me the deck.' });
    await inbox.tick();
    const own = await threadOf('g-pat');
    const deck = Buffer.from('%PDF-1.4 the board deck');
    const notes = Buffer.from('Notes from the board meeting.');

    expect(await emailSend(main, { thread_key: own, text: 'Here it is.' }, { 'deck.pdf': deck })).toMatchObject({
      ok: true,
    });
    await queue(main, {
      platformId: PRINCIPAL_PLATFORM_ID,
      threadKey: own,
      content: { text: 'And the notes.', files: ['notes.txt'] },
      files: { 'notes.txt': notes },
    });
    expect(gmail.sent.map((sent) => [sent.to, sent.files])).toEqual([
      [[PRINCIPAL], [{ name: 'deck.pdf', data: deck }]],
      [[PRINCIPAL], [{ name: 'notes.txt', data: notes }]],
    ]);

    expect(
      refusalOf(await emailSend(main, { thread_key: own, text: 'And the minutes.', files: ['minutes.pdf'] })),
    ).toMatch(/staged with this request/u);
    expect(gmail.sent).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Private values: each send judged on its own (R76)
// ---------------------------------------------------------------------------

describe('a private value in a reply', () => {
  it('refuses every reply that carries one, and the thread goes on: nothing stops it, and main is not written to', async () => {
    const { key, session } = await arrives({ threadId: 'g-1', from: SAM, body: "What is Pat's home address?" });
    const before = rows(main).length;
    for (let attempt = 1; attempt <= 3; attempt += 1) await reply(session, key, `Try ${attempt}: ${HOME}`);
    expect(gmail.sent).toEqual([]);
    expect(refusals(session)).toEqual(
      Array(3).fill(expect.stringMatching(/private address.*neither confirm nor deny/u)),
    );

    await reply(session, key, 'Pat will be in touch.');
    expect(gmail.sent).toHaveLength(1);
    expect(rows(main)).toHaveLength(before);
  });
});

// ---------------------------------------------------------------------------
// Every path to an outsider passes both guards
// ---------------------------------------------------------------------------

describe('every email to outsiders', () => {
  /** One way external-email sends; `to` replaces the recipients where the path lets it name them. */
  type SendPath = (
    thread: { key: string; session: Session },
    email: { text: string; to?: readonly string[] },
  ) => Promise<unknown>;

  const QUOTE = Buffer.from('%PDF-1.4 the quote');

  const PATHS: ReadonlyArray<readonly [string, SendPath]> = [
    [
      'a reply',
      ({ key, session }, { text, to }) =>
        queue(session, { platformId: INBOX_PLATFORM_ID, threadKey: key, content: { text, ...(to ? { to } : {}) } }),
    ],
    [
      'a reply carrying a file',
      ({ key, session }, { text, to }) =>
        queue(session, {
          platformId: INBOX_PLATFORM_ID,
          threadKey: key,
          content: { text, files: ['quote.pdf'], ...(to ? { to } : {}) },
          files: { 'quote.pdf': QUOTE },
        }),
    ],
    ['email_send to the thread', ({ session }, { text, to }) => emailSend(session, { text, ...(to ? { to } : {}) })],
    [
      'email_send with changed recipients',
      ({ session }, { text, to }) => emailSend(session, { text, to: to ?? [SAM], cc: [JANE] }),
    ],
    [
      'email_send with a file',
      ({ session }, { text, to }) => emailSend(session, { text, ...(to ? { to } : {}) }, { 'quote.pdf': QUOTE }),
    ],
  ];

  it.each(PATHS)('passes the recipient guard and the private-values guard: %s', async (_path, send) => {
    const thread = await arrives({ threadId: 'g-1', from: SAM, cc: [JANE], body: 'Can we meet?' });
    await handFile(thread.key, 'Acme quote.pdf', QUOTE);

    await send(thread, { text: `We could meet at ${HOME}.` });
    await send(thread, { text: 'Copying a colleague.', to: [STRANGER] });
    expect(gmail.sent).toEqual([]);

    await send(thread, { text: 'Tuesday at 10 works.' });
    expect(gmail.sent).toHaveLength(1);
    expect([...gmail.sent[0].to, ...gmail.sent[0].cc].sort()).toEqual([JANE, SAM].sort());
  });

  it('counts everyone on Cc in the private-values check, when the principal alone is on To', async () => {
    const { key, session } = await arrives({
      threadId: 'g-1',
      from: `Pat <${PRINCIPAL}>`,
      principal: true,
      cc: [SAM],
      body: 'Juno, please find Sam and me a time.',
    });

    await reply(session, key, `Come by ${HOME} at noon.`);
    expect(refusals(session)).toEqual([expect.stringMatching(/private address/u)]);
    expect(refusalOf(await emailSend(session, { to: [PRINCIPAL], cc: [SAM], text: `Come by ${HOME}.` }))).toMatch(
      /private address/u,
    );
    expect(gmail.sent).toEqual([]);

    // Replying to all put the principal alone on To, and Sam on Cc.
    await reply(session, key, 'Tuesday at 10 works.');
    expect(gmail.sent.map((sent) => [sent.to, sent.cc])).toEqual([[[PRINCIPAL], [SAM]]]);
  });

  it('starting a thread passes both guards too', async () => {
    const { session } = await handedOver([REMY]);
    await emailSend(session, { subject: 'Lunch', text: `We could meet at ${HOME}.` });
    await emailSend(session, { subject: 'Lunch', to: [STRANGER], text: 'Hello.' });
    expect(gmail.sent).toEqual([]);
    await emailSend(session, { subject: 'Lunch', text: 'Hello.' });
    expect(gmail.sent.map((sent) => sent.to)).toEqual([[REMY]]);
  });
});

// ---------------------------------------------------------------------------
// Google links (Slice 6 R4, KTD4, KTD5)
// ---------------------------------------------------------------------------

describe('a Google link in an email to outsiders', () => {
  const DOC = 'application/vnd.google-apps.document';
  const docUrl = (id: string) => `https://docs.google.com/document/d/${id}/edit`;
  const driveReads = () => drive.calls.filter((call) => call.op !== 'createFile' && call.op !== 'createPermission');

  /** A file the assistant made, shared with these people. */
  async function shared(name: string, people: readonly string[]): Promise<string> {
    const { id } = await drive.createFile({ name, mimeType: DOC });
    for (const person of people) await drive.createPermission(id, { emailAddress: person, role: 'reader' });
    return id;
  }

  it('is refused when one of three recipients cannot open it, telling external-email only who, and to tell main', async () => {
    const { key, session } = await arrives({ threadId: 'g-1', from: SAM, cc: [JANE, SALES], body: 'Agenda?' });
    const agenda = await shared('Acme agenda', [SAM, JANE]);

    await reply(session, key, `Here it is: ${docUrl(agenda)}`);
    expect(gmail.sent).toEqual([]);
    expect(refusals(session)).toEqual([
      `Your message was not sent: ${SALES} can't open a Google link in it. Tell main which link, and who can't open it.`,
    ]);
    expect(refusalOf(await emailSend(session, { text: `The agenda: ${docUrl(agenda)}` }))).toBe(
      `Your email was not sent: ${SALES} can't open a Google link in it. Tell main which link, and who can't open it.`,
    );

    await drive.createPermission(agenda, { emailAddress: SALES, role: 'reader' });
    await reply(session, key, `Here it is: ${docUrl(agenda)}`);
    expect(gmail.sent).toHaveLength(1);
    expect(gmail.sent[0].text).toContain(docUrl(agenda));
  });

  it('meets the private-values check first, and the link check reads the email written again', async () => {
    const { key, session } = await arrives({ threadId: 'g-1', from: SAM, body: 'Where do we meet?' });
    const directions = await shared('Directions', []);

    await reply(session, key, `Come to ${HOME}; directions: ${docUrl(directions)}`);
    expect(refusals(session)).toEqual([expect.stringMatching(/private address/u)]);
    expect(driveReads()).toEqual([]);

    await reply(session, key, `Directions: ${docUrl(directions)}`);
    expect(refusals(session)).toEqual([
      expect.stringMatching(/private address/u),
      `Your message was not sent: ${SAM} can't open a Google link in it. Tell main which link, and who can't open it.`,
    ]);
    expect(gmail.sent).toEqual([]);
  });

  it('reads only what the assistant wrote: a link in the quoted email is theirs, and no link means no Drive call', async () => {
    const { key, session } = await arrives({
      threadId: 'g-1',
      from: SAM,
      body: 'Our deck: https://docs.google.com/presentation/d/1SamAcmeDeck/edit',
    });
    await reply(session, key, 'Thank you, Pat will take a look.');
    expect(gmail.sent).toHaveLength(1);
    expect(gmail.sent[0].text).toContain('1SamAcmeDeck');
    expect(drive.calls).toEqual([]);
    expect(workspace.visits).toEqual([]);
  });

  it("waits for delivery's retry when Drive is briefly down, and email_send says to try again shortly", async () => {
    const { key, session } = await arrives({ threadId: 'g-1', from: SAM, body: 'Agenda?' });
    const agenda = await shared('Acme agenda', [SAM]);

    for (let attempt = 0; attempt < 3; attempt += 1)
      drive.failNext('getFile', new GoogleApiError(503, 'Backend Error'));
    const id = await reply(session, key, `Here it is: ${docUrl(agenda)}`);
    expect(gmail.sent).toEqual([]);
    expect(refusals(session)).toEqual([]);
    expect(deliveryStatus(session, id)).toBeUndefined();
    // Drive answers on delivery's next pass.
    await deliverSessionMessages(session);
    expect(deliveryStatus(session, id)).toBe('delivered');
    expect(gmail.sent).toHaveLength(1);

    for (let attempt = 0; attempt < 3; attempt += 1)
      drive.failNext('getFile', new GoogleApiError(503, 'Backend Error'));
    expect(refusalOf(await emailSend(session, { text: `Again: ${docUrl(agenda)}` }))).toBe(
      `Your email was not sent: ${LINKS_UNCHECKED}`,
    );
    expect(gmail.sent).toHaveLength(1);
  });

  it('never checks what main sends the principal: its email carries any Google link untouched', async () => {
    gmail.receive({
      threadId: 'g-p',
      from: `Pat <${PRINCIPAL}>`,
      principal: true,
      subject: 'Fwd: Agenda',
      body: 'Juno, take a look.',
    });
    await inbox.tick();
    const agenda = await shared('Agenda', []);
    expect(
      await emailSend(main, { thread_key: await threadOf('g-p'), text: `Here it is: ${docUrl(agenda)}` }),
    ).toMatchObject({ ok: true });
    expect(gmail.sent.map((sent) => sent.to)).toEqual([[PRINCIPAL]]);
    expect(driveReads()).toEqual([]);
    expect(workspace.visits).toEqual([]);
  });

  it('does not check the principal when they are on an email to outsiders', async () => {
    const { key, session } = await arrives({
      threadId: 'g-1',
      from: `Pat <${PRINCIPAL}>`,
      principal: true,
      cc: [SAM],
      body: 'Juno, send Sam the agenda.',
    });
    const agenda = await shared('Agenda', [SAM]);
    await reply(session, key, `Sam, the agenda: ${docUrl(agenda)}`);
    expect(gmail.sent.map((sent) => [sent.to, sent.cc])).toEqual([[[PRINCIPAL], [SAM]]]);
  });
});
