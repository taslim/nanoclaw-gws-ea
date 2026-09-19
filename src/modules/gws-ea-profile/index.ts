import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import { registerRequiredProjectDocSection } from '../../project-doc-sections.js';
import { register } from '../../cli/registry.js';
import type { AgentGroup } from '../../types.js';
import { getGwsEaProfile, reconcileGwsEaProfile, validateGwsEaProfileInput } from './db.js';
import { gwsEaProfileMigration } from './migration.js';

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

export {
  bindVerifiedPrincipalUser,
  getGwsEaProfile,
  isVerifiedPrincipalUser,
  listVerifiedPrincipalUsers,
  reconcileGwsEaProfile,
} from './db.js';
