/**
 * The assistant's inbox as a NanoClaw channel adapter (KTD1). Inbound, it
 * polls Gmail's history each minute for messages added to INBOX and routes
 * each one to the part allowed to write to its readers (route-mail.ts).
 * Outbound, `deliver` sends `main`'s email to the principal on
 * `email:principal` (principal-reply.ts), and `external-email`'s on
 * `email:inbox` (outbound.ts).
 *
 * The poll is exactly-once and never stalls:
 * - a Gmail message ID routes once: each is recorded as settled;
 * - a known message not yet settled routes first, before new history, and
 *   without counting its sender again: a retry, or mail an update left to
 *   route (KTD10);
 * - the history cursor advances only when every message up to it settled;
 * - a message that keeps failing is set aside after `MAX_ROUTING_ATTEMPTS`
 *   polls, the cursor moves past it, and the principal hears one sentence;
 * - Gmail being unreachable fails the poll, never a message, and enough
 *   failed polls in a row make the inbox unhealthy;
 * - an expired cursor (404) resyncs from the newest INBOX messages, which
 *   the settled record keeps from routing twice.
 *
 * Each poll also keeps the assistant's calendar list first: each principal
 * address's calendar in it, its access recorded, and notifications on for
 * the principal's calendars (calendar-notifications.ts). The mail that waits
 * for main to place its thread or hand it over, Calendar's notifications,
 * and Docs' and Drive's each become one note for `main` after the poll's
 * messages are routed; Drive failing as that note is written costs the note
 * detail, never the poll.
 */
import type { ChannelAdapter, ChannelContextDefaults, ChannelDefaults, ChannelSetup } from '../../channels/adapter.js';
import { log } from '../../log.js';
import type { MeetingsCalendarApi } from '../gws-ea-meetings/calendar-api.js';
import type { DriveApi } from '../gws-ea-workspace/drive-api.js';
import { writeWorkspaceNote, type WorkspaceNotice } from '../gws-ea-workspace/notices.js';
import { syncCalendarList, type CalendarListApi, type CalendarNotice } from './calendar-notifications.js';
import {
  getInboxState,
  isSettled,
  isReservedSignInMail,
  pruneSenderCounts,
  pruneSettledMessages,
  recordFailedAttempt,
  reservedSignInMailIds,
  settleMessage,
  unsettledMessages,
  updateInboxState,
  type RouteOutcome,
} from './db.js';
import { GoogleApiError, type GmailApi, type GmailHistoryRecord } from './gmail-api.js';
import { recordPollFailure, recordPollSuccess } from './health.js';
import { hasPendingSignInMail, unmatchedSignInClaims } from './claims.js';
import { parseGmailMessage, type ParsedMail } from './mime.js';
import { noticeSetAside } from './notices.js';
import { sendToOutside } from './outbound.js';
import { sendToPrincipal } from './principal-reply.js';
import {
  loadRoutingContext,
  routeMail,
  routeSignInMail,
  writeCalendarNote,
  writeHeldNote,
  type HeldMail,
  type RoutingContext,
} from './route-mail.js';
import {
  activeInbox,
  assistantAddresses,
  EMAIL_CHANNEL_TYPE,
  PRINCIPAL_PLATFORM_ID,
  setActiveInbox,
  type InboxRuntime,
} from './runtime.js';

/** Failed polls a message may fail routing in before it is set aside. */
export const MAX_ROUTING_ATTEMPTS = 5;
/** History pages one poll reads; the rest wait for the next poll. */
const MAX_HISTORY_PAGES = 10;
/** INBOX messages a resync reads, newest first. */
const RESYNC_LIMIT = 100;
/** How long a settled message is remembered, and so how far back a resync reaches. */
const SETTLED_RETENTION_MS = 30 * 24 * 3_600_000;
const SENDER_COUNT_RETENTION_MS = 24 * 3_600_000;

/**
 * Every conversation is an email thread; no one mentions the assistant; and
 * anyone may write to the inbox, because routing, not the sender policy,
 * decides what reaches an agent. The host creates both of the channel's
 * groups and pins their wirings (wiring-policy.ts).
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
  /** The principal's events as the host's own Calendar token reads them, for who organized a new one. */
  readonly events: Pick<MeetingsCalendarApi, 'getEvent'>;
  /** Drive as the host's own Drive token reaches it, for the details of Docs and Drive activity. */
  readonly drive: DriveApi;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface Inbox {
  readonly adapter: ChannelAdapter;
  /** One poll: the calendar list, then mail. Never throws. */
  tick(): Promise<void>;
  /** One serialized Gmail loop, with prompt mail-only checks for waiting sign-ins. */
  run(signal: AbortSignal): Promise<void>;
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
  let wakeRevision = 0;
  let wake: (() => void) | undefined;

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
    wakeSignIn() {
      wakeRevision += 1;
      wake?.();
    },
  };

  /**
   * Route messages in order; true when every one settled or was set aside.
   * `limited` counts each sender against the hourly limit.
   */
  async function routeBatch(
    ids: readonly string[],
    context: RoutingContext,
    limited: boolean,
    signInMode?: 'retry' | 'search',
  ): Promise<boolean> {
    const at = context.at.toISOString();
    const reserved = signInMode ? undefined : new Set(await reservedSignInMailIds());
    const held: { gmailMessageId: string; held: HeldMail }[] = [];
    const calendar: { gmailMessageId: string; notice: CalendarNotice }[] = [];
    const workspace: { gmailMessageId: string; notice: WorkspaceNotice }[] = [];
    let complete = true;
    // Each message set aside, as it was read; a batched notification's is not kept.
    const setAside: (ParsedMail | undefined)[] = [];

    const failed = async (
      gmailMessageId: string,
      error: unknown,
      mail?: ParsedMail,
    ): Promise<'retry' | 'set-aside'> => {
      const attempts = await recordFailedAttempt(gmailMessageId, at);
      if (attempts < MAX_ROUTING_ATTEMPTS) {
        log.warn('An inbox message could not be routed; retrying next poll', { gmailMessageId, attempts, error });
        return 'retry';
      }
      log.error('An inbox message kept failing to route; set aside', { gmailMessageId, attempts, error });
      const signIn = await isReservedSignInMail(gmailMessageId);
      await settleMessage(gmailMessageId, signIn ? 'browser-sign-in' : 'set-aside', at);
      if (!signIn) setAside.push(mail);
      return 'set-aside';
    };

    for (const id of ids) {
      if (reserved?.has(id)) continue;
      if (await isSettled(id)) continue;
      const message = await deps.gmail.getMessage(id, 'full');
      if (!message) {
        await settleMessage(id, 'gone', at);
        continue;
      }
      let mail: ParsedMail | undefined;
      try {
        // Parsing is part of routing: a message the parser cannot read is retried, then set aside.
        mail = parseGmailMessage(message);
        if (!signInMode && !mail.labelIds.includes('INBOX')) {
          const claimed = await routeSignInMail(mail, context.at);
          await settleMessage(id, claimed ? 'browser-sign-in' : 'not-in-inbox', at);
          continue;
        }
        if (signInMode) {
          if (await routeSignInMail(mail, context.at)) {
            await settleMessage(id, 'browser-sign-in', at);
            if (signInMode === 'search' && (await unmatchedSignInClaims(context.at)).length === 0) break;
          } else if (signInMode === 'retry') await settleMessage(id, 'browser-sign-in', at);
          continue;
        }
        const routed = await routeMail(mail, runtime, context, { limited });
        if (routed.kind === 'held') held.push({ gmailMessageId: id, held: routed.held });
        else if (routed.kind === 'calendar') calendar.push({ gmailMessageId: id, notice: routed.notice });
        else if (routed.kind === 'workspace') workspace.push({ gmailMessageId: id, notice: routed.notice });
        else await settleMessage(id, routed.outcome, at);
      } catch (error) {
        if (error instanceof GoogleApiError) throw error;
        if ((await failed(id, error, mail)) === 'retry') {
          complete = false;
          break;
        }
      }
    }

    /** Write one batch's note, then settle its notifications; failing to write it is each one's failed attempt. */
    const writeBatch = async (
      entries: readonly { readonly gmailMessageId: string }[],
      write: () => Promise<void>,
      outcome: RouteOutcome,
    ): Promise<void> => {
      if (entries.length === 0) return;
      /* eslint-disable no-catch-all/no-catch-all -- any failure to write the note is each notification's failed attempt */
      try {
        await write();
        for (const entry of entries) await settleMessage(entry.gmailMessageId, outcome, at);
      } catch (error) {
        for (const entry of entries) {
          if ((await failed(entry.gmailMessageId, error)) === 'retry') complete = false;
        }
      }
      /* eslint-enable no-catch-all/no-catch-all */
    };
    await writeBatch(held, () => writeHeldNote(held, context.at), 'outside');
    await writeBatch(calendar, () => writeCalendarNote(calendar, deps.events, context.at), 'calendar-note');
    await writeBatch(workspace, () => writeWorkspaceNote(workspace, deps.drive, context.at), 'workspace-note');
    if (setAside.length > 0) await noticeSetAside(setAside);
    return complete;
  }

  async function resync(context: RoutingContext): Promise<void> {
    const { historyId } = await deps.gmail.getProfile();
    const after = Math.floor((context.at.getTime() - SETTLED_RETENTION_MS) / 1_000);
    const refs = await deps.gmail.listMessages({ labelIds: ['INBOX'], q: `after:${after}`, maxResults: RESYNC_LIMIT });
    log.warn("The inbox's history cursor expired; resyncing from the newest INBOX mail", { messages: refs.length });
    if (await routeBatch(refs.map((ref) => ref.id).reverse(), context, true))
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
    // A retry goes before new mail, so a thread's messages arrive in order; its sender was counted the first time.
    if (!(await routeBatch(await unsettledMessages(), context, false))) return;
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
    if (await routeBatch(inboxAdditions(records), context, true)) await updateInboxState({ history_id: next });
  }

  async function pollSignInMail(context: RoutingContext): Promise<void> {
    const reserved = await reservedSignInMailIds();
    if (reserved.length > 0) await routeBatch(reserved, context, false, 'retry');
    const claims = await unmatchedSignInClaims(context.at);
    if (claims.length === 0) return;
    const refs = await deps.gmail.listMessages({
      q: `in:anywhere after:${Math.floor(Date.parse(claims[0].since_at) / 1_000)}`,
      includeSpamTrash: true,
      maxResults: 500,
    });
    // Gmail lists newest first; reserve the earliest eligible message just as ordinary history does.
    const retried = new Set(reserved);
    await routeBatch(
      refs
        .map((ref) => ref.id)
        .reverse()
        .filter((id) => !retried.has(id)),
      context,
      false,
      'search',
    );
  }

  async function poll(mailOnly: boolean): Promise<void> {
    const at = now();
    /* eslint-disable no-catch-all/no-catch-all -- the poll loop never stops: each failure is recorded and the next poll retries */
    try {
      const { auth } = await loadRoutingContext(await assistantAddresses(), at);
      if (!mailOnly) await syncCalendarList(deps.calendar, auth.principalAddresses, at.toISOString());
      try {
        // The assistant's own Gmail address is never "someone else" on a message.
        await runtime.gmailAddress();
        // Read after the sync, so a calendar added this minute already counts as the principal's.
        const context = await loadRoutingContext(await assistantAddresses(), at);
        await pollSignInMail(context);
        if (!mailOnly) await pollMail(context);
        await recordPollSuccess(at.toISOString());
      } catch (error) {
        log.warn('The inbox poll failed', { reason: reasonOf(error) });
        await recordPollFailure(reasonOf(error), at.toISOString());
        return;
      }
      if (mailOnly) return;
      await pruneSettledMessages(new Date(at.getTime() - SETTLED_RETENTION_MS).toISOString());
      await pruneSenderCounts(new Date(at.getTime() - SENDER_COUNT_RETENTION_MS).toISOString());
    } catch (error) {
      log.error('The inbox poll could not finish', { reason: reasonOf(error) });
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }

  let ticking = Promise.resolve();
  const tick = (mailOnly = false): Promise<void> => {
    const next = ticking.then(() => poll(mailOnly));
    ticking = next;
    return next;
  };

  async function run(signal: AbortSignal): Promise<void> {
    let nextRegular = 0;
    while (!signal.aborted) {
      const regular = now().getTime() >= nextRegular;
      if (regular) nextRegular = now().getTime() + 60_000;
      await tick(!regular);
      const revision = wakeRevision;
      let pending = false;
      /* eslint-disable no-catch-all/no-catch-all -- temporary claim-read failures must not stop ordinary inbox polling */
      try {
        pending = await hasPendingSignInMail(now());
      } catch (_error) {
        log.warn('The inbox could not read pending sign-in claims; retrying at its normal cadence.');
      }
      /* eslint-enable no-catch-all/no-catch-all */
      const duration = Math.max(0, Math.min(nextRegular - now().getTime(), pending ? 1_000 : 60_000));
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          signal.removeEventListener('abort', done);
          if (wake === done) wake = undefined;
          resolve();
        };
        const timer = setTimeout(done, duration);
        wake = done;
        signal.addEventListener('abort', done, { once: true });
        if (signal.aborted || wakeRevision !== revision) done();
      });
    }
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
    deliver: (platformId, threadId, message) =>
      platformId === PRINCIPAL_PLATFORM_ID
        ? sendToPrincipal(runtime, threadId, message)
        : sendToOutside(runtime, platformId, threadId, message),
  };

  return { adapter, tick, run };
}
