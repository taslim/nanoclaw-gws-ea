/**
 * GWS-EA's inbox: the assistant's Gmail as an `email` channel with two
 * messaging groups (KTD1), and Google Calendar's notification emails as
 * calendar news.
 *
 * - Inbound mail is routed per message to the part allowed to write to its
 *   readers (route-mail.ts): what only the principal and the assistant can
 *   read reaches `main` in the principal's own email conversation
 *   (`email:principal`); everything else reaches `external-email`'s session
 *   for its thread (`email:inbox`).
 * - `main`'s replies leave through ordinary delivery to the principal alone,
 *   which the audience check resolves to the same address
 *   (principal-reply.ts). A thread's replies go to everyone on it
 *   (outbound.ts, recipients.ts).
 * - Mail is the principal's only when Gmail verified that the domain of one
 *   of their addresses sent it (authentication.ts).
 *
 * The host starts the inbox after `external-email` exists: it creates both
 * messaging groups and their wirings when absent, brings `main`'s members in
 * step with the principal's addresses, then polls each minute.
 */
import { setTimeout as delay } from 'node:timers/promises';

import { registerChannelAdapter } from '../../channels/channel-registry.js';
import { register } from '../../cli/registry.js';
import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import { registerDeliveryFailedHook, registerPostDeliveryHook } from '../../delivery.js';
import { readEnvFile } from '../../env.js';
import { onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import type { OutboundMessage } from '../../mailbox/index.js';
import { getExternalEmailAgentGroupId } from '../gws-ea-external-email/index.js';
import { getInboxHealth } from './health.js';
import { hostGoogleAccessToken } from '../gws-ea-google/index.js';
import { GOOGLE_GRANT_FILE_ENV } from '../gws-ea-google/grant.js';
import { identityMatchKey } from '../../gws-ea/validation.js';
import { registerPersonForgetHook } from '../gws-ea-people/index.js';
import {
  gwsEaMeetingsCalendarActionsMigration,
  gwsEaMeetingsMigration,
  gwsEaMeetingsRoomsMigration,
} from '../gws-ea-meetings/migration.js';
import { registerRecipientResolver } from '../gws-ea-privacy/index.js';
import { getMainAgentGroupId, syncPrincipalMembers } from '../gws-ea-profile/db.js';
import { registerRoleGrantPolicy } from '../permissions/db/user-roles.js';
import { createInbox, EMAIL_CHANNEL_DEFAULTS, type Inbox } from './adapter.js';
import { createCalendarListApi } from './calendar-notifications.js';
import { deleteSends } from './db.js';
import { createGmailApi } from './gmail-api.js';
import { gwsEaInboxEmailChannelMigration } from './migration-email-channel.js';
import { gwsEaInboxMigration } from './migration.js';
import { resolveRecipients } from './outbound.js';
import { principalRecipients } from './principal-reply.js';
import { EMAIL_CHANNEL_TYPE, INBOX_PLATFORM_ID, PRINCIPAL_PLATFORM_ID } from './runtime.js';
import { contentHash, replyText } from './send.js';
import { deleteSends as deleteThreadSends } from './thread-map.js';
import { ensureInbox, ensurePrincipalConversation } from './wiring-policy.js';

// The inbox registers the meetings store too, unchanged, so the email channel's
// migration runs after every inbox and meetings table exists (KTD10).
registerMigration(gwsEaInboxMigration);
registerMigration(gwsEaMeetingsMigration);
registerMigration(gwsEaMeetingsCalendarActionsMigration);
registerMigration(gwsEaMeetingsRoomsMigration);
registerMigration(gwsEaInboxEmailChannelMigration);

/** How often the inbox polls Gmail. */
const POLL_INTERVAL_MS = 60_000;

let live: Inbox | undefined;

function grantFile(): string | undefined {
  return process.env[GOOGLE_GRANT_FILE_ENV] || readEnvFile([GOOGLE_GRANT_FILE_ENV])[GOOGLE_GRANT_FILE_ENV];
}

registerChannelAdapter(EMAIL_CHANNEL_TYPE, {
  // Only a GWS-EA instance, which has the assistant's Google sign-in, has an inbox.
  factory: () => {
    if (!grantFile()) return null;
    live = createInbox({
      gmail: createGmailApi({ token: () => hostGoogleAccessToken('gmail') }),
      calendar: createCalendarListApi({ token: () => hostGoogleAccessToken('calendar-host') }),
    });
    return live.adapter;
  },
  defaults: EMAIL_CHANNEL_DEFAULTS,
});

registerRecipientResolver(EMAIL_CHANNEL_TYPE, (send) =>
  send.platformId === PRINCIPAL_PLATFORM_ID ? principalRecipients(send) : resolveRecipients(send),
);

// A mail sender is only as trustworthy as the domain behind it, so no email
// identity may hold a privilege: commands and approvals stay with chat users
// the channel itself authenticates (KTD4).
registerRoleGrantPolicy('gws-ea-inbox:no-email-privilege', (grant) =>
  grant.user_id.startsWith(`${EMAIL_CHANNEL_TYPE}:`) ? 'an email identity never holds owner or admin' : undefined,
);

/** The send record of a row the channel sent: a thread's reply, or `main`'s reply to the principal. */
function emailSend(
  msg: OutboundMessage,
): { readonly to: 'inbox' | 'principal'; readonly threadKey: string; readonly hash: string } | undefined {
  if (msg.channelType !== EMAIL_CHANNEL_TYPE || msg.threadId === null) return undefined;
  const to =
    msg.platformId === INBOX_PLATFORM_ID ? 'inbox' : msg.platformId === PRINCIPAL_PLATFORM_ID ? 'principal' : undefined;
  if (to === undefined) return undefined;
  /* eslint-disable no-catch-all/no-catch-all -- a row the inbox could never have sent has no send record */
  try {
    return { to, threadKey: msg.threadId, hash: contentHash(msg.threadId, replyText(JSON.parse(msg.content))) };
  } catch {
    return undefined;
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

async function forgetSend(msg: OutboundMessage, state: 'pending' | 'sent'): Promise<void> {
  const send = emailSend(msg);
  if (send?.to === 'inbox') await deleteSends(send.threadKey, send.hash, state);
  if (send?.to === 'principal') {
    await deleteThreadSends({ threadKey: send.threadKey, side: 'principal' }, send.hash, state);
  }
}

// Delivery recorded the email: its send record has done its job.
registerPostDeliveryHook((msg) => forgetSend(msg, 'sent'));

// Delivery gave up on the email: the same words sent later are a new send.
registerDeliveryFailedHook(async (failed) => {
  for (const msg of failed) await forgetSend(msg, 'pending');
});

// A forgotten person leaves no held mail, rate count, or place on a thread behind.
registerPersonForgetHook('gws-ea-inbox:purge', async ({ handles }) => {
  const db = getDb();
  if (!(await db.hasTable('gws_ea_inbox_threads'))) return;
  const forgotten = new Set(
    handles.filter((handle) => handle.toLowerCase().startsWith('email:')).map((handle) => identityMatchKey(handle)),
  );
  if (forgotten.size === 0) return;
  const isForgotten = (address: string | null) =>
    address !== null && forgotten.has(identityMatchKey(`email:${address}`));
  await db.transaction(async () => {
    for (const row of await db.all<{ gmail_message_id: string; sender: string | null }>(
      'SELECT gmail_message_id, sender FROM gws_ea_inbox_held',
    )) {
      if (isForgotten(row.sender))
        await db.run('DELETE FROM gws_ea_inbox_held WHERE gmail_message_id = ?', row.gmail_message_id);
    }
    for (const row of await db.all<{ sender: string }>('SELECT DISTINCT sender FROM gws_ea_inbox_sender_counts')) {
      if (isForgotten(row.sender)) await db.run('DELETE FROM gws_ea_inbox_sender_counts WHERE sender = ?', row.sender);
    }
    const columns = ['people_to', 'people_cc', 'people_bcc', 'vouched_people'] as const;
    for (const row of await db.all<Record<(typeof columns)[number] | 'thread_key', string>>(
      'SELECT thread_key, people_to, people_cc, people_bcc, vouched_people FROM gws_ea_inbox_threads',
    )) {
      for (const column of columns) {
        const addresses = JSON.parse(row[column]) as readonly string[];
        const kept = addresses.filter((address) => !isForgotten(address));
        if (kept.length !== addresses.length) {
          await db.run(
            `UPDATE gws_ea_inbox_threads SET ${column} = ? WHERE thread_key = ?`,
            JSON.stringify(kept),
            row.thread_key,
          );
        }
      }
    }
  });
});

// What status reads, from the host only: `getInboxHealth()` exactly as follow-through reads it.
register({
  name: 'gws-ea-inbox-health',
  description: "Report the inbox's health and its calendar notifications.",
  access: 'hidden',
  hostOnly: true,
  parseArgs(raw) {
    const unknown = Object.keys(raw);
    if (unknown.length > 0) throw new Error(`Unknown inbox field: --${unknown[0]}`);
    return undefined;
  },
  handler: async () => getInboxHealth(),
});

// ---------------------------------------------------------------------------
// Host start
// ---------------------------------------------------------------------------

onHostStart(async ({ signal }) => {
  if (!(await getDb().hasTable('gws_ea_inbox_state'))) return;
  const externalEmail = await getExternalEmailAgentGroupId();
  if (externalEmail === null) return;
  await ensureInbox(externalEmail);
  const main = await getMainAgentGroupId();
  if (main !== null) await ensurePrincipalConversation(main);
  await syncPrincipalMembers();
  const inbox = live;
  if (!inbox?.adapter.isConnected()) {
    log.warn('The inbox is not polling: its channel did not start');
    return;
  }
  // Started, not awaited: host startup never waits on Gmail.
  void (async () => {
    while (!signal.aborted) {
      await inbox.tick();
      await delay(POLL_INTERVAL_MS, undefined, { signal }).catch(() => undefined);
    }
  })();
});

export { createInbox, EMAIL_CHANNEL_DEFAULTS, type Inbox, type InboxDeps } from './adapter.js';
export {
  recordOwnCalendarChange,
  type CalendarListApi,
  type CalendarListEntry,
  type CalendarNotification,
} from './calendar-notifications.js';
export {
  GoogleApiError,
  type GmailApi,
  type GmailHistoryRecord,
  type GmailMessage,
  type GmailMessagePart,
  type GmailMessageRef,
} from './gmail-api.js';
export type { ThreadOrigin, ThreadPeople, ThreadState } from './db.js';
export { getInboxHealth, type InboxHealth } from './health.js';
export { sendPrincipalReply, type PrincipalReply } from './outbound.js';
export type { Placement } from './recipients.js';
export { registerThreadReplyHook, type ThreadReplyHook } from './routing.js';
export { EMAIL_CHANNEL_TYPE, INBOX_PLATFORM_ID, PRINCIPAL_PLATFORM_ID } from './runtime.js';
export {
  addThreadPeople,
  arrangeThreadPeople,
  authorizeThread,
  closeThread,
  getThreadParticipants,
  handBackHeldThread,
  mintThreadKey,
  openThreadSession,
  releaseHeldMail,
  threadAddress,
  vouchThreadPeople,
  type AuthorizeThreadInput,
  type ThreadView,
} from './threads.js';
export { ensureInbox, ensurePrincipalConversation, getInboxMessagingGroupId } from './wiring-policy.js';
