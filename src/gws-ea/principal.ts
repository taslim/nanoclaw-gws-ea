import { createHash } from 'node:crypto';
import path from 'node:path';

import { INSTANCE_KEY_RE } from '../channels/channel-registry.js';
import { buildInstanceCliCommand, validateRuntimeConfig, type InstanceRuntimeConfig } from './service.js';
import { runSanitizedCommand, type SanitizedCommandRunner } from './process.js';
import { GwsEaError } from './types.js';

const CHANNEL_TYPE = 'gchat';

export interface PrincipalCandidate {
  readonly messagingGroupId: string;
  readonly platformId: string;
  readonly userId: string;
  readonly senderName: string | null;
  readonly authenticatedMessageId: string;
  readonly authenticatedMessageAt: string;
}

export interface PrincipalDiscoveryInput {
  readonly adapterInstance: string;
  readonly provisioningStartedAt: string;
  readonly messagingGroupId?: string;
}

export type PrincipalDiscoveryResult =
  | { readonly status: 'waiting' }
  | { readonly status: 'selection-required'; readonly candidates: readonly PrincipalCandidate[] }
  | {
      readonly status: 'bound';
      readonly candidate: PrincipalCandidate;
      readonly agentGroupId: string;
      readonly eventId: string;
    };

export interface PrincipalDiscoveryDependencies {
  readonly runNcl?: (config: InstanceRuntimeConfig, args: readonly string[]) => Promise<unknown>;
  readonly runBootstrap?: (config: InstanceRuntimeConfig, args: readonly string[]) => Promise<void>;
  readonly runCommand?: SanitizedCommandRunner;
}

interface MainProfile {
  readonly mainAgentGroupId: string;
  readonly principalDisplayName: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unwrapData(value: unknown): unknown {
  return isRecord(value) && 'data' in value ? value.data : value;
}

function canonicalTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? value : undefined;
}

function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return undefined;
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  })
    ? undefined
    : value;
}

function safeDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 120 && safeIdentifier(normalized) ? normalized : undefined;
}

function parseProfile(value: unknown): MainProfile {
  const profile = unwrapData(value);
  if (!isRecord(profile)) throw new GwsEaError('invalid_child_output', 'ncl returned an invalid GWS-EA profile');
  const mainAgentGroupId = safeIdentifier(profile.main_agent_group_id);
  const principalDisplayName = safeDisplayName(profile.principal_display_name);
  if (!mainAgentGroupId) {
    throw new GwsEaError('main_not_ready', 'Canonical main is not published with a verified selective grant');
  }
  if (!principalDisplayName) throw new GwsEaError('profile_mismatch', 'The principal profile is incomplete');
  return { mainAgentGroupId, principalDisplayName };
}

function parseCandidate(
  value: unknown,
  adapterInstance: string,
  provisioningStartedAt: string,
): PrincipalCandidate | undefined {
  if (!isRecord(value)) return undefined;
  const authenticatedMessageAt = canonicalTimestamp(value.authenticated_message_at);
  const authenticatedMessageId = safeIdentifier(value.authenticated_message_id);
  const messagingGroupId = safeIdentifier(value.messaging_group_id);
  const platformId = safeIdentifier(value.platform_id);
  const userId = safeIdentifier(value.user_id);
  if (
    value.channel_type !== CHANNEL_TYPE ||
    value.instance !== adapterInstance ||
    value.reason !== 'no_agent_wired' ||
    value.sender_authenticated !== 1 ||
    value.sender_kind !== 'human' ||
    value.is_group !== 0 ||
    !authenticatedMessageAt ||
    authenticatedMessageAt < provisioningStartedAt ||
    !authenticatedMessageId ||
    !messagingGroupId ||
    !platformId ||
    !userId?.startsWith(`${CHANNEL_TYPE}:`)
  ) {
    return undefined;
  }
  return {
    messagingGroupId,
    platformId,
    userId,
    senderName: safeDisplayName(value.sender_name) ?? null,
    authenticatedMessageId,
    authenticatedMessageAt,
  };
}

function parseCandidates(value: unknown, adapterInstance: string, provisioningStartedAt: string): PrincipalCandidate[] {
  const rows = unwrapData(value);
  if (!Array.isArray(rows))
    throw new GwsEaError('invalid_child_output', 'ncl returned an invalid dropped-message list');
  return rows
    .map((row) => parseCandidate(row, adapterInstance, provisioningStartedAt))
    .filter((candidate): candidate is PrincipalCandidate => candidate !== undefined)
    .sort(
      (left, right) =>
        left.authenticatedMessageAt.localeCompare(right.authenticatedMessageAt) ||
        left.messagingGroupId.localeCompare(right.messagingGroupId),
    );
}

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new GwsEaError('invalid_child_output', 'ncl returned invalid JSON');
  }
}

async function defaultRunNcl(config: InstanceRuntimeConfig, args: readonly string[]): Promise<unknown> {
  const command = buildInstanceCliCommand(config, [...args, '--json']);
  const result = await runSanitizedCommand({ ...command, timeoutMs: 30_000 });
  const frame = parseJson(result.stdout);
  if (!isRecord(frame) || frame.ok !== true || !('data' in frame)) {
    throw new GwsEaError('ncl_failed', 'The selected NanoClaw command did not succeed');
  }
  return frame.data;
}

async function defaultRunBootstrap(
  config: InstanceRuntimeConfig,
  args: readonly string[],
  run: SanitizedCommandRunner = runSanitizedCommand,
): Promise<void> {
  const environment = buildInstanceCliCommand(config, []).env;
  await run({
    command: config.node_path,
    args: [
      '--import',
      path.join(config.checkout_realpath, 'node_modules', 'tsx', 'dist', 'loader.mjs'),
      path.join(config.checkout_realpath, 'scripts', 'init-first-agent.ts'),
      ...args,
    ],
    cwd: config.checkout_realpath,
    env: environment,
    timeoutMs: 120_000,
  });
}

export function principalWelcomeEventId(
  config: Pick<InstanceRuntimeConfig, 'instance_id'>,
  mainAgentGroupId: string,
  candidate: PrincipalCandidate,
): string {
  const digest = createHash('sha256')
    .update(
      [config.instance_id, mainAgentGroupId, candidate.messagingGroupId, candidate.authenticatedMessageId].join('\0'),
    )
    .digest('hex');
  return `gws-ea-welcome:${digest}`;
}

/**
 * Select and bind an authenticated first Google Chat DM. Discovery is
 * intentionally read-only until one exact candidate is unambiguous (or the
 * operator supplies its exact messaging-group ID).
 */
export async function reconcilePrincipalDm(
  configInput: InstanceRuntimeConfig,
  input: PrincipalDiscoveryInput,
  dependencies: PrincipalDiscoveryDependencies = {},
): Promise<PrincipalDiscoveryResult> {
  const config = validateRuntimeConfig(configInput);
  const provisioningStartedAt = canonicalTimestamp(input.provisioningStartedAt);
  if (!provisioningStartedAt) throw new GwsEaError('invalid_arguments', 'Provisioning start timestamp is invalid');
  if (!INSTANCE_KEY_RE.test(input.adapterInstance)) {
    throw new GwsEaError('invalid_arguments', 'Google Chat adapter instance is invalid');
  }
  const runNcl = dependencies.runNcl ?? defaultRunNcl;
  const runBootstrap =
    dependencies.runBootstrap ??
    ((runtimeConfig: InstanceRuntimeConfig, args: readonly string[]) =>
      defaultRunBootstrap(runtimeConfig, args, dependencies.runCommand));

  // A non-null pointer is published only after U5 verifies the selective
  // OneCLI grant, so it is the hard prerequisite for any principal wiring.
  const profile = parseProfile(await runNcl(config, ['gws-ea-profile', 'get']));
  const candidates = parseCandidates(
    await runNcl(config, [
      'dropped-messages',
      'list',
      '--channel-type',
      CHANNEL_TYPE,
      '--instance',
      input.adapterInstance,
      '--reason',
      'no_agent_wired',
      '--limit',
      '200',
    ]),
    input.adapterInstance,
    provisioningStartedAt,
  );

  let selected: PrincipalCandidate | undefined;
  if (input.messagingGroupId !== undefined) {
    selected = candidates.find((candidate) => candidate.messagingGroupId === input.messagingGroupId);
    if (!selected) throw new GwsEaError('principal_selection_mismatch', 'Selected principal DM is not eligible');
  } else if (candidates.length === 0) {
    return { status: 'waiting' };
  } else if (candidates.length > 1) {
    return { status: 'selection-required', candidates };
  } else {
    [selected] = candidates;
  }

  const stableEventId = principalWelcomeEventId(config, profile.mainAgentGroupId, selected);
  const binding = unwrapData(
    await runNcl(config, [
      'gws-ea-profile',
      'bind-principal',
      '--user-id',
      selected.userId,
      '--verified-at',
      selected.authenticatedMessageAt,
    ]),
  );
  if (
    !isRecord(binding) ||
    binding.user_id !== selected.userId ||
    binding.verified_at !== selected.authenticatedMessageAt
  ) {
    throw new GwsEaError('profile_mismatch', 'The principal user binding was not confirmed');
  }
  await runBootstrap(config, [
    '--channel',
    CHANNEL_TYPE,
    '--user-id',
    selected.userId,
    '--platform-id',
    selected.platformId,
    '--display-name',
    selected.senderName ?? profile.principalDisplayName,
    '--agent-group-id',
    profile.mainAgentGroupId,
    '--verified-principal',
    '--role',
    'owner',
    '--instance',
    input.adapterInstance,
    '--sender-scope',
    'known',
    '--session-mode',
    'agent-shared',
    '--event-id',
    stableEventId,
  ]);
  return { status: 'bound', candidate: selected, agentGroupId: profile.mainAgentGroupId, eventId: stableEventId };
}
