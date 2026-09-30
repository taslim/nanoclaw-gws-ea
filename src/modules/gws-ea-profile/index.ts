import { getDb } from '../../db/connection.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { registerMigration } from '../../db/migrations/index.js';
import { registerRequiredProjectDocSection } from '../../project-doc-sections.js';
import { registerResource } from '../../cli/crud.js';
import type { CallerContext } from '../../cli/frame.js';
import { register } from '../../cli/registry.js';
import type { AgentGroup } from '../../types.js';
import { rememberAuthenticatedUserDm } from '../permissions/user-dm.js';
import {
  addPrincipalAddress,
  bindVerifiedPrincipalUser,
  getGwsEaProfile,
  listPrincipalAddresses,
  reconcileGwsEaProfile,
  removePrincipalAddress,
  validateGwsEaProfileInput,
} from './db.js';
import { gwsEaPrincipalAddressesMigration, gwsEaProfileMigration } from './migration.js';
import './wiring-policy.js';

registerMigration(gwsEaProfileMigration);
registerMigration(gwsEaPrincipalAddressesMigration);

function escapeMarkdownInline(value: string): string {
  const special = new Set(['\\', '`', '*', '_', '{', '}', '[', ']', '<', '>', '#']);
  return [...value].map((character) => (special.has(character) ? `\\${character}` : character)).join('');
}

const ADDRESS_LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

/** Addresses hold no backtick (the profile refuses one), so each is quoted exactly in a code span. */
function principalAddressesSentence(principal: string, emails: readonly string[]): string {
  if (emails.length === 0) return '';
  const quoted = ADDRESS_LIST.format(emails.map((email) => `\`${email}\``));
  return emails.length === 1
    ? ` ${principal}'s email address is ${quoted}.`
    : ` ${principal}'s email addresses are ${quoted}.`;
}

async function identitySection(_group: AgentGroup): Promise<{ name: string; body: string } | undefined> {
  if (!(await getDb().hasTable('gws_ea_profile'))) return undefined;
  const profile = await getGwsEaProfile();
  if (profile.assistant_display_name === null || profile.principal_display_name === null) return undefined;
  const assistant = escapeMarkdownInline(profile.assistant_display_name);
  const principal = escapeMarkdownInline(profile.principal_display_name);
  return {
    name: 'Assistant Identity',
    body: `${assistant} is the assistant. ${principal} is the principal. They are separate people: act and communicate as ${assistant}, support ${principal}, and never present the assistant as the principal.${principalAddressesSentence(principal, profile.principal_emails)}`,
  };
}

registerRequiredProjectDocSection('gws-ea-profile:identity', identitySection);

const reconcileKeys = new Set([
  'assistant-display-name',
  'assistant-workspace-email',
  'principal-display-name',
  'principal-timezone',
  'main-agent-group-id',
  'principal-emails',
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
    if (unknown.length > 0) throw new Error(`Unknown profile field: --${unknown[0]}`);
    const required = (key: string): string => {
      const value = raw[key];
      if (typeof value !== 'string' || value.length === 0) throw new Error(`--${key} is required`);
      return value;
    };
    const principalEmails = raw['principal-emails'];
    return validateGwsEaProfileInput({
      assistantDisplayName: required('assistant-display-name'),
      assistantWorkspaceEmail: required('assistant-workspace-email'),
      principalDisplayName: required('principal-display-name'),
      principalTimezone: required('principal-timezone'),
      mainAgentGroupId: required('main-agent-group-id'),
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
    if (unknown.length > 0) throw new Error(`Unknown profile field: --${unknown[0]}`);
    return undefined;
  },
  handler: async () => getGwsEaProfile(),
});

const bindPrincipalKeys = new Set(['user-id', 'verified-at', 'messaging-group-id']);

register({
  name: 'gws-ea-profile-bind-principal',
  description:
    'Bind one adapter-authenticated platform user to the principal, with the direct message that authenticated them.',
  access: 'hidden',
  hostOnly: true,
  parseArgs(raw) {
    const unknown = Object.keys(raw).filter((key) => !bindPrincipalKeys.has(key));
    if (unknown.length > 0) throw new Error(`Unknown profile field: --${unknown[0]}`);
    const required = (key: string): string => {
      const value = raw[key];
      if (typeof value !== 'string' || value.length === 0) throw new Error(`--${key} is required`);
      return value;
    };
    return {
      userId: required('user-id'),
      verifiedAt: required('verified-at'),
      messagingGroupId: required('messaging-group-id'),
    };
  },
  // The DM mapping is what canonical-main wiring admission proves the
  // principal's conversation with, so it is recorded with the binding.
  handler: async ({ userId, verifiedAt, messagingGroupId }) => {
    const dm = await getMessagingGroup(messagingGroupId);
    if (!dm) throw new Error(`Principal direct message not found: ${messagingGroupId}`);
    await getDb().transaction(async () => {
      await bindVerifiedPrincipalUser(userId, verifiedAt);
      await rememberAuthenticatedUserDm(userId, dm, verifiedAt);
    });
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
  const profile = await getDb().get<{ main_agent_group_id: string | null }>(
    'SELECT main_agent_group_id FROM gws_ea_profile WHERE singleton = 1',
  );
  if (!profile?.main_agent_group_id || profile.main_agent_group_id !== ctx.agentGroupId) {
    throw new Error("Only main changes the principal's addresses, on the principal's word.");
  }
}

function emailArgument(args: Record<string, unknown>): string {
  const email = args.email;
  if (typeof email !== 'string') throw new Error('--email is required');
  return email;
}

const EMAIL_ARGUMENT = {
  name: 'email',
  type: 'string',
  required: true,
  description: "One of the principal's email addresses; stored lowercased.",
} as const;

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
      description: "List the principal's email addresses.",
      args: [],
      handler: async () => listPrincipalAddresses(),
    },
    add: {
      access: 'open',
      description:
        "Add one of the principal's email addresses, when the principal says it is theirs. Adding one already held changes nothing.",
      args: [EMAIL_ARGUMENT],
      examples: ['ncl principal-addresses add --email name@example.com'],
      handler: async (args, ctx) => {
        await assertMayChangePrincipalAddresses(ctx);
        return addPrincipalAddress(emailArgument(args));
      },
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

export {
  bindVerifiedPrincipalUser,
  getGwsEaProfile,
  isVerifiedPrincipalUser,
  listPrincipalAddresses,
  listVerifiedPrincipalUsers,
  reconcileGwsEaProfile,
} from './db.js';
