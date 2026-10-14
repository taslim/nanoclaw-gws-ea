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
import { hasBrowserAccess } from '../gws-ea-browser/access.js';
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

/**
 * The assistant on the web, for each group that delegates to the browser
 * (KTD14): its alias, or that none is set up yet, and that accounts in the
 * principal's name come only from their logins in 1Password (R25).
 */
function delegatorWebSentences(assistant: string, principal: string, alias: string | null): string {
  const address =
    alias === null
      ? ` ${assistant} has no web address yet: until the operator sets it up, a browser errand that needs ${assistant}'s email stops with \`alias_unavailable\`.`
      : ` ${assistant}'s web address is ${quotedAddress(alias)}: ${assistant}'s email on every website, for ${assistant}'s own accounts and for bookings and checkouts made for ${principal}.`;
  return `${address} ${assistant} never creates an account in ${principal}'s name: ${principal}'s own accounts come only from their logins in 1Password, so when an errand needs one that the vault has no login for, ask ${principal} to add it to 1Password.`;
}

/**
 * The principal's addresses for the browser (R34): to recognize on a page, never to give a site. Only the
 * host puts one on a site, when it signs the principal in to their own account from their login in 1Password.
 */
function browserPrincipalAddressesSentence(principal: string, emails: readonly string[]): string {
  if (emails.length === 0) return '';
  const quoted = LIST.format(emails.map((email) => `\`${email}\``));
  const signIn = `signing ${principal} in to their own account with their login in 1Password.`;
  return emails.length === 1
    ? ` ${principal}'s email address is ${quoted}, so you recognize it on a page; never type it into a site. Only the host puts it on a site, ${signIn}`
    : ` ${principal}'s email addresses are ${quoted}, so you recognize them on a page; never type one into a site. Only the host puts one on a site, ${signIn}`;
}

/** The browser's email on every website (KTD14): the alias, never the address the assistant converses from. */
function browserWebSentence(assistant: string, principal: string, alias: string | null): string {
  return alias === null
    ? ` ${assistant} has no email address for websites yet: a site form that needs one cannot be completed until the operator sets it up, so report that to main.`
    : ` ${assistant}'s email on every website is ${quotedAddress(alias)}: give it wherever a site asks for ${assistant}'s email, including on a booking or checkout made for ${principal} in ${principal}'s name, and open ${assistant}'s accounts with it, in ${assistant}'s own name.`;
}

/**
 * Main changes the principal's addresses mid-conversation, and the calendar
 * poll keeps each one's calendar access, so it reads both live: a copy
 * composed when its container started would go stale the moment either
 * changed (R9).
 * to: main
 */
export const MAIN_PRINCIPAL_ADDRESSES_POINTER =
  " The principal's email addresses decide which calendars are theirs. Read them with `ncl principal-addresses list`, whose `calendar_access` says what you can do with each address's calendar, before you decide whose a calendar is or what you can do with one: the list is the only current copy, and an address or its access may have changed since you last read it. Once the assistant has its own inbox, mail from these addresses carries the principal's authority, so a new one waits for the principal to confirm it in the conversation; the command says when it does, and you are told the result.";

/**
 * Who the assistant and the principal are, for each audience (KTD14). Main
 * reads the principal's addresses live. Outside email gets names and its
 * email signature, casual chats names only; a chat job additionally gets
 * the assistant's web address while explicitly allowed to delegate. The browser gives that alias to websites, never
 * the address it converses from, and knows the principal's addresses only
 * to recognize them (R34). Any other group gets the addresses as of
 * its container's start: the default `group` CLI scope leaves the live list
 * out of its reach. Main or another group gets the assistant's web address
 * only while the browser access setting lets it delegate errands, which is
 * all that address is for.
 */
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
    const body = `${browserWebSentence(assistant, principal, profile.assistant_alias)}${browserPrincipalAddressesSentence(principal, profile.principal_emails)}`;
    return { name: 'Assistant Identity', body: `${names}${body}` };
  }
  const web = (await hasBrowserAccess(group.id))
    ? delegatorWebSentences(assistant, principal, profile.assistant_alias)
    : '';
  if (audience === 'job') return { name: 'Assistant Identity', body: `${names}${web}` };
  const own = assistantAddressSentence(assistant, profile.assistant_workspace_email);
  const addresses =
    audience === 'main'
      ? MAIN_PRINCIPAL_ADDRESSES_POINTER
      : principalAddressesSentence(principal, profile.principal_emails);
  const body = `${own}${web}${addresses}`;
  return { name: 'Assistant Identity', body: `${names}${body}` };
}

registerRequiredProjectDocSection('gws-ea-profile:identity', identitySection);

/** A canonical key as the flag the control plane passes (src/cli/args.ts canonicalizes `-` to `_`). */
const flag = (key: string): string => `--${key.replace(/_/g, '-')}`;

const reconcileKeys = new Set([
  'assistant_display_name',
  'assistant_workspace_email',
  'principal_display_name',
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
    const principalEmails = raw.principal_emails;
    return validateGwsEaProfileInput({
      assistantDisplayName: required('assistant_display_name'),
      assistantWorkspaceEmail: required('assistant_workspace_email'),
      principalDisplayName: seed('principal_display_name'),
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
    if (approver === undefined) return DENY('No verified principal can confirm a new address yet.');
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
  readonly field: keyof PublishedNameAndTimezone;
  readonly from: string;
  readonly to: string;
}

function profileChanges(before: PublishedNameAndTimezone, after: PublishedNameAndTimezone): ProfileChange[] {
  return (['name', 'timezone'] as const)
    .filter((field) => after[field] !== before[field])
    .map((field) => ({ field, from: before[field], to: after[field] }));
}

/**
 * The principal's receipt: every change, old and new, so a change they did
 * not ask for cannot pass unseen (KTD9).
 */
function receiptText(changes: readonly ProfileChange[]): string {
  const described = changes.map(({ field, from, to }) =>
    field === 'name' ? `your name is now ${to} (it was ${from})` : `your home time zone is now ${to} (it was ${from})`,
  );
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
  const name = typeof args.name === 'string' ? args.name : undefined;
  const timezone = typeof args.timezone === 'string' ? args.timezone : undefined;
  if (name === undefined && timezone === undefined) throw new Error('Give --name, --timezone, or both');
  const { before, after } = await setPrincipalNameAndTimezone({ name, timezone });
  const changes = profileChanges(before, after);
  const answer = { name: after.name, timezone: after.timezone, changed: changes.map(({ field }) => field) };
  if (changes.length === 0) return { ...answer, message: 'Nothing changed: the profile already holds these.' };
  const delivered = await sendPrincipalNotice(receiptText(changes), 'principal-profile-changed');
  return {
    ...answer,
    message: delivered
      ? `Saved, and the principal was sent a receipt giving the old and new values. ${TAKES_EFFECT}`
      : `Saved, but the receipt could not reach the principal: tell them what changed. ${TAKES_EFFECT}`,
  };
}

const NAME_ARGUMENT = {
  name: 'name',
  type: 'string',
  description:
    "The principal's name as they want it used, such as in the signature on the assistant's email. A person's name only: no address, link, domain or markup, and at most 80 characters.",
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
  columns: [NAME_ARGUMENT, TIMEZONE_ARGUMENT],
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
      args: [NAME_ARGUMENT, TIMEZONE_ARGUMENT],
      examples: ['ncl principal-profile set --name "Juno Hale"', 'ncl principal-profile set --timezone Europe/London'],
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
