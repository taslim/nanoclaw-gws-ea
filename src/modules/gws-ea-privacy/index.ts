import { noVerifiedPrincipalMessage } from '../gws-ea-profile/approval-wording.js';
/**
 * The principal's private values and the audience check that keeps them from
 * everyone else.
 *
 * Private values are the ones the principal names, held in a main-only
 * store. A handoff that cites the principal's request in a chat clears every
 * value it contains for that chat while the chat stays active. One check
 * covers everything sent to anyone but the principal:
 *
 *   - an outbound guard at the delivery adapter, which every channel send
 *     passes. A refused send never reaches the channel, and its sender is
 *     told to write it again without the value. Email to the inbox's outside
 *     threads is the exception: the guard sees only the agent's words, while
 *     the inbox builds the email that goes, so the inbox runs `checkOutbound`
 *     itself, on the final email and its final recipients (gws-ea-inbox's
 *     `sendToOutside`);
 *   - `checkOutbound`, the same check, for that email and for any text bound
 *     for others that does not travel as a channel send, such as a host write
 *     or a handoff to another agent.
 *
 * Each send is judged on its own: external-email never holds a private value
 * (main's handoffs are checked before they cross), so there is nothing for it
 * to split across sends. Both read what the assistant wrote three ways, as
 * its readers receive it: as written, as a mail client renders it, and the
 * targets of its links (`readingsOf`).
 *
 * Websites are the browser module's to guard: it reads what each site would
 * receive through `loadPersonalData`, which names the values it finds by
 * reference, and refuses each on a site its errand has no disclosure for. No
 * disclosure opens a site to one of the principal's addresses.
 *
 * A refusal names only the value's fixed kind, never the value or its label.
 * Removing a value switches its check off, so an agent's removal waits for
 * the principal's card.
 */
import { registerResource, type ColumnDef } from '../../cli/crud.js';
import type { CallerContext } from '../../cli/frame.js';
import { getDb } from '../../db/connection.js';
import type { DbDriver } from '../../db/driver.js';
import { registerMigration } from '../../db/migrations/index.js';
import { registerOutboundGuard } from '../../delivery.js';
import { ALLOW, DENY, defineGuardedAction, guard, HOLD } from '../../guard/index.js';
import { identityMatchKey } from '../../gws-ea/validation.js';
import { registerApprovalHandler } from '../approvals/index.js';
import { NAME_LIMIT, quoted } from '../approvals/request-text.js';
import {
  assertMainCaller,
  getMainAgentGroupId,
  isVerifiedPrincipalUser,
  listPrincipalAddresses,
  principalApproverUserId,
} from '../gws-ea-profile/db.js';
import { guardActor, requestPrincipalConfirmation } from '../gws-ea-profile/principal-confirmation.js';
import { addPrivateValue, getPrivateValue, listPrivateValues, removePrivateValue, type PrivateValue } from './db.js';
import { compilePrivateValue, fieldStreamOf, givesAway, PRIVATE_VALUE_KINDS } from './match.js';
import { judgeSend, KIND_NOUNS, type PrivateValueReference } from './outbound.js';
import { gwsEaChatClearancesMigration, gwsEaPrivacyDropThreadsMigration, gwsEaPrivacyMigration } from './migration.js';

registerMigration(gwsEaPrivacyMigration);
registerMigration(gwsEaPrivacyDropThreadsMigration);
registerMigration(gwsEaChatClearancesMigration);

export {
  audienceForAddresses,
  registerRecipientResolver,
  resolveAudience,
  type Audience,
  type RecipientResolver,
} from './audience.js';
export { listPrivateValues, type PrivateValue } from './db.js';
export { PRIVATE_VALUE_KINDS, type PrivateValueKind } from './match.js';
export { recordChatClearances, deleteChatClearances } from './clearance.js';
export {
  checkOutbound,
  linkTargets,
  messageStrings,
  privateValuesGivenAway,
  privateValuesGivenAwayInHtml,
  privateKindNoun,
  type OutboundCheck,
  type PrivateValueReference,
} from './outbound.js';

export const PRIVACY_GUARD_ID = 'gws-ea-privacy:audience';

registerOutboundGuard(PRIVACY_GUARD_ID, judgeSend);

// ---------------------------------------------------------------------------
// What the host browser gives a website
// ---------------------------------------------------------------------------

export interface PersonalDataReading {
  readonly values: readonly PrivateValueReference[];
  readonly principalAddress: boolean;
}

export interface PersonalData {
  /** No stored value and no principal address: nothing a website could be given. */
  readonly empty: boolean;
  /** `fields` is everything one website receives, read in order as one form's fields. */
  read(fields: readonly string[]): PersonalDataReading;
}

const WRITTEN_ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gu;

/** One mailbox in every spelling that reaches it (`identityMatchKey`): any case, any `+tag`, and Gmail's dots. */
function mailbox(address: string): string {
  return identityMatchKey(`email:${address.trim()}`);
}

/**
 * For reading what the host browser would give a website: each stored value, which only its errand's disclosure
 * gives one site, and each of the principal's addresses, which only the host's own sign-in to their own account
 * gives a site. A value is found however it is written and split across the fields, a phone number across an
 * area-code field and a number field included, and an address in any spelling that reaches the principal's
 * mailbox. A reading names values by reference, so no value leaves this module.
 */
export async function loadPersonalData(db: DbDriver = getDb()): Promise<PersonalData> {
  const stored = (await db.hasTable('gws_ea_private_values')) ? await listPrivateValues(db) : [];
  const addresses = (await db.hasTable('gws_ea_principal_addresses'))
    ? (await listPrincipalAddresses(db)).map(({ email }) => email)
    : [];
  const values = stored.map(({ id, kind, value }) => ({
    reference: { id, kind },
    compiled: compilePrivateValue(kind, value),
  }));
  const principal = addresses.map((address) => compilePrivateValue('email', address));
  const mailboxes = new Set(addresses.map(mailbox));
  return {
    empty: values.length === 0 && addresses.length === 0,
    read(fields) {
      const stream = fieldStreamOf(fields);
      return {
        values: values.filter(({ compiled }) => givesAway(compiled, stream)).map(({ reference }) => reference),
        principalAddress:
          principal.some((address) => givesAway(address, stream)) ||
          fields.some((field) =>
            (field.match(WRITTEN_ADDRESS) ?? []).some((address) => mailboxes.has(mailbox(address))),
          ),
      };
    },
  };
}

/**
 * A stored value as a disclosure names it, never the value itself. `principalAddress` marks one that reaches the
 * principal's mailbox, which no disclosure may open a site to.
 */
export async function privateValueReference(
  id: string,
): Promise<(PrivateValueReference & { readonly label: string; readonly principalAddress: boolean }) | undefined> {
  const value = await getPrivateValue(id);
  if (!value) return undefined;
  const { principalAddress } = (await loadPersonalData()).read([value.value]);
  return { id: value.id, kind: value.kind, label: value.label, principalAddress };
}

// ---------------------------------------------------------------------------
// Removal: held for the principal's card, because it switches a check off.
// ---------------------------------------------------------------------------

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
    if (approver === undefined) return DENY(noVerifiedPrincipalMessage());
    return HOLD('removing a private value switches its check off, so the principal confirms it', approver);
  },
});

async function requestRemovalCard(ctx: CallerContext, value: PrivateValue, approverUserId: string | undefined) {
  await requestPrincipalConfirmation(ctx, approverUserId, {
    action: REMOVAL_APPROVAL,
    payload: removalPayload(value.id),
    title: 'Stop protecting a private detail?',
    asks: `to stop protecting your private ${KIND_NOUNS[value.kind]} ${quoted(value.label, NAME_LIMIT)}. Once it is removed, I may share it with people other than you.`,
    details: { facts: { kind: value.kind, label: value.label } },
  });
  return {
    id: value.id,
    status: 'awaiting-principal',
    message: 'The principal was asked to confirm. You will be told the result; until then the value stays protected.',
  } as const;
}

registerApprovalHandler(
  REMOVAL_APPROVAL,
  async ({ session, payload, approval, userId, notify }) => {
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
  },
  {
    rejectionNote: async (approval, reason) => {
      const { id } = JSON.parse(approval.payload) as { id?: unknown };
      const value = typeof id === 'string' ? await getPrivateValue(id) : undefined;
      const detail = value ? `their private ${KIND_NOUNS[value.kind]} "${value.label}"` : 'that private detail';
      return `The principal declined to stop protecting ${detail}${reason ? `: "${reason}"` : ''}. It stays protected.`;
    },
  },
);

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

/** to: main */
registerResource({
  name: 'private value',
  plural: 'private-values',
  // Custom verbs only: the generic CRUD handlers that read `table` and `idColumn` are not enabled.
  table: 'gws_ea_private_values',
  idColumn: 'id',
  description:
    "The principal's private values: details such as a home address or a personal phone number that nothing sent to anyone but the principal may contain, except to a site the principal's own request names, recorded for one browser errand with record_disclosure. Only main may use them.",
  columns: [
    {
      name: 'id',
      type: 'string',
      description: "The value's id, from `list`: what remove and record_disclosure take.",
      generated: true,
    },
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
        "Protect a value the principal calls private: from then on nothing sent to anyone but the principal may contain it, however it is written, except to a site the principal's own request names, recorded for one browser errand with record_disclosure.\n\n" +
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
        'Stop protecting a private value. Removing one switches its check off, so the principal confirms it first; you are told the result, and the value stays protected until then.',
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
