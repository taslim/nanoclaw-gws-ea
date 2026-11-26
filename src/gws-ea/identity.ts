import { instanceOnecliAdmin, validateRuntimeConfig, type InstanceRuntimeConfig } from './service.js';
import { runInstanceNclJson } from './ncl.js';
import { findCredentialSecret } from './onecli.js';
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
import { normalizePersonName, type PersonName, type NameOwner } from './person-name.js';
import { publishedGoogleSecretIds } from '../modules/gws-ea-google/gateway-grants.js';
import type { ProviderCredentialMetadata } from '../provider-credential.js';
import { getProviderHostContract } from '../provider-contracts/index.js';
import { ianaTimezone } from '../timezone.js';

export const MAIN_TEMPLATE = 'gws-ea/main';
export const MAIN_GROUP_NAME = 'main';
export const MAIN_PLUGIN_NAME = 'gws-ea-main';

export interface PrincipalSeed {
  readonly name: PersonName;
  /** Main's container runs in it; the host derives that from the profile. */
  readonly timezone: string;
  /** One or more addresses; the profile then holds exactly these. */
  readonly emails: readonly string[];
}

export interface MainIdentityInput {
  readonly assistantName: PersonName;
  readonly assistantWorkspaceEmail: string;
  /**
   * The principal, until main is published. Absent after: the profile is the
   * one source of their name, timezone and addresses, which the principal
   * changes through main and the operator through `gws-ea ncl`, and nothing
   * here writes them again.
   */
  readonly principal?: PrincipalSeed;
}

export interface MainIdentityResult {
  readonly agentGroupId: string;
  readonly onecliAgentId: string;
}

export interface MainIdentityDependencies {
  readonly runNcl?: (config: InstanceRuntimeConfig, args: readonly string[]) => Promise<unknown>;
  readonly onecliAdmin?: (config: InstanceRuntimeConfig) => Promise<OnecliAdmin>;
  readonly providerCredential?: ProviderCredentialMetadata;
}

function safeString(value: unknown, label: string, maxLength = 256): string {
  return requireString(value, label, 'invalid_identity', maxLength);
}

/**
 * The main group `ncl groups create --template` answered with: the group it
 * stamped, or, when a group already carries the plugin, the group its restamp
 * plan names. Without `--yes` that plan is only a plan, and nothing is
 * restamped.
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

function identityName(input: PersonName, owner: NameOwner): PersonName {
  try {
    return normalizePersonName(input, owner);
  } catch (error) {
    if (error instanceof Error) throw new GwsEaError('invalid_identity', error.message);
    throw error;
  }
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
    assistantName: identityName(input.assistantName, 'assistant'),
    assistantWorkspaceEmail,
    ...(input.principal === undefined
      ? {}
      : { principal: validatePrincipalSeed(input.principal, assistantWorkspaceEmail) }),
  };
}

/**
 * The timezone is canonicalized (`ianaTimezone`) because main's container runs
 * in it: an offset or a miscased name would put main's clock on the wrong
 * offset or on UTC.
 */
function validatePrincipalSeed(seed: PrincipalSeed, assistantWorkspaceEmail: string): PrincipalSeed {
  const timezone = ianaTimezone(safeString(seed.timezone, 'Principal timezone', 120));
  if (timezone === undefined) throw new GwsEaError('invalid_identity', 'Principal timezone is invalid');
  return {
    name: identityName(seed.name, 'principal'),
    timezone,
    emails: validatePrincipalEmails(seed.emails, assistantWorkspaceEmail),
  };
}

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
  const conflict = principalAddressesConflict(emails, [assistantWorkspaceEmail]);
  if (conflict !== undefined) throw new GwsEaError('invalid_identity', conflict);
  return emails;
}

function sameAddresses(held: unknown, declared: readonly string[]): boolean {
  if (!Array.isArray(held)) return false;
  const holding = new Set<unknown>(held);
  return holding.size === held.length && held.length === declared.length && declared.every((e) => holding.has(e));
}

/**
 * Resolve the one unambiguous model secret ID in OneCLI for `provider`. Uses
 * exact credential metadata when supplied, otherwise falls back to the
 * provider's declared model endpoint hostnames.
 */
export function resolveModelSecretId(
  secrets: readonly Record<string, unknown>[],
  provider: string,
  providerCredential?: ProviderCredentialMetadata,
): string | undefined {
  if (providerCredential !== undefined) {
    const found = findCredentialSecret(secrets, providerCredential, {
      ambiguous: `More than one OneCLI secret matches ${providerCredential.name}`,
      conflict: `An existing OneCLI secret named ${providerCredential.name} has incompatible metadata`,
    });
    return typeof found?.id === 'string' && found.id.length > 0 ? found.id : undefined;
  }
  const endpoints = getProviderHostContract(provider)?.modelEndpoints;
  const hosts = new Set(
    [endpoints?.api, endpoints?.subscription]
      .filter((value): value is string => value !== undefined)
      .map((value) => new URL(value).hostname),
  );
  if (hosts.size === 0) return undefined;
  const candidates = secrets.filter(
    (secret) =>
      typeof secret.id === 'string' &&
      secret.id.length > 0 &&
      typeof secret.hostPattern === 'string' &&
      hosts.has(secret.hostPattern),
  );
  if (candidates.length > 1) {
    throw new GwsEaError('ambiguous_onecli_secret', `More than one OneCLI secret matches provider ${provider}`);
  }
  return candidates.length === 1 ? (candidates[0]!.id as string) : undefined;
}

/**
 * Reconcile canonical main's OneCLI identity under OneCLI 1.44+ explicit
 * grants: ensure the agent exists, attach its model credential and any
 * already-published Google credentials, and preserve every other grant
 * (such as operator-attached MCP server credentials).
 */
async function reconcileMainGatewayGrants(
  admin: OnecliAdmin,
  agentGroupId: string,
  provider: string,
  providerCredential?: ProviderCredentialMetadata,
): Promise<string> {
  let agent = exactAgent(await admin.listAgents(), agentGroupId);
  if (!agent) {
    await admin.createAgent({ name: MAIN_GROUP_NAME, identifier: agentGroupId });
    agent = exactAgent(await admin.listAgents(), agentGroupId);
    if (!agent) throw new GwsEaError('onecli_agent_missing', 'OneCLI did not create canonical main');
  }
  if (agent.secretMode === 'all') {
    throw new GwsEaError(
      'onecli_secret_mode_mismatch',
      'Canonical main is still in legacy all-secrets mode; upgrade or reconvert OneCLI',
    );
  }

  const secrets = await admin.listSecrets();
  const modelId = resolveModelSecretId(secrets, provider, providerCredential);
  if (modelId === undefined) {
    throw new GwsEaError(
      'onecli_model_credential_missing',
      `OneCLI holds no model credential for provider ${provider}`,
    );
  }
  const required = [...new Set([modelId, ...publishedGoogleSecretIds(secrets).values()])];
  const granted = new Set(await admin.listAgentSecretGrants(agent.id));
  for (const secretId of required) {
    if (!granted.has(secretId)) await admin.attachAgentSecretGrant(agent.id, secretId);
  }

  const verified = exactAgent(await admin.listAgents(), agentGroupId);
  if (!verified || verified.id !== agent.id || verified.secretMode === 'all') {
    throw new GwsEaError('onecli_secret_mode_mismatch', 'Canonical main does not have verified OneCLI grants');
  }
  const verifiedGrants = new Set(await admin.listAgentSecretGrants(verified.id));
  if (required.some((secretId) => !verifiedGrants.has(secretId))) {
    throw new GwsEaError('onecli_grants_mismatch', 'Canonical main did not retain its required OneCLI secret grants');
  }
  return verified.id;
}

/**
 * The profile pointer is published last, so principal binding cannot observe a
 * canonical main until its provider, its shared skills, and instance-vault-wide
 * OneCLI access have been verified. Main's container runs in the principal's
 * timezone, which the host derives from the profile in the same transaction
 * that publishes or reconciles it, so nothing here sets it. The principal
 * seeds the profile only with main's first publication: after it, a reconcile
 * writes none of the principal's profile. Main is stamped from its template
 * only when no group carries it yet: an existing main is found, never
 * restamped, so a customized template survives every repair.
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

  // Main's shared skills and capabilities are the release's own selection, and
  // this reconcile on create and update is the only place they are set: the
  // host never rewrites them at start. Only an explicit skill list is checked.
  const skills = unwrapData(await runNcl(config, ['gws-ea-main', 'reconcile', '--agent-group-id', group.id]));
  if (
    !isRecord(skills) ||
    skills.agent_group_id !== group.id ||
    !Array.isArray(skills.skills) ||
    !skills.skills.every((skill) => typeof skill === 'string')
  ) {
    throw new GwsEaError('main_group_mismatch', "Canonical main's skills did not reconcile to the release's list");
  }

  const onecliAgentId = await reconcileMainGatewayGrants(
    await onecliAdmin(config),
    group.id,
    config.selected_provider,
    dependencies.providerCredential,
  );
  const { principal } = input;
  const profile = unwrapData(
    await runNcl(config, [
      'gws-ea-profile',
      'reconcile',
      '--assistant-first-name',
      input.assistantName.firstName,
      ...(input.assistantName.lastName === null ? [] : ['--assistant-last-name', input.assistantName.lastName]),
      '--assistant-workspace-email',
      input.assistantWorkspaceEmail,
      '--main-agent-group-id',
      group.id,
      ...(principal === undefined
        ? []
        : [
            '--principal-first-name',
            principal.name.firstName,
            ...(principal.name.lastName === null ? [] : ['--principal-last-name', principal.name.lastName]),
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
