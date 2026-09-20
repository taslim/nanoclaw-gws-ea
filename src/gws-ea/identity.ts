import { runInstanceOnecliAdminCommand, validateRuntimeConfig, type InstanceRuntimeConfig } from './service.js';
import { runInstanceNclJson } from './ncl.js';
import { GwsEaError } from './types.js';
import { hasControlCharacters, isRecord } from './validation.js';
import { isValidTimezone } from '../timezone.js';

const MAIN_TEMPLATE = 'gws-ea/main';
const MAIN_GROUP_NAME = 'main';
const MAIN_PLUGIN_NAME = 'gws-ea-main';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export interface MainIdentityInput {
  readonly assistantDisplayName: string;
  readonly assistantWorkspaceEmail: string;
  readonly principalDisplayName: string;
  readonly principalTimezone: string;
}

export interface MainIdentityResult {
  readonly agentGroupId: string;
  readonly onecliAgentId: string;
}

export interface MainIdentityDependencies {
  readonly runNcl?: (config: InstanceRuntimeConfig, args: readonly string[]) => Promise<unknown>;
  readonly runOnecliAdmin?: (config: InstanceRuntimeConfig, args: readonly string[]) => Promise<unknown>;
}

interface OnecliAgent {
  readonly id: string;
  readonly identifier: string;
  readonly name: string;
  readonly secretMode: string;
}

function unwrapData(value: unknown): unknown {
  return isRecord(value) && 'data' in value ? value.data : value;
}

function parseJson(source: string, label: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new GwsEaError('invalid_child_output', `${label} returned invalid JSON`);
  }
}

function safeString(value: unknown, label: string, maxLength = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || hasControlCharacters(value)) {
    throw new GwsEaError('invalid_identity', `${label} is invalid`);
  }
  return value;
}

function parseGroupResult(value: unknown): { id: string; name: string } {
  const data = unwrapData(value);
  if (!isRecord(data)) throw new GwsEaError('invalid_child_output', 'ncl returned an invalid main group');
  const nested = data.group;
  const candidate = isRecord(nested) ? nested : data;
  if (nested !== undefined && (data.plugin !== MAIN_PLUGIN_NAME || data.applied !== true)) {
    throw new GwsEaError('invalid_child_output', 'ncl returned an invalid main template restamp');
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

function parseOnecliAgents(value: unknown): OnecliAgent[] {
  const data = unwrapData(value);
  if (!Array.isArray(data) || !data.every(isRecord)) {
    throw new GwsEaError('invalid_child_output', 'OneCLI returned an invalid agent list');
  }
  return data.map((agent) => ({
    id: safeString(agent.id, 'OneCLI agent ID'),
    identifier: safeString(agent.identifier, 'OneCLI agent identifier'),
    name: safeString(agent.name, 'OneCLI agent name', 120),
    secretMode: safeString(agent.secretMode, 'OneCLI agent secret mode', 32),
  }));
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

async function defaultRunOnecliAdmin(config: InstanceRuntimeConfig, args: readonly string[]): Promise<unknown> {
  const result = await runInstanceOnecliAdminCommand(config, args);
  return parseJson(result.stdout, 'OneCLI');
}

function validateInput(input: MainIdentityInput): MainIdentityInput {
  const assistantWorkspaceEmail = safeString(
    input.assistantWorkspaceEmail.trim().toLowerCase(),
    'Assistant Workspace email',
    254,
  );
  const principalTimezone = safeString(input.principalTimezone, 'Principal timezone', 120);
  if (!EMAIL_PATTERN.test(assistantWorkspaceEmail)) {
    throw new GwsEaError('invalid_identity', 'Assistant Workspace email is invalid');
  }
  if (!isValidTimezone(principalTimezone)) {
    throw new GwsEaError('invalid_identity', 'Principal timezone is invalid');
  }
  return {
    assistantDisplayName: safeString(input.assistantDisplayName.trim(), 'Assistant display name', 120),
    assistantWorkspaceEmail,
    principalDisplayName: safeString(input.principalDisplayName.trim(), 'Principal display name', 120),
    principalTimezone,
  };
}

async function reconcileAllSecretMode(
  config: InstanceRuntimeConfig,
  agentGroupId: string,
  run: NonNullable<MainIdentityDependencies['runOnecliAdmin']>,
): Promise<string> {
  let agents = parseOnecliAgents(await run(config, ['agents', 'list', '--max', '0']));
  let agent = exactAgent(agents, agentGroupId);
  if (!agent) {
    await run(config, ['agents', 'create', '--name', MAIN_GROUP_NAME, '--identifier', agentGroupId]);
    agents = parseOnecliAgents(await run(config, ['agents', 'list', '--max', '0']));
    agent = exactAgent(agents, agentGroupId);
    if (!agent) throw new GwsEaError('onecli_agent_missing', 'OneCLI did not create canonical main');
  }

  if (agent.secretMode !== 'all') {
    await run(config, ['agents', 'set-secret-mode', '--id', agent.id, '--mode', 'all']);
  }

  agents = parseOnecliAgents(await run(config, ['agents', 'list', '--max', '0']));
  const verified = exactAgent(agents, agentGroupId);
  if (!verified || verified.id !== agent.id || verified.secretMode !== 'all') {
    throw new GwsEaError('onecli_secret_mode_mismatch', 'Canonical main does not have verified all secret mode');
  }
  return verified.id;
}

/**
 * Reconcile the canonical main group and its credential boundary. The profile
 * pointer is published last, so principal binding cannot observe a canonical
 * main until its provider and instance-vault-wide OneCLI access have been verified.
 */
export async function reconcileMainIdentity(
  configInput: InstanceRuntimeConfig,
  inputValue: MainIdentityInput,
  dependencies: MainIdentityDependencies = {},
): Promise<MainIdentityResult> {
  const config = validateRuntimeConfig(configInput);
  const input = validateInput(inputValue);
  const runNcl = dependencies.runNcl ?? runInstanceNclJson;
  const runOnecliAdmin = dependencies.runOnecliAdmin ?? defaultRunOnecliAdmin;

  const group = parseGroupResult(
    await runNcl(config, ['groups', 'create', '--template', MAIN_TEMPLATE, '--name', MAIN_GROUP_NAME, '--yes']),
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

  const onecliAgentId = await reconcileAllSecretMode(config, group.id, runOnecliAdmin);
  const profile = unwrapData(
    await runNcl(config, [
      'gws-ea-profile',
      'reconcile',
      '--assistant-display-name',
      input.assistantDisplayName,
      '--assistant-workspace-email',
      input.assistantWorkspaceEmail,
      '--principal-display-name',
      input.principalDisplayName,
      '--principal-timezone',
      input.principalTimezone,
      '--main-agent-group-id',
      group.id,
    ]),
  );
  if (!isRecord(profile) || profile.main_agent_group_id !== group.id) {
    throw new GwsEaError('profile_mismatch', 'GWS-EA profile did not retain canonical main');
  }

  return { agentGroupId: group.id, onecliAgentId };
}
