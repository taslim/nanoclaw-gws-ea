/**
 * GWS-EA failure notices (R38).
 *
 * When the assistant cannot finish something, the principal hears one plain
 * sentence in their own direct message, never in the conversation the
 * failure came from, so a counterpart never sees it. Core reports three
 * causes; this module owns the wording and the audience:
 *
 *   - a reply the host gave up delivering (registerDeliveryFailedHook);
 *   - an inbound message the host gave up processing (registerInboundFailedHook);
 *   - a turn the agent runner reports as failed (the `turn_failed` delivery action).
 *
 * Each report sends at most one sentence. Only a failure in a conversation
 * with a person counts: host notes and agent-to-agent traffic ride the
 * `agent` channel, and a task session serves no conversation. A failure in
 * the principal's direct message keeps its thread there; any other goes to
 * the top of the direct message.
 *
 * The notice is one direct send through the delivery adapter, so it passes
 * the outbound guard. It is never queued or retried, so a failing channel
 * cannot turn one notice into a stream of them. Why the failure happened goes
 * to the host log only.
 */
import { getDb } from '../../db/connection.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter, registerDeliveryAction, registerDeliveryFailedHook } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { log } from '../../log.js';
import type { OutboundMessage } from '../../mailbox/index.js';
import { registerInboundFailedHook } from '../../reconcile-session.js';
import type { MessagingGroup, Session } from '../../types.js';

/** The one plain sentence the principal sees whenever the assistant could not finish. */
const FAILURE_NOTICE_TEXT = "Something went wrong on my side and I couldn't finish that. Please send it again.";

type Cause = 'delivery-failed' | 'inbound-failed' | 'turn-failed';

/** The conversation and thread a failed message or turn belonged to. */
interface Route {
  readonly channelType: string | null;
  readonly platformId: string | null;
  readonly threadId: string | null;
}

/** A conversation with a person, not a host note or another agent. */
function isPersonRoute(route: Route): boolean {
  return route.channelType !== null && route.platformId !== null && route.channelType !== 'agent';
}

/** The direct message of the most recently verified principal identity (bound by gws-ea-profile). */
async function principalDirectMessage(): Promise<MessagingGroup | undefined> {
  const db = getDb();
  if (!(await db.hasTable('gws_ea_principal_users'))) return undefined;
  const row = await db.get<{ messaging_group_id: string }>(
    `SELECT dm.messaging_group_id
       FROM gws_ea_principal_users principal
       JOIN user_dms dm ON dm.user_id = principal.user_id
      ORDER BY principal.verified_at DESC, dm.resolved_at DESC
      LIMIT 1`,
  );
  return row ? getMessagingGroup(row.messaging_group_id) : undefined;
}

async function tellPrincipal(cause: Cause, session: Session, route: Route): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) return;
  // Best effort from the lookup on: the work that failed is already recorded,
  // so a notice failure is logged, never retried, and never thrown.
  /* eslint-disable no-catch-all/no-catch-all -- the notice is best effort; its failure is logged, never retried */
  try {
    const dm = await principalDirectMessage();
    if (!dm || dm.detached_at) {
      log.info('Failure notice not sent: no reachable principal direct message', { cause, sessionId: session.id });
      return;
    }
    const inDm = route.channelType === dm.channel_type && route.platformId === dm.platform_id;
    await adapter.deliver(
      dm.channel_type,
      dm.platform_id,
      inDm ? route.threadId : null,
      'chat',
      JSON.stringify({ text: FAILURE_NOTICE_TEXT }),
      undefined,
      dm.instance,
    );
    log.info('Failure notice delivered', { cause, sessionId: session.id });
  } catch (err) {
    log.error('Failure notice could not be delivered', { cause, sessionId: session.id, err });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

/** A row a person would have seen as a message; a reaction the agent placed is decoration, not a reply. */
function isPersonFacingPost(msg: OutboundMessage): boolean {
  if (msg.kind === 'system' || msg.kind === 'task_log' || !isPersonRoute(msg)) return false;
  let content: unknown;
  /* eslint-disable no-catch-all/no-catch-all -- an unreadable row was still meant for the channel */
  try {
    content = JSON.parse(msg.content);
  } catch {
    return true;
  }
  /* eslint-enable no-catch-all/no-catch-all */
  return (content as { operation?: unknown } | null)?.operation !== 'reaction';
}

registerDeliveryFailedHook(async (failed, session) => {
  if (session.messaging_group_id === null) return;
  const reply = failed.find(isPersonFacingPost);
  if (reply) await tellPrincipal('delivery-failed', session, reply);
});

registerInboundFailedHook(async (failed, session) => {
  if (session.messaging_group_id === null) return;
  const fromPerson = failed.find(isPersonRoute);
  if (fromPerson) await tellPrincipal('inbound-failed', session, fromPerson);
});

/** The route a `turn_failed` report carries; a missing or malformed field counts as none. */
function reportedRoute(content: Record<string, unknown>): Route {
  const field = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
  return {
    channelType: field(content.channelType),
    platformId: field(content.platformId),
    threadId: field(content.threadId),
  };
}

registerDeliveryAction(
  'turn_failed',
  async (content, session) => {
    if (session.messaging_group_id === null) return;
    const route = reportedRoute(content);
    if (isPersonRoute(route)) await tellPrincipal('turn-failed', session, route);
  },
  unguarded('reports a failure to the principal only; the notice itself passes the outbound guard'),
);
