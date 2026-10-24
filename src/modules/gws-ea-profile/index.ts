import { noVerifiedPrincipalMessage } from './approval-wording.js';
import { registerSessionAdmissionPolicy } from '../../container-runner.js';
import { getDb } from '../../db/connection.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { registerMigration } from '../../db/migrations/index.js';
import { ALLOW, DENY, defineGuardedAction, guard, HOLD } from '../../guard/index.js';
import { onHostStart } from '../../host-lifecycle.js';
import { registerInboundPreparer } from '../../inbound-preparation.js';
import { registerRequiredProjectDocSection } from '../../project-doc-sections.js';
import { registerResource } from '../../cli/crud.js';
import type { CallerContext } from '../../cli/frame.js';
import { register } from '../../cli/registry.js';
import type { AgentGroup } from '../../types.js';
import { registerApprovalHandler } from '../approvals/index.js';
import { NAME_LIMIT, quoted } from '../approvals/request-text.js';
// The inbox's store alone: its module entry points load external-email, whose
// registrations must follow this module's.
import { getInboxState, principalCalendarAccess } from '../gws-ea-inbox/db.js';
import { sendPrincipalNotice } from '../gws-ea-notices/index.js';
import { bindPrincipalIdentity } from './bind.js';
import {
  addPrincipalAddress,
  assertMainCaller,
  ensureMainAgentGroupIdLoaded,
  getGwsEaProfile,
  getMainAgentGroupId,
  isVerifiedPrincipalUser,
  listPrincipalAddresses,
  loadMainAgentGroupId,
  principalApproverUserId,
  principalNameAndTimezone,
  projectDocAudience,
  proposedPrincipalAddress,
  reconcileGwsEaProfile,
  removePrincipalAddress,
  setPrincipalNameAndTimezone,
  validateGwsEaProfileInput,
  type PublishedNameAndTimezone,
} from './db.js';
import { registerGuidance } from './guidance.js';
import { escapeMarkdownInline } from './markdown.js';
import {
  gwsEaExternalEmailPointerMigration,
  gwsEaExternalChatPointerMigration,
  gwsEaBrowserPointerMigration,
  gwsEaPrincipalAddressesMigration,
  gwsEaProfileMigration,
  gwsEaWebAliasMigration,
  gwsEaPrincipalMessagesMigration,
  gwsEaPrincipalDmRoutingMigration,
} from './migration.js';
import { preparePrincipalMessageContent } from './marks.js';
import { guardActor, requestPrincipalConfirmation } from './principal-confirmation.js';
import './wiring-policy.js';

registerMigration(gwsEaProfileMigration);
registerMigration(gwsEaPrincipalAddressesMigration);
registerMigration(gwsEaExternalEmailPointerMigration);
registerMigration(gwsEaBrowserPointerMigration);
registerMigration(gwsEaWebAliasMigration);
registerMigration(gwsEaExternalChatPointerMigration);
registerMigration(gwsEaPrincipalMessagesMigration);
registerMigration(gwsEaPrincipalDmRoutingMigration);
registerInboundPreparer(preparePrincipalMessageContent);

// What a spawn reads synchronously: main's group, as the profile names it.
// Start callbacks run in module import order, so it is read before any later module's start.
onHostStart(() => loadMainAgentGroupId());
// The host releases the messages its channels held before it starts its
// modules, so a spawn can come first: it reads main's group itself before its
// environment is composed. An adopted container keeps the environment it has.
registerSessionAdmissionPolicy('gws-ea-profile:main-known', async ({ disposition }) => {
  if (disposition === 'create') await ensureMainAgentGroupIdLoaded();
});

const LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

/** Addresses hold no backtick (the profile refuses one), so each is quoted exactly in a code span. */
function principalAddressesSentence(principal: string, emails: readonly string[]): string {
  if (emails.length === 0) return '';
  const quoted = LIST.format(emails.map((email) => `\`${email}\``));
  return emails.length === 1
    ? ` ${principal}'s email address is ${quoted}.`
    : ` ${principal}'s email addresses are ${quoted}.`;
}

/** An address quoted exactly in a code span when it can be. */
function quotedAddress(email: string): string {
  return email.includes('`') ? escapeMarkdownInline(email) : `\`${email}\``;
}

/** The assistant's own address, where the principal shares calendars; quoted exactly when it can be. */
function assistantAddressSentence(assistant: string, email: string | null): string {
  if (email === null) return '';
  return ` ${assistant}'s own Google Workspace address is ${quotedAddress(email)}.`;
}

function browserPrincipalAddressesSentence(principal: string, emails: readonly string[]): string {
  if (emails.length === 0) return '';
  const quoted = LIST.format(emails.map((email) => `\`${email}\``));
  return emails.length === 1
    ? ` ${principal}'s email address is ${quoted}, so you recognize it on a page; never type it into a site.`
    : ` ${principal}'s email addresses are ${quoted}, so you recognize them on a page; never type one into a site.`;
}

/**
 * Main changes the principal's addresses mid-conversation, and the calendar
 * poll keeps each one's calendar access, so it reads both live: a copy
 * composed when its container started would go stale the moment either
 * changed (R9).
 * to: main
 */
export const MAIN_PRINCIPAL_ADDRESSES_POINTER =
  " Read `ncl principal-addresses list` before identifying the principal's calendars or using their access. Its addresses and `calendar_access` are the only current copy; either may have changed since your last read.";

async function identitySection(group: AgentGroup): Promise<{ name: string; body: string } | undefined> {
  if (!(await getDb().hasTable('gws_ea_profile'))) return undefined;
  const profile = await getGwsEaProfile();
  if (profile.assistant_display_name === null || profile.principal_display_name === null) return undefined;
  const assistant = escapeMarkdownInline(profile.assistant_display_name);
  const principal = escapeMarkdownInline(profile.principal_display_name);
  const names = `${assistant} is the assistant. ${principal} is the principal. They are separate people: act and communicate as ${assistant}, support ${principal}, and never present the assistant as the principal.`;
  const audience = await projectDocAudience(group.id);
  if (audience === 'external-email') {
    return {
      name: 'Assistant Identity',
      body: `${names}\n\nYour email signature:\n\n${assistant} | EA to ${principal}`,
    };
  }
  if (audience === 'external-chat') return { name: 'Assistant Identity', body: names };
  if (audience === 'browser') {
    const body = browserPrincipalAddressesSentence(principal, profile.principal_emails);
    return { name: 'Assistant Identity', body: `${names}${body}` };
  }
  if (audience === 'job') return { name: 'Assistant Identity', body: names };
  const own = assistantAddressSentence(assistant, profile.assistant_workspace_email);
  const addresses =
    audience === 'main'
      ? MAIN_PRINCIPAL_ADDRESSES_POINTER
      : principalAddressesSentence(principal, profile.principal_emails);
  const body = `${own}${addresses}`;
  return { name: 'Assistant Identity', body: `${names}${body}` };
}

registerGuidance('gws-ea-profile:character', {
  agent: 'the assistant',
  heading: 'Assistant Character',
  file: 'src/modules/gws-ea-profile/character.md',
  receives: async (agentGroupId) => {
    const audience = await projectDocAudience(agentGroupId);
    return audience === 'main' || audience === 'external-email' || audience === 'external-chat' || audience === 'job';
  },
});
registerRequiredProjectDocSection('gws-ea-profile:identity', identitySection);

/** A canonical key as the flag the control plane passes (src/cli/args.ts canonicalizes `-` to `_`). */
const flag = (key: string): string => `--${key.replace(/_/g, '-')}`;

const reconcileKeys = new Set([
  'assistant_first_name',
  'assistant_last_name',
  'assistant_workspace_email',
  'principal_first_name',
  'principal_last_name',
  'principal_timezone',
  'main_agent_group_id',
  'principal_emails',
]);

/** `--principal-emails`: a JSON array of addresses, as the control plane passes it. */
function parsePrincipalEmails(value: unknown): readonly string[] {
  const invalid = new Error('--principal-emails must be a JSON array of email addresses');
  if (typeof value !== 'string') throw invalid;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(invalid.message, { cause: error });
  }
  if (!Array.isArray(parsed) || !parsed.every((email): email is string => typeof email === 'string')) throw invalid;
  return parsed;
}

register({
  name: 'gws-ea-profile-reconcile',
  description: 'Reconcile the installation-owned GWS-EA identity profile.',
  access: 'hidden',
  hostOnly: true,
  parseArgs(raw) {
    const unknown = Object.keys(raw).filter((key) => !reconcileKeys.has(key));
    if (unknown.length > 0) throw new Error(`Unknown profile field: ${flag(unknown[0])}`);
    const required = (key: string): string => {
      const value = raw[key];
      if (typeof value !== 'string' || value.length === 0) throw new Error(`${flag(key)} is required`);
      return value;
    };
    // The principal's name and timezone seed the profile: create declares them, and nothing after it.
    const seed = (key: string): string | undefined => (raw[key] === undefined ? undefined : required(key));
    if (raw.principal_last_name !== undefined && raw.principal_first_name === undefined) {
      throw new Error('--principal-last-name requires --principal-first-name');
    }
    const principalEmails = raw.principal_emails;
    return validateGwsEaProfileInput({
      assistantName: { firstName: required('assistant_first_name'), lastName: seed('assistant_last_name') ?? null },
      assistantWorkspaceEmail: required('assistant_workspace_email'),
      ...(raw.principal_first_name === undefined
        ? {}
        : {
            principalName: {
              firstName: required('principal_first_name'),
              lastName: seed('principal_last_name') ?? null,
            },
          }),
      principalTimezone: seed('principal_timezone'),
      mainAgentGroupId: required('main_agent_group_id'),
      ...(principalEmails === undefined ? {} : { principalEmails: parsePrincipalEmails(principalEmails) }),
    });
  },
  handler: async (input) => reconcileGwsEaProfile(input),
});

register({
  name: 'gws-ea-profile-get',
  description: 'Read the installation-owned GWS-EA identity profile.',
  access: 'hidden',
  hostOnly: true,
  parseArgs(raw) {
    const unknown = Object.keys(raw);
    if (unknown.length > 0) throw new Error(`Unknown profile field: ${flag(unknown[0])}`);
    return undefined;
  },
  handler: async () => getGwsEaProfile(),
});

const bindPrincipalKeys = new Set(['user_id', 'verified_at', 'messaging_group_id']);

register({
  name: 'gws-ea-profile-bind-principal',
  description:
    'Bind one adapter-authenticated platform user to the principal, with the direct message that authenticated them.',
  access: 'hidden',
  hostOnly: true,
  parseArgs(raw) {
    const unknown = Object.keys(raw).filter((key) => !bindPrincipalKeys.has(key));
    if (unknown.length > 0) throw new Error(`Unknown profile field: ${flag(unknown[0])}`);
    const required = (key: string): string => {
      const value = raw[key];
      if (typeof value !== 'string' || value.length === 0) throw new Error(`${flag(key)} is required`);
      return value;
    };
    return {
      userId: required('user_id'),
      verifiedAt: required('verified_at'),
      messagingGroupId: required('messaging_group_id'),
    };
  },
  // The DM mapping is what canonical-main wiring admission proves the
  // principal's conversation with, so it is recorded with the binding.
  handler: async ({ userId, verifiedAt, messagingGroupId }) => {
    const dm = await getMessagingGroup(messagingGroupId);
    if (!dm) throw new Error(`Principal direct message not found: ${messagingGroupId}`);
    await bindPrincipalIdentity({ userId, verifiedAt, messagingGroupId });
    return { user_id: userId, verified_at: verifiedAt, messaging_group_id: dm.id };
  },
});

/**
 * Only canonical main changes the principal's addresses on the principal's
 * word: canonical-main wiring admission lets it serve nothing but the
 * principal's own conversation. The operator reaches the same commands as the
 * host caller, through `gws-ea ncl`.
 */
async function assertMayChangePrincipalAddresses(ctx: CallerContext): Promise<void> {
  if (ctx.caller === 'host') return;
  const mainAgentGroupId = await getMainAgentGroupId();
  if (!mainAgentGroupId || mainAgentGroupId !== ctx.agentGroupId) {
    throw new Error("Only main changes the principal's addresses, on the principal's word.");
  }
}

function emailArgument(args: Record<string, unknown>): string {
  const email = args.email;
  if (typeof email !== 'string') throw new Error('--email is required');
  return email;
}

// ---------------------------------------------------------------------------
// Adding an address: held for the principal's card once the inbox exists.
// ---------------------------------------------------------------------------

/**
 * Whether the assistant's inbox exists (`getInboxMessagingGroupId`). From
 * then on, mail from a principal address authenticates as the principal and
 * carries their authority, so a new address widens who speaks for them.
 */
async function inboxExists(): Promise<boolean> {
  if (!(await getDb().hasTable('gws_ea_inbox_state'))) return false;
  return (await getInboxState()).messaging_group_id !== null;
}

/** The `pending_approvals.action` an address card resolves through. */
const ADD_ADDRESS_APPROVAL = 'principal_address_add';

/** The card's payload, exactly as `requestApproval` stores it, so a grant binds to one address. */
function addAddressPayload(email: string): { readonly email: string } {
  return { email };
}

const addPrincipalAddressAction = defineGuardedAction({
  action: 'profile.add_principal_address',
  grantActionName: ADD_ADDRESS_APPROVAL,
  grantCoversRequest: (grant, input) =>
    typeof input.payload.email === 'string' && grant.payload === JSON.stringify(addAddressPayload(input.payload.email)),
  decide: async ({ actor }) => {
    if (actor.kind === 'host') return ALLOW('host caller (trusted socket)');
    const mainAgentGroupId = await getMainAgentGroupId();
    if (actor.kind !== 'agent' || mainAgentGroupId === null || actor.agentGroupId !== mainAgentGroupId) {
      return DENY("Only main changes the principal's addresses, on the principal's word.");
    }
    if (!(await inboxExists())) return ALLOW('no inbox yet: an address decides only whose calendars are theirs');
    const approver = await principalApproverUserId();
    if (approver === undefined) return DENY(noVerifiedPrincipalMessage());
    return HOLD("mail from the principal's addresses carries their authority, so the principal confirms it", approver);
  },
});

async function requestAddAddressCard(ctx: CallerContext, email: string, approverUserId: string | undefined) {
  await requestPrincipalConfirmation(ctx, approverUserId, {
    action: ADD_ADDRESS_APPROVAL,
    payload: addAddressPayload(email),
    title: 'Add one of your email addresses?',
    asks: `to record ${quoted(email, NAME_LIMIT)} as one of your email addresses. Mail I receive from your addresses is treated as yours, with your authority, and each of them can open the Google Drive folder where I keep what I make for you, so approve only if this address is yours.`,
    details: { facts: { email } },
  });
  return {
    email,
    status: 'awaiting-principal',
    message:
      'The principal was asked to confirm, because mail from their addresses carries their authority. You will be told the result; until then the address is not theirs.',
  } as const;
}

registerApprovalHandler(
  ADD_ADDRESS_APPROVAL,
  async ({ session, payload, approval, userId, notify }) => {
    const email = typeof payload.email === 'string' ? payload.email : '';
    // The card names its approver; this re-check holds even if the principal
    // identity changed after the card went out.
    if (!(await isVerifiedPrincipalUser(userId))) {
      await notify(`${email} was not added: only the principal can confirm one of their addresses.`);
      return;
    }
    const decision = await guard(addPrincipalAddressAction, {
      actor: { kind: 'agent', agentGroupId: session.agent_group_id, sessionId: session.id },
      payload: addAddressPayload(email),
      grant: approval,
    });
    if (decision.effect !== 'allow') {
      await notify(`${email} was not added: ${decision.reason}`);
      return;
    }
    const { added } = await addPrincipalAddress(email);
    await notify(
      added
        ? `The principal confirmed. ${email} is now one of their addresses.`
        : `The principal confirmed. ${email} was already one of their addresses.`,
    );
  },
  {
    rejectionNote: (approval, reason) => {
      const { email } = JSON.parse(approval.payload) as { email?: unknown };
      const address = typeof email === 'string' ? email : 'that address';
      return `The principal declined to add ${address} as one of their addresses${reason ? `: "${reason}"` : ''}. Mail from it carries no authority of theirs.`;
    },
  },
);

/**
 * Add an address: directly for the operator, and for main until the inbox
 * exists; after that, main's new address waits for the principal's card.
 * One the profile already holds changes nothing, so it needs no card.
 */
async function addAddress(args: Record<string, unknown>, ctx: CallerContext) {
  await assertMayChangePrincipalAddresses(ctx);
  const { email, held } = await proposedPrincipalAddress(emailArgument(args));
  if (held) return { email, added: false };
  const decision = await guard(addPrincipalAddressAction, {
    actor: guardActor(ctx),
    payload: addAddressPayload(email),
  });
  switch (decision.effect) {
    case 'allow':
      return addPrincipalAddress(email);
    case 'hold':
      return requestAddAddressCard(ctx, email, decision.approverUserId);
    case 'deny':
      throw new Error(decision.reason);
    default: {
      const unreachable: never = decision;
      throw new Error(`Unknown guard decision: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Each address with what the assistant can do with its main calendar, as
 * the inbox's calendar poll last read it from Google: the facts status shows
 * too. Adding or removing an address calls no one; the next poll acts on it.
 */
async function listAddresses() {
  const addresses = await listPrincipalAddresses();
  const access = await principalCalendarAccess(addresses.map((address) => address.email));
  return addresses.map((address, index) => ({
    ...address,
    calendar_access: access[index].access,
    calendar_checked_at: access[index].checkedAt,
  }));
}

const EMAIL_ARGUMENT = {
  name: 'email',
  type: 'string',
  required: true,
  description: "One of the principal's email addresses; stored lowercased.",
} as const;

/** to: main */
registerResource({
  name: 'principal address',
  plural: 'principal-addresses',
  table: 'gws_ea_principal_addresses',
  description: "The principal's email addresses. A calendar owned by one of them is the principal's.",
  idColumn: 'email',
  columns: [
    { name: 'email', type: 'string', description: 'The address, lowercased.' },
    { name: 'added_at', type: 'string', description: 'When it was added.', generated: true },
  ],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description:
        "List the principal's email addresses, each with what the assistant can do with its main calendar (`calendar_access`), as the host last checked with Google (`calendar_checked_at`): `bookable` (it can book on it), `readable` (it can read its events but not book), `free-busy` (it sees only when the principal is busy, which still counts when offering times), `none` (it is not shared with the assistant), or `unchecked` (not checked yet). The host adds each address's calendar to the assistant's calendar list itself, and checks again every 15 minutes while it is not shared.",
      args: [],
      handler: listAddresses,
    },
    add: {
      access: 'open',
      description:
        "Add one of the principal's email addresses, when the principal says it is theirs. Adding one already held changes nothing. Once the assistant has its own inbox, mail from these addresses carries the principal's authority, so a new one waits for the principal to confirm it in the conversation: the result says so, and you are told when they decide.",
      args: [EMAIL_ARGUMENT],
      examples: ['ncl principal-addresses add --email name@example.com'],
      handler: addAddress,
    },
    remove: {
      access: 'open',
      description:
        "Remove one of the principal's email addresses, when the principal says it is no longer theirs. The last one cannot be removed.",
      args: [EMAIL_ARGUMENT],
      examples: ['ncl principal-addresses remove --email name@example.com'],
      handler: async (args, ctx) => {
        await assertMayChangePrincipalAddresses(ctx);
        return removePrincipalAddress(emailArgument(args));
      },
    },
  },
});

// ---------------------------------------------------------------------------
// The principal's name and home timezone: main changes them on their word.
// ---------------------------------------------------------------------------

/** What the refusal to any caller but main says `principal-profile` holds. */
const NAME_AND_TIMEZONE = 'name and timezone';

/** One field a `set` changed, from and to what the profile held. */
interface ProfileChange {
  readonly field: 'first_name' | 'last_name' | 'timezone';
  readonly from: string | null;
  readonly to: string | null;
}

function profileChanges(before: PublishedNameAndTimezone, after: PublishedNameAndTimezone): ProfileChange[] {
  return (['first_name', 'last_name', 'timezone'] as const)
    .filter((field) => after[field] !== before[field])
    .map((field) => ({ field, from: before[field], to: after[field] }));
}

/**
 * The principal's receipt: every change, old and new, so a change they did
 * not ask for cannot pass unseen (KTD9).
 */
function receiptText(changes: readonly ProfileChange[]): string {
  const described = changes.map(({ field, from, to }) => {
    const label = field === 'first_name' ? 'first name' : field === 'last_name' ? 'last name' : 'home time zone';
    return `your ${label} is now ${to ?? 'not set'} (it was ${from ?? 'not set'})`;
  });
  return `I updated your profile: ${LIST.format(described)}. If you didn't ask for this, tell me and I'll change it back.`;
}

/**
 * What follows the change, and when: the host's readers now, each agent's own copy on its next start.
 * to: main
 */
const TAKES_EFFECT =
  "The times external-email offers use the new values now. Your own clock and the identity in your instructions follow at your next start; external-email's identity and email signature follow at its next start, with nothing for you to do.";

async function setPrincipalProfile(args: Record<string, unknown>, ctx: CallerContext) {
  await assertMainCaller(ctx, NAME_AND_TIMEZONE);
  const firstName = typeof args.first_name === 'string' ? args.first_name : undefined;
  const lastName = typeof args.last_name === 'string' ? args.last_name : undefined;
  const clearLastName = args.clear_last_name === true;
  const timezone = typeof args.timezone === 'string' ? args.timezone : undefined;
  if (lastName !== undefined && clearLastName) throw new Error('Use --last-name or --clear-last-name, never both');
  if (firstName === undefined && lastName === undefined && !clearLastName && timezone === undefined) {
    throw new Error('Give --first-name, --last-name, --clear-last-name, or --timezone');
  }
  const { before, after } = await setPrincipalNameAndTimezone({
    firstName,
    lastName: clearLastName ? null : lastName,
    timezone,
  });
  const changes = profileChanges(before, after);
  const answer = { ...after, changed: changes.map(({ field }) => field) };
  if (changes.length === 0) return { ...answer, message: 'Nothing changed: the profile already holds these.' };
  const delivered = await sendPrincipalNotice(receiptText(changes), 'principal-profile-changed');
  return {
    ...answer,
    message: delivered
      ? `Saved, and the principal was sent a receipt giving the old and new values. ${TAKES_EFFECT}`
      : `Saved, but the receipt could not reach the principal: tell them what changed. ${TAKES_EFFECT}`,
  };
}

const FIRST_NAME_ARGUMENT = {
  name: 'first_name',
  type: 'string',
  description:
    "The principal's first name, preserving compound given names. A person's name only; combined first and last name at most 80 characters.",
} as const;

const LAST_NAME_ARGUMENT = {
  name: 'last_name',
  type: 'string',
  description:
    "The principal's last name, preserving compound surnames. Omit to keep it; use --clear-last-name to remove it.",
} as const;

const CLEAR_LAST_NAME_ARGUMENT = {
  name: 'clear_last_name',
  type: 'boolean',
  description: "Remove the principal's last name.",
} as const;

const TIMEZONE_ARGUMENT = {
  name: 'timezone',
  type: 'string',
  description: 'Their home time zone, as an IANA id such as Europe/London.',
} as const;

/** to: main */
registerResource({
  name: 'principal profile',
  plural: 'principal-profile',
  // Custom verbs only: the generic CRUD handlers that read `table` and `idColumn` are not enabled.
  table: 'gws_ea_profile',
  idColumn: 'singleton',
  description: "The principal's name and home time zone, as the assistant uses them. Only main may use them.",
  columns: [FIRST_NAME_ARGUMENT, LAST_NAME_ARGUMENT, TIMEZONE_ARGUMENT],
  operations: {},
  customOperations: {
    get: {
      access: 'open',
      description: "Read the principal's name and home time zone.",
      args: [],
      handler: async (_args, ctx) => {
        await assertMainCaller(ctx, NAME_AND_TIMEZONE);
        return principalNameAndTimezone();
      },
    },
    set: {
      access: 'open',
      description:
        "Change the principal's name, home time zone, or both, when the principal tells you to. No confirmation is needed; the principal is sent a receipt giving the old and new values. The host uses the new values at once; your own clock and the identity text in your instructions follow on your next start.",
      args: [FIRST_NAME_ARGUMENT, LAST_NAME_ARGUMENT, CLEAR_LAST_NAME_ARGUMENT, TIMEZONE_ARGUMENT],
      examples: [
        'ncl principal-profile set --first-name Juno --last-name Hale',
        'ncl principal-profile set --timezone Europe/London',
      ],
      handler: setPrincipalProfile,
    },
  },
});

export {
  getGwsEaProfile,
  isVerifiedPrincipalUser,
  listPrincipalAddresses,
  listVerifiedPrincipalUsers,
  reconcileGwsEaProfile,
} from './db.js';
export {
  requirePrincipalMessage,
  requirePrincipalDirectMessage,
  PRINCIPAL_MESSAGE_LIFETIME_MS,
  type PrincipalMessage,
} from './marks.js';
