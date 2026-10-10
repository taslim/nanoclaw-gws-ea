import { instanceOnecliAdmin, validateRuntimeConfig, type InstanceRuntimeConfig } from './service.js';
import { runInstanceNclJson } from './ncl.js';
import type { OnecliAdmin, OnecliAgent } from './onecli-admin.js';
import { GwsEaError } from './types.js';
import {
  EMAIL_PATTERN,
  isRecord,
  normalizePrincipalEmail,
  principalAddressesConflict,
  requireString,
  unwrapData,
} from './validation.js';
import { ianaTimezone } from '../timezone.js';

/** The template create stamps main from, the group it names, and the plugin it stamps into main's folder. */
export const MAIN_TEMPLATE = 'gws-ea/main';
export const MAIN_GROUP_NAME = 'main';
export const MAIN_PLUGIN_NAME = 'gws-ea-main';

/** The principal as create declared them, which seeds the profile when it first publishes main. */
export interface PrincipalSeed {
  readonly displayName: string;
  /** Their home timezone; main's container runs in it, as the host derives it from the profile (KTD7). */
  readonly timezone: string;
  /** One or more addresses; the profile then holds exactly these. */
  readonly emails: readonly string[];
}

export interface MainIdentityInput {
  readonly assistantDisplayName: string;
  readonly assistantWorkspaceEmail: string;
  /**
   * The principal, until main is published. Absent after: the profile is the
   * one source of their name, timezone and addresses, which the principal
   * changes through main and the operator through `gws-ea ncl`, and nothing
   * here writes them again (KTD9).
   */
  readonly principal?: PrincipalSeed;
}

export interface MainIdentityResult {
  readonly agentGroupId: string;
  readonly onecliAgentId: string;
}

export interface MainIdentityDependencies {
  readonly runNcl?: (config: InstanceRuntimeConfig, args: readonly string[]) => Promise<unknown>;
  /** The instance's OneCLI administration; its own, with its admin key, by default. */
  readonly onecliAdmin?: (config: InstanceRuntimeConfig) => Promise<OnecliAdmin>;
}

function safeString(value: unknown, label: string, maxLength = 256): string {
  return requireString(value, label, 'invalid_identity', maxLength);
}

/**
 * The main group `ncl groups create --template` answered with: the group it
 * stamped, or, when a group already carries the plugin, the group its restamp
 * plan names. Without `--yes` that plan is only a plan, and nothing is
 * restamped (KTD12).
 */
function parseGroupResult(value: unknown): { id: string; name: string } {
  const data = unwrapData(value);
  if (!isRecord(data)) throw new GwsEaError('invalid_child_output', 'ncl returned an invalid main group');
  const nested = data.group;
  const candidate = isRecord(nested) ? nested : data;
  if (nested !== undefined && (data.plugin !== MAIN_PLUGIN_NAME || data.applied !== false)) {
    throw new GwsEaError('invalid_child_output', 'ncl returned an invalid plan for the existing main group');
  }
  const id = safeString(candidate.id, 'Main agent group ID');
  const name = safeString(candidate.name, 'Main agent group name', 120);
  if (!id.startsWith('ag-') || name !== MAIN_GROUP_NAME) {
    throw new GwsEaError(
      'main_group_mismatch',
      'The stamped main group does not match the canonical template identity',
    );
  }
  return { id, name };
}

function exactAgent(agents: readonly OnecliAgent[], agentGroupId: string): OnecliAgent | undefined {
  const matches = agents.filter((agent) => agent.identifier === agentGroupId);
  if (matches.length > 1) throw new GwsEaError('onecli_agent_collision', 'Multiple OneCLI agents claim canonical main');
  const match = matches[0];
  if (match && match.name !== MAIN_GROUP_NAME) {
    throw new GwsEaError('onecli_agent_collision', 'Canonical main has a OneCLI agent identity collision');
  }
  if (agents.some((agent) => agent.name === MAIN_GROUP_NAME && agent.identifier !== agentGroupId)) {
    throw new GwsEaError('onecli_agent_collision', 'The OneCLI main name has an agent identity collision');
  }
  return match;
}

function validateInput(input: MainIdentityInput): MainIdentityInput {
  const assistantWorkspaceEmail = safeString(
    input.assistantWorkspaceEmail.trim().toLowerCase(),
    'Assistant Workspace email',
    254,
  );
  if (!EMAIL_PATTERN.test(assistantWorkspaceEmail)) {
    throw new GwsEaError('invalid_identity', 'Assistant Workspace email is invalid');
  }
  return {
    assistantDisplayName: safeString(input.assistantDisplayName.trim(), 'Assistant display name', 120),
    assistantWorkspaceEmail,
    ...(input.principal === undefined
      ? {}
      : { principal: validatePrincipalSeed(input.principal, assistantWorkspaceEmail) }),
  };
}

/**
 * The principal as the profile is seeded with them. Their timezone is held as
 * main's container runs in it (`ianaTimezone`), the host deriving that from
 * the profile (KTD7): an offset or a miscased name would put main's clock on
 * the wrong offset or on UTC.
 */
function validatePrincipalSeed(seed: PrincipalSeed, assistantWorkspaceEmail: string): PrincipalSeed {
  const timezone = ianaTimezone(safeString(seed.timezone, 'Principal timezone', 120));
  if (timezone === undefined) throw new GwsEaError('invalid_identity', 'Principal timezone is invalid');
  return {
    displayName: safeString(seed.displayName.trim(), 'Principal display name', 120),
    timezone,
    emails: validatePrincipalEmails(seed.emails, assistantWorkspaceEmail),
  };
}

/**
 * One or more addresses, lowercased and each once, none the assistant's own
 * or another spelling of one before it (`principalAddressesConflict`).
 */
function validatePrincipalEmails(values: readonly string[], assistantWorkspaceEmail: string): readonly string[] {
  const emails = [
    ...new Set(
      values.map((value) => {
        const email = normalizePrincipalEmail(value);
        if (email === undefined) throw new GwsEaError('invalid_identity', 'Principal email address is invalid');
        return email;
      }),
    ),
  ];
  if (emails.length === 0) throw new GwsEaError('invalid_identity', 'The principal needs at least one email address');
  const conflict = principalAddressesConflict(emails, assistantWorkspaceEmail);
  if (conflict !== undefined) throw new GwsEaError('invalid_identity', conflict);
  return emails;
}

/** Whether the profile holds exactly the declared addresses, in any order. */
function sameAddresses(held: unknown, declared: readonly string[]): boolean {
  if (!Array.isArray(held)) return false;
  const holding = new Set<unknown>(held);
  return holding.size === held.length && held.length === declared.length && declared.every((e) => holding.has(e));
}

/**
 * Main's OneCLI agent, created when missing, in all secret mode. A create
 * that finds the agent already there (a 409) reads it from the list.
 */
async function reconcileAllSecretMode(admin: OnecliAdmin, agentGroupId: string): Promise<string> {
  let agent = exactAgent(await admin.listAgents(), agentGroupId);
  if (!agent) {
    await admin.createAgent({ name: MAIN_GROUP_NAME, identifier: agentGroupId });
    agent = exactAgent(await admin.listAgents(), agentGroupId);
    if (!agent) throw new GwsEaError('onecli_agent_missing', 'OneCLI did not create canonical main');
  }

  if (agent.secretMode !== 'all') await admin.setSecretMode(agent.id, 'all');

  const verified = exactAgent(await admin.listAgents(), agentGroupId);
  if (!verified || verified.id !== agent.id || verified.secretMode !== 'all') {
    throw new GwsEaError('onecli_secret_mode_mismatch', 'Canonical main does not have verified all secret mode');
  }
  return verified.id;
}

/**
 * Reconcile the canonical main group and its credential boundary. The profile
 * pointer is published last, so principal binding cannot observe a canonical
 * main until its provider, its shared skills, and instance-vault-wide OneCLI
 * access have been verified. Main's container runs in the principal's
 * timezone, which the host derives from the profile in the same transaction
 * that publishes or reconciles it (KTD7), so nothing here sets it. The
 * principal seeds the profile only with main's first publication: after it,
 * a reconcile writes none of the principal's profile (KTD9).
 * Main is stamped from its template only when no group carries it yet: an
 * existing main is found, never restamped, so a customized template survives
 * every repair (R11, KTD12).
 */
export async function reconcileMainIdentity(
  configInput: InstanceRuntimeConfig,
  inputValue: MainIdentityInput,
  dependencies: MainIdentityDependencies = {},
): Promise<MainIdentityResult> {
  const config = validateRuntimeConfig(configInput);
  const input = validateInput(inputValue);
  const runNcl = dependencies.runNcl ?? runInstanceNclJson;
  const onecliAdmin = dependencies.onecliAdmin ?? instanceOnecliAdmin;

  const group = parseGroupResult(
    await runNcl(config, ['groups', 'create', '--template', MAIN_TEMPLATE, '--name', MAIN_GROUP_NAME]),
  );
  const updatedConfig = unwrapData(
    await runNcl(config, ['groups', 'config', 'update', '--id', group.id, '--provider', config.selected_provider]),
  );
  if (
    !isRecord(updatedConfig) ||
    updatedConfig.agent_group_id !== group.id ||
    updatedConfig.provider !== config.selected_provider
  ) {
    throw new GwsEaError('main_group_mismatch', 'Canonical main provider reconciliation did not persist');
  }

  // Main's shared skills are the release's own list (KTD13), and this
  // reconcile on create and update is the only place it is set: the host
  // never rewrites it at start. Only an explicit list is checked here.
  const skills = unwrapData(await runNcl(config, ['gws-ea-main', 'reconcile', '--agent-group-id', group.id]));
  if (
    !isRecord(skills) ||
    skills.agent_group_id !== group.id ||
    !Array.isArray(skills.skills) ||
    !skills.skills.every((skill) => typeof skill === 'string')
  ) {
    throw new GwsEaError('main_group_mismatch', "Canonical main's skills did not reconcile to the release's list");
  }

  const onecliAgentId = await reconcileAllSecretMode(await onecliAdmin(config), group.id);
  const { principal } = input;
  const profile = unwrapData(
    await runNcl(config, [
      'gws-ea-profile',
      'reconcile',
      '--assistant-display-name',
      input.assistantDisplayName,
      '--assistant-workspace-email',
      input.assistantWorkspaceEmail,
      '--main-agent-group-id',
      group.id,
      ...(principal === undefined
        ? []
        : [
            '--principal-display-name',
            principal.displayName,
            '--principal-timezone',
            principal.timezone,
            '--principal-emails',
            JSON.stringify(principal.emails),
          ]),
    ]),
  );
  if (!isRecord(profile) || profile.main_agent_group_id !== group.id) {
    throw new GwsEaError('profile_mismatch', 'GWS-EA profile did not retain canonical main');
  }
  if (principal !== undefined && !sameAddresses(profile.principal_emails, principal.emails)) {
    throw new GwsEaError('profile_mismatch', "GWS-EA profile did not retain the principal's email addresses");
  }

  return { agentGroupId: group.id, onecliAgentId };
}
