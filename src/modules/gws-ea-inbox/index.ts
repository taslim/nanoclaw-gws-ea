/**
 * GWS-EA's inbox: the assistant's Gmail as an `email` channel (KTD4), and
 * Google Calendar's notification emails as calendar news (KTD9).
 *
 * - Inbound mail is routed per message (routing.ts): `main` hears principal
 *   mail, calendar changes, and every other email as typed notes, and
 *   triages each thread the host holds for it; `external-email` hears only
 *   threads `main` handed over, one session per thread.
 * - Replies leave through ordinary delivery to everyone on the thread, as
 *   placed in To, Cc, and Bcc, which the audience check resolves through the
 *   same people (outbound.ts, recipients.ts). The principal's own email is
 *   answered to them alone (`sendPrincipalReply`).
 * - The operator pins the DKIM selectors the principal's mail must be signed
 *   with (`ncl dkim-selectors`); until one is pinned for a domain, no mail
 *   from it is the principal's.
 *
 * The host starts the inbox after `external-email` exists: it creates the
 * inbox's messaging group and wiring when absent, then polls each minute.
 * The handoff (U11) drives threads through threads.ts.
 */
import { setTimeout as delay } from 'node:timers/promises';

import { registerChannelAdapter } from '../../channels/channel-registry.js';
import { registerResource, type ColumnDef } from '../../cli/crud.js';
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
import { registerRecipientResolver } from '../gws-ea-privacy/index.js';
import { registerRoleGrantPolicy } from '../permissions/db/user-roles.js';
import { createInbox, EMAIL_CHANNEL_DEFAULTS, type Inbox } from './adapter.js';
import { createCalendarListApi } from './calendar-notifications.js';
import { deleteSends, listPinnedSelectors, pinSelector, unpinSelector } from './db.js';
import { createGmailApi } from './gmail-api.js';
import { gwsEaInboxMigration } from './migration.js';
import { contentHash, replyText, resolveRecipients } from './outbound.js';
import { EMAIL_CHANNEL_TYPE, INBOX_PLATFORM_ID } from './runtime.js';
import { ensureInbox } from './wiring-policy.js';

registerMigration(gwsEaInboxMigration);

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

registerRecipientResolver(EMAIL_CHANNEL_TYPE, resolveRecipients);

// A mail sender is only as trustworthy as the domain behind it, so no email
// identity may hold a privilege: commands and approvals stay with chat users
// the channel itself authenticates (KTD4).
registerRoleGrantPolicy('gws-ea-inbox:no-email-privilege', (grant) =>
  grant.user_id.startsWith(`${EMAIL_CHANNEL_TYPE}:`) ? 'an email identity never holds owner or admin' : undefined,
);

/** The reply's text, when the row is one of the inbox's thread replies. */
function inboxReply(msg: OutboundMessage): { readonly threadKey: string; readonly hash: string } | undefined {
  if (msg.channelType !== EMAIL_CHANNEL_TYPE || msg.platformId !== INBOX_PLATFORM_ID || msg.threadId === null) {
    return undefined;
  }
  /* eslint-disable no-catch-all/no-catch-all -- a row the inbox could never have sent has no send record */
  try {
    return { threadKey: msg.threadId, hash: contentHash(msg.threadId, replyText(JSON.parse(msg.content))) };
  } catch {
    return undefined;
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

// Delivery recorded the reply: its send record has done its job.
registerPostDeliveryHook(async (msg) => {
  const reply = inboxReply(msg);
  if (reply) await deleteSends(reply.threadKey, reply.hash, 'sent');
});

// Delivery gave up on the reply: the same words sent later are a new send.
registerDeliveryFailedHook(async (failed) => {
  for (const msg of failed) {
    const reply = inboxReply(msg);
    if (reply) await deleteSends(reply.threadKey, reply.hash, 'pending');
  }
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

// ---------------------------------------------------------------------------
// `ncl dkim-selectors` — the operator's pins, from the host only.
// ---------------------------------------------------------------------------

const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const SELECTOR = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62})$/u;

function pinArgs(args: Record<string, unknown>): { readonly domain: string; readonly selector: string } {
  const domain = typeof args.domain === 'string' ? args.domain.trim().toLowerCase() : '';
  const selector = typeof args.selector === 'string' ? args.selector.trim() : '';
  if (!DOMAIN.test(domain)) throw new Error('--domain must be a domain name, such as example.com');
  if (!SELECTOR.test(selector)) throw new Error('--selector must be a DKIM selector, such as google');
  return { domain, selector };
}

const PIN_ARGS: ColumnDef[] = [
  { name: 'domain', type: 'string', required: true, description: "The signing domain, such as the principal's." },
  {
    name: 'selector',
    type: 'string',
    required: true,
    description: 'The DKIM selector (the s= tag) its mail is signed with.',
  },
];

registerResource({
  name: 'dkim selector',
  plural: 'dkim-selectors',
  table: 'gws_ea_inbox_dkim_selectors',
  idColumn: 'domain',
  description:
    "DKIM selectors the operator pinned per domain. Mail from the principal's address counts as theirs only when Gmail verified a DKIM signature from its domain with a pinned selector.",
  columns: [
    { name: 'domain', type: 'string', description: 'The signing domain.' },
    { name: 'selector', type: 'string', description: 'The pinned selector.' },
    { name: 'pinned_at', type: 'string', description: 'When it was pinned.', generated: true },
  ],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      hostOnly: true,
      description: 'List the pinned DKIM selectors.',
      args: [],
      handler: async () => listPinnedSelectors(),
    },
    pin: {
      access: 'open',
      hostOnly: true,
      description:
        "Pin a DKIM selector for a domain. Read it from the s= tag of Gmail's dkim=pass result on a message the principal sent the assistant.",
      args: PIN_ARGS,
      examples: ['ncl dkim-selectors pin --domain example.com --selector google'],
      handler: async (args) => {
        const { domain, selector } = pinArgs(args);
        return { domain, selector, pinned: await pinSelector(domain, selector, new Date().toISOString()) };
      },
    },
    unpin: {
      access: 'open',
      hostOnly: true,
      description: 'Unpin a DKIM selector. With none left for a domain, no mail from it is the principal’s.',
      args: PIN_ARGS,
      handler: async (args) => {
        const { domain, selector } = pinArgs(args);
        return { domain, selector, unpinned: await unpinSelector(domain, selector) };
      },
    },
  },
});

// What status reads, from the host only: `getInboxHealth()` exactly as follow-through reads it.
register({
  name: 'gws-ea-inbox-health',
  description:
    "Report the inbox's health, calendar notifications, and the principal's domains with no pinned DKIM selector.",
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
  type GmailMessageRef,
} from './gmail-api.js';
export type { ThreadOrigin, ThreadPeople, ThreadState } from './db.js';
export { getInboxHealth, type InboxHealth } from './health.js';
export type { HeldMailFields, InboxNote } from './notes.js';
export { sendPrincipalReply, type PrincipalReply } from './outbound.js';
export type { Placement } from './recipients.js';
export { registerThreadReplyHook, type ThreadReplyHook } from './routing.js';
export { EMAIL_CHANNEL_TYPE, INBOX_PLATFORM_ID } from './runtime.js';
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
export { ensureInbox, getInboxMessagingGroupId } from './wiring-policy.js';
