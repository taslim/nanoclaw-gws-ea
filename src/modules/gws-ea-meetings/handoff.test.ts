/**
 * The typed handoff between `main` and `external-email` (KTD5; R7, R8, R16,
 * R19, R20, R21, R23, R26).
 *
 * Drives the real delivery actions, guards, router, inbox channel, privacy
 * guard, people store and session DBs against an in-memory Gmail and Google
 * Calendar. Only the container runtime and its wake are mocked. U12's
 * bookings and offered slots are written directly, as its tools will.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-test-gws-ea-meetings';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-gws-ea-meetings',
    GROUPS_DIR: '/tmp/nanoclaw-test-gws-ea-meetings/groups',
  };
});

vi.mock('../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-runner.js')>()),
  getContainerStartedAtMs: vi.fn(() => Date.now()),
  isContainerRunning: vi.fn(() => false),
  killContainer: vi.fn(),
  wakeContainer: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn().mockResolvedValue(true) }));

/** The test's Google Calendar, swapped in per test behind the module's own client. */
const google = vi.hoisted(() => ({ calendar: undefined as unknown }));
vi.mock('./calendar-api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./calendar-api.js')>();
  const { delegatingCalendarApi } = await import('./testing/fake-calendar.js');
  return {
    ...actual,
    createMeetingsCalendarApi: () =>
      delegatingCalendarApi(() => google.calendar as import('./calendar-api.js').MeetingsCalendarApi),
  };
});

import type { ChannelAdapter, ChannelSetup } from '../../channels/adapter.js';
import {
  createChannelDeliveryAdapter,
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import type { ResponseFrame } from '../../cli/frame.js';
import { dispatch } from '../../cli/dispatch.js';
import { killContainer } from '../../container-runner.js';
import { getDb } from '../../db/connection.js';
import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
import { getSession } from '../../db/sessions.js';
import { deliverSessionMessages, getDeliveryAction, setDeliveryAdapter } from '../../delivery.js';
import { inboundDbPath, outboundDbPath } from '../../mailbox/sqlite/paths.js';
import { requestWake } from '../../request-wake.js';
import { routeInbound } from '../../router.js';
import { resolveSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import '../permissions/index.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { upsertUser } from '../permissions/db/users.js';
import '../gws-ea-profile/index.js';
import {
  addPrincipalAddress,
  bindVerifiedPrincipalUser,
  recordExternalEmailAgentGroupId,
} from '../gws-ea-profile/db.js';
import '../gws-ea-people/index.js';
import { addPerson, addPersonInstruction, forgetPerson, type Person } from '../gws-ea-people/db.js';
import { GOOGLE_GRANT_FILE_ENV } from '../gws-ea-google/grant.js';
import '../gws-ea-privacy/index.js';
import { addPrivateValue } from '../gws-ea-privacy/db.js';
import '../gws-ea-external-email/index.js';
import {
  createInbox,
  EMAIL_CHANNEL_DEFAULTS,
  ensureInbox,
  getThreadParticipants,
  GoogleApiError,
  INBOX_PLATFORM_ID,
  type GmailApi,
  type GmailHistoryRecord,
  type GmailMessage,
  type GmailMessageRef,
  type Inbox,
} from '../gws-ea-inbox/index.js';
import { consumeOwnCalendarChange } from '../gws-ea-inbox/calendar-notifications.js';
import { getMeeting, type Meeting } from './index.js';
import { FakeCalendar, type StoredEvent } from './testing/fake-calendar.js';

const ROBIN = 'robin@assistant.example';
const PRINCIPAL = 'pat@principal.example';
const PRINCIPAL_USER = 'gchat:users/pat';
const SAM = 'sam@acme.example';
const SALES = 'sales@acme.example';
const DANA = 'dana@friends.example';
const OLU = 'olu@partner.example';
const LEE = 'lee@stranger.example';
const TEAM_CALENDAR = 'team@group.calendar.google.com';
const READ_ONLY_CALENDAR = 'holidays@group.calendar.google.com';
const COLLEAGUE_CALENDAR = 'kim@principal.example';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// An in-memory Gmail: enough to copy Robin in, hold mail, and send replies
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
  readonly principal?: boolean;
}

interface SentMail {
  readonly id: string;
  readonly threadId: string;
  readonly headers: Header[];
  readonly text: string;
}

function header(headers: readonly Header[], name: string): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function parseRaw(raw: string): { headers: Header[]; text: string } {
  const source = Buffer.from(raw, 'base64url').toString('utf8');
  const split = source.indexOf('\r\n\r\n');
  const head = source.slice(0, split).replace(/\r\n[ \t]+/g, ' ');
  const headers = head.split('\r\n').map((line) => {
    const colon = line.indexOf(':');
    return { name: line.slice(0, colon), value: line.slice(colon + 1).trim() };
  });
  const body = source.slice(split + 4).replace(/\r\n/g, '');
  return { headers, text: Buffer.from(body, 'base64').toString('utf8') };
}

class FakeGmail implements GmailApi {
  historyId = 1000;
  readonly messages = new Map<string, GmailMessage>();
  readonly history: GmailHistoryRecord[] = [];
  readonly sent: SentMail[] = [];
  private nextId = 1;

  receive(mail: IncomingMail): string {
    const id = `m${this.nextId++}`;
    const threadId = mail.threadId ?? `t${this.nextId++}`;
    const domain = mail.from.slice(mail.from.lastIndexOf('@') + 1).replace('>', '');
    const auth = mail.principal
      ? `mx.google.com;\r\n dkim=pass header.i=@${domain} header.s=google header.b=a;\r\n dmarc=pass (p=REJECT) header.from=${domain}`
      : `mx.google.com;\r\n dkim=pass header.i=@${domain} header.s=s1 header.b=a;\r\n dmarc=pass (p=NONE) header.from=${domain}`;
    const headers: Header[] = [
      { name: 'Delivered-To', value: ROBIN },
      { name: 'Received', value: 'from mail.example by mx.google.com with ESMTPS id y' },
      { name: 'Authentication-Results', value: auth },
      { name: 'From', value: mail.from },
      { name: 'To', value: (mail.to ?? [ROBIN]).join(', ') },
      ...(mail.cc ? [{ name: 'Cc', value: mail.cc.join(', ') }] : []),
      { name: 'Subject', value: mail.subject ?? 'Hello' },
      { name: 'Message-ID', value: `<${id}@mail.example>` },
    ];
    this.messages.set(id, {
      id,
      threadId,
      labelIds: ['INBOX', 'UNREAD'],
      internalDate: String(Date.now()),
      payload: {
        mimeType: 'text/plain',
        headers,
        body: { data: Buffer.from(mail.body ?? 'Hi', 'utf8').toString('base64url') },
      },
    });
    this.historyId += 1;
    this.history.push({
      id: String(this.historyId),
      messagesAdded: [{ message: { id, threadId, labelIds: ['INBOX', 'UNREAD'] } }],
    });
    return id;
  }

  async getProfile() {
    return { emailAddress: ROBIN, historyId: String(this.historyId) };
  }

  async listHistory(input: { startHistoryId: string }) {
    const start = Number(input.startHistoryId);
    return { history: this.history.filter((r) => Number(r.id) > start), historyId: String(this.historyId) };
  }

  async getMessage(id: string) {
    return this.messages.get(id);
  }

  async listMessages(input: { maxResults: number }): Promise<GmailMessageRef[]> {
    return [...this.messages.values()]
      .reverse()
      .slice(0, input.maxResults)
      .map((m) => ({ id: m.id, threadId: m.threadId }));
  }

  async getThread(id: string) {
    const messages = [...this.messages.values()].filter((m) => m.threadId === id);
    return messages.length > 0 ? messages : undefined;
  }

  async send(input: { raw: string; threadId?: string }) {
    const id = `s${this.nextId++}`;
    const threadId = input.threadId ?? `t${this.nextId++}`;
    const { headers, text } = parseRaw(input.raw);
    this.messages.set(id, { id, threadId, labelIds: ['SENT'], payload: { mimeType: 'text/plain', headers } });
    this.sent.push({ id, threadId, headers, text });
    return { id, threadId };
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let gmail: FakeGmail;
let calendar: FakeCalendar;
let inbox: Inbox;
let main: Session;
let sam: Person;
let dana: Person;
let olu: Person;
let requestCount = 0;

function now(): string {
  return new Date().toISOString();
}

/** A UTC instant `days` from today, `hours` (fractions too) after midnight. */
function inDays(days: number, hours = 0): string {
  const midnight = new Date(Date.now() + days * DAY);
  midnight.setUTCHours(0, 0, 0, 0);
  return new Date(midnight.getTime() + hours * HOUR).toISOString();
}

const WINDOW = { window_start: inDays(7, 9), window_end: inDays(11, 17) };

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

function chatAdapter(): ChannelAdapter {
  return {
    name: 'gchat',
    channelType: 'gchat',
    supportsThreads: false,
    async setup() {},
    async teardown() {},
    isConnected: () => true,
    async deliver() {
      return 'chat-message';
    },
  };
}

interface InboundRow {
  id: string;
  kind: string;
  trigger: number;
  thread_id: string | null;
  content: string;
}

function inbound(session: Session): InboundRow[] {
  const file = inboundDbPath(session.agent_group_id, session.id);
  if (!fs.existsSync(file)) return [];
  const db = new Database(file, { readonly: true });
  const rows = db
    .prepare('SELECT id, kind, trigger, thread_id, content FROM messages_in ORDER BY seq')
    .all() as InboundRow[];
  db.close();
  return rows;
}

interface Content {
  text?: string;
  sender?: string;
  type?: string;
  requestId?: string;
  frame?: ResponseFrame;
  note?: { type: string; [key: string]: unknown };
  brief?: { type: string; meeting_id: string; version: number; [key: string]: unknown };
}

function contents(session: Session): Array<Content & { row: InboundRow }> {
  return inbound(session).map((row) => ({ ...(JSON.parse(row.content) as Content), row }));
}

/** What a tool reads back: the session's `action_response` for one request. */
function responses(session: Session, requestId: string): ResponseFrame[] {
  return contents(session)
    .filter((c) => c.type === 'action_response' && c.requestId === requestId)
    .map((c) => c.frame as ResponseFrame);
}

function meetingNotes(outcome?: string) {
  return contents(main).filter(
    (c) => c.note?.type === 'gws-ea-meetings.outcome' && (outcome === undefined || c.note.outcome === outcome),
  );
}

function briefs(session: Session) {
  return contents(session).filter((c) => c.brief !== undefined);
}

/** Send one typed request from a session, as delivery does, and read its answer. */
async function ask(
  session: Session,
  action: string,
  fields: Record<string, unknown>,
  requestId = `req-${++requestCount}`,
): Promise<ResponseFrame> {
  const handler = getDeliveryAction(action);
  if (!handler) throw new Error(`no delivery action ${action}`);
  await handler({ action, requestId, ...fields }, session);
  const answers = responses(session, requestId);
  expect(answers).toHaveLength(1);
  return answers[0];
}

function data(frame: ResponseFrame): Record<string, unknown> {
  if (!frame.ok) throw new Error(`refused: ${frame.error.message}`);
  return frame.data as Record<string, unknown>;
}

function refusal(frame: ResponseFrame): string {
  if (frame.ok) throw new Error(`accepted: ${JSON.stringify(frame.data)}`);
  return frame.error.message;
}

async function meeting(id: unknown): Promise<Meeting> {
  const found = await getMeeting(String(id));
  if (!found) throw new Error(`no meeting ${String(id)}`);
  return found;
}

async function meetingSession(id: unknown): Promise<Session> {
  const { session_id } = await meeting(id);
  const session = session_id === null ? undefined : await getSession(session_id);
  if (!session) throw new Error(`meeting ${String(id)} has no session`);
  return session;
}

function arrangeWith(person: Person, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    people: [{ person_id: person.id }],
    calendar_id: PRINCIPAL,
    length_minutes: 30,
    ...WINDOW,
    purpose: 'Partnership intro',
    constraints: 'Mornings suit the principal best.',
    ...extra,
  };
}

function queueReply(session: Session, id: string, text: string, threadKey: string): void {
  const db = new Database(outboundDbPath(session.agent_group_id, session.id));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, content)
     VALUES (?, ?, 'chat', ?, 'email', ?, ?)`,
  ).run(id, now(), INBOX_PLATFORM_ID, threadKey, JSON.stringify({ text }));
  db.close();
}

async function reply(session: Session, threadKey: string, text: string): Promise<void> {
  queueReply(session, `out-${Math.random().toString(36).slice(2)}`, text, threadKey);
  await deliverSessionMessages(session);
}

async function count(table: string): Promise<number> {
  const row = await getDb().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return row?.n ?? 0;
}

async function recordBooking(meetingId: string, start: string, end: string, eventId = 'robin-booked-1') {
  await getDb().run(
    `INSERT INTO gws_ea_meeting_bookings (meeting_id, calendar_id, event_id, start_at, end_at, booked_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    meetingId,
    PRINCIPAL,
    eventId,
    start,
    end,
    now(),
  );
}

async function startInbox(): Promise<void> {
  await teardownChannelAdapters();
  inbox = createInbox({
    gmail,
    calendar: { list: async () => [...calendar.calendars.values()], patchNotifications: async () => undefined },
    sleep: async () => undefined,
  });
  registerChannelAdapter('email', { factory: () => inbox.adapter, defaults: EMAIL_CHANNEL_DEFAULTS });
  registerChannelAdapter('gchat', { factory: chatAdapter });
  await initChannelAdapters(() => hostSetup);
  setDeliveryAdapter(createChannelDeliveryAdapter());
}

/** The principal copies Robin into a thread with Acme Sales; returns the thread key from main's note. */
async function copyRobinIn(): Promise<string> {
  gmail.receive({
    threadId: 'g-acme',
    from: `Pat <${PRINCIPAL}>`,
    principal: true,
    to: [`Acme Sales <${SALES}>`],
    cc: [`Robin <${ROBIN}>`],
    subject: 'Partnership',
    body: 'Adding my assistant to find 45 minutes for us next week.',
  });
  await inbox.tick();
  const copyIn = contents(main).find((c) => c.note?.type === 'gws-ea-inbox.copy-in');
  if (!copyIn) throw new Error('no copy-in note');
  return String(copyIn.note?.thread_key);
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  vi.mocked(requestWake).mockClear();
  vi.mocked(killContainer).mockClear();

  for (const [id, name] of [
    ['ag-main', 'main'],
    ['ag-external', 'external-email'],
    ['ag-other', 'other'],
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
  await createMessagingGroup({
    id: 'mg-other',
    channel_type: 'gchat',
    platform_id: 'spaces/other',
    name: 'other',
    is_group: 1,
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
        SET main_agent_group_id = 'ag-main', assistant_display_name = 'Robin', assistant_workspace_email = ?,
            principal_display_name = 'Pat Doe', principal_timezone = 'Europe/London'
      WHERE singleton = 1`,
    ROBIN,
  );
  await recordExternalEmailAgentGroupId('ag-external');
  await addPrincipalAddress(PRINCIPAL);
  const pinned = await dispatch(
    { id: 'pin', command: 'dkim-selectors-pin', args: { domain: 'principal.example', selector: 'google' } },
    { caller: 'host' },
  );
  expect(pinned.ok).toBe(true);

  sam = await addPerson({
    name: 'Sam Lee',
    level: 'active',
    source: 'principal',
    basis: 'a frequent collaborator',
    identity: `email:${SAM}`,
    organization: 'Acme Holdings',
    notes: 'Has a dog called Rexford',
  });
  await addPersonInstruction({ id: sam.id, text: 'Never book Sam on Fridays', source: 'principal' });
  dana = await addPerson({
    name: 'Dana Fox',
    level: 'close',
    source: 'principal',
    basis: 'an old friend',
    identity: `email:${DANA}`,
  });
  olu = await addPerson({
    name: 'Olu Ade',
    level: 'known',
    source: 'principal',
    basis: 'met once',
    identity: `email:${OLU}`,
  });

  gmail = new FakeGmail();
  calendar = new FakeCalendar();
  google.calendar = calendar;
  calendar.calendars.set(PRINCIPAL, { id: PRINCIPAL, accessRole: 'writer', primary: false });
  calendar.calendars.set(TEAM_CALENDAR, { id: TEAM_CALENDAR, accessRole: 'owner', dataOwner: PRINCIPAL });
  calendar.calendars.set(READ_ONLY_CALENDAR, { id: READ_ONLY_CALENDAR, accessRole: 'reader', dataOwner: PRINCIPAL });
  calendar.calendars.set(COLLEAGUE_CALENDAR, { id: COLLEAGUE_CALENDAR, accessRole: 'writer' });

  await ensureInbox('ag-external');
  await startInbox();
  main = (await resolveSession('ag-main', 'mg-dm', null, 'agent-shared')).session;
  await inbox.tick();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

// ---------------------------------------------------------------------------
// arrange
// ---------------------------------------------------------------------------

describe('arrange', () => {
  it("stores the meeting at its counterpart's level and opens a session whose first message is the brief", async () => {
    const answer = data(await ask(main, 'meeting_arrange', arrangeWith(sam)));
    expect(answer).toMatchObject({ level: 'active' });

    const stored = await meeting(answer.meeting_id);
    expect(stored).toMatchObject({
      kind: 'arrange',
      state: 'active',
      level: 'active',
      booking_calendar_id: PRINCIPAL,
      length_minutes: 30,
      purpose: 'Partnership intro',
    });
    expect(stored.counterparts).toEqual([{ address: SAM, person_id: sam.id, name: 'Sam Lee', level: 'active' }]);

    const session = await meetingSession(answer.meeting_id);
    expect(session.agent_group_id).toBe('ag-external');
    const [first, ...rest] = contents(session);
    expect(rest).toEqual([]);
    expect(first.sender).toBe('system');
    expect(first.row.thread_id).toBe(stored.thread_key);
    expect(first.brief).toMatchObject({ type: 'gws-ea-meetings.brief', meeting_id: stored.id, version: 1 });
    for (const shown of ['Sam Lee', SAM, 'active', '30', 'Partnership intro', 'Mornings suit the principal best.']) {
      expect(first.text).toContain(shown);
    }
    // Nothing else from the people store, and no event details.
    for (const hidden of ['Acme Holdings', 'Rexford', 'Fridays', 'a frequent collaborator']) {
      expect(first.text).not.toContain(hidden);
      expect(first.row.content).not.toContain(hidden);
    }
    expect(vi.mocked(requestWake)).toHaveBeenCalledWith(expect.objectContaining({ id: session.id }), 'inbound-message');

    const thread = await getThreadParticipants(stored.thread_key);
    expect(thread).toMatchObject({ origin: 'arrange', state: 'open', counterparts: [SAM] });
  });

  it('takes the lowest level among several counterparts', async () => {
    const answer = data(
      await ask(
        main,
        'meeting_arrange',
        arrangeWith(dana, { people: [{ person_id: dana.id }, { person_id: olu.id }] }),
      ),
    );
    expect((await meeting(answer.meeting_id)).level).toBe('known');
  });

  it("refuses a calendar that is not the principal's or that the assistant cannot write to", async () => {
    for (const calendarId of [COLLEAGUE_CALENDAR, READ_ONLY_CALENDAR, 'missing@group.calendar.google.com']) {
      const message = refusal(await ask(main, 'meeting_arrange', arrangeWith(sam, { calendar_id: calendarId })));
      expect(message).toMatch(/calendar/i);
    }
    expect(data(await ask(main, 'meeting_arrange', arrangeWith(sam, { calendar_id: TEAM_CALENDAR })))).toMatchObject({
      level: 'active',
    });
    expect(await count('gws_ea_meetings')).toBe(1);
  });

  it("refuses a purpose or constraints that carry the principal's private value, before external-email sees them", async () => {
    await addPrivateValue({ label: 'Home', kind: 'address', value: '12 Elm Road, Springfield' });
    const message = refusal(
      await ask(main, 'meeting_arrange', arrangeWith(sam, { constraints: 'Meet near 12 Elm Rd Springfield.' })),
    );
    expect(message).toContain('address');
    expect(message).not.toContain('Elm');
    expect(await count('gws_ea_meetings')).toBe(0);
    expect(await count('gws_ea_inbox_threads')).toBe(0);
  });

  it('refuses a person with no record and a window that has already ended', async () => {
    refusal(await ask(main, 'meeting_arrange', arrangeWith(sam, { people: [{ person_id: 'p-000000000000' }] })));
    refusal(
      await ask(main, 'meeting_arrange', arrangeWith(sam, { window_start: inDays(-3, 9), window_end: inDays(-1, 17) })),
    );
    expect(await count('gws_ea_meetings')).toBe(0);
  });

  it('binds a copied-in thread, takes its counterparts from the principal’s message, and never its length or window from counterpart mail', async () => {
    const threadKey = await copyRobinIn();
    gmail.receive({
      threadId: 'g-acme',
      from: `Acme Sales <${SALES}>`,
      to: [PRINCIPAL],
      cc: [ROBIN],
      subject: 'Re: Partnership',
      body: 'Let us do two hours sometime next month instead.',
    });
    await inbox.tick();

    refusal(
      await ask(main, 'meeting_arrange', {
        ...arrangeWith(sam),
        thread_key: threadKey,
      }),
    );

    const fields = {
      thread_key: threadKey,
      calendar_id: PRINCIPAL,
      length_minutes: 45,
      ...WINDOW,
      purpose: 'Partnership follow-up',
    };
    const answer = data(await ask(main, 'meeting_arrange', fields));
    expect(answer.thread_key).toBe(threadKey);
    const stored = await meeting(answer.meeting_id);
    expect(stored.counterparts).toEqual([{ address: SALES, person_id: null, name: null, level: 'unknown' }]);
    expect(stored).toMatchObject({
      level: 'unknown',
      length_minutes: 45,
      window_start: WINDOW.window_start,
      window_end: WINDOW.window_end,
      thread_key: threadKey,
    });

    const session = await meetingSession(answer.meeting_id);
    const [first, second] = contents(session);
    expect(first.brief?.meeting_id).toBe(stored.id);
    expect(first.text).toContain('copied you into');
    expect(second.text).toContain('two hours sometime next month');
    expect(await getThreadParticipants(threadKey)).toMatchObject({ state: 'open' });
  });

  it('is refused to every caller but main', async () => {
    const other = (await resolveSession('ag-other', 'mg-other', null, 'shared')).session;
    expect(refusal(await ask(other, 'meeting_arrange', arrangeWith(sam)))).toMatch(/main/);

    const answer = data(await ask(main, 'meeting_arrange', arrangeWith(sam)));
    const external = await meetingSession(answer.meeting_id);
    expect(refusal(await ask(external, 'meeting_arrange', arrangeWith(dana)))).toMatch(/main/);
    expect(await count('gws_ea_meetings')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Replays and errors
// ---------------------------------------------------------------------------

describe('a request replayed after a host restart', () => {
  it('returns the first result: no second meeting, thread, brief or note', async () => {
    const arranged = await ask(main, 'meeting_arrange', arrangeWith(sam), 'req-arrange');
    const handler = getDeliveryAction('meeting_arrange');
    await handler?.({ action: 'meeting_arrange', requestId: 'req-arrange', ...arrangeWith(sam) }, main);
    expect(responses(main, 'req-arrange')).toEqual([arranged]);
    expect(await count('gws_ea_meetings')).toBe(1);
    expect(await count('gws_ea_inbox_threads')).toBe(1);
    const session = await meetingSession(data(arranged).meeting_id);
    expect(briefs(session)).toHaveLength(1);

    const meetingId = String(data(arranged).meeting_id);
    await recordBooking(meetingId, inDays(8, 10), inDays(8, 10.5));
    const booked = await ask(session, 'meeting_outcome', { meeting_id: meetingId, outcome: 'booked' }, 'req-booked');
    await getDeliveryAction('meeting_outcome')?.(
      { action: 'meeting_outcome', requestId: 'req-booked', meeting_id: meetingId, outcome: 'booked' },
      session,
    );
    expect(responses(session, 'req-booked')).toEqual([booked]);
    // The same outcome sent again as a new request is recorded once too.
    expect(data(await ask(session, 'meeting_outcome', { meeting_id: meetingId, outcome: 'booked' }))).toEqual(
      data(booked),
    );
    expect(meetingNotes('booked')).toHaveLength(1);
  });

  it('returns the first result for reschedule and ask_organizer too', async () => {
    calendar.put(principalEvent('evt-review', OLU));
    calendar.put(invitation('evt-invite', OLU));
    const rescheduleFields = {
      calendar_id: PRINCIPAL,
      event_id: 'evt-review',
      ...WINDOW,
      purpose: 'Moving the review',
    };
    const askFields = { calendar_id: PRINCIPAL, event_id: 'evt-invite', ...WINDOW, purpose: 'Your Tuesday invitation' };

    const moved = await ask(main, 'meeting_reschedule', rescheduleFields, 'req-move');
    const asked = await ask(main, 'meeting_ask_organizer', askFields, 'req-ask');
    await getDeliveryAction('meeting_reschedule')?.(
      { action: 'meeting_reschedule', requestId: 'req-move', ...rescheduleFields },
      main,
    );
    await getDeliveryAction('meeting_ask_organizer')?.(
      { action: 'meeting_ask_organizer', requestId: 'req-ask', ...askFields },
      main,
    );
    expect(responses(main, 'req-move')).toEqual([moved]);
    expect(responses(main, 'req-ask')).toEqual([asked]);
    expect(await count('gws_ea_meetings')).toBe(2);
    expect(await count('gws_ea_inbox_threads')).toBe(2);
  });

  it('answers a failed request with its error once, and never runs it again as a new side effect', async () => {
    calendar.failure = new GoogleApiError(503, 'Google refused /calendar: backend error');
    const failed = await ask(main, 'meeting_arrange', arrangeWith(sam), 'req-fails');
    expect(failed).toMatchObject({ ok: false, error: { code: 'handler-error' } });
    const callsAfterFailure = calendar.calls;

    calendar.failure = undefined;
    await getDeliveryAction('meeting_arrange')?.(
      { action: 'meeting_arrange', requestId: 'req-fails', ...arrangeWith(sam) },
      main,
    );
    expect(responses(main, 'req-fails')).toEqual([failed]);
    expect(calendar.calls).toBe(callsAfterFailure);
    expect(await count('gws_ea_meetings')).toBe(0);
    expect(await count('gws_ea_inbox_threads')).toBe(0);
  });

  it('answers a request delivered from the outbound mailbox, and marks it delivered', async () => {
    const db = new Database(outboundDbPath(main.agent_group_id, main.id));
    db.prepare(`INSERT INTO messages_out (id, timestamp, kind, content) VALUES (?, ?, 'system', ?)`).run(
      'req-mailbox',
      now(),
      JSON.stringify({ action: 'meeting_arrange', requestId: 'req-mailbox', ...arrangeWith(sam) }),
    );
    db.close();
    await deliverSessionMessages(main);
    await deliverSessionMessages(main);
    expect(responses(main, 'req-mailbox')).toHaveLength(1);
    expect(responses(main, 'req-mailbox')[0]).toMatchObject({ ok: true });
    expect(await count('gws_ea_meetings')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// outcome
// ---------------------------------------------------------------------------

describe('outcome', () => {
  it('is refused from main, from another group, and from a session bound to a different meeting', async () => {
    const first = data(await ask(main, 'meeting_arrange', arrangeWith(sam)));
    const second = data(await ask(main, 'meeting_arrange', arrangeWith(dana)));
    const secondSession = await meetingSession(second.meeting_id);
    const other = (await resolveSession('ag-other', 'mg-other', null, 'shared')).session;

    for (const caller of [main, other, secondSession]) {
      refusal(await ask(caller, 'meeting_outcome', { meeting_id: first.meeting_id, outcome: 'gave-up' }));
    }
    expect((await meeting(first.meeting_id)).state).toBe('active');
    expect(meetingNotes()).toHaveLength(0);
  });

  it('accepts booked only after the host’s own booking, and tells main in a note it turns into one line (R26)', async () => {
    const answer = data(await ask(main, 'meeting_arrange', arrangeWith(sam)));
    const session = await meetingSession(answer.meeting_id);

    expect(
      refusal(await ask(session, 'meeting_outcome', { meeting_id: answer.meeting_id, outcome: 'booked' })),
    ).toMatch(/book/);
    expect(meetingNotes()).toHaveLength(0);

    await recordBooking(String(answer.meeting_id), inDays(8, 10), inDays(8, 10.5));
    vi.mocked(requestWake).mockClear();
    data(await ask(session, 'meeting_outcome', { meeting_id: answer.meeting_id, outcome: 'booked' }));

    const stored = await meeting(answer.meeting_id);
    expect(stored.state).toBe('booked');
    const [note] = meetingNotes('booked');
    expect(note.note).toMatchObject({
      meeting_id: answer.meeting_id,
      outcome: 'booked',
      booking: { calendar_id: PRINCIPAL, event_id: 'robin-booked-1' },
    });
    expect(note.text).toContain('Sam Lee');
    expect(note.text).toContain('one line');
    expect(note.row.trigger).toBe(1);
    expect(vi.mocked(requestWake)).toHaveBeenCalledWith(expect.objectContaining({ id: main.id }), 'inbound-message');
    // The session stays open after booking, so a later "can we move it?" lands there.
    expect((await getSession(session.id))?.status).toBe('active');
  });

  it('refuses needs-room for an active or known meeting, and accepts it for a close one', async () => {
    for (const person of [sam, olu]) {
      const answer = data(await ask(main, 'meeting_arrange', arrangeWith(person)));
      const session = await meetingSession(answer.meeting_id);
      expect(
        refusal(await ask(session, 'meeting_outcome', { meeting_id: answer.meeting_id, outcome: 'needs-room' })),
      ).toMatch(/close/);
    }
    const close = data(await ask(main, 'meeting_arrange', arrangeWith(dana)));
    const closeSession = await meetingSession(close.meeting_id);
    data(await ask(closeSession, 'meeting_outcome', { meeting_id: close.meeting_id, outcome: 'needs-room' }));
    expect(meetingNotes('needs-room')).toHaveLength(1);
    expect((await meeting(close.meeting_id)).state).toBe('active');
  });

  it('closes a copied-in thread that is not about scheduling, and lets main tell the principal in one line (R19)', async () => {
    const threadKey = await copyRobinIn();
    const answer = data(
      await ask(main, 'meeting_arrange', {
        thread_key: threadKey,
        calendar_id: PRINCIPAL,
        length_minutes: 30,
        ...WINDOW,
        purpose: 'Whatever the principal needs',
      }),
    );
    const session = await meetingSession(answer.meeting_id);
    data(await ask(session, 'meeting_outcome', { meeting_id: answer.meeting_id, outcome: 'not-scheduling' }));

    const [note] = meetingNotes('not-scheduling');
    expect(note.text).toMatch(/can't take it on yet/);
    expect(note.text).toContain('one line');
    expect((await meeting(answer.meeting_id)).state).toBe('not-scheduling');
    expect((await getSession(session.id))?.status).toBe('closed');
    expect(await getThreadParticipants(threadKey)).toMatchObject({ state: 'closed' });
  });

  it('refuses not-scheduling for a thread main opened for scheduling', async () => {
    const answer = data(await ask(main, 'meeting_arrange', arrangeWith(sam)));
    const session = await meetingSession(answer.meeting_id);
    refusal(await ask(session, 'meeting_outcome', { meeting_id: answer.meeting_id, outcome: 'not-scheduling' }));
  });

  it('reports gave-up and closes the session', async () => {
    const answer = data(await ask(main, 'meeting_arrange', arrangeWith(sam)));
    const session = await meetingSession(answer.meeting_id);
    data(await ask(session, 'meeting_outcome', { meeting_id: answer.meeting_id, outcome: 'gave-up' }));
    expect(meetingNotes('gave-up')).toHaveLength(1);
    expect((await getSession(session.id))?.status).toBe('closed');
    expect(
      refusal(await ask(session, 'meeting_outcome', { meeting_id: answer.meeting_id, outcome: 'booked' })),
    ).toMatch(/gave-up/);
  });
});

// ---------------------------------------------------------------------------
// ask_organizer and settled
// ---------------------------------------------------------------------------

function invitation(id: string, organizer: string, startHour = 10, endHour = 11): StoredEvent {
  return {
    calendarId: PRINCIPAL,
    id,
    iCalUID: `${id}@google.com`,
    status: 'confirmed',
    organizer: { email: organizer },
    attendees: [
      { email: organizer, organizer: true, responseStatus: 'accepted' },
      { email: PRINCIPAL, responseStatus: 'needsAction' },
    ],
    start: { dateTime: inDays(9, startHour) },
    end: { dateTime: inDays(9, endHour) },
  };
}

function principalEvent(id: string, attendee: string, startHour = 10, endHour = 11): StoredEvent {
  return {
    calendarId: PRINCIPAL,
    id,
    iCalUID: `${id}@google.com`,
    status: 'confirmed',
    organizer: { email: PRINCIPAL },
    attendees: [
      { email: PRINCIPAL, organizer: true, responseStatus: 'accepted' },
      { email: attendee, responseStatus: 'accepted' },
      { email: 'room-1@resource.calendar.google.com', resource: true, responseStatus: 'accepted' },
    ],
    start: { dateTime: inDays(9, startHour) },
    end: { dateTime: inDays(9, endHour) },
  };
}

describe('ask_organizer', () => {
  it('addresses the organizer Google reports, for the length of their invitation', async () => {
    calendar.put(invitation('evt-invite', OLU, 10, 11));
    const answer = data(
      await ask(main, 'meeting_ask_organizer', {
        calendar_id: PRINCIPAL,
        event_id: 'evt-invite',
        ...WINDOW,
        purpose: 'Your Thursday invitation',
      }),
    );
    const stored = await meeting(answer.meeting_id);
    expect(stored).toMatchObject({
      kind: 'ask_organizer',
      level: 'known',
      length_minutes: 60,
      event_calendar_id: PRINCIPAL,
      event_id: 'evt-invite',
      booking_calendar_id: null,
    });
    expect(stored.counterparts).toEqual([{ address: OLU, person_id: olu.id, name: 'Olu Ade', level: 'known' }]);
    expect(await getThreadParticipants(stored.thread_key)).toMatchObject({
      origin: 'ask_organizer',
      counterparts: [OLU],
    });
  });

  it('is refused for an organizer without a record (R16)', async () => {
    calendar.put(invitation('evt-stranger', LEE));
    const message = refusal(
      await ask(main, 'meeting_ask_organizer', {
        calendar_id: PRINCIPAL,
        event_id: 'evt-stranger',
        ...WINDOW,
        purpose: 'Your invitation',
      }),
    );
    expect(message).toMatch(/record/);
    expect(await count('gws_ea_meetings')).toBe(0);
    expect(await count('gws_ea_inbox_threads')).toBe(0);
  });

  it('accepts settled only once the invitation moved to an offered slot or its conflict cleared', async () => {
    calendar.put(invitation('evt-invite', OLU, 10, 11));
    calendar.put(principalEvent('evt-standup', SAM, 10, 11));
    const answer = data(
      await ask(main, 'meeting_ask_organizer', {
        calendar_id: PRINCIPAL,
        event_id: 'evt-invite',
        ...WINDOW,
        purpose: 'Your Thursday invitation',
      }),
    );
    const meetingId = String(answer.meeting_id);
    const session = await meetingSession(meetingId);

    // Still clashing with the standup: refused.
    expect(refusal(await ask(session, 'meeting_outcome', { meeting_id: meetingId, outcome: 'settled' }))).toMatch(
      /conflict/,
    );

    // Moved, but to a time nobody offered, which still clashes: refused.
    calendar.put(principalEvent('evt-lunch', SAM, 13, 14));
    calendar.put({ ...invitation('evt-invite', OLU, 13, 14) });
    refusal(await ask(session, 'meeting_outcome', { meeting_id: meetingId, outcome: 'settled' }));

    // Moved to a slot external-email offered: accepted.
    await getDb().run(
      `INSERT INTO gws_ea_meeting_slots (meeting_id, slot_id, start_at, end_at, offered_at) VALUES (?, ?, ?, ?, ?)`,
      meetingId,
      'slot-1',
      inDays(9, 15),
      inDays(9, 16),
      now(),
    );
    calendar.put({ ...invitation('evt-invite', OLU, 15, 16) });
    data(await ask(session, 'meeting_outcome', { meeting_id: meetingId, outcome: 'settled' }));
    expect((await meeting(meetingId)).state).toBe('settled');
    expect(meetingNotes('settled')).toHaveLength(1);
    expect((await getSession(session.id))?.status).toBe('closed');
  });

  it('accepts settled when the conflicting event is gone', async () => {
    calendar.put(invitation('evt-invite', OLU, 10, 11));
    calendar.put(principalEvent('evt-standup', SAM, 10, 11));
    const answer = data(
      await ask(main, 'meeting_ask_organizer', {
        calendar_id: PRINCIPAL,
        event_id: 'evt-invite',
        ...WINDOW,
        purpose: 'Your Thursday invitation',
      }),
    );
    const session = await meetingSession(answer.meeting_id);
    calendar.remove(PRINCIPAL, 'evt-standup');
    data(await ask(session, 'meeting_outcome', { meeting_id: answer.meeting_id, outcome: 'settled' }));
  });
});

// ---------------------------------------------------------------------------
// reschedule
// ---------------------------------------------------------------------------

describe('reschedule', () => {
  it('is accepted for a meeting the principal organizes, with its attendees as counterparts', async () => {
    calendar.put(principalEvent('evt-review', SAM, 10, 11));
    const answer = data(
      await ask(main, 'meeting_reschedule', {
        calendar_id: PRINCIPAL,
        event_id: 'evt-review',
        ...WINDOW,
        purpose: 'Moving our review',
      }),
    );
    const stored = await meeting(answer.meeting_id);
    expect(stored).toMatchObject({
      kind: 'reschedule',
      level: 'active',
      length_minutes: 60,
      booking_calendar_id: PRINCIPAL,
      event_calendar_id: PRINCIPAL,
      event_id: 'evt-review',
    });
    expect(stored.counterparts.map((c) => c.address)).toEqual([SAM]);
  });

  it('is refused for a meeting someone else organizes (R8)', async () => {
    calendar.put(invitation('evt-theirs', OLU));
    const message = refusal(
      await ask(main, 'meeting_reschedule', {
        calendar_id: PRINCIPAL,
        event_id: 'evt-theirs',
        ...WINDOW,
        purpose: 'Moving it',
      }),
    );
    expect(message).toMatch(/ask_organizer/);
    expect(await count('gws_ea_meetings')).toBe(0);
  });

  it('continues in the thread of a meeting the assistant booked, which it takes over', async () => {
    const arranged = data(await ask(main, 'meeting_arrange', arrangeWith(sam)));
    const session = await meetingSession(arranged.meeting_id);
    await recordBooking(String(arranged.meeting_id), inDays(8, 10), inDays(8, 10.5), 'robin-booked-1');
    data(await ask(session, 'meeting_outcome', { meeting_id: arranged.meeting_id, outcome: 'booked' }));
    calendar.put({
      ...principalEvent('robin-booked-1', SAM, 10, 11),
      start: { dateTime: inDays(8, 10) },
      end: { dateTime: inDays(8, 10.5) },
    });

    const moved = data(
      await ask(main, 'meeting_reschedule', {
        calendar_id: PRINCIPAL,
        event_id: 'robin-booked-1',
        ...WINDOW,
        purpose: 'Moving our intro',
      }),
    );
    expect((await meeting(arranged.meeting_id)).state).toBe('superseded');
    const stored = await meeting(moved.meeting_id);
    expect(stored).toMatchObject({
      session_id: session.id,
      length_minutes: 30,
      replaces_meeting_id: arranged.meeting_id,
    });
    expect(briefs(session).map((b) => b.brief?.meeting_id)).toEqual([arranged.meeting_id, moved.meeting_id]);
  });
});

// ---------------------------------------------------------------------------
// cancel and amend
// ---------------------------------------------------------------------------

describe('cancel', () => {
  it('releases the meeting, closes its session, sends the counterparts one checked line, and leaves no deadline', async () => {
    const answer = data(await ask(main, 'meeting_arrange', arrangeWith(sam)));
    const stored = await meeting(answer.meeting_id);
    const session = await meetingSession(answer.meeting_id);
    await reply(session, stored.thread_key, 'Hello Sam, I am Robin, Pat Doe’s assistant. Would Tuesday at 10:00 work?');
    expect(gmail.sent).toHaveLength(1);
    await getDb().run(
      'UPDATE gws_ea_meetings SET nudge_at = ?, give_up_at = ? WHERE id = ?',
      inDays(2),
      inDays(4),
      stored.id,
    );

    const cancelled = data(await ask(main, 'meeting_cancel', { meeting_id: stored.id }));
    expect(cancelled).toMatchObject({ state: 'cancelled', counterparts_told: true });

    expect(gmail.sent).toHaveLength(2);
    const line = gmail.sent[1];
    expect(line.threadId).toBe(gmail.sent[0].threadId);
    expect(header(line.headers, 'To')).toBe(SAM);
    expect(line.text.split('\n').filter((l) => l.trim() !== '').length).toBeLessThanOrEqual(2);

    const after = await meeting(stored.id);
    expect(after).toMatchObject({ state: 'cancelled', nudge_at: null, give_up_at: null });
    expect((await getSession(session.id))?.status).toBe('closed');
    expect(vi.mocked(killContainer)).toHaveBeenCalledWith(session.id, expect.any(String));
    expect(await getThreadParticipants(stored.thread_key)).toMatchObject({ state: 'closed' });
    expect(
      await getDb().all('SELECT thread_id FROM gws_ea_privacy_threads WHERE thread_id = ?', stored.thread_key),
    ).toEqual([]);

    // A cancelled meeting takes no more outcomes.
    refusal(await ask(session, 'meeting_outcome', { meeting_id: stored.id, outcome: 'gave-up' }));
  });

  it('checks the line like every send, so a line carrying a private detail is not sent', async () => {
    await addPrivateValue({ label: 'Full name', kind: 'other', value: 'Pat Doe' });
    const answer = data(await ask(main, 'meeting_arrange', arrangeWith(sam)));
    const stored = await meeting(answer.meeting_id);
    const session = await meetingSession(answer.meeting_id);
    await reply(session, stored.thread_key, 'Hello Sam, I am Robin. Would Tuesday at 10:00 work?');
    expect(gmail.sent).toHaveLength(1);

    expect(data(await ask(main, 'meeting_cancel', { meeting_id: stored.id }))).toMatchObject({
      state: 'cancelled',
      counterparts_told: false,
    });
    expect(gmail.sent).toHaveLength(1);
    expect((await getSession(session.id))?.status).toBe('closed');
  });

  it('sends no line to people the assistant has not written to yet', async () => {
    const answer = data(await ask(main, 'meeting_arrange', arrangeWith(sam)));
    expect(data(await ask(main, 'meeting_cancel', { meeting_id: answer.meeting_id }))).toMatchObject({
      counterparts_told: false,
    });
    expect(gmail.sent).toHaveLength(0);
  });
});

describe('cancel for an event the principal organizes (R8)', () => {
  it("deletes it with Google's own cancellation notice to its guests, and no text of the assistant's", async () => {
    calendar.put(principalEvent('evt-review', SAM, 10, 11));
    const answer = data(await ask(main, 'meeting_cancel', { calendar_id: PRINCIPAL, event_id: 'evt-review' }));
    expect(answer).toMatchObject({ calendar_id: PRINCIPAL, event_id: 'evt-review', state: 'cancelled' });
    expect(String(answer.message)).toContain(SAM);
    expect(calendar.writes).toEqual([
      { op: 'delete', calendarId: PRINCIPAL, eventId: 'evt-review', sendUpdates: 'all' },
    ]);
    expect(calendar.event(PRINCIPAL, 'evt-review')?.status).toBe('cancelled');
    // The notification Google sends about it is the assistant's own change.
    expect(consumeOwnCalendarChange(PRINCIPAL, 'evt-review', new Date())).toBe(true);
    expect(gmail.sent).toHaveLength(0);
    expect(await count('gws_ea_meetings')).toBe(0);
  });

  it('refuses an event someone else organizes: ask its organizer instead', async () => {
    calendar.put(invitation('evt-theirs', OLU));
    const message = refusal(await ask(main, 'meeting_cancel', { calendar_id: PRINCIPAL, event_id: 'evt-theirs' }));
    expect(message).toMatch(/ask_organizer/);
    expect(calendar.writes).toEqual([]);
    expect(calendar.event(PRINCIPAL, 'evt-theirs')?.status).toBe('confirmed');
  });

  it('refuses an event on a calendar the assistant cannot change', async () => {
    calendar.put({ ...principalEvent('evt-holiday', SAM), calendarId: READ_ONLY_CALENDAR });
    const message = refusal(
      await ask(main, 'meeting_cancel', { calendar_id: READ_ONLY_CALENDAR, event_id: 'evt-holiday' }),
    );
    expect(message).toMatch(/calendar/i);
    expect(calendar.writes).toEqual([]);
  });

  it('answers a replay with the first result, and deletes nothing twice', async () => {
    calendar.put(principalEvent('evt-review', SAM, 10, 11));
    const fields = { calendar_id: PRINCIPAL, event_id: 'evt-review' };
    const first = await ask(main, 'meeting_cancel', fields, 'req-cancel-event');
    await getDeliveryAction('meeting_cancel')?.(
      { action: 'meeting_cancel', requestId: 'req-cancel-event', ...fields },
      main,
    );
    expect(responses(main, 'req-cancel-event')).toEqual([first]);
    // Asked again as a new request, it is already cancelled.
    expect(data(await ask(main, 'meeting_cancel', fields))).toMatchObject({ state: 'cancelled' });
    expect(calendar.writes.filter((write) => write.op === 'delete')).toHaveLength(1);
  });

  it('ends a meeting the assistant booked as that event, as cancelling the meeting does', async () => {
    const arranged = data(await ask(main, 'meeting_arrange', arrangeWith(sam)));
    const stored = await meeting(arranged.meeting_id);
    const session = await meetingSession(arranged.meeting_id);
    await reply(session, stored.thread_key, 'Hello Sam, I am Robin. Would Tuesday at 10:00 work?');
    await recordBooking(stored.id, inDays(8, 10), inDays(8, 10.5), 'robin-booked-1');
    data(await ask(session, 'meeting_outcome', { meeting_id: stored.id, outcome: 'booked' }));
    calendar.put({
      ...principalEvent('robin-booked-1', SAM),
      start: { dateTime: inDays(8, 10) },
      end: { dateTime: inDays(8, 10.5) },
    });

    const answer = data(await ask(main, 'meeting_cancel', { calendar_id: PRINCIPAL, event_id: 'robin-booked-1' }));
    expect(answer).toMatchObject({ state: 'cancelled', meeting_id: stored.id });
    expect(calendar.event(PRINCIPAL, 'robin-booked-1')?.status).toBe('cancelled');
    expect((await meeting(stored.id)).state).toBe('cancelled');
    expect((await getSession(session.id))?.status).toBe('closed');
    expect(await getThreadParticipants(stored.thread_key)).toMatchObject({ state: 'closed' });
    expect(gmail.sent).toHaveLength(2);
  });
});

describe('amend', () => {
  it('writes a new brief into the meeting’s session', async () => {
    const answer = data(await ask(main, 'meeting_arrange', arrangeWith(sam)));
    const session = await meetingSession(answer.meeting_id);
    vi.mocked(requestWake).mockClear();

    const amended = data(
      await ask(main, 'meeting_amend', {
        meeting_id: answer.meeting_id,
        length_minutes: 60,
        constraints: 'Afternoons now suit better.',
      }),
    );
    expect(amended).toMatchObject({ brief_version: 2 });
    const all = briefs(session);
    expect(all.map((b) => b.brief?.version)).toEqual([1, 2]);
    expect(all[1].text).toContain('60');
    expect(all[1].text).toContain('Afternoons now suit better.');
    expect(await meeting(answer.meeting_id)).toMatchObject({ length_minutes: 60, brief_version: 2 });
    expect(vi.mocked(requestWake)).toHaveBeenCalledWith(expect.objectContaining({ id: session.id }), 'inbound-message');
  });
});

// ---------------------------------------------------------------------------
// Ending a thread from elsewhere
// ---------------------------------------------------------------------------

describe('a thread the privacy check stops', () => {
  it('closes its meeting’s session, so it cannot keep waking its agent', async () => {
    await addPrivateValue({ label: 'Home', kind: 'address', value: '12 Elm Road, Springfield' });
    const answer = data(await ask(main, 'meeting_arrange', arrangeWith(sam)));
    const stored = await meeting(answer.meeting_id);
    const session = await meetingSession(answer.meeting_id);
    for (let attempt = 0; attempt < 3; attempt++) {
      await reply(session, stored.thread_key, 'Come to 12 Elm Road, Springfield.');
    }
    expect(gmail.sent).toHaveLength(0);
    expect((await meeting(stored.id)).state).toBe('stopped');
    expect((await getSession(session.id))?.status).toBe('closed');
    expect(await getThreadParticipants(stored.thread_key)).toMatchObject({ state: 'closed' });
  });
});

describe('forgetting a person', () => {
  it("purges their meetings and their meetings' sessions", async () => {
    const secrets = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-ea-meetings-secrets-'));
    fs.chmodSync(secrets, 0o700);
    vi.stubEnv(GOOGLE_GRANT_FILE_ENV, path.join(secrets, 'google-grant.json'));
    try {
      const answer = data(await ask(main, 'meeting_arrange', arrangeWith(sam)));
      const kept = data(await ask(main, 'meeting_arrange', arrangeWith(dana)));
      const stored = await meeting(answer.meeting_id);
      const session = await meetingSession(answer.meeting_id);

      await forgetPerson({ id: sam.id, source: 'principal' });

      expect(await getMeeting(stored.id)).toBeUndefined();
      expect(await getSession(session.id)).toBeUndefined();
      expect(fs.existsSync(inboundDbPath(session.agent_group_id, session.id))).toBe(false);
      expect(await getThreadParticipants(stored.thread_key)).toMatchObject({ state: 'closed' });
      expect(
        await getDb().all('SELECT request_id FROM gws_ea_meeting_requests WHERE meeting_id = ?', stored.id),
      ).toEqual([]);
      expect(await getMeeting(String(kept.meeting_id))).toBeDefined();
    } finally {
      fs.rmSync(secrets, { recursive: true, force: true });
    }
  });
});
