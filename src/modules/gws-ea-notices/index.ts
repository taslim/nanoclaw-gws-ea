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
 * Other GWS-EA modules that own a sentence of their own (the inbox, for mail
 * it set aside or an inbox it cannot reach) send it through
 * `sendPrincipalNotice`, to the same audience by the same path.
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
import { getDeliveryAdapter, registerDeliveryAction, registerDeliveryFailedHook } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { log } from '../../log.js';
import type { OutboundMessage } from '../../mailbox/index.js';
import { registerInboundFailedHook } from '../../reconcile-session.js';
import type { Session } from '../../types.js';
import { principalContact } from '../gws-ea-profile/db.js';

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

/** What a notice's log lines name it by. */
interface NoticeLog {
  readonly label: 'Failure notice' | 'Notice';
  readonly fields: Readonly<Record<string, unknown>>;
}

/**
 * Send `text` to the principal's direct message as one direct send, in
 * `route`'s thread when the route is that direct message. Best effort: the
 * work it reports is already recorded, so a failure is logged, never retried,
 * and never thrown. Returns whether it was delivered.
 */
async function deliverToPrincipal(text: string, route: Route | undefined, notice: NoticeLog): Promise<boolean> {
  const adapter = getDeliveryAdapter();
  if (!adapter) return false;
  /* eslint-disable no-catch-all/no-catch-all -- the notice is best effort; its failure is logged, never retried */
  try {
    const dm = (await principalContact())?.directMessage;
    if (!dm || dm.detached_at) {
      log.info(`${notice.label} not sent: no reachable principal direct message`, notice.fields);
      return false;
    }
    const inDm = route !== undefined && route.channelType === dm.channel_type && route.platformId === dm.platform_id;
    await adapter.deliver(
      dm.channel_type,
      dm.platform_id,
      inDm ? route.threadId : null,
      'chat',
      JSON.stringify({ text }),
      undefined,
      dm.instance,
    );
    log.info(`${notice.label} delivered`, notice.fields);
    return true;
  } catch (err) {
    log.error(`${notice.label} could not be delivered`, { ...notice.fields, err });
    return false;
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

async function tellPrincipal(cause: Cause, session: Session, route: Route): Promise<void> {
  await deliverToPrincipal(FAILURE_NOTICE_TEXT, route, {
    label: 'Failure notice',
    fields: { cause, sessionId: session.id },
  });
}

/**
 * One plain sentence to the principal, at the top of their direct message,
 * for a module that owns its own wording (such as the inbox reporting a
 * message it set aside). It passes the outbound guard like any send, and is
 * never queued or retried. Returns whether it was delivered.
 */
export async function sendPrincipalNotice(text: string, cause: string): Promise<boolean> {
  return deliverToPrincipal(text, undefined, { label: 'Notice', fields: { cause } });
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
