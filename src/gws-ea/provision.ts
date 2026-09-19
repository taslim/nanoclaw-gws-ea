import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { mkdir, rmdir } from 'node:fs/promises';
import path from 'node:path';

import {
  beginPhase,
  commitPhaseSuccess,
  ensureProvisionJournal,
  observePhase,
  recordPhaseFailure,
  type InstanceOperation,
} from './journal.js';
import {
  defineProvisionPhaseRegistry,
  type PhaseEffectResult,
  type PhaseProbeResult,
  type ProvisionHumanPause,
  type ProvisionPhaseRegistry,
} from './phases.js';
import { journalResourceKey } from './journal.js';
import { assertReleaseCheckoutAgreement, materializeReleaseCheckout, type ResolvedRelease } from './checkout.js';
import { runReleasePreflight, type ReleasePreflightInput } from './release-preflight.js';
import {
  importProviderCredential,
  inspectOnecliRuntime,
  persistOnecliApiKeyFiles,
  reconcileOnecliRuntime,
  validateObservedOnecliRuntime,
  type OnecliCompatibilityReceipt,
  type OnecliRuntimeDependencies,
  type ProviderCredentialInput,
} from './onecli.js';
import type { OnecliRuntimeLayout } from './onecli-compose.js';
import { createOnecliRuntimeLayout } from './onecli-compose.js';
import {
  reconcileInstanceRuntime,
  runInstanceOnecliAdminCommand,
  createInstanceRuntimeConfig,
  loadInstanceRuntimeConfig,
  type InstanceRuntimeConfig,
  type InstanceServiceDependencies,
} from './service.js';
import { runInstanceNclJson } from './ncl.js';
import { reconcileMainIdentity, type MainIdentityDependencies, type MainIdentityInput } from './identity.js';
import { reconcilePrincipalDm, type PrincipalCandidate, type PrincipalDiscoveryDependencies } from './principal.js';
import { verifyExistingGchatEndpoint, verifyExistingGchatRoute, validateExistingGchatEndpoint } from './endpoint.js';
import {
  verifyPrincipalBinding,
  verifyTalkableConversation,
  type ConversationVerificationInput,
  type ConversationVerificationResult,
  type PrincipalBindingVerificationInput,
  type PrincipalBindingVerificationResult,
} from './verify.js';
import { readOwnerOnlyFile, removePrivateFile, writePrivateTextFile } from './secrets.js';
import { assertInstanceId, getInstanceReservation } from './registry.js';
import { preparePrivateLocalDirectory, type ControlPlanePaths } from './paths.js';
import {
  GwsEaError,
  PROVISION_PHASES,
  type InstanceReservation,
  type ProvisionJournal,
  type ProvisionPhase,
} from './types.js';
import { isRecord } from './validation.js';

export type ProvisionBoundary = 'intent' | 'effect' | 'verify';

export interface ProvisionBoundaryEvent {
  readonly phase: ProvisionPhase;
  readonly boundary: ProvisionBoundary;
  readonly attemptId: string;
}

export interface ProvisionRuntime {
  readonly onBoundary?: (event: ProvisionBoundaryEvent) => void | Promise<void>;
}

export type ProvisionResult =
  | { readonly status: 'ready' }
  | { readonly status: 'paused'; readonly pause: ProvisionHumanPause };

/** Test/process harness signal used to model an abrupt stop at a journal boundary. */
export class ProvisionBoundaryInterruption extends Error {
  readonly event: ProvisionBoundaryEvent;

  constructor(event: ProvisionBoundaryEvent) {
    super(`Provision interrupted after ${event.phase} ${event.boundary}`);
    this.name = 'ProvisionBoundaryInterruption';
    this.event = event;
  }
}

export interface ProductionProvisionInput {
  readonly release: ResolvedRelease;
  readonly releasePreflight: ReleasePreflightInput;
  readonly onecli: OnecliRuntimeLayout;
  readonly runtime: InstanceRuntimeConfig;
  readonly providerCredentialMetadata?: Omit<ProviderCredentialInput, 'value'>;
  readonly providerCredential?: ProviderCredentialInput;
  readonly identity: Omit<MainIdentityInput, 'providerSecretId'>;
  readonly adapterInstance: string;
  readonly provisioningStartedAt: string;
  readonly selectedMessagingGroupId?: string;
  readonly gchatCredentialSourceFile?: string;
  readonly bootstrapManifestFile?: string;
  readonly serviceDependencies: InstanceServiceDependencies;
  readonly onecliDependencies?: OnecliRuntimeDependencies;
  readonly identityDependencies?: MainIdentityDependencies;
  readonly principalDependencies?: PrincipalDiscoveryDependencies;
}

export interface ProductionProvisionState {
  onecliReceipt?: OnecliCompatibilityReceipt;
  providerSecretId?: string;
  mainAgentGroupId?: string;
  principal?: PrincipalCandidate;
  welcomeEventId?: string;
}

export interface ProductionProvisionContext {
  readonly operation: InstanceOperation;
  readonly input: ProductionProvisionInput;
  readonly state: ProductionProvisionState;
}

export interface ProductionProvisionDependencies {
  readonly probeCheckout: (context: ProductionProvisionContext) => Promise<PhaseProbeResult>;
  readonly materializeReleaseCheckout: typeof materializeReleaseCheckout;
  readonly runReleasePreflight: typeof runReleasePreflight;
  readonly probeOnecli: (context: ProductionProvisionContext) => Promise<PhaseProbeResult>;
  readonly reconcileOnecliRuntime: typeof reconcileOnecliRuntime;
  readonly persistOnecliApiKeyFiles: typeof persistOnecliApiKeyFiles;
  readonly probeProvider: (context: ProductionProvisionContext) => Promise<PhaseProbeResult>;
  readonly importProviderCredential: typeof importProviderCredential;
  readonly probeNanoclaw: (context: ProductionProvisionContext) => Promise<PhaseProbeResult>;
  readonly reconcileInstanceRuntime: typeof reconcileInstanceRuntime;
  readonly reconcileMainIdentity: typeof reconcileMainIdentity;
  readonly verifyRoute: typeof verifyExistingGchatRoute;
  readonly verifyEndpoint: typeof verifyExistingGchatEndpoint;
  readonly verifyPrincipalBinding: (input: PrincipalBindingVerificationInput) => PrincipalBindingVerificationResult;
  readonly reconcilePrincipal: typeof reconcilePrincipalDm;
  readonly verifyConversation: (input: ConversationVerificationInput) => ConversationVerificationResult;
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

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === 'string' && value[key].length > 0 ? value[key] : undefined;
}

async function defaultProbeCheckout(context: ProductionProvisionContext): Promise<PhaseProbeResult> {
  try {
    await assertReleaseCheckoutAgreement(context.operation.paths, context.operation.instanceId);
    return { status: 'matched' };
  } catch (error) {
    if (error instanceof GwsEaError && ['marker_missing', 'checkout_exists', 'unsafe_checkout'].includes(error.code)) {
      return { status: 'absent' };
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { status: 'absent' };
    throw error;
  }
}

async function defaultProbeOnecli(context: ProductionProvisionContext): Promise<PhaseProbeResult> {
  try {
    const observed = await inspectOnecliRuntime(context.input.onecli);
    validateObservedOnecliRuntime(context.input.onecli, observed);
    const [runtimeKey, adminKey] = await Promise.all([
      readOwnerOnlyFile(context.input.runtime.secret_files.onecli_runtime_api_key),
      readOwnerOnlyFile(context.input.runtime.secret_files.onecli_admin_api_key),
    ]);
    if (!runtimeKey.trim() || runtimeKey.trim() !== adminKey.trim()) return { status: 'absent' };
    return { status: 'matched' };
  } catch (error) {
    if (error instanceof GwsEaError && error.code.startsWith('unsafe_')) throw error;
    return { status: 'absent' };
  }
}

function credentialMetadataMatches(
  row: Record<string, unknown>,
  input: Omit<ProviderCredentialInput, 'value'>,
): boolean {
  const optional = (key: string, expected: string | undefined): boolean =>
    expected === undefined ? row[key] === undefined || row[key] === null || row[key] === '' : row[key] === expected;
  return (
    row.name === input.name &&
    row.type === input.type &&
    row.hostPattern === input.hostPattern &&
    optional('pathPattern', input.pathPattern) &&
    optional('headerName', input.headerName) &&
    optional('valueFormat', input.valueFormat) &&
    optional('paramName', input.paramName) &&
    optional('paramFormat', input.paramFormat)
  );
}

async function defaultProbeProvider(context: ProductionProvisionContext): Promise<PhaseProbeResult> {
  const credential = context.input.providerCredentialMetadata;
  try {
    const result = await runInstanceOnecliAdminCommand(context.input.runtime, ['secrets', 'list', '--max', '0']);
    const value = unwrapData(parseJson(result.stdout, 'OneCLI'));
    if (!Array.isArray(value) || !value.every(isRecord)) {
      throw new GwsEaError('invalid_child_output', 'OneCLI returned an invalid secret list');
    }
    if (context.state.providerSecretId) {
      const match = value.find((candidate) => candidate.id === context.state.providerSecretId);
      return match ? { status: 'matched' } : { status: 'absent' };
    }
    if (!credential) return { status: 'absent' };
    const matches = value.filter((candidate) => candidate.name === credential.name);
    if (matches.length > 1) throw new GwsEaError('ambiguous_onecli_secret', 'Provider credential is ambiguous');
    const match = matches[0];
    if (!match) return { status: 'absent' };
    if (!credentialMetadataMatches(match, credential)) {
      throw new GwsEaError('onecli_secret_conflict', 'Provider credential metadata does not match');
    }
    const id = stringField(match, 'id');
    if (!id) throw new GwsEaError('invalid_child_output', 'OneCLI provider secret has no ID');
    context.state.providerSecretId = id;
    return { status: 'matched' };
  } catch (error) {
    if (error instanceof GwsEaError && ['command_failed', 'command_timeout'].includes(error.code)) {
      return { status: 'absent' };
    }
    throw error;
  }
}

async function defaultProbeNanoclaw(context: ProductionProvisionContext): Promise<PhaseProbeResult> {
  try {
    const profileValue = unwrapData(await runInstanceNclJson(context.input.runtime, ['gws-ea-profile', 'get']));
    if (!isRecord(profileValue)) return { status: 'absent' };
    const mainAgentGroupId = stringField(profileValue, 'main_agent_group_id');
    if (
      !mainAgentGroupId ||
      profileValue.assistant_display_name !== context.input.identity.assistantDisplayName ||
      profileValue.assistant_workspace_email !== context.input.identity.assistantWorkspaceEmail.toLowerCase() ||
      profileValue.principal_display_name !== context.input.identity.principalDisplayName ||
      profileValue.principal_timezone !== context.input.identity.principalTimezone
    ) {
      return { status: 'absent' };
    }
    const groupValue = unwrapData(
      await runInstanceNclJson(context.input.runtime, ['groups', 'get', '--id', mainAgentGroupId]),
    );
    const configValue = unwrapData(
      await runInstanceNclJson(context.input.runtime, ['groups', 'config', 'get', '--id', mainAgentGroupId]),
    );
    if (
      !isRecord(groupValue) ||
      groupValue.name !== 'main' ||
      !isRecord(configValue) ||
      configValue.provider !== context.input.runtime.selected_provider
    ) {
      return { status: 'absent' };
    }
    const providerSecretId = context.state.providerSecretId;
    if (!providerSecretId) return { status: 'absent' };
    const agentsResult = await runInstanceOnecliAdminCommand(context.input.runtime, ['agents', 'list', '--max', '0']);
    const agents = unwrapData(parseJson(agentsResult.stdout, 'OneCLI'));
    if (!Array.isArray(agents) || !agents.every(isRecord)) return { status: 'absent' };
    const matching = agents.filter((agent) => agent.identifier === mainAgentGroupId);
    if (matching.length !== 1 || matching[0]!.secretMode !== 'selective') return { status: 'absent' };
    const agentId = stringField(matching[0]!, 'id');
    if (!agentId) return { status: 'absent' };
    const secretResult = await runInstanceOnecliAdminCommand(context.input.runtime, [
      'agents',
      'secrets',
      '--id',
      agentId,
    ]);
    const secrets = unwrapData(parseJson(secretResult.stdout, 'OneCLI'));
    if (!Array.isArray(secrets) || secrets.length !== 1 || secrets[0] !== providerSecretId) {
      return { status: 'absent' };
    }
    context.state.mainAgentGroupId = mainAgentGroupId;
    return { status: 'matched' };
  } catch (error) {
    if (error instanceof GwsEaError && ['command_failed', 'command_timeout', 'ncl_failed'].includes(error.code)) {
      return { status: 'absent' };
    }
    throw error;
  }
}

async function bootstrapManifestRemoved(file: string | undefined): Promise<boolean> {
  if (!file) return true;
  try {
    await readOwnerOnlyFile(file);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

const SERVICE_ACCOUNT_KEYS = new Set([
  'type',
  'project_id',
  'private_key_id',
  'private_key',
  'client_email',
  'client_id',
  'auth_uri',
  'token_uri',
  'auth_provider_x509_cert_url',
  'client_x509_cert_url',
  'universe_domain',
]);

function serviceAccountString(credential: Record<string, unknown>, field: string, maximumLength = 4_096): string {
  const value = credential[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength) {
    throw new GwsEaError('invalid_gchat_credential', 'Google Chat credential schema is invalid');
  }
  return value;
}

function serviceAccountHttpsUrl(credential: Record<string, unknown>, field: string): void {
  const value = serviceAccountString(credential, field);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new GwsEaError('invalid_gchat_credential', 'Google Chat credential schema is invalid');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new GwsEaError('invalid_gchat_credential', 'Google Chat credential schema is invalid');
  }
}

function validateGchatServiceAccountCredential(
  contents: string,
  expected: { readonly projectId: string; readonly privateKeyId: string },
): void {
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    throw new GwsEaError('invalid_gchat_credential', 'Google Chat credential is not valid JSON');
  }
  if (!isRecord(value) || Object.keys(value).some((key) => !SERVICE_ACCOUNT_KEYS.has(key))) {
    throw new GwsEaError('invalid_gchat_credential', 'Google Chat credential schema is invalid');
  }
  if (value.type !== 'service_account') {
    throw new GwsEaError('invalid_gchat_credential', 'Google Chat credential must be a service-account key');
  }
  const projectId = serviceAccountString(value, 'project_id', 30);
  const privateKeyId = serviceAccountString(value, 'private_key_id', 256);
  const privateKey = serviceAccountString(value, 'private_key', 32_768);
  const clientEmail = serviceAccountString(value, 'client_email', 320);
  serviceAccountString(value, 'client_id', 256);
  for (const field of ['auth_uri', 'token_uri', 'auth_provider_x509_cert_url', 'client_x509_cert_url']) {
    serviceAccountHttpsUrl(value, field);
  }
  if (value.universe_domain !== undefined) serviceAccountString(value, 'universe_domain', 256);
  if (
    !privateKey.startsWith('-----BEGIN PRIVATE KEY-----\n') ||
    !privateKey.trimEnd().endsWith('\n-----END PRIVATE KEY-----') ||
    !clientEmail.endsWith(`@${projectId}.iam.gserviceaccount.com`)
  ) {
    throw new GwsEaError('invalid_gchat_credential', 'Google Chat credential schema is invalid');
  }
  if (projectId !== expected.projectId) {
    throw new GwsEaError('gchat_credential_mismatch', 'Google Chat credential project does not match the reservation');
  }
  // The reservation's chat_credential_id is the Google service-account key ID.
  if (privateKeyId !== expected.privateKeyId) {
    throw new GwsEaError('gchat_credential_mismatch', 'Google Chat credential key does not match the reservation');
  }
}

function canonicalGchatAppResourceName(appId: string): string {
  return appId.startsWith('users/') ? appId : `users/${appId}`;
}

async function ensureGchatCredential(context: ProductionProvisionContext): Promise<PhaseEffectResult | undefined> {
  const target = context.input.runtime.secret_files.gchat_credentials;
  let contents: string;
  let install = false;
  try {
    contents = await readOwnerOnlyFile(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const source = context.input.gchatCredentialSourceFile;
    if (!source) {
      return humanPause(
        'start_nanoclaw',
        'gchat_credential_required',
        'Install the Google Chat service-account credential in the instance private file, then resume.',
      );
    }
    contents = await readOwnerOnlyFile(source);
    install = true;
  }
  const reservation = await getInstanceReservation(context.operation.paths, context.operation.instanceId);
  if (
    context.input.runtime.gchat_bot_user_id !==
    canonicalGchatAppResourceName(reservation.exclusive_resource_claims.chat_app_id)
  ) {
    throw new GwsEaError('gchat_app_mismatch', 'Google Chat bot identity does not match the reserved app');
  }
  validateGchatServiceAccountCredential(contents, {
    projectId: reservation.exclusive_resource_claims.gcp_project_id,
    privateKeyId: reservation.exclusive_resource_claims.chat_credential_id,
  });
  if (install) {
    await preparePrivateLocalDirectory(path.dirname(target));
    await writePrivateTextFile(target, contents);
  }
  return undefined;
}

const defaultProductionDependencies: ProductionProvisionDependencies = {
  probeCheckout: defaultProbeCheckout,
  materializeReleaseCheckout,
  runReleasePreflight,
  probeOnecli: defaultProbeOnecli,
  reconcileOnecliRuntime,
  persistOnecliApiKeyFiles,
  probeProvider: defaultProbeProvider,
  importProviderCredential,
  probeNanoclaw: defaultProbeNanoclaw,
  reconcileInstanceRuntime,
  reconcileMainIdentity,
  verifyRoute: verifyExistingGchatRoute,
  verifyEndpoint: verifyExistingGchatEndpoint,
  verifyPrincipalBinding,
  reconcilePrincipal: reconcilePrincipalDm,
  verifyConversation: verifyTalkableConversation,
};

function humanPause(phase: ProvisionPhase, code: string, message: string): PhaseEffectResult {
  return { status: 'paused', pause: { kind: 'human-action', phase, code, message } };
}

function principalResult(
  context: ProductionProvisionContext,
  result: Awaited<ReturnType<typeof reconcilePrincipalDm>>,
): PhaseProbeResult {
  if (result.status === 'waiting') {
    return {
      status: 'paused',
      pause: {
        kind: 'human-action',
        phase: 'bind_principal',
        code: 'principal_dm_required',
        message: 'Ask the principal to send a direct message to the configured Google Chat app, then resume.',
      },
    };
  }
  if (result.status === 'selection-required') {
    return {
      status: 'paused',
      pause: {
        kind: 'human-action',
        phase: 'bind_principal',
        code: 'principal_selection_required',
        message: 'Select the principal direct-message conversation, then resume.',
        choices: result.candidates.map((candidate) => ({
          id: candidate.messagingGroupId,
          label: candidate.senderName ?? candidate.userId,
        })),
      },
    };
  }
  context.state.mainAgentGroupId = result.agentGroupId;
  context.state.principal = result.candidate;
  context.state.welcomeEventId = result.eventId;
  return { status: 'matched' };
}

function bindingObservation(
  context: ProductionProvisionContext,
  result: PrincipalBindingVerificationResult,
): PhaseProbeResult {
  if (result.status === 'absent') return { status: 'absent' };
  context.state.mainAgentGroupId = result.agentGroupId;
  context.state.principal = result.candidate;
  context.state.welcomeEventId = result.welcomeEventId;
  return { status: 'matched' };
}

function conversationInput(context: ProductionProvisionContext): ConversationVerificationInput | undefined {
  const mainAgentGroupId = context.state.mainAgentGroupId;
  const principal = context.state.principal;
  const welcomeEventId = context.state.welcomeEventId;
  if (!mainAgentGroupId || !principal || !welcomeEventId) return undefined;
  return {
    checkoutRoot: context.input.runtime.checkout_realpath,
    mainAgentGroupId,
    messagingGroupId: principal.messagingGroupId,
    principalUserId: principal.userId,
    adapterInstance: context.input.adapterInstance,
    boundAt: principal.authenticatedMessageAt,
    welcomeEventId,
  };
}

/**
 * Production phase composition over the U2-U6 primitives. Dependencies are
 * injectable for boundary tests; omitted functions are the real checkout,
 * OneCLI, runtime, identity, principal, endpoint, and mailbox implementations.
 */
export function createProductionProvisionRegistry(
  context: ProductionProvisionContext,
  overrides: Partial<ProductionProvisionDependencies> = {},
): ProvisionPhaseRegistry<ProductionProvisionContext> {
  const dependencies: ProductionProvisionDependencies = { ...defaultProductionDependencies, ...overrides };
  const { input } = context;
  if (input.runtime.instance_id !== context.operation.instanceId) {
    throw new GwsEaError('runtime_mismatch', 'Provision runtime targets a different instance');
  }
  if (input.release.commit !== input.runtime.deployed_commit) {
    throw new GwsEaError('release_mismatch', 'Provision release and runtime commits disagree');
  }
  if (input.releasePreflight.checkoutRoot !== input.runtime.checkout_realpath) {
    throw new GwsEaError('runtime_mismatch', 'Release preflight targets a different checkout');
  }
  if (input.runtime.endpoint_url !== validateExistingGchatEndpoint(input.runtime.endpoint_url)) {
    throw new GwsEaError('endpoint_mismatch', 'Runtime endpoint is not canonical');
  }
  if (input.adapterInstance !== 'gchat') {
    throw new GwsEaError(
      'adapter_instance_mismatch',
      'Checkpoint 2 requires the registered Google Chat instance gchat',
    );
  }

  const key = (kind: string, value: string): string => journalResourceKey(kind, value);
  const principalProbe = async (value: ProductionProvisionContext): Promise<PhaseProbeResult> =>
    bindingObservation(
      value,
      dependencies.verifyPrincipalBinding({
        runtime: value.input.runtime,
        adapterInstance: value.input.adapterInstance,
        provisioningStartedAt: value.input.provisioningStartedAt,
        selectedMessagingGroupId: value.input.selectedMessagingGroupId,
      }),
    );
  const conversationProbe = async (value: ProductionProvisionContext): Promise<PhaseProbeResult> => {
    const verificationInput = conversationInput(value);
    if (!verificationInput) return { status: 'absent' };
    return dependencies.verifyConversation(verificationInput).ready ? { status: 'matched' } : { status: 'absent' };
  };

  return defineProvisionPhaseRegistry({
    materialize_checkout: {
      resourceKey: () => key('checkout', JSON.stringify([input.release.sourceRemote, input.release.commit])),
      probe: dependencies.probeCheckout,
      apply: async (value) => {
        await dependencies.materializeReleaseCheckout(
          value.operation.paths,
          value.operation.instanceId,
          value.input.release,
        );
        await dependencies.runReleasePreflight(value.input.releasePreflight);
        return { status: 'completed' };
      },
    },
    start_onecli: {
      resourceKey: () =>
        key('onecli', JSON.stringify([input.onecli.project, input.onecli.appPort, input.onecli.gatewayPort])),
      probe: dependencies.probeOnecli,
      apply: async (value) => {
        const receipt = await dependencies.reconcileOnecliRuntime(value.input.onecli, value.input.onecliDependencies);
        value.state.onecliReceipt = receipt;
        await dependencies.persistOnecliApiKeyFiles(receipt, {
          runtime: value.input.runtime.secret_files.onecli_runtime_api_key,
          admin: value.input.runtime.secret_files.onecli_admin_api_key,
        });
        return { status: 'completed' };
      },
    },
    configure_provider: {
      resourceKey: () =>
        key(
          'provider',
          JSON.stringify([
            input.runtime.selected_provider,
            input.providerCredentialMetadata?.name ?? context.state.providerSecretId ?? 'unresolved',
            input.providerCredentialMetadata?.type ?? '',
            input.providerCredentialMetadata?.hostPattern ?? '',
          ]),
        ),
      probe: dependencies.probeProvider,
      apply: async (value) => {
        if (!value.input.providerCredential) {
          return humanPause(
            'configure_provider',
            'provider_credential_required',
            'Supply the selected provider credential through the private setup input, then resume.',
          );
        }
        const receipt =
          value.state.onecliReceipt ??
          (await dependencies.reconcileOnecliRuntime(value.input.onecli, value.input.onecliDependencies));
        value.state.onecliReceipt = receipt;
        await dependencies.persistOnecliApiKeyFiles(receipt, {
          runtime: value.input.runtime.secret_files.onecli_runtime_api_key,
          admin: value.input.runtime.secret_files.onecli_admin_api_key,
        });
        const imported = await dependencies.importProviderCredential(
          receipt,
          value.input.providerCredential,
          value.input.onecliDependencies,
        );
        value.state.providerSecretId = imported.id;
        return { status: 'completed' };
      },
    },
    start_nanoclaw: {
      resourceKey: () =>
        key(
          'nanoclaw',
          JSON.stringify([input.runtime.instance_id, input.runtime.deployed_commit, input.runtime.selected_provider]),
        ),
      probe: async (value) => {
        const observed = await dependencies.probeNanoclaw(value);
        if (observed.status !== 'matched') return observed;
        return (await bootstrapManifestRemoved(value.input.bootstrapManifestFile)) ? observed : { status: 'absent' };
      },
      apply: async (value) => {
        if (!value.state.providerSecretId) {
          throw new GwsEaError('provider_not_ready', 'Provider credential must be reconciled before NanoClaw');
        }
        const credentialPause = await ensureGchatCredential(value);
        if (credentialPause) return credentialPause;
        await dependencies.reconcileInstanceRuntime(value.input.runtime, value.input.serviceDependencies);
        const main = await dependencies.reconcileMainIdentity(
          value.input.runtime,
          { ...value.input.identity, providerSecretId: value.state.providerSecretId },
          value.input.identityDependencies,
        );
        value.state.mainAgentGroupId = main.agentGroupId;
        if (value.input.bootstrapManifestFile) {
          await removePrivateFile(value.input.bootstrapManifestFile);
        }
        return { status: 'completed' };
      },
    },
    establish_transport: {
      resourceKey: () => key('transport', input.runtime.endpoint_url),
      probe: async () => {
        try {
          await dependencies.verifyRoute({ endpointUrl: input.runtime.endpoint_url });
          return { status: 'matched' };
          /* eslint-disable-next-line no-catch-all/no-catch-all -- Any route-probe failure means the external postcondition is absent. */
        } catch {
          return { status: 'absent' };
        }
      },
      apply: async () =>
        humanPause(
          'establish_transport',
          'existing_endpoint_required',
          'Publish the claimed HTTPS /webhook/gchat route without redirects, then resume.',
        ),
    },
    configure_channel: {
      resourceKey: () => key('gchat', JSON.stringify([input.adapterInstance, input.runtime.endpoint_url])),
      probe: async () => {
        try {
          await dependencies.verifyEndpoint({
            endpointUrl: input.runtime.endpoint_url,
            audienceUrl: input.runtime.endpoint_url,
          });
          return { status: 'matched' };
          /* eslint-disable-next-line no-catch-all/no-catch-all -- Any auth-probe failure means the external postcondition is absent. */
        } catch {
          return { status: 'absent' };
        }
      },
      apply: async () => {
        await dependencies.verifyEndpoint({
          endpointUrl: input.runtime.endpoint_url,
          audienceUrl: input.runtime.endpoint_url,
        });
        return { status: 'completed' };
      },
    },
    bind_principal: {
      resourceKey: () => key('principal', JSON.stringify([input.adapterInstance, input.provisioningStartedAt])),
      probe: principalProbe,
      apply: async (value) => {
        const result = principalResult(
          value,
          await dependencies.reconcilePrincipal(
            value.input.runtime,
            {
              adapterInstance: value.input.adapterInstance,
              provisioningStartedAt: value.input.provisioningStartedAt,
              messagingGroupId: value.input.selectedMessagingGroupId,
            },
            value.input.principalDependencies,
          ),
        );
        return result.status === 'paused' ? result : { status: 'completed' };
      },
    },
    verify_conversation: {
      resourceKey: () => key('conversation', input.runtime.instance_id),
      probe: conversationProbe,
      apply: async (value) => {
        const verificationInput = conversationInput(value);
        if (!verificationInput) throw new GwsEaError('principal_not_ready', 'Principal binding is not available');
        const result = dependencies.verifyConversation(verificationInput);
        return result.ready
          ? { status: 'completed' }
          : humanPause(
              'verify_conversation',
              result.reason,
              'Wait for the delivered welcome, then ask the principal to send a later Google Chat message and resume.',
            );
      },
    },
    ready: {
      resourceKey: () => key('ready', input.runtime.instance_id),
      probe: conversationProbe,
      apply: async (value) => {
        const result = await conversationProbe(value);
        return result.status === 'matched'
          ? { status: 'completed' }
          : humanPause('ready', 'conversation_not_ready', 'Conversation evidence is not ready; resume after delivery.');
      },
    },
  });
}

function succeeded(journal: ProvisionJournal, phase: ProvisionPhase): boolean {
  return journal.phases[phase].attempts.at(-1)?.succeeded_at !== undefined;
}

function failureCode(error: unknown): string {
  return error instanceof GwsEaError ? error.code : 'phase_failed';
}

async function boundary(
  runtime: ProvisionRuntime,
  phase: ProvisionPhase,
  kind: ProvisionBoundary,
  attemptId: string,
): Promise<void> {
  await runtime.onBoundary?.({ phase, boundary: kind, attemptId });
}

async function assertCompletedPostcondition<Context>(
  phase: ProvisionPhase,
  definition: ProvisionPhaseRegistry<Context>[ProvisionPhase],
  context: Context,
): Promise<void> {
  const observation = await definition.probe(context);
  if (observation.status !== 'matched') {
    throw new GwsEaError('postcondition_drift', `Completed phase postcondition drifted: ${phase}`);
  }
}

/**
 * Reconcile every completed phase and advance the first incomplete phase via
 * durable intent -> effect -> observed postcondition -> success. The caller
 * owns the instance-operation lifetime; returning `paused` lets it release
 * the lock before waiting on a person or an inbound message.
 */
export async function reconcileProvisioning<Context>(
  operation: InstanceOperation,
  context: Context,
  definitions: ProvisionPhaseRegistry<Context>,
  runtime: ProvisionRuntime = {},
): Promise<ProvisionResult> {
  let journal = await ensureProvisionJournal(operation);

  for (const phase of PROVISION_PHASES) {
    const definition = definitions[phase];
    if (succeeded(journal, phase)) {
      await assertCompletedPostcondition(phase, definition, context);
      continue;
    }

    const resourceKey = definition.resourceKey(context);
    let begun = await beginPhase(operation, phase, resourceKey);
    let attempt = begun.attempt;
    try {
      if (begun.requires_reconciliation) {
        const reconciled = await definition.probe(context);
        if (reconciled.status === 'paused') return { status: 'paused', pause: reconciled.pause };
        journal = await observePhase(
          operation,
          phase,
          attempt.attempt_id,
          reconciled.status === 'matched' ? { matched: true, resource_key: resourceKey } : { matched: false },
        );
        await boundary(runtime, phase, 'verify', attempt.attempt_id);
        if (reconciled.status === 'matched') {
          journal = await commitPhaseSuccess(operation, phase, attempt.attempt_id);
          continue;
        }
        begun = await beginPhase(operation, phase, resourceKey);
        attempt = begun.attempt;
      }

      await boundary(runtime, phase, 'intent', attempt.attempt_id);
      const alreadySatisfied = await definition.probe(context);
      if (alreadySatisfied.status === 'paused') {
        return { status: 'paused', pause: alreadySatisfied.pause };
      }
      if (alreadySatisfied.status === 'matched') {
        journal = await observePhase(operation, phase, attempt.attempt_id, {
          matched: true,
          resource_key: resourceKey,
        });
        await boundary(runtime, phase, 'verify', attempt.attempt_id);
        journal = await commitPhaseSuccess(operation, phase, attempt.attempt_id);
        continue;
      }
      const applied = await definition.apply(context);
      if (applied.status === 'paused') return { status: 'paused', pause: applied.pause };
      await boundary(runtime, phase, 'effect', attempt.attempt_id);

      const verified = await definition.probe(context);
      if (verified.status === 'paused') return { status: 'paused', pause: verified.pause };
      journal = await observePhase(
        operation,
        phase,
        attempt.attempt_id,
        verified.status === 'matched' ? { matched: true, resource_key: resourceKey } : { matched: false },
      );
      await boundary(runtime, phase, 'verify', attempt.attempt_id);
      if (verified.status !== 'matched') {
        throw new GwsEaError('postcondition_missing', `Phase postcondition is not satisfied: ${phase}`);
      }
      journal = await commitPhaseSuccess(operation, phase, attempt.attempt_id);
    } catch (error) {
      if (!(error instanceof ProvisionBoundaryInterruption)) {
        await recordPhaseFailure(operation, phase, attempt.attempt_id, failureCode(error));
      }
      throw error;
    }
  }

  return { status: 'ready' };
}

const BOOTSTRAP_SCHEMA_VERSION = 1 as const;

export interface ProductionBootstrapManifest {
  readonly schema_version: typeof BOOTSTRAP_SCHEMA_VERSION;
  readonly onecli_cli_path: string;
  readonly node_path: string;
  readonly home_directory: string;
  readonly platform: 'macos' | 'linux';
  readonly running_as_root: boolean;
  readonly provider: {
    readonly id: string;
    readonly name: string;
    readonly type: string;
    readonly host_pattern: string;
    readonly credential_file: string;
    readonly header_name: string | null;
  };
  readonly identity: {
    readonly assistant_display_name: string;
    readonly principal_display_name: string;
    readonly principal_timezone: string;
  };
  readonly gchat: {
    readonly bot_user_id: string;
    readonly credential_file: string;
  };
  readonly selected_messaging_group_id: string | null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new GwsEaError('invalid_bootstrap_manifest', `${label} contains unknown or missing fields`);
  }
}

function bootstrapString(value: unknown, label: string, maximum = 2_048): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    [...value].some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code <= 0x1f || code === 0x7f);
    })
  ) {
    throw new GwsEaError('invalid_bootstrap_manifest', `${label} is invalid`);
  }
  return value;
}

function bootstrapPath(value: unknown, label: string): string {
  const result = bootstrapString(value, label);
  if (!path.isAbsolute(result) || path.resolve(result) !== result) {
    throw new GwsEaError('invalid_bootstrap_manifest', `${label} must be an absolute normalized path`);
  }
  return result;
}

function validateBootstrapManifest(value: unknown): ProductionBootstrapManifest {
  if (!isRecord(value)) throw new GwsEaError('invalid_bootstrap_manifest', 'Bootstrap manifest must be an object');
  exactKeys(
    value,
    [
      'schema_version',
      'onecli_cli_path',
      'node_path',
      'home_directory',
      'platform',
      'running_as_root',
      'provider',
      'identity',
      'gchat',
      'selected_messaging_group_id',
    ],
    'Bootstrap manifest',
  );
  if (value.schema_version !== BOOTSTRAP_SCHEMA_VERSION) {
    throw new GwsEaError('invalid_bootstrap_manifest', 'Bootstrap manifest schema is unsupported');
  }
  if (value.platform !== 'macos' && value.platform !== 'linux') {
    throw new GwsEaError('invalid_bootstrap_manifest', 'Bootstrap platform is invalid');
  }
  if (typeof value.running_as_root !== 'boolean') {
    throw new GwsEaError('invalid_bootstrap_manifest', 'Bootstrap running_as_root is invalid');
  }
  if (!isRecord(value.provider) || !isRecord(value.identity) || !isRecord(value.gchat)) {
    throw new GwsEaError('invalid_bootstrap_manifest', 'Bootstrap nested input is invalid');
  }
  exactKeys(value.provider, ['id', 'name', 'type', 'host_pattern', 'credential_file', 'header_name'], 'provider');
  exactKeys(value.identity, ['assistant_display_name', 'principal_display_name', 'principal_timezone'], 'identity');
  exactKeys(value.gchat, ['bot_user_id', 'credential_file'], 'gchat');
  const selected = value.selected_messaging_group_id;
  if (selected !== null && typeof selected !== 'string') {
    throw new GwsEaError('invalid_bootstrap_manifest', 'selected_messaging_group_id is invalid');
  }
  const header = value.provider.header_name;
  if (header !== null && typeof header !== 'string') {
    throw new GwsEaError('invalid_bootstrap_manifest', 'provider header_name is invalid');
  }
  return {
    schema_version: BOOTSTRAP_SCHEMA_VERSION,
    onecli_cli_path: bootstrapPath(value.onecli_cli_path, 'onecli_cli_path'),
    node_path: bootstrapPath(value.node_path, 'node_path'),
    home_directory: bootstrapPath(value.home_directory, 'home_directory'),
    platform: value.platform,
    running_as_root: value.running_as_root,
    provider: {
      id: bootstrapString(value.provider.id, 'provider id', 64),
      name: bootstrapString(value.provider.name, 'provider name', 256),
      type: bootstrapString(value.provider.type, 'provider type', 64),
      host_pattern: bootstrapString(value.provider.host_pattern, 'provider host_pattern', 512),
      credential_file: bootstrapPath(value.provider.credential_file, 'provider credential_file'),
      header_name: header === null ? null : bootstrapString(header, 'provider header_name', 128),
    },
    identity: {
      assistant_display_name: bootstrapString(value.identity.assistant_display_name, 'assistant display name', 120),
      principal_display_name: bootstrapString(value.identity.principal_display_name, 'principal display name', 120),
      principal_timezone: bootstrapString(value.identity.principal_timezone, 'principal timezone', 128),
    },
    gchat: {
      bot_user_id: bootstrapString(value.gchat.bot_user_id, 'gchat bot user ID', 256),
      credential_file: bootstrapPath(value.gchat.credential_file, 'gchat credential_file'),
    },
    selected_messaging_group_id:
      selected === null ? null : bootstrapString(selected, 'selected messaging group ID', 512),
  };
}

export async function loadProductionBootstrapManifest(file: string): Promise<ProductionBootstrapManifest> {
  let value: unknown;
  try {
    value = JSON.parse(await readOwnerOnlyFile(file)) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new GwsEaError('invalid_bootstrap_manifest', 'Bootstrap manifest is not valid JSON');
    }
    throw error;
  }
  return validateBootstrapManifest(value);
}

/** Copy validated, non-secret bootstrap metadata into instance-private state. */
export async function installProductionBootstrapManifest(
  paths: ControlPlanePaths,
  instanceId: string,
  input: ProductionBootstrapManifest,
): Promise<void> {
  assertInstanceId(instanceId);
  const manifest = validateBootstrapManifest(input);
  await preparePrivateLocalDirectory(paths.instancesRoot);
  try {
    await mkdir(paths.instanceRoot(instanceId), { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new GwsEaError('instance_state_exists', 'Instance state already exists; refusing to overwrite it');
    }
    throw error;
  }
  try {
    await writePrivateTextFile(paths.bootstrapFile(instanceId), `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    await removeProductionBootstrapManifest(paths, instanceId);
    throw error;
  }
}

/** Remove only the staged bootstrap file after an unsuccessful reservation. */
export async function removeProductionBootstrapManifest(paths: ControlPlanePaths, instanceId: string): Promise<void> {
  assertInstanceId(instanceId);
  await removePrivateFile(paths.bootstrapFile(instanceId));
  try {
    await rmdir(paths.instanceRoot(instanceId));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error;
  }
}

interface PersistedProfileIdentity {
  readonly assistant_display_name: string;
  readonly assistant_workspace_email: string;
  readonly principal_display_name: string;
  readonly principal_timezone: string;
  readonly main_agent_group_id: string;
  readonly updated_at: string;
}

function readPersistedProfile(runtime: InstanceRuntimeConfig): PersistedProfileIdentity | undefined {
  const file = path.join(runtime.checkout_realpath, 'data', 'v2.db');
  if (!existsSync(file)) return undefined;
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return database
      .prepare(
        `SELECT assistant_display_name, assistant_workspace_email,
                principal_display_name, principal_timezone, main_agent_group_id, updated_at
           FROM gws_ea_profile
          WHERE singleton = 1 AND main_agent_group_id IS NOT NULL`,
      )
      .get() as PersistedProfileIdentity | undefined;
  } finally {
    database.close();
  }
}

async function hydrateMainState(
  runtime: InstanceRuntimeConfig,
  profile: PersistedProfileIdentity | undefined,
): Promise<ProductionProvisionState> {
  if (!profile) return {};
  const agents = unwrapData(
    parseJson((await runInstanceOnecliAdminCommand(runtime, ['agents', 'list', '--max', '0'])).stdout, 'OneCLI'),
  );
  if (!Array.isArray(agents) || !agents.every(isRecord)) return {};
  const agent = agents.find((candidate) => candidate.identifier === profile.main_agent_group_id);
  const agentId = agent ? stringField(agent, 'id') : undefined;
  if (!agentId) return {};
  const secrets = unwrapData(
    parseJson((await runInstanceOnecliAdminCommand(runtime, ['agents', 'secrets', '--id', agentId])).stdout, 'OneCLI'),
  );
  if (!Array.isArray(secrets) || secrets.length !== 1 || typeof secrets[0] !== 'string') return {};
  return {
    providerSecretId: secrets[0],
    mainAgentGroupId: profile.main_agent_group_id,
  };
}

function firstProvisionIntent(journal: ProvisionJournal): string | undefined {
  const timestamps = PROVISION_PHASES.flatMap((phase) =>
    journal.phases[phase].attempts.map((attempt) => attempt.intended_at),
  ).sort();
  return timestamps[0];
}

async function ensureTrustedProvisioningStart(
  operation: InstanceOperation,
  reservation: InstanceReservation,
): Promise<string> {
  const journal = await ensureProvisionJournal(operation);
  const existing = firstProvisionIntent(journal);
  if (existing) return existing;
  const resourceKey = journalResourceKey(
    'checkout',
    JSON.stringify([reservation.source_remote, reservation.deployed_commit]),
  );
  return (await beginPhase(operation, 'materialize_checkout', resourceKey)).attempt.intended_at;
}

/** Build the real U7 context from temporary bootstrap input or authoritative instance state. */
export async function runProductionProvision(
  operation: InstanceOperation,
  selectedMessagingGroupId?: string,
): Promise<ProvisionResult> {
  const reservation = await getInstanceReservation(operation.paths, operation.instanceId);
  const provisioningStartedAt = await ensureTrustedProvisioningStart(operation, reservation);
  let manifest: ProductionBootstrapManifest | undefined;
  try {
    manifest = await loadProductionBootstrapManifest(operation.paths.bootstrapFile(operation.instanceId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const runtimeFile = path.join(reservation.checkout_realpath, 'data', 'gws-ea', 'runtime.json');
  let runtime: InstanceRuntimeConfig;
  try {
    runtime = await loadInstanceRuntimeConfig(runtimeFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !manifest) throw error;
    const onecli = createOnecliRuntimeLayout({
      instanceId: reservation.instance_id,
      instanceRoot: operation.paths.instanceRoot(reservation.instance_id),
      project: reservation.exclusive_resource_claims.onecli_project,
      appPort: reservation.allocated_ports.onecli_app,
      gatewayPort: reservation.allocated_ports.onecli_gateway,
      cliExecutable: manifest.onecli_cli_path,
    });
    runtime = createInstanceRuntimeConfig(reservation, onecli, {
      nodePath: manifest.node_path,
      homeDirectory: manifest.home_directory,
      selectedProvider: manifest.provider.id,
      gchatBotUserId: manifest.gchat.bot_user_id,
    });
  }
  const onecli = createOnecliRuntimeLayout({
    instanceId: reservation.instance_id,
    instanceRoot: operation.paths.instanceRoot(reservation.instance_id),
    project: reservation.exclusive_resource_claims.onecli_project,
    appPort: reservation.allocated_ports.onecli_app,
    gatewayPort: reservation.allocated_ports.onecli_gateway,
    cliExecutable: runtime.onecli_cli_path,
  });
  const profile = readPersistedProfile(runtime);
  if (!manifest && !profile) {
    throw new GwsEaError('bootstrap_required', 'The temporary bootstrap manifest is required until main is published');
  }
  const identity = manifest
    ? {
        assistantDisplayName: manifest.identity.assistant_display_name,
        assistantWorkspaceEmail: reservation.exclusive_resource_claims.workspace_email,
        principalDisplayName: manifest.identity.principal_display_name,
        principalTimezone: manifest.identity.principal_timezone,
      }
    : {
        assistantDisplayName: profile!.assistant_display_name,
        assistantWorkspaceEmail: profile!.assistant_workspace_email,
        principalDisplayName: profile!.principal_display_name,
        principalTimezone: profile!.principal_timezone,
      };
  let providerCredential: ProviderCredentialInput | undefined;
  if (manifest) {
    try {
      providerCredential = {
        name: manifest.provider.name,
        type: manifest.provider.type,
        value: await readOwnerOnlyFile(manifest.provider.credential_file),
        hostPattern: manifest.provider.host_pattern,
        ...(manifest.provider.header_name ? { headerName: manifest.provider.header_name } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const state = await hydrateMainState(runtime, profile);
  const context: ProductionProvisionContext = {
    operation,
    state,
    input: {
      release: {
        sourceRemote: reservation.source_remote,
        releaseRef: reservation.release_track,
        commit: reservation.deployed_commit,
      },
      releasePreflight: { checkoutRoot: reservation.checkout_realpath, provider: runtime.selected_provider },
      onecli,
      runtime,
      ...(manifest
        ? {
            providerCredentialMetadata: {
              name: manifest.provider.name,
              type: manifest.provider.type,
              hostPattern: manifest.provider.host_pattern,
              ...(manifest.provider.header_name ? { headerName: manifest.provider.header_name } : {}),
            },
          }
        : {}),
      ...(providerCredential ? { providerCredential } : {}),
      identity,
      adapterInstance: 'gchat',
      provisioningStartedAt,
      ...((selectedMessagingGroupId ?? manifest?.selected_messaging_group_id)
        ? { selectedMessagingGroupId: selectedMessagingGroupId ?? manifest!.selected_messaging_group_id! }
        : {}),
      ...(manifest ? { gchatCredentialSourceFile: manifest.gchat.credential_file } : {}),
      bootstrapManifestFile: operation.paths.bootstrapFile(operation.instanceId),
      serviceDependencies: {
        platform: manifest?.platform ?? (process.platform === 'darwin' ? 'macos' : 'linux'),
        homeDirectory: runtime.home_directory,
        runningAsRoot: manifest?.running_as_root ?? process.getuid?.() === 0,
      },
    },
  };
  return reconcileProvisioning(operation, context, createProductionProvisionRegistry(context));
}
