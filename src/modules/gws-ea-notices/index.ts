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
 * Each report sends at most one sentence. Only a failure in one of the
 * principal's own conversations counts: a session of `main`, by the
 * profile's pointer, with a person. Host notes and agent-to-agent traffic
 * ride the `agent` channel, and a task session serves no conversation. A
 * failure in `external-email`'s sessions is never the principal's to hear
 * this way: they asked for nothing there. A failed turn is reported only
 * through this module's `turn_failed` action, so a failed turn in any other
 * conversation goes to the owners registered with `registerTurnFailedHook`.
 * A failure in the principal's direct message keeps its thread there; any
 * other goes to the top of the direct message.
 *
 * The notice is one direct send through the delivery adapter, so it passes
 * the outbound guard. It is never queued or retried, so a failing channel
 * cannot turn one notice into a stream of them. Why the failure happened goes
 * to the host log only.
 */
import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import { getDeliveryAdapter, registerDeliveryAction, registerDeliveryFailedHook } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { log } from '../../log.js';
import type { OutboundMessage } from '../../mailbox/index.js';
import { registerInboundFailedHook } from '../../reconcile-session.js';
import type { Session } from '../../types.js';
import { getMainAgentGroupId, principalContact } from '../gws-ea-profile/db.js';
import { gwsEaNoticesMigration } from './migration.js';

registerMigration(gwsEaNoticesMigration);

/** The one plain sentence the principal sees whenever the assistant could not finish. */
const FAILURE_NOTICE_TEXT = "Something went wrong on my side and I couldn't finish that. Please send it again.";

type Cause = 'delivery-failed' | 'inbound-failed' | 'turn-failed';

/** The conversation and thread a failed message or turn belonged to. */
export interface Route {
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

/**
 * One of the principal's own conversations: a session of `main` serving a
 * conversation. Every other agent's sessions, `external-email`'s included,
 * are their owner's to report.
 */
async function isPrincipalConversation(session: Session): Promise<boolean> {
  return session.messaging_group_id !== null && session.agent_group_id === (await getMainAgentGroupId());
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

/** The failed replies among `ids` the principal has not been told of. */
async function unreported(ids: readonly string[]): Promise<Set<string>> {
  const rows = await getDb().all<{ message_id: string }>(
    `SELECT message_id FROM gws_ea_notices_reported WHERE message_id IN (${ids.map(() => '?').join(', ')})`,
    ...ids,
  );
  const reported = new Set(rows.map((row) => row.message_id));
  return new Set(ids.filter((id) => !reported.has(id)));
}

async function recordReported(ids: readonly string[]): Promise<void> {
  const at = new Date().toISOString();
  for (const id of ids) {
    await getDb().run(
      'INSERT INTO gws_ea_notices_reported (message_id, reported_at) VALUES (?, ?) ON CONFLICT (message_id) DO NOTHING',
      id,
      at,
    );
  }
}

// Delivery may report a give-up again after a stop: the principal hears of each failed reply once.
registerDeliveryFailedHook(async (failed, session) => {
  const replies = failed.filter(isPersonFacingPost);
  if (replies.length === 0 || !(await isPrincipalConversation(session))) return;
  const fresh = await unreported(replies.map((reply) => reply.id));
  const reply = replies.find((candidate) => fresh.has(candidate.id));
  if (!reply) return;
  await tellPrincipal('delivery-failed', session, reply);
  await recordReported([...fresh]);
});

registerInboundFailedHook(async (failed, session) => {
  const fromPerson = failed.find(isPersonRoute);
  if (fromPerson && (await isPrincipalConversation(session))) {
    await tellPrincipal('inbound-failed', session, fromPerson);
  }
});

/**
 * What the module owning a conversation does about a failed turn in it,
 * when the conversation is not the principal's own.
 */
export type TurnFailedHook = (route: Route, session: Session) => Promise<void>;

const turnFailedHooks = new Map<string, TurnFailedHook>();

/** Register an owner's reaction to a failed turn in a conversation that is not the principal's. */
export function registerTurnFailedHook(id: string, hook: TurnFailedHook): void {
  if (turnFailedHooks.has(id)) throw new Error(`Turn-failed hook "${id}" is already registered`);
  turnFailedHooks.set(id, hook);
}

/** Each hook is isolated: a failure is logged, and the hooks after it still run. */
async function handOnFailedTurn(route: Route, session: Session): Promise<void> {
  for (const [id, hook] of turnFailedHooks) {
    /* eslint-disable no-catch-all/no-catch-all -- the turn already failed; one owner's failure must not stop the others */
    try {
      await hook(route, session);
    } catch (err) {
      log.error('Turn-failed hook failed', { hookId: id, sessionId: session.id, err });
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }
}

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
    const route = reportedRoute(content);
    if (!isPersonRoute(route) || session.messaging_group_id === null) return;
    if (await isPrincipalConversation(session)) await tellPrincipal('turn-failed', session, route);
    else await handOnFailedTurn(route, session);
  },
  unguarded(
    "reports a failure to the principal or the conversation's owner only; the notice itself passes the outbound guard",
  ),
);
