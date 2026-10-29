/**
 * An email thread and a chat that both book on the principal's team
 * calendar, for the booking engine's tests. Each test file mocks `DATA_DIR`
 * and `requestWake` itself: vitest hoists a mock only in the file it is in.
 */
import Database from 'better-sqlite3';
import { vi } from 'vitest';

import '../../gws-ea-inbox/index.js';
import '../../gws-ea-preferences/index.js';
import '../../gws-ea-whereabouts/index.js';
import { DATA_DIR } from '../../../config.js';
import { ANSWER_LATER } from '../../../cli/delivery-action.js';
import type { ResponseFrame } from '../../../cli/frame.js';
import { getDb } from '../../../db/connection.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { createAgentGroup } from '../../../db/agent-groups.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../../db/container-configs.js';
import { createMessagingGroup } from '../../../db/messaging-groups.js';
import { inboundDbPath } from '../../../mailbox/sqlite/paths.js';
import { resolveSession } from '../../../session-manager.js';
import type { Session } from '../../../types.js';
import { setChatCalendar } from '../../gws-ea-chats/handoffs.js';
import { setChatMemberEmail } from '../../gws-ea-chats/roster.js';
import { cleanChatDelivery, seedChatDelivery } from '../../gws-ea-chats/testing/chat-delivery-fixture.js';
import { replacePrincipalCalendars } from '../../gws-ea-inbox/db.js';
import { createThread, recordThreadAddresses } from '../../gws-ea-inbox/thread-map.js';
import { addPrincipalAddress, recordExternalEmailAgentGroupId } from '../../gws-ea-profile/db.js';
import { createBookingTools } from '../booking.js';
import { bookingsMigration } from '../bookings-migration.js';
import { chatBookingRequestsMigration } from '../chat-booking-migration.js';
import { chatBookingReportsMigration } from '../chat-booking-report-migration.js';
import { setThreadBookingCalendar } from '../thread-calendar.js';
import { FakeCalendar } from './fake-calendar.js';
import { weekAcknowledgementsMigration } from '../week/acks-migration.js';
import { calendarWriteLogMigration } from '../week/write-log-migration.js';
import { pendingCalendarChangesMigration } from '../week/pending-changes-migration.js';

export const PRINCIPAL = 'juno@example.com';
export const ASSISTANT = 'avery@example.com';
export const MIRA = 'mira@example.com';
export const TEAM = 'visits@group.calendar.google.com';
export const BOOK = { start: '2026-10-20T12:00:00Z', minutes: 30, title: 'Venue visit' };
export const LATER = '2026-10-21T12:00:00Z';

export type BookingTools = ReturnType<typeof createBookingTools>;

export interface BookingFixture {
  readonly calendar: FakeCalendar;
  readonly thread: string;
  readonly chat: string;
  /** The open matter the chat belongs to. */
  readonly matterId: string;
  readonly emailSession: Session;
  readonly chatSession: Session;
  readonly tools: BookingTools;
}

export async function seedBookingFixture(): Promise<BookingFixture> {
  vi.useFakeTimers({ now: new Date('2026-10-18T12:00:00Z'), toFake: ['Date'] });
  const seeded = await seedChatDelivery();
  for (const migration of [chatBookingRequestsMigration, chatBookingReportsMigration, bookingsMigration]) {
    if (migration.sqliteOnly) throw new Error('Expected portable migration');
    await migration.up(getDb());
  }
  await runMigrations(getDb(), [
    weekAcknowledgementsMigration,
    calendarWriteLogMigration,
    pendingCalendarChangesMigration,
  ]);
  const chatSession = seeded.session;
  const chat = chatSession.messaging_group_id ?? '';
  await createAgentGroup({
    id: 'email',
    name: 'email',
    folder: 'email',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await createMessagingGroup({
    id: 'mail',
    channel_type: 'email',
    platform_id: 'mail',
    name: 'Mail',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: new Date().toISOString(),
  });
  await recordExternalEmailAgentGroupId('email');
  await addPrincipalAddress(PRINCIPAL);
  await getDb().run('UPDATE gws_ea_profile SET assistant_workspace_email=? WHERE singleton=1', ASSISTANT);
  await replacePrincipalCalendars([PRINCIPAL], new Date().toISOString());
  const { threadKey: thread } = await createThread(null, new Date().toISOString());
  await recordThreadAddresses(thread, [PRINCIPAL, ASSISTANT, MIRA], 'message', new Date().toISOString());
  const emailSession = (await resolveSession('email', 'mail', thread, 'per-thread')).session;
  await setThreadBookingCalendar(thread, TEAM);
  await setChatCalendar(chat, TEAM);
  await setChatMemberEmail(chat, 'whatsapp:22', MIRA, 'main');
  await setChatMemberEmail(chat, 'whatsapp:11', PRINCIPAL, 'main');
  const calendar = new FakeCalendar();
  calendar.calendars.set(PRINCIPAL, { id: PRINCIPAL, accessRole: 'writer' });
  calendar.calendars.set(TEAM, {
    id: TEAM,
    dataOwner: PRINCIPAL,
    accessRole: 'writer',
    conferenceTypes: ['hangoutsMeet'],
  });
  return {
    calendar,
    thread,
    chat,
    matterId: seeded.matter.id,
    emailSession,
    chatSession,
    tools: createBookingTools({ calendar: () => calendar }),
  };
}

export async function cleanBookingFixture(): Promise<void> {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await cleanChatDelivery(DATA_DIR);
}

/** Main's session, in the principal's DM, with its own time zone for the notes it reads. */
export async function mainSession(): Promise<Session> {
  const now = new Date().toISOString();
  await ensureContainerConfig('main');
  await updateContainerConfigScalars('main', { timezone: 'Europe/Paris' });
  await getDb().run("INSERT INTO users(id,kind,display_name,created_at) VALUES('gchat:juno','gchat','Juno',?)", now);
  await getDb().run("INSERT INTO gws_ea_principal_users(user_id,verified_at) VALUES('gchat:juno',?)", now);
  await createMessagingGroup({
    id: 'principal-dm',
    channel_type: 'gchat',
    platform_id: 'spaces/juno',
    name: 'Juno',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now,
  });
  await getDb().run(
    "INSERT INTO user_dms(user_id,channel_type,messaging_group_id,resolved_at) VALUES('gchat:juno','gchat','principal-dm',?)",
    now,
  );
  return (await resolveSession('main', 'principal-dm', null, 'agent-shared')).session;
}

export interface InboundRow {
  readonly id: string;
  readonly kind: string;
  readonly content: string;
  readonly seq: number;
  readonly trigger: number;
}

export function messagesIn(session: Session): InboundRow[] {
  const db = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  try {
    return db.prepare('SELECT id,kind,content,seq,trigger FROM messages_in ORDER BY seq').all() as InboundRow[];
  } finally {
    db.close();
  }
}

export function notesIn(session: Session): string[] {
  return messagesIn(session)
    .filter((message) => message.id.startsWith('gws-ea-booking-'))
    .map((message) => message.content);
}

export function responseIn(session: Session, requestId: string): ResponseFrame | undefined {
  const row = messagesIn(session).find((message) => message.id === `action-resp-${requestId}`);
  return row ? (JSON.parse(row.content) as { frame: ResponseFrame }).frame : undefined;
}

/** The host lines that carry a late answer, with the text the agent reads. */
export function wakeMessages(session: Session): InboundRow[] {
  return messagesIn(session)
    .filter((message) => message.id.startsWith('gws-ea-booking-answer-'))
    .map((message) => ({ ...message, content: (JSON.parse(message.content) as { text: string }).text }));
}

export function answerData(answer: Record<string, unknown> | typeof ANSWER_LATER): Record<string, unknown> {
  if (answer === ANSWER_LATER) throw new Error('The booking still awaits settlement');
  return answer;
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
