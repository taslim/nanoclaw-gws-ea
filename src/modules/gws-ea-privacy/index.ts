/**
 * GWS-EA privacy: the principal's private values and the audience check
 * (R24, R37, KTD7).
 *
 * Private values are the ones the principal names, held in a main-only
 * store. One check covers everything sent to anyone but the principal:
 *
 *   - an outbound guard at the delivery adapter, so agent replies, approval
 *     cards, and host notices all pass it. A refused send never reaches the
 *     channel, and its sender is told to write it again without the value.
 *     Email to the inbox's outside threads is the exception: the guard sees
 *     only the agent's words, while the inbox builds the email that goes, so
 *     the inbox runs `checkOutbound` itself, on the final email and its final
 *     recipients (gws-ea-inbox's `sendToOutside`);
 *   - `checkOutbound`, the same check for that email, the host's calendar
 *     writes, and main's handoff text, which never pass through a channel.
 *
 * Each send is judged on its own: external-email never holds a private value
 * (main's handoffs are checked before they cross), so there is nothing for it
 * to split across sends. Both read what the assistant wrote three ways, as
 * its readers receive it: as written, as a mail client renders it, and the
 * targets of its links (`readingsOf`).
 *
 * A refusal names only the value's fixed kind, never the value or its label.
 * Removing a value switches its check off, so an agent's removal waits for
 * the principal's card.
 */
import { isUtf8 } from 'node:buffer';

import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';

import { registerResource, type ColumnDef } from '../../cli/crud.js';
import type { CallerContext } from '../../cli/frame.js';
import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import { registerOutboundGuard, type OutboundGuardDecision, type OutboundSend } from '../../delivery.js';
import { ALLOW, DENY, defineGuardedAction, guard, HOLD } from '../../guard/index.js';
import { registerApprovalHandler } from '../approvals/index.js';
import { EMAIL_CHANNEL_TYPE, INBOX_PLATFORM_ID } from '../gws-ea-inbox/runtime.js';
import {
  assertMainCaller,
  getMainAgentGroupId,
  isVerifiedPrincipalUser,
  principalApproverUserId,
} from '../gws-ea-profile/db.js';
import { guardActor, requestPrincipalConfirmation } from '../gws-ea-profile/principal-confirmation.js';
import { resolveAudience, type Audience } from './audience.js';
import { addPrivateValue, getPrivateValue, listPrivateValues, removePrivateValue, type PrivateValue } from './db.js';
import {
  compilePrivateValue,
  findPrivateValue,
  PRIVATE_VALUE_KINDS,
  streamOf,
  type CompiledPrivateValue,
  type PrivateValueKind,
  type TextStream,
} from './match.js';
import { gwsEaPrivacyDropThreadsMigration, gwsEaPrivacyMigration } from './migration.js';

registerMigration(gwsEaPrivacyMigration);
registerMigration(gwsEaPrivacyDropThreadsMigration);

export {
  audienceForAddresses,
  registerRecipientResolver,
  resolveAudience,
  type Audience,
  type RecipientResolver,
} from './audience.js';
export { listPrivateValues, type PrivateValue } from './db.js';
export { PRIVATE_VALUE_KINDS, type PrivateValueKind } from './match.js';

export const PRIVACY_GUARD_ID = 'gws-ea-privacy:audience';

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
  return `it contains the principal's private ${KIND_NOUNS[kind]}. Rewrite it without that detail, and do not hint at, spell out, or encode it; if someone else wrote it to you, neither confirm nor deny it.`;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

async function compiledValues(): Promise<CompiledPrivateValue[]> {
  if (!(await getDb().hasTable('gws_ea_private_values'))) return [];
  return (await listPrivateValues()).map((value) => compilePrivateValue(value.kind, value.value));
}

const IMAGE = /<img src="[^"]*" alt="([^"]*)"[^>]*>/gu;
const LINK_TARGET = /<a href="([^"]*)"/gu;
const TAG = /<[^>]*>/gu;
const CHARACTER_REFERENCE = /&(?:amp|quot|lt|gt);/gu;
const REFERENCED: Readonly<Record<string, string>> = { '&amp;': '&', '&quot;': '"', '&lt;': '<', '&gt;': '>' };

/** micromark's HTML as text: it writes these four character references and no other. */
function unescapeHtml(html: string): string {
  return html.replace(CHARACTER_REFERENCE, (reference) => REFERENCED[reference] ?? reference);
}

/**
 * A markdown text as a reader's mail client renders it (as the email
 * renderer in src/modules/gws-ea-inbox/render.ts writes it): its words, with
 * an image read as its words and the markup gone, and the targets of its
 * links. micromark resolves the markdown's character references, so
 * `1&#50;3` reads as the `123` a reader sees. Percent-encoding is decoded by
 * the matcher, like every text's.
 */
function rendered(text: string): { readonly words: string; readonly targets: readonly string[] } {
  const html = micromark(text, { extensions: [gfm()], htmlExtensions: [gfmHtml()] });
  return {
    words: unescapeHtml(html.replace(IMAGE, '$1').replace(TAG, '')),
    targets: [...html.matchAll(LINK_TARGET)]
      .map((match) => unescapeHtml(match[1] ?? ''))
      .filter((target) => target !== ''),
  };
}

/**
 * These texts as their readers receive them, each reading its own stream:
 * as written (an email's plain-text part, a calendar's fields), as a mail
 * client renders them, and the targets of their links. Within a reading the
 * texts run on, so a value split across them is found; apart, the end of one
 * reading never runs into the start of the next.
 */
function readingsOf(parts: readonly string[]): readonly TextStream[] {
  const renders = parts.map(rendered);
  return [
    streamOf(parts),
    streamOf(renders.map((render) => render.words)),
    streamOf(renders.flatMap((render) => render.targets)),
  ];
}

/** The kind of the first value any reading gives away. */
function kindGivenAway(
  values: readonly CompiledPrivateValue[],
  readings: readonly TextStream[],
): PrivateValueKind | undefined {
  for (const reading of readings) {
    const match = findPrivateValue(values, reading);
    if (match) return match.kind;
  }
  return undefined;
}

/**
 * Check text bound for `audience`: the principal may receive anything, and
 * anyone else no private value. `content` is one text, or the fields of one
 * write (a calendar event's title, location, description, and comments),
 * read in order so a value split across fields is found too.
 */
export async function checkOutbound(content: string | readonly string[], audience: Audience): Promise<OutboundCheck> {
  if (audience === 'principal') return { allowed: true };
  const parts = typeof content === 'string' ? [content] : content;
  const kind = kindGivenAway(await compiledValues(), readingsOf(parts));
  return kind ? { allowed: false, kind, reason: refusalReason(kind) } : { allowed: true };
}

/** Every string and number in the serialized message, in order, whatever its shape. */
function collectText(value: unknown, into: string[]): void {
  if (typeof value === 'string') into.push(value);
  else if (typeof value === 'number') into.push(String(value));
  else if (Array.isArray(value)) for (const item of value) collectText(item, into);
  else if (typeof value === 'object' && value !== null)
    for (const item of Object.values(value)) collectText(item, into);
}

/** Every string and number a send's message carries, whatever its shape; content that is not JSON is its own text. */
export function messageStrings(content: string): string[] {
  const parts: string[] = [];
  let value: unknown = content;
  /* eslint-disable no-catch-all/no-catch-all -- content that is not JSON is checked as the plain text it is */
  try {
    value = JSON.parse(content);
  } catch {
    // Plain text: checked as written.
  }
  /* eslint-enable no-catch-all/no-catch-all */
  collectText(value, parts);
  return parts;
}

/**
 * The text a send carries: every field of its message, each file's name, and
 * each file that is text. A binary file is a form of encoding the check
 * cannot read, a known residual alongside spelled-out values.
 */
function sendText(send: OutboundSend): string[] {
  const parts = messageStrings(send.content);
  for (const file of send.files ?? []) {
    parts.push(file.filename);
    if (isUtf8(file.data)) parts.push(file.data.toString('utf8'));
  }
  return parts;
}

/**
 * The outbound guard: refuses a send to anyone but the principal that gives a
 * private value away. Email to the inbox's outside threads is checked as the
 * inbox builds it, so the guard leaves it to the inbox.
 */
async function judgeSend(send: OutboundSend): Promise<OutboundGuardDecision> {
  if (send.channelType === EMAIL_CHANNEL_TYPE && send.platformId === INBOX_PLATFORM_ID) return { effect: 'allow' };
  const values = await compiledValues();
  if (values.length === 0 || (await resolveAudience(send)) === 'principal') return { effect: 'allow' };
  const kind = kindGivenAway(values, readingsOf(sendText(send)));
  return kind ? { effect: 'refuse', reason: refusalReason(kind) } : { effect: 'allow' };
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

async function requestRemovalCard(ctx: CallerContext, value: PrivateValue, approverUserId: string | undefined) {
  await requestPrincipalConfirmation(ctx, approverUserId, {
    action: REMOVAL_APPROVAL,
    payload: removalPayload(value.id),
    title: 'Stop protecting a private detail?',
    asks: `to stop protecting your private ${KIND_NOUNS[value.kind]} "${value.label}". Once it is removed, the assistant may share it with people other than you.`,
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
        const decision = await guard(removePrivateValueAction, { actor: guardActor(ctx), payload: { id } });
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
