/**
 * GWS-EA privacy: the principal's private values and the audience check
 * (R24, R37, KTD7).
 *
 * Private values are the ones the principal names, held in a main-only
 * store. One check covers everything sent to anyone but the principal:
 *
 *   - an outbound guard at the delivery adapter, so agent replies, approval
 *     cards, and host notices all pass it. A send is read together with its
 *     thread's earlier outbound text, so a value split across sends is found.
 *     After `MAX_REFUSALS_PER_THREAD` refusals the thread stops: nothing more
 *     is sent in it, and main's shared session gets a typed signal, routed to
 *     the principal's direct message;
 *   - `checkOutbound`, the same check for the host's calendar writes and
 *     main's handoff text, which never pass through a channel.
 *
 * A refusal names only the value's fixed kind, never the value or its label.
 * Removing a value switches its check off, so an agent's removal waits for
 * the principal's card.
 */
import { randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';

import { registerResource, type ColumnDef } from '../../cli/crud.js';
import type { CallerContext } from '../../cli/frame.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import { getSession } from '../../db/sessions.js';
import { registerOutboundGuard, type OutboundGuardDecision, type OutboundSend } from '../../delivery.js';
import { ALLOW, DENY, defineGuardedAction, guard, HOLD, type GuardActor } from '../../guard/index.js';
import { log } from '../../log.js';
import { registerApprovalHandler, requestApproval } from '../approvals/index.js';
import {
  assertMainCaller,
  getMainAgentGroupId,
  isVerifiedPrincipalUser,
  principalApproverUserId,
} from '../gws-ea-profile/db.js';
import { writeNoteForMain } from '../gws-ea-profile/main-note.js';
import { resolveAudience, type Audience } from './audience.js';
import {
  addPrivateValue,
  getPrivateValue,
  judgeThreadSend,
  listPrivateValues,
  removePrivateValue,
  type PrivateValue,
  type ThreadKey,
} from './db.js';
import {
  compilePrivateValue,
  findPrivateValue,
  PRIVATE_VALUE_KINDS,
  streamOf,
  type CompiledPrivateValue,
  type PrivateValueKind,
} from './match.js';
import { gwsEaPrivacyMigration } from './migration.js';

registerMigration(gwsEaPrivacyMigration);

export {
  audienceForAddresses,
  registerRecipientResolver,
  resolveAudience,
  type Audience,
  type RecipientResolver,
} from './audience.js';
export { deleteThreadRecord, listPrivateValues, type PrivateValue, type ThreadKey } from './db.js';
export { PRIVATE_VALUE_KINDS, type PrivateValueKind } from './match.js';

export const PRIVACY_GUARD_ID = 'gws-ea-privacy:audience';
/** Refusals one thread may collect; the one that reaches it stops the thread. */
export const MAX_REFUSALS_PER_THREAD = 3;
/** The `signal.type` of the note main's shared session gets when a thread stops. */
export const THREAD_STOPPED_SIGNAL = 'gws-ea-privacy.thread-stopped';

/** What main's session receives, in `content.signal`, when a thread stops. */
export interface ThreadStoppedSignal {
  readonly type: typeof THREAD_STOPPED_SIGNAL;
  /** The kind the stopping send carried. */
  readonly kind: PrivateValueKind;
  readonly refusals: number;
  readonly channel_type: string;
  readonly platform_id: string;
  readonly thread_id: string | null;
  readonly stopped_at: string;
}

export type OutboundCheck =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly kind: PrivateValueKind;
      /** For the sender: names the kind, never the value or its label. */
      readonly reason: string;
    };

// ---------------------------------------------------------------------------
// Wording: the fixed kind only, never a value or a label.
// ---------------------------------------------------------------------------

const KIND_NOUNS: Readonly<Record<PrivateValueKind, string>> = {
  address: 'address',
  phone: 'phone number',
  email: 'email address',
  other: 'detail',
};

function refusalReason(kind: PrivateValueKind): string {
  return `it contains the principal's private ${KIND_NOUNS[kind]}. Rewrite it without that detail, and do not hint at, spell out, or encode it.`;
}

function stoppingReason(kind: PrivateValueKind): string {
  return `it contains the principal's private ${KIND_NOUNS[kind]}, and this conversation is now stopped after repeated attempts. Send nothing more in it; the principal will be told.`;
}

const STOPPED_REASON =
  "this conversation is stopped after repeated attempts to send the principal's private details. Send nothing more in it; the principal will be told.";

function stoppedSignalText(kind: PrivateValueKind, refusals: number): string {
  return (
    `The host stopped a conversation with someone other than the principal: the assistant tried ${refusals} times to send them the principal's private ${KIND_NOUNS[kind]}. ` +
    'Every attempt was refused, so nothing private was sent, and nothing more will be sent in that conversation.'
  );
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

async function compiledValues(): Promise<CompiledPrivateValue[]> {
  if (!(await getDb().hasTable('gws_ea_private_values'))) return [];
  return (await listPrivateValues()).map((value) => compilePrivateValue(value.kind, value.value));
}

/**
 * Check text bound for `audience`: the principal may receive anything, and
 * anyone else no private value. `content` is one text, or the fields of one
 * write (a calendar event's title, location, description, and comments),
 * read in order as one stream so a value split across fields is found too.
 */
export async function checkOutbound(content: string | readonly string[], audience: Audience): Promise<OutboundCheck> {
  if (audience === 'principal') return { allowed: true };
  const parts = typeof content === 'string' ? [content] : content;
  const match = findPrivateValue(await compiledValues(), streamOf(parts));
  return match ? { allowed: false, kind: match.kind, reason: refusalReason(match.kind) } : { allowed: true };
}

/** Every string and number in the serialized message, in order, whatever its shape. */
function collectText(value: unknown, into: string[]): void {
  if (typeof value === 'string') into.push(value);
  else if (typeof value === 'number') into.push(String(value));
  else if (Array.isArray(value)) for (const item of value) collectText(item, into);
  else if (typeof value === 'object' && value !== null)
    for (const item of Object.values(value)) collectText(item, into);
}

function parsedContent(content: string): unknown {
  /* eslint-disable no-catch-all/no-catch-all -- content that is not JSON is checked as the plain text it is */
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

/**
 * The text a send carries: every field of its message, each file's name, and
 * each file that is text. A binary file is a form of encoding the check
 * cannot read, a known residual alongside spelled-out values.
 */
function sendText(send: OutboundSend): string[] {
  const parts: string[] = [];
  collectText(parsedContent(send.content), parts);
  for (const file of send.files ?? []) {
    parts.push(file.filename);
    if (isUtf8(file.data)) parts.push(file.data.toString('utf8'));
  }
  return parts;
}

/** The outbound guard: refuses a send to anyone but the principal that gives a private value away. */
async function judgeSend(send: OutboundSend): Promise<OutboundGuardDecision> {
  if (!(await getDb().hasTable('gws_ea_privacy_threads'))) return { effect: 'allow' };
  if ((await resolveAudience(send)) === 'principal') return { effect: 'allow' };
  const values = await compiledValues();
  const key: ThreadKey = { channelType: send.channelType, platformId: send.platformId, threadId: send.threadId };
  const current = streamOf(sendText(send));
  const verdict = await judgeThreadSend(
    key,
    current,
    (history) => findPrivateValue(values, current, history)?.kind,
    MAX_REFUSALS_PER_THREAD,
  );
  switch (verdict.outcome) {
    case 'allowed':
      return { effect: 'allow' };
    case 'stopped':
      return { effect: 'refuse', reason: STOPPED_REASON };
    case 'refused':
      if (!verdict.stopped) return { effect: 'refuse', reason: refusalReason(verdict.kind) };
      await signalThreadStopped(key, verdict.kind, verdict.refusals);
      await runThreadStoppedHooks(key);
      return { effect: 'refuse', reason: stoppingReason(verdict.kind) };
    default: {
      const unreachable: never = verdict;
      throw new Error(`Unknown thread verdict: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Tell main, in its shared session, that a thread stopped. The note is routed
 * to the principal's direct message, so main's reply reaches the principal.
 * The stop already holds, so a failure here is logged and never retried.
 */
async function signalThreadStopped(key: ThreadKey, kind: PrivateValueKind, refusals: number): Promise<void> {
  /* eslint-disable no-catch-all/no-catch-all -- the stop holds either way; telling main is best effort and logged */
  try {
    const stoppedAt = new Date().toISOString();
    const signal: ThreadStoppedSignal = {
      type: THREAD_STOPPED_SIGNAL,
      kind,
      refusals,
      channel_type: key.channelType,
      platform_id: key.platformId,
      thread_id: key.threadId,
      stopped_at: stoppedAt,
    };
    const result = await writeNoteForMain({
      id: `privacy-stop-${randomUUID()}`,
      timestamp: stoppedAt,
      text: stoppedSignalText(kind, refusals),
      fields: { signal },
      wake: true,
    });
    if (result === 'no-main' || result === 'no-principal') {
      log.warn('Privacy stop not signalled: no main or no principal direct message', {
        channelType: key.channelType,
      });
      return;
    }
    log.info('Privacy stop signalled to main', { channelType: key.channelType, kind });
  } catch (err) {
    log.error('Privacy stop could not be signalled to main', { channelType: key.channelType, err });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

/** What another module does when one of its threads stops, such as closing the session behind it. */
export type ThreadStoppedHook = (thread: ThreadKey) => Promise<void>;

const threadStoppedHooks = new Map<string, ThreadStoppedHook>();
const HOOK_ID = /^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/u;

/** Register a module's reaction to a stopped thread. IDs take the `module:name` form. */
export function registerThreadStoppedHook(id: string, hook: ThreadStoppedHook): void {
  if (!HOOK_ID.test(id)) throw new Error(`Thread-stopped hook "${id}" must use "<module-id>:<hook-id>"`);
  if (threadStoppedHooks.has(id)) throw new Error(`Thread-stopped hook "${id}" is already registered`);
  threadStoppedHooks.set(id, hook);
}

/** The stop already holds, so each hook is isolated: a failure is logged and never stops the others. */
async function runThreadStoppedHooks(key: ThreadKey): Promise<void> {
  for (const [id, hook] of threadStoppedHooks) {
    /* eslint-disable no-catch-all/no-catch-all -- the stop holds either way; a hook failure is logged */
    try {
      await hook(key);
    } catch (err) {
      log.error('Thread-stopped hook failed', { hookId: id, channelType: key.channelType, err });
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }
}

registerOutboundGuard(PRIVACY_GUARD_ID, judgeSend);

// ---------------------------------------------------------------------------
// Removal: held for the principal's card, because it switches a check off.
// ---------------------------------------------------------------------------

/** The `pending_approvals.action` a removal card resolves through. */
const REMOVAL_APPROVAL = 'private_value_remove';

/** The card's payload, exactly as `requestApproval` stores it, so a grant binds to one value. */
function removalPayload(id: string): { readonly id: string } {
  return { id };
}

const removePrivateValueAction = defineGuardedAction({
  action: 'privacy.remove_value',
  grantActionName: REMOVAL_APPROVAL,
  grantCoversRequest: (grant, input) =>
    typeof input.payload.id === 'string' && grant.payload === JSON.stringify(removalPayload(input.payload.id)),
  decide: async ({ actor }) => {
    if (actor.kind === 'host') return ALLOW('host caller (trusted socket)');
    const mainAgentGroupId = await getMainAgentGroupId();
    if (actor.kind !== 'agent' || mainAgentGroupId === null || actor.agentGroupId !== mainAgentGroupId) {
      return DENY('Only main may ask to remove a private value.');
    }
    const approver = await principalApproverUserId();
    if (approver === undefined) return DENY('No verified principal can confirm removing a private value yet.');
    return HOLD('removing a private value switches its check off, so the principal confirms it', approver);
  },
});

function actorOf(ctx: CallerContext): GuardActor {
  return ctx.caller === 'host'
    ? { kind: 'host' }
    : { kind: 'agent', agentGroupId: ctx.agentGroupId, sessionId: ctx.sessionId };
}

async function requestRemovalCard(ctx: CallerContext, value: PrivateValue, approverUserId: string | undefined) {
  if (ctx.caller !== 'agent' || approverUserId === undefined) {
    throw new Error('Only an agent removal is held for the principal');
  }
  const session = await getSession(ctx.sessionId);
  if (!session) throw new Error('Session not found');
  const agentName = (await getAgentGroup(ctx.agentGroupId))?.name ?? ctx.agentGroupId;
  await requestApproval({
    session,
    agentName,
    action: REMOVAL_APPROVAL,
    payload: removalPayload(value.id),
    title: 'Stop protecting a private detail?',
    question: `${agentName} asks to stop protecting your private ${KIND_NOUNS[value.kind]} "${value.label}". Once it is removed, the assistant may share it with people other than you.`,
    approverUserId,
  });
  return {
    id: value.id,
    status: 'awaiting-principal',
    message:
      'The principal was asked to confirm on a card. You will be told the result; until then the value stays protected.',
  } as const;
}

registerApprovalHandler(REMOVAL_APPROVAL, async ({ session, payload, approval, userId, notify }) => {
  const id = typeof payload.id === 'string' ? payload.id : '';
  // The card names its approver; this re-check holds even if the principal
  // identity changed after the card went out.
  if (!(await isVerifiedPrincipalUser(userId))) {
    await notify('The private value was not removed: only the principal can confirm removing one.');
    return;
  }
  const decision = await guard(removePrivateValueAction, {
    actor: { kind: 'agent', agentGroupId: session.agent_group_id, sessionId: session.id },
    payload: { id },
    grant: approval,
  });
  if (decision.effect !== 'allow') {
    await notify(`The private value was not removed: ${decision.reason}`);
    return;
  }
  const removed = await removePrivateValue(id);
  await notify(
    `The principal confirmed. Their private ${KIND_NOUNS[removed.kind]} "${removed.label}" is removed and no longer checked.`,
  );
});

// ---------------------------------------------------------------------------
// `ncl private-values list | add | remove` — main's path to the store.
// ---------------------------------------------------------------------------

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') throw new Error(`--${key} is required`);
  return value;
}

const KIND_ARG: ColumnDef = {
  name: 'kind',
  type: 'string',
  description: 'address, phone, email, or other. A refusal names only this kind.',
  required: true,
  enum: [...PRIVATE_VALUE_KINDS],
};

registerResource({
  name: 'private value',
  plural: 'private-values',
  // Custom verbs only: the generic CRUD handlers that read `table` and `idColumn` are not enabled.
  table: 'gws_ea_private_values',
  idColumn: 'id',
  description:
    "The principal's private values: details such as a home address or a personal phone number that nothing sent to anyone but the principal may contain. Only main may use them.",
  columns: [
    { name: 'id', type: 'string', description: 'The value to remove (from `list`).', generated: true },
    { name: 'label', type: 'string', description: 'What the principal calls it, such as Home.' },
    KIND_ARG,
    { name: 'value', type: 'string', description: 'The value, as the principal gave it.' },
    { name: 'created_at', type: 'string', description: 'When it was added.', generated: true },
  ],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description: "List the principal's private values with their labels and kinds.",
      args: [],
      handler: async (_args, ctx) => {
        await assertMainCaller(ctx, 'private values');
        return listPrivateValues();
      },
    },
    add: {
      access: 'open',
      description:
        'Protect a value the principal calls private: from then on nothing sent to anyone but the principal may contain it, however it is written.\n\n' +
        'Adding a value already held, in any spelling, changes nothing. A phone value needs 7 to 15 digits; any other needs at least 4 letters or digits.',
      args: [
        { name: 'label', type: 'string', description: 'What the principal calls it, in a few words.', required: true },
        KIND_ARG,
        { name: 'value', type: 'string', description: 'The value, as the principal gave it.', required: true },
      ],
      examples: [
        'ncl private-values add --label "Home" --kind address --value "12 Elm Road, Springfield"',
        'ncl private-values add --label "Personal mobile" --kind phone --value "+1 415 555 0134"',
      ],
      handler: async (args, ctx) => {
        await assertMainCaller(ctx, 'private values');
        return addPrivateValue({
          label: stringArg(args, 'label'),
          kind: stringArg(args, 'kind'),
          value: stringArg(args, 'value'),
        });
      },
    },
    remove: {
      access: 'open',
      description:
        'Stop protecting a private value. Removing one switches its check off, so the principal confirms it on a card first; you are told the result, and the value stays protected until then.',
      args: [{ name: 'id', type: 'string', description: 'The value to remove (from `list`).', required: true }],
      examples: ['ncl private-values remove --id pv-1a2b3c4d5e6f'],
      handler: async (args, ctx) => {
        await assertMainCaller(ctx, 'private values');
        const id = stringArg(args, 'id');
        const value = await getPrivateValue(id);
        if (!value) throw new Error(`No private value ${JSON.stringify(id)} exists`);
        const decision = await guard(removePrivateValueAction, { actor: actorOf(ctx), payload: { id } });
        switch (decision.effect) {
          case 'allow':
            return { removed: await removePrivateValue(id) };
          case 'hold':
            return requestRemovalCard(ctx, value, decision.approverUserId);
          case 'deny':
            throw new Error(decision.reason);
          default: {
            const unreachable: never = decision;
            throw new Error(`Unknown guard decision: ${JSON.stringify(unreachable)}`);
          }
        }
      },
    },
  },
});
