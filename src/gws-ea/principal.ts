import { createHash } from 'node:crypto';
import path from 'node:path';

import { INSTANCE_KEY_RE } from '../channels/channel-registry.js';
import { runInstanceNclJson, type InstanceNclOptions } from './ncl.js';
import { buildInstanceCliCommand, validateRuntimeConfig, type InstanceRuntimeConfig } from './service.js';
import { runSanitizedCommand, type SanitizedCommandRunner } from './process.js';
import { GCHAT_CHANNEL_TYPE, GwsEaError } from './types.js';
import {
  canonicalTimestamp,
  hasControlCharacters,
  isRecord,
  normalizePrincipalEmail,
  unwrapData,
} from './validation.js';

/** The principal as bound: who Google resolved, and the DM the assistant opened with them. */
export interface PrincipalBinding {
  /** `gchat:users/{numericId}`, as Chat names the person. */
  readonly userId: string;
  readonly messagingGroupId: string;
  /** `gchat:{space}`, the conversation the adapter routes the DM to. */
  readonly platformId: string;
  /** When the binding was verified: the bind step's start, so every attempt records the same moment. */
  readonly boundAt: string;
}

export interface PrincipalBindingInput {
  readonly adapterInstance: string;
  /** The one address the principal uses for Google Chat, as create named it (KTD11). */
  readonly chatEmail: string;
  /** When the bind step began. */
  readonly verifiedAt: string;
}

export type PrincipalBindingResult =
  | {
      readonly status: 'bound';
      readonly principal: PrincipalBinding;
      readonly agentGroupId: string;
      readonly eventId: string;
    }
  /** The principal is outside the assistant's organization and has not accepted its DM yet. */
  | { readonly status: 'awaiting_acceptance'; readonly space: string }
  /** Google stayed unavailable while the host opened the DM. */
  | { readonly status: 'unavailable'; readonly reason: string };

export interface PrincipalBindingDependencies {
  readonly runNcl?: (
    config: InstanceRuntimeConfig,
    args: readonly string[],
    options?: InstanceNclOptions,
  ) => Promise<unknown>;
  readonly runCommand?: SanitizedCommandRunner;
}

interface MainProfile {
  readonly mainAgentGroupId: string;
  readonly principalDisplayName: string;
}

/** The DM the host opened, as its command answers. */
type OpenedDm =
  | {
      readonly status: 'opened';
      readonly userId: string;
      readonly platformId: string;
      readonly messagingGroupId: string;
    }
  | Extract<PrincipalBindingResult, { status: 'awaiting_acceptance' | 'unavailable' }>;

/**
 * How long the host may take to open the DM: it retries Google while Google
 * is unavailable before it answers.
 */
const OPEN_DM_TIMEOUT_MS = 120_000;

function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return undefined;
  return hasControlCharacters(value) ? undefined : value;
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
    throw new GwsEaError('main_not_ready', 'Canonical main is not published with verified OneCLI access');
  }
  if (!principalDisplayName) throw new GwsEaError('profile_mismatch', 'The principal profile is incomplete');
  return { mainAgentGroupId, principalDisplayName };
}

function invalidDm(problem: string): GwsEaError {
  return new GwsEaError('invalid_child_output', `The host's direct message with the principal ${problem}`);
}

/**
 * The host's answer: an open DM names the person by the numeric ID Chat knows
 * them by, never the address, and the conversation the adapter routes it to.
 */
function parseOpenedDm(value: unknown): OpenedDm {
  const dm = unwrapData(value);
  if (!isRecord(dm)) throw invalidDm('is not an answer');
  if (dm.status === 'awaiting_acceptance' && typeof dm.space === 'string') {
    return { status: 'awaiting_acceptance', space: dm.space };
  }
  if (dm.status === 'unavailable' && typeof dm.reason === 'string') return { status: 'unavailable', reason: dm.reason };
  if (dm.status !== 'opened') throw invalidDm('has an unknown state');
  const userId = safeIdentifier(dm.user_id);
  const platformId = safeIdentifier(dm.platform_id);
  const messagingGroupId = safeIdentifier(dm.messaging_group_id);
  if (!userId || !/^gchat:users\/\d+$/u.test(userId)) throw invalidDm('names no Chat user ID');
  if (!platformId?.startsWith(`${GCHAT_CHANNEL_TYPE}:spaces/`)) throw invalidDm('is not a Google Chat conversation');
  if (!messagingGroupId) throw invalidDm('has no conversation');
  return { status: 'opened', userId, platformId, messagingGroupId };
}

async function runBootstrap(
  config: InstanceRuntimeConfig,
  args: readonly string[],
  run: SanitizedCommandRunner = runSanitizedCommand,
): Promise<void> {
  const environment = buildInstanceCliCommand(config, []).env;
  await run({
    command: config.node_path,
    args: [
      '--import',
      path.join(config.checkout_root, 'node_modules', 'tsx', 'dist', 'loader.mjs'),
      path.join(config.checkout_root, 'scripts', 'init-first-agent.ts'),
      ...args,
    ],
    cwd: config.checkout_root,
    env: environment,
    timeoutMs: 120_000,
  });
}

/**
 * The first message main receives. Main's `welcome` is the GWS-EA skill its
 * template stamps, which asks the principal for their calendars; NanoClaw's
 * own capability tour is not among main's skills (KTD11, KTD13). Passed
 * explicitly so NanoClaw's default, which can point at a channel addendum
 * for its own welcome, never reaches main.
 */
export const GWS_EA_WELCOME_INSTRUCTION =
  'System instruction: run /welcome to introduce yourself to the principal in this new conversation.';

export function principalWelcomeEventId(
  config: Pick<InstanceRuntimeConfig, 'instance_id'>,
  mainAgentGroupId: string,
  principal: Pick<PrincipalBinding, 'messagingGroupId'>,
): string {
  const digest = createHash('sha256')
    .update([config.instance_id, mainAgentGroupId, principal.messagingGroupId].join('\0'))
    .digest('hex');
  return `gws-ea-welcome:${digest}`;
}

/**
 * Bind the principal through the DM the assistant opens (KTD11). The host
 * opens the assistant's DM with the one address create named; whoever Google
 * resolves for it is the principal. No message anyone sends the assistant
 * binds anyone, and another address is never tried.
 *
 * Binding order: the host opens the DM; the principal and that DM are bound;
 * then the host creates the principal's user, owner role, membership, and
 * main's DM wiring, which its canonical-main admission accepts or rejects;
 * then `init-first-agent` reuses those records and hands main its welcome,
 * once per stable event ID, so the welcome is the first message in the DM.
 * Every command is idempotent, so a retry after a crash repeats the whole
 * sequence safely.
 */
export async function bindPrincipal(
  configInput: InstanceRuntimeConfig,
  input: PrincipalBindingInput,
  dependencies: PrincipalBindingDependencies = {},
): Promise<PrincipalBindingResult> {
  const config = validateRuntimeConfig(configInput);
  const verifiedAt = canonicalTimestamp(input.verifiedAt);
  if (!verifiedAt) throw new GwsEaError('invalid_arguments', 'Principal verification timestamp is invalid');
  if (!INSTANCE_KEY_RE.test(input.adapterInstance)) {
    throw new GwsEaError('invalid_arguments', 'Google Chat adapter instance is invalid');
  }
  const chatEmail = normalizePrincipalEmail(input.chatEmail);
  if (chatEmail === undefined) throw new GwsEaError('invalid_arguments', "The principal's Chat address is invalid");
  const runNcl = dependencies.runNcl ?? runInstanceNclJson;

  // A non-null pointer is published only after main's OneCLI access is
  // verified, so it is the hard prerequisite for any principal wiring.
  const profile = parseProfile(await runNcl(config, ['gws-ea-profile', 'get']));
  const dm = parseOpenedDm(
    await runNcl(config, ['gws-ea-chat', 'open-principal-dm', '--email', chatEmail], {
      timeoutMs: OPEN_DM_TIMEOUT_MS,
    }),
  );
  if (dm.status !== 'opened') return dm;

  const principal: PrincipalBinding = {
    userId: dm.userId,
    messagingGroupId: dm.messagingGroupId,
    platformId: dm.platformId,
    boundAt: verifiedAt,
  };
  const mainAgentGroupId = profile.mainAgentGroupId;
  const displayName = profile.principalDisplayName;
  const stableEventId = principalWelcomeEventId(config, mainAgentGroupId, principal);
  // Every record is made through the host, so its wiring admission judges
  // main's DM wiring when it is created.
  await runNcl(config, [
    'users',
    'create',
    '--id',
    principal.userId,
    '--kind',
    GCHAT_CHANNEL_TYPE,
    '--display-name',
    displayName,
  ]);
  const binding = unwrapData(
    await runNcl(config, [
      'gws-ea-profile',
      'bind-principal',
      '--user-id',
      principal.userId,
      '--verified-at',
      principal.boundAt,
      '--messaging-group-id',
      principal.messagingGroupId,
    ]),
  );
  if (
    !isRecord(binding) ||
    binding.user_id !== principal.userId ||
    binding.verified_at !== principal.boundAt ||
    binding.messaging_group_id !== principal.messagingGroupId
  ) {
    throw new GwsEaError('profile_mismatch', 'The principal user binding was not confirmed');
  }
  await runNcl(config, ['roles', 'grant', '--user', principal.userId, '--role', 'owner']);
  await runNcl(config, ['members', 'add', '--user', principal.userId, '--group', mainAgentGroupId]);
  const wiring = unwrapData(
    await runNcl(config, [
      'wirings',
      'create',
      '--messaging-group-id',
      principal.messagingGroupId,
      '--agent-group-id',
      mainAgentGroupId,
      '--sender-scope',
      'known',
      '--session-mode',
      'agent-shared',
    ]),
  );
  if (
    !isRecord(wiring) ||
    wiring.messaging_group_id !== principal.messagingGroupId ||
    wiring.agent_group_id !== mainAgentGroupId ||
    wiring.sender_scope !== 'known' ||
    wiring.session_mode !== 'agent-shared'
  ) {
    throw new GwsEaError('profile_mismatch', "Main's principal DM wiring was not confirmed");
  }
  await runBootstrap(
    config,
    [
      '--channel',
      GCHAT_CHANNEL_TYPE,
      '--user-id',
      principal.userId,
      '--platform-id',
      principal.platformId,
      '--display-name',
      displayName,
      '--agent-group-id',
      mainAgentGroupId,
      '--role',
      'owner',
      '--instance',
      input.adapterInstance,
      '--event-id',
      stableEventId,
      '--welcome',
      GWS_EA_WELCOME_INSTRUCTION,
    ],
    dependencies.runCommand,
  );
  return { status: 'bound', principal, agentGroupId: mainAgentGroupId, eventId: stableEventId };
}
