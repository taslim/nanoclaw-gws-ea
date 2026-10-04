/**
 * The assistant's inbox as a NanoClaw channel adapter (KTD4). Inbound, it polls
 * Gmail's history each minute for messages added to INBOX and routes each one
 * (routing.ts); outbound, `deliver` sends a thread's reply (outbound.ts).
 *
 * The poll is exactly-once and never stalls:
 * - a Gmail message ID routes once: each is recorded as settled;
 * - the history cursor advances only when every message up to it settled;
 * - a message that keeps failing is set aside after `MAX_ROUTING_ATTEMPTS`
 *   polls, the cursor moves past it, and the principal hears one sentence;
 * - Gmail being unreachable fails the poll, never a message, and enough
 *   failed polls in a row make the inbox unhealthy;
 * - an expired cursor (404) resyncs from the newest INBOX messages, which
 *   the settled record keeps from routing twice.
 *
 * Each poll also keeps calendar notifications on for the principal's
 * calendars (KTD9), and hands over held mail a release left behind.
 */
import type { ChannelAdapter, ChannelContextDefaults, ChannelDefaults, ChannelSetup } from '../../channels/adapter.js';
import { log } from '../../log.js';
import { syncCalendarNotifications, type CalendarListApi, type CalendarNotice } from './calendar-notifications.js';
import {
  getInboxState,
  isSettled,
  openThreadsWithHeldMail,
  prunePrincipalMessages,
  pruneSenderCounts,
  pruneSettledMessages,
  recordFailedAttempt,
  settleMessage,
  updateInboxState,
} from './db.js';
import { GoogleApiError, type GmailApi, type GmailHistoryRecord } from './gmail-api.js';
import { recordPollFailure, recordPollSuccess } from './health.js';
import { parseGmailMessage } from './mime.js';
import { noticeSetAside } from './notices.js';
import { sendReply } from './outbound.js';
import { loadRoutingContext, routeMail, writeCalendarNote, type RoutingContext } from './routing.js';
import { deliverHeldMail } from './threads.js';
import { assistantAddresses, activeInbox, EMAIL_CHANNEL_TYPE, setActiveInbox, type InboxRuntime } from './runtime.js';

/** Failed polls a message may fail routing in before it is set aside. */
export const MAX_ROUTING_ATTEMPTS = 5;
/** History pages one poll reads; the rest wait for the next poll. */
const MAX_HISTORY_PAGES = 10;
/** INBOX messages a resync reads, newest first. */
const RESYNC_LIMIT = 100;
/** How long a settled message is remembered, and so how far back a resync reaches. */
const SETTLED_RETENTION_MS = 30 * 24 * 3_600_000;
/** How long the principal's messages can be answered by email. */
const PRINCIPAL_MESSAGE_RETENTION_MS = SETTLED_RETENTION_MS;
const SENDER_COUNT_RETENTION_MS = 24 * 3_600_000;

/**
 * Every conversation is an email thread with its own session; no one mentions
 * the assistant; and anyone may write, because routing, not the sender
 * policy, decides what reaches an agent.
 */
const EMAIL_CONTEXT: ChannelContextDefaults = {
  engageMode: 'pattern',
  engagePattern: '.',
  threads: true,
  sessionMode: 'per-thread',
  unknownSenderPolicy: 'public',
};

export const EMAIL_CHANNEL_DEFAULTS: ChannelDefaults = { dm: EMAIL_CONTEXT, group: EMAIL_CONTEXT, mentions: 'never' };

export interface InboxDeps {
  readonly gmail: GmailApi;
  readonly calendar: CalendarListApi;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface Inbox {
  readonly adapter: ChannelAdapter;
  /** One poll: calendar notification settings, new mail, and any release left to finish. Never throws. */
  tick(): Promise<void>;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Messages added to INBOX, once each, in history order. */
function inboxAdditions(records: readonly GmailHistoryRecord[]): string[] {
  const ids: string[] = [];
  for (const record of records) {
    for (const added of record.messagesAdded ?? []) {
      if (added.message.labelIds === undefined || added.message.labelIds.includes('INBOX')) ids.push(added.message.id);
    }
    for (const labelled of record.labelsAdded ?? []) {
      if (labelled.labelIds.includes('INBOX')) ids.push(labelled.message.id);
    }
  }
  return [...new Set(ids)];
}

export function createInbox(deps: InboxDeps): Inbox {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let setup: ChannelSetup | undefined;
  let gmailAddress: string | undefined;

  const runtime: InboxRuntime = {
    gmail: deps.gmail,
    setup: () => setup,
    async gmailAddress() {
      gmailAddress ??= (await deps.gmail.getProfile()).emailAddress.toLowerCase();
      return gmailAddress;
    },
    knownGmailAddress: () => gmailAddress,
    now,
    sleep,
  };

  /** Route messages in order; true when every one settled or was set aside. */
  async function routeBatch(ids: readonly string[], context: RoutingContext): Promise<boolean> {
    const at = context.at.toISOString();
    const calendar: { gmailMessageId: string; notice: CalendarNotice }[] = [];
    let complete = true;
    let setAside = 0;

    const failed = async (gmailMessageId: string, error: unknown): Promise<'retry' | 'set-aside'> => {
      const attempts = await recordFailedAttempt(gmailMessageId, at);
      if (attempts < MAX_ROUTING_ATTEMPTS) {
        log.warn('An inbox message could not be routed; retrying next poll', { gmailMessageId, attempts, error });
        return 'retry';
      }
      log.error('An inbox message kept failing to route; set aside', { gmailMessageId, attempts, error });
      await settleMessage(gmailMessageId, 'set-aside', at);
      setAside += 1;
      return 'set-aside';
    };

    for (const id of ids) {
      if (await isSettled(id)) continue;
      const message = await deps.gmail.getMessage(id, 'full');
      if (!message) {
        await settleMessage(id, 'gone', at);
        continue;
      }
      const mail = parseGmailMessage(message);
      if (!mail.labelIds.includes('INBOX')) {
        await settleMessage(id, 'not-in-inbox', at);
        continue;
      }
      try {
        const routed = await routeMail(mail, runtime, context);
        if (routed.kind === 'calendar') calendar.push({ gmailMessageId: id, notice: routed.notice });
        else await settleMessage(id, routed.outcome, at);
      } catch (error) {
        if (error instanceof GoogleApiError) throw error;
        if ((await failed(id, error)) === 'retry') {
          complete = false;
          break;
        }
      }
    }

    if (calendar.length > 0) {
      /* eslint-disable no-catch-all/no-catch-all -- any failure to write the note is each notification's failed attempt */
      try {
        await writeCalendarNote(calendar, context.at);
        for (const entry of calendar) await settleMessage(entry.gmailMessageId, 'calendar-note', at);
      } catch (error) {
        for (const entry of calendar) {
          if ((await failed(entry.gmailMessageId, error)) === 'retry') complete = false;
        }
      }
      /* eslint-enable no-catch-all/no-catch-all */
    }
    if (setAside > 0) await noticeSetAside();
    return complete;
  }

  async function resync(context: RoutingContext): Promise<void> {
    const { historyId } = await deps.gmail.getProfile();
    const after = Math.floor((context.at.getTime() - SETTLED_RETENTION_MS) / 1_000);
    const refs = await deps.gmail.listMessages({ labelIds: ['INBOX'], q: `after:${after}`, maxResults: RESYNC_LIMIT });
    log.warn("The inbox's history cursor expired; resyncing from the newest INBOX mail", { messages: refs.length });
    if (await routeBatch(refs.map((ref) => ref.id).reverse(), context))
      await updateInboxState({ history_id: historyId });
  }

  async function pollMail(context: RoutingContext): Promise<void> {
    const cursor = (await getInboxState()).history_id;
    if (cursor === null) {
      // The first poll starts from now: mail already in the inbox is not replayed.
      const profile = await deps.gmail.getProfile();
      gmailAddress ??= profile.emailAddress.toLowerCase();
      await updateInboxState({ history_id: profile.historyId });
      return;
    }
    const records: GmailHistoryRecord[] = [];
    let latest = cursor;
    let pageToken: string | undefined;
    try {
      for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
        const result = await deps.gmail.listHistory({
          startHistoryId: cursor,
          labelId: 'INBOX',
          historyTypes: ['messageAdded', 'labelAdded'],
          ...(pageToken === undefined ? {} : { pageToken }),
        });
        records.push(...result.history);
        latest = result.historyId;
        pageToken = result.nextPageToken;
        if (pageToken === undefined) break;
      }
    } catch (error) {
      if (error instanceof GoogleApiError && error.status === 404) {
        await resync(context);
        return;
      }
      throw error;
    }
    const next = pageToken === undefined ? latest : (records[records.length - 1]?.id ?? cursor);
    if (await routeBatch(inboxAdditions(records), context)) await updateInboxState({ history_id: next });
  }

  async function finishReleases(): Promise<void> {
    let setAside = 0;
    for (const threadKey of await openThreadsWithHeldMail()) {
      setAside += (await deliverHeldMail(threadKey)).setAside;
    }
    if (setAside > 0) await noticeSetAside();
  }

  async function tick(): Promise<void> {
    const at = now();
    /* eslint-disable no-catch-all/no-catch-all -- the poll loop never stops: each failure is recorded and the next poll retries */
    try {
      const { auth } = await loadRoutingContext(await assistantAddresses(), at);
      await syncCalendarNotifications(deps.calendar, auth.principalAddresses, at.toISOString());
      try {
        // The assistant's own Gmail address is never "someone else" on a message.
        await runtime.gmailAddress();
        // Read after the sync, so a calendar added this minute already counts as the principal's.
        await pollMail(await loadRoutingContext(await assistantAddresses(), at));
        await recordPollSuccess(at.toISOString());
      } catch (error) {
        log.warn('The inbox poll failed', { reason: reasonOf(error) });
        await recordPollFailure(reasonOf(error), at.toISOString());
        return;
      }
      await finishReleases();
      await pruneSettledMessages(new Date(at.getTime() - SETTLED_RETENTION_MS).toISOString());
      await prunePrincipalMessages(new Date(at.getTime() - PRINCIPAL_MESSAGE_RETENTION_MS).toISOString());
      await pruneSenderCounts(new Date(at.getTime() - SENDER_COUNT_RETENTION_MS).toISOString());
    } catch (error) {
      log.error('The inbox poll could not finish', { reason: reasonOf(error) });
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }

  const adapter: ChannelAdapter = {
    name: EMAIL_CHANNEL_TYPE,
    channelType: EMAIL_CHANNEL_TYPE,
    supportsThreads: true,
    defaults: EMAIL_CHANNEL_DEFAULTS,
    async setup(config) {
      setup = config;
      setActiveInbox(runtime);
    },
    async teardown() {
      setup = undefined;
      if (activeInbox() === runtime) setActiveInbox(undefined);
    },
    isConnected: () => setup !== undefined,
    deliver: (platformId, threadId, message) => sendReply(runtime, platformId, threadId, message),
  };

  return { adapter, tick };
}
