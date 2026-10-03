/**
 * A whole scheduling assistant for the meetings module's end-to-end tests:
 * `main` in the principal's direct message, `external-email` behind the
 * inbox, the principal and the people they know, Gmail and Google Calendar
 * in memory, and the real delivery actions, guards, router, privacy check,
 * people and preference stores, and session DBs.
 *
 * The test file mocks what this cannot run (the container runtime and its
 * wake, the config paths, and the Calendar client, which it points at
 * `scheduling.calendar`) and fixes the clock; see `follow-through.test.ts`.
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { expect } from 'vitest';

import type { ChannelAdapter, ChannelSetup } from '../../../channels/adapter.js';
import {
  createChannelDeliveryAdapter,
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../../channels/channel-registry.js';
import type { ResponseFrame } from '../../../cli/frame.js';
import { dispatch } from '../../../cli/dispatch.js';
import { getDb } from '../../../db/connection.js';
import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../../../db/index.js';
import { getSession } from '../../../db/sessions.js';
import { deliverSessionMessages, getDeliveryAction, setDeliveryAdapter } from '../../../delivery.js';
import { inboundDbPath, outboundDbPath } from '../../../mailbox/sqlite/paths.js';
import { routeInbound } from '../../../router.js';
import { resolveSession } from '../../../session-manager.js';
import type { Session } from '../../../types.js';
import '../../permissions/index.js';
import { upsertUserDm } from '../../permissions/db/user-dms.js';
import { upsertUser } from '../../permissions/db/users.js';
import '../../gws-ea-profile/index.js';
import {
  addPrincipalAddress,
  bindVerifiedPrincipalUser,
  recordExternalEmailAgentGroupId,
} from '../../gws-ea-profile/db.js';
import '../../gws-ea-people/index.js';
import { addPerson, type Person } from '../../gws-ea-people/db.js';
import '../../gws-ea-preferences/index.js';
import '../../gws-ea-privacy/index.js';
import '../../gws-ea-external-email/index.js';
import {
  createInbox,
  EMAIL_CHANNEL_DEFAULTS,
  ensureInbox,
  INBOX_PLATFORM_ID,
  type Inbox,
} from '../../gws-ea-inbox/index.js';
import { getMeeting, type Meeting } from '../index.js';
import { FakeCalendar } from './fake-calendar.js';
import { FakeGmail } from './fake-gmail.js';

export const ROBIN = 'robin@assistant.example';
export const PRINCIPAL = 'alex@principal.example';
export const PRINCIPAL_USER = 'gchat:users/alex';
export const LONDON = 'Europe/London';

/** The people the principal knows, by their address. */
export const ADDRESSES = {
  acme: 'sales@acme.example',
  pat: 'pat@cafe.example',
  sam: 'sam@studio.example',
  dana: 'dana@friends.example',
  lee: 'lee@friends.example',
  jo: 'jo@family.example',
} as const;

export interface Scheduling {
  readonly gmail: FakeGmail;
  readonly calendar: FakeCalendar;
  readonly inbox: Inbox;
  readonly main: Session;
  /** Acme Sales and Pat Lee are known, Sam Kay active, Dana Fox and Lee Wu close, Jo Fox inner circle. */
  readonly people: Readonly<Record<keyof typeof ADDRESSES, Person>>;
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

function now(): string {
  return new Date().toISOString();
}

/**
 * Build the assistant on a fresh database in `testDir`. `google.calendar` is
 * where the test's mock of the Calendar client looks for the calendar.
 */
export async function setUpScheduling(testDir: string, google: { calendar: unknown }): Promise<Scheduling> {
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
  fs.mkdirSync(testDir, { recursive: true });
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
  await upsertUser({ id: PRINCIPAL_USER, kind: 'gchat', display_name: 'Alex', created_at: now() });
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
            principal_display_name = 'Alex Doe', principal_timezone = ?
      WHERE singleton = 1`,
    ROBIN,
    LONDON,
  );
  await recordExternalEmailAgentGroupId('ag-external');
  await addPrincipalAddress(PRINCIPAL);
  const pinned = await dispatch(
    { id: 'pin', command: 'dkim-selectors-pin', args: { domain: 'principal.example', selector: 'google' } },
    { caller: 'host' },
  );
  expect(pinned.ok).toBe(true);

  const person = (name: string, level: 'inner-circle' | 'close' | 'active' | 'known', address: string) =>
    addPerson({ name, level, source: 'principal', basis: 'a contact', identity: `email:${address}` });
  const people = {
    acme: await person('Acme Sales', 'known', ADDRESSES.acme),
    pat: await person('Pat Lee', 'known', ADDRESSES.pat),
    sam: await person('Sam Kay', 'active', ADDRESSES.sam),
    dana: await person('Dana Fox', 'close', ADDRESSES.dana),
    lee: await person('Lee Wu', 'close', ADDRESSES.lee),
    jo: await person('Jo Fox', 'inner-circle', ADDRESSES.jo),
  };

  const gmail = new FakeGmail(ROBIN);
  const calendar = new FakeCalendar();
  google.calendar = calendar;
  calendar.calendars.set(PRINCIPAL, { id: PRINCIPAL, accessRole: 'writer', primary: false });

  await ensureInbox('ag-external');
  const inbox = await startInbox(gmail, calendar);
  const main = (await resolveSession('ag-main', 'mg-dm', null, 'agent-shared')).session;
  await inbox.tick();
  return { gmail, calendar, inbox, main, people };
}

/**
 * Start the inbox on `gmail` and `calendar`, with the principal's chat, behind
 * the real channel registry and delivery adapter.
 */
export async function startInbox(gmail: FakeGmail, calendar: FakeCalendar): Promise<Inbox> {
  await teardownChannelAdapters();
  const inbox = createInbox({
    gmail,
    calendar: { list: async () => [...calendar.calendars.values()], patchNotifications: async () => undefined },
    sleep: async () => undefined,
  });
  registerChannelAdapter('email', { factory: () => inbox.adapter, defaults: EMAIL_CHANNEL_DEFAULTS });
  registerChannelAdapter('gchat', { factory: chatAdapter });
  await initChannelAdapters(() => hostSetup);
  setDeliveryAdapter(createChannelDeliveryAdapter());
  return inbox;
}

export async function tearDownScheduling(testDir: string): Promise<void> {
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// What a session holds, and the typed requests its agent sends
// ---------------------------------------------------------------------------

export interface InboundRow {
  readonly id: string;
  readonly kind: string;
  readonly trigger: number;
  readonly thread_id: string | null;
  readonly content: string;
}

export interface Content {
  readonly text?: string;
  readonly sender?: string;
  readonly type?: string;
  readonly requestId?: string;
  readonly frame?: ResponseFrame;
  readonly note?: { readonly type: string; readonly [key: string]: unknown };
  readonly brief?: { readonly type: string; readonly meeting_id: string; readonly [key: string]: unknown };
}

export function inbound(session: Session): InboundRow[] {
  const file = inboundDbPath(session.agent_group_id, session.id);
  if (!fs.existsSync(file)) return [];
  const db = new Database(file, { readonly: true });
  const rows = db
    .prepare('SELECT id, kind, trigger, thread_id, content FROM messages_in ORDER BY seq')
    .all() as InboundRow[];
  db.close();
  return rows;
}

export function contents(session: Session): Array<Content & { readonly row: InboundRow }> {
  return inbound(session).map((row) => ({ ...(JSON.parse(row.content) as Content), row }));
}

/** The host's notes of one type in a session. */
export function notes(session: Session, type: string): Array<Content & { readonly row: InboundRow }> {
  return contents(session).filter((content) => content.note?.type === type);
}

let requestCount = 0;

/** Send one typed request from a session, as delivery does, and read its answer. */
export async function ask(
  session: Session,
  action: string,
  fields: Record<string, unknown>,
  requestId = `req-${++requestCount}`,
): Promise<ResponseFrame> {
  const handler = getDeliveryAction(action);
  if (!handler) throw new Error(`no delivery action ${action}`);
  await handler({ action, requestId, ...fields }, session);
  const answers = contents(session)
    .filter((content) => content.type === 'action_response' && content.requestId === requestId)
    .map((content) => content.frame as ResponseFrame);
  expect(answers).toHaveLength(1);
  return answers[0];
}

export function data(frame: ResponseFrame): Record<string, unknown> {
  if (!frame.ok) throw new Error(`refused: ${frame.error.message}`);
  return frame.data as Record<string, unknown>;
}

export function refusal(frame: ResponseFrame): string {
  if (frame.ok) throw new Error(`accepted: ${JSON.stringify(frame.data)}`);
  return frame.error.message;
}

export async function meeting(id: unknown): Promise<Meeting> {
  const found = await getMeeting(String(id));
  if (!found) throw new Error(`no meeting ${String(id)}`);
  return found;
}

export async function meetingSession(id: unknown): Promise<Session> {
  const { session_id } = await meeting(id);
  const session = session_id === null ? undefined : await getSession(session_id);
  if (!session) throw new Error(`meeting ${String(id)} has no session`);
  return session;
}

/** external-email writes in its thread, as delivery sends it. */
export async function reply(session: Session, threadKey: string, text: string): Promise<void> {
  const db = new Database(outboundDbPath(session.agent_group_id, session.id));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, content)
     VALUES (?, ?, 'chat', ?, 'email', ?, ?)`,
  ).run(`out-${Math.random().toString(36).slice(2)}`, now(), INBOX_PLATFORM_ID, threadKey, JSON.stringify({ text }));
  db.close();
  await deliverSessionMessages(session);
}

export interface OfferedSlot {
  readonly slot_id: string;
  readonly start: string;
  readonly end: string;
  readonly held: boolean;
}

export function slotsOf(frame: ResponseFrame): OfferedSlot[] {
  return data(frame).slots as OfferedSlot[];
}
