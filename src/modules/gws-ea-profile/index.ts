import { getDb } from '../../db/connection.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { registerMigration } from '../../db/migrations/index.js';
import { registerRequiredProjectDocSection } from '../../project-doc-sections.js';
import { register } from '../../cli/registry.js';
import type { AgentGroup } from '../../types.js';
import { rememberAuthenticatedUserDm } from '../permissions/user-dm.js';
import { bindVerifiedPrincipalUser, getGwsEaProfile, reconcileGwsEaProfile, validateGwsEaProfileInput } from './db.js';
import { gwsEaProfileMigration } from './migration.js';
import './wiring-policy.js';

registerMigration(gwsEaProfileMigration);

function escapeMarkdownInline(value: string): string {
  const special = new Set(['\\', '`', '*', '_', '{', '}', '[', ']', '<', '>', '#']);
  return [...value].map((character) => (special.has(character) ? `\\${character}` : character)).join('');
}

async function identitySection(_group: AgentGroup): Promise<{ name: string; body: string } | undefined> {
  if (!(await getDb().hasTable('gws_ea_profile'))) return undefined;
  const profile = await getGwsEaProfile();
  if (profile.assistant_display_name === null || profile.principal_display_name === null) return undefined;
  const assistant = escapeMarkdownInline(profile.assistant_display_name);
  const principal = escapeMarkdownInline(profile.principal_display_name);
  return {
    name: 'Assistant Identity',
    body: `${assistant} is the assistant. ${principal} is the principal. They are separate people: act and communicate as ${assistant}, support ${principal}, and never present the assistant as the principal.`,
  };
}

registerRequiredProjectDocSection('gws-ea-profile:identity', identitySection);

const reconcileKeys = new Set([
  'assistant-display-name',
  'assistant-workspace-email',
  'principal-display-name',
  'principal-timezone',
  'main-agent-group-id',
]);

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
    return validateGwsEaProfileInput({
      assistantDisplayName: required('assistant-display-name'),
      assistantWorkspaceEmail: required('assistant-workspace-email'),
      principalDisplayName: required('principal-display-name'),
      principalTimezone: required('principal-timezone'),
      mainAgentGroupId: required('main-agent-group-id'),
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

export {
  bindVerifiedPrincipalUser,
  getGwsEaProfile,
  isVerifiedPrincipalUser,
  listVerifiedPrincipalUsers,
  reconcileGwsEaProfile,
} from './db.js';
