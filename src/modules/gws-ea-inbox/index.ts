/**
 * GWS-EA's inbox: the assistant's Gmail as an `email` channel with two
 * messaging groups (KTD1), and Google Calendar's mail as calendar news.
 *
 * - Inbound mail is routed per message to the part allowed to write to its
 *   readers (route-mail.ts): what only the principal and the assistant can
 *   read reaches `main` in the principal's own email conversation
 *   (`email:principal`); everything else reaches `external-email`'s session
 *   for its thread (`email:inbox`).
 * - `main`'s replies leave through ordinary delivery to the principal alone,
 *   which the audience check resolves to the same address
 *   (principal-reply.ts). `external-email`'s go to everyone on its thread,
 *   or to whom it names among the thread's addresses (outbound.ts,
 *   recipients.ts). `email_send` lets either write in a thread at any time,
 *   each by its own rules.
 * - Mail is the principal's only when Gmail verified that the domain of one
 *   of their addresses sent it (authentication.ts). Mail in their name that
 *   Gmail could not verify is outside mail, and the principal hears of it
 *   once for each address and reason.
 * - Google Docs' and Drive's activity mail becomes one note for `main` per
 *   poll, read from Drive with the host's own Drive token
 *   (gws-ea-workspace/notices.ts).
 *
 * The host starts the inbox after `external-email` exists: it creates both
 * messaging groups and their wirings when absent, brings `main`'s members in
 * step with the principal's addresses, then polls each minute.
 */
import fs from 'node:fs';

import { registerChannelAdapter } from '../../channels/channel-registry.js';
import { register } from '../../cli/registry.js';
import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import { deleteSession, getSessionsByAgentGroup, updateSession } from '../../db/sessions.js';
import { registerDeliveryAction, registerDeliveryFailedHook, registerPostDeliveryHook } from '../../delivery.js';
import { readEnvFile } from '../../env.js';
import { onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import type { OutboundMessage } from '../../mailbox/index.js';
import { destroySessionMailbox, sessionDir } from '../../session-manager.js';
import { getExternalEmailAgentGroupId } from '../gws-ea-external-email/index.js';
import { getInboxHealth } from './health.js';
import { hostGoogleAccessToken } from '../gws-ea-google/index.js';
import { GOOGLE_GRANT_FILE_ENV } from '../gws-ea-google/grant.js';
import { identityMatchKey } from '../../gws-ea/validation.js';
import { createMeetingsCalendarApi } from '../gws-ea-meetings/calendar-api.js';
import { registerPersonForgetHook } from '../gws-ea-people/index.js';
import { registerRecipientResolver } from '../gws-ea-privacy/index.js';
import {
  getAliasSetup,
  getMainAgentGroupId,
  proposeAliasCandidate,
  syncPrincipalMembers,
  type AliasSetup,
} from '../gws-ea-profile/db.js';
import { createDriveApi } from '../gws-ea-workspace/drive-api.js';
import { registerRoleGrantPolicy } from '../permissions/db/user-roles.js';
import { HOLD_UNTIL_RELEASED, registerInboundDelay } from '../../router.js';
import { createInbox, EMAIL_CHANNEL_DEFAULTS, type Inbox } from './adapter.js';
import { probeAlias } from './alias-probe.js';
import { createCalendarListApi } from './calendar-notifications.js';
import { createGmailApi } from './gmail-api.js';
import {
  gwsEaInboxCalendarAccessMigration,
  gwsEaInboxDropThreadHoldsMigration,
  gwsEaInboxEmailChannelMigration,
  gwsEaInboxMigration,
  gwsEaInboxRelativeFilePathsMigration,
  gwsEaInboxThreadAccountsMigration,
  gwsEaInboxThreadPlacementMigration,
  gwsEaInboxUnsignedNoticesMigration,
} from './migration.js';
import { EMAIL_SEND_ACTION, EMAIL_SEND_GUARD, emailSendHandler } from './outbound.js';
import { inboundPace } from './pace.js';
import { principalRecipients } from './principal-reply.js';
import { activeInbox, EMAIL_CHANNEL_TYPE, INBOX_PLATFORM_ID, PRINCIPAL_PLATFORM_ID } from './runtime.js';
import { emailWords, sendKey } from './send.js';
import {
  clearThreadAccounts,
  deleteSends,
  deleteThreadAddresses,
  threadsWithAddresses,
  type SendScope,
} from './thread-map.js';
import { ensureInbox, ensurePrincipalConversation } from './wiring-policy.js';

// The inbox's own state, its thread map, then what was added since (migration.ts).
registerMigration(gwsEaInboxMigration);
registerMigration(gwsEaInboxEmailChannelMigration);
registerMigration(gwsEaInboxDropThreadHoldsMigration);
registerMigration(gwsEaInboxRelativeFilePathsMigration);
registerMigration(gwsEaInboxUnsignedNoticesMigration);
registerMigration(gwsEaInboxCalendarAccessMigration);
registerMigration(gwsEaInboxThreadAccountsMigration);
registerMigration(gwsEaInboxThreadPlacementMigration);

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
      events: createMeetingsCalendarApi({ token: () => hostGoogleAccessToken('calendar-host') }),
      drive: createDriveApi({ token: () => hostGoogleAccessToken('drive-host') }),
    });
    return live.adapter;
  },
  defaults: EMAIL_CHANNEL_DEFAULTS,
});

// Email to the principal is theirs when it goes only to their address. The
// privacy guard leaves email to the inbox's outside threads to `sendToOutside`,
// which checks it as it is built; any other email address reaches no one.
registerRecipientResolver(EMAIL_CHANNEL_TYPE, (send) =>
  send.platformId === PRINCIPAL_PLATFORM_ID ? principalRecipients(send) : [],
);

registerDeliveryAction(EMAIL_SEND_ACTION, emailSendHandler, EMAIL_SEND_GUARD);

// A mail sender is only as trustworthy as the domain behind it, so no email
// identity may hold a privilege: commands and approvals stay with chat users
// the channel itself authenticates (KTD4).
registerRoleGrantPolicy('gws-ea-inbox:no-email-privilege', (grant) =>
  grant.user_id.startsWith(`${EMAIL_CHANNEL_TYPE}:`) ? 'an email identity never holds owner or admin' : undefined,
);

// An outside thread is worked at a human pace: what reaches its session waits for the thread's next turn (KTD3).
// Before that, its mail waits, held, until main places the thread and hands it over (Slice 5 KTD8): a hold
// wins over a time, as the router resolves them.
registerInboundDelay(async (_event, session) => {
  const pace = await inboundPace(session);
  if (pace === undefined) return null;
  return pace.held ? HOLD_UNTIL_RELEASED : pace.deadline;
});

/** The send record of a row the channel sent: an agent's email on one side of its thread. */
function emailSend(msg: OutboundMessage): { readonly scope: SendScope; readonly key: string } | undefined {
  if (msg.channelType !== EMAIL_CHANNEL_TYPE || msg.threadId === null) return undefined;
  const side =
    msg.platformId === INBOX_PLATFORM_ID
      ? 'outside'
      : msg.platformId === PRINCIPAL_PLATFORM_ID
        ? 'principal'
        : undefined;
  if (side === undefined) return undefined;
  /* eslint-disable no-catch-all/no-catch-all -- a row the inbox could never have sent has no send record */
  let content: unknown;
  try {
    content = JSON.parse(msg.content);
  } catch {
    return undefined;
  }
  /* eslint-enable no-catch-all/no-catch-all */
  const words = emailWords(content);
  return words === undefined
    ? undefined
    : { scope: { threadKey: msg.threadId, side }, key: sendKey(msg.threadId, words) };
}

async function forgetSend(msg: OutboundMessage, state: 'pending' | 'sent'): Promise<void> {
  const send = emailSend(msg);
  if (send !== undefined) await deleteSends(send.scope, send.key, state);
}

// Delivery recorded the email: its send record has done its job.
registerPostDeliveryHook((msg) => forgetSend(msg, 'sent'));

// Delivery gave up on the email: the same words sent later are a new send.
registerDeliveryFailedHook(async (failed) => {
  for (const msg of failed) await forgetSend(msg, 'pending');
});

/**
 * Remove a session and everything it holds. A container still running for it
 * is the host's orphan sweep to stop (`stopOrphanedSessions`), within a sweep
 * of the session's row going.
 */
async function purgeSession(sessionId: string, agentGroupId: string): Promise<void> {
  await updateSession(sessionId, { status: 'closed' });
  await destroySessionMailbox(agentGroupId, sessionId);
  fs.rmSync(sessionDir(agentGroupId, sessionId), { recursive: true, force: true });
  await deleteSession(sessionId);
}

/** Remove the `external-email` sessions of these threads. */
async function purgeThreadSessions(threadKeys: readonly string[]): Promise<void> {
  const externalEmail = await getExternalEmailAgentGroupId();
  const threads = new Set(threadKeys);
  if (externalEmail !== null) {
    for (const session of await getSessionsByAgentGroup(externalEmail)) {
      if (session.thread_id !== null && threads.has(session.thread_id)) await purgeSession(session.id, externalEmail);
    }
  }
}

// A forgotten person leaves nothing of theirs on the threads they were on, in this order: those threads'
// external-email sessions, then together the accounts on those threads, which may tell of them, the person's
// addresses on every thread, by which those threads are known, and their hourly counts.
registerPersonForgetHook('gws-ea-inbox:purge', async ({ handles }) => {
  const db = getDb();
  if (!(await db.hasTable('gws_ea_threads'))) return;
  const forgotten = new Set(
    handles.filter((handle) => handle.toLowerCase().startsWith('email:')).map((handle) => identityMatchKey(handle)),
  );
  if (forgotten.size === 0) return;
  const isForgotten = (address: string) => forgotten.has(identityMatchKey(`email:${address}`));
  const { threadKeys, addresses } = await threadsWithAddresses(isForgotten);
  await purgeThreadSessions(threadKeys);
  await db.transaction(async () => {
    await clearThreadAccounts(threadKeys);
    await deleteThreadAddresses(addresses);
    for (const row of await db.all<{ sender: string }>('SELECT DISTINCT sender FROM gws_ea_inbox_sender_counts')) {
      if (isForgotten(row.sender)) await db.run('DELETE FROM gws_ea_inbox_sender_counts WHERE sender = ?', row.sender);
    }
  });
});

// What status reads, from the host only: `getInboxHealth()`, in the shape status reads.
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

// The web alias's setup, for gws-ea only (KTD13): gws-ea proposes the candidate the operator adds, then the
// running inbox probes it.
function aliasView(setup: AliasSetup) {
  return { alias: setup.alias, candidate: setup.candidate, probe_sent: setup.probe_message_id !== null };
}

function aliasFields(raw: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`Unknown alias field: --${unknown[0]}`);
}

function aliasAddress(raw: Record<string, unknown>): string {
  if (typeof raw.address !== 'string' || raw.address.length === 0) throw new Error('--address is required');
  return raw.address;
}

register({
  name: 'gws-ea-alias-get',
  description: "Report the web alias's setup.",
  access: 'hidden',
  hostOnly: true,
  parseArgs(raw) {
    aliasFields(raw, []);
    return undefined;
  },
  handler: async () => aliasView(await getAliasSetup()),
});

register({
  name: 'gws-ea-alias-propose',
  description: 'Ask for an address as the web alias (--address), or for none (--none).',
  access: 'hidden',
  hostOnly: true,
  parseArgs(raw) {
    aliasFields(raw, ['address', 'none']);
    if (raw.none === true && raw.address === undefined) return null;
    if (raw.none !== undefined) throw new Error('Give --address or --none, not both');
    return aliasAddress(raw);
  },
  handler: async (address) => aliasView(await proposeAliasCandidate(address)),
});

register({
  name: 'gws-ea-alias-probe',
  description: 'Read back the web alias probe from the running inbox, sending a new one first with --send.',
  access: 'hidden',
  hostOnly: true,
  parseArgs(raw) {
    aliasFields(raw, ['address', 'send']);
    if (raw.send !== undefined && raw.send !== true) throw new Error('--send takes no value');
    return { address: aliasAddress(raw), send: raw.send === true };
  },
  handler: async (input) => {
    const inbox = activeInbox();
    if (inbox === undefined) throw new Error("The assistant's inbox is not running, so its web alias cannot be probed");
    return probeAlias(inbox, input);
  },
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
  void inbox.run(signal);
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
export { getInboxHealth, type InboxHealth } from './health.js';
export { EMAIL_SEND_ACTION } from './outbound.js';
export { EMAIL_CHANNEL_TYPE, INBOX_PLATFORM_ID, PRINCIPAL_PLATFORM_ID } from './runtime.js';
export { ensureInbox, ensurePrincipalConversation, getInboxMessagingGroupId } from './wiring-policy.js';
