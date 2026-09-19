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
import { runReleasePreflight, type ReleasePreflightInput, type ReleasePreflightResult } from './release-preflight.js';
import {
  importProviderCredential,
  inspectOnecliRuntime,
  persistOnecliApiKeyFiles,
  reconcileOnecliRuntime,
  validateObservedOnecliRuntime,
  onecliSecretMatchesCredentialMetadata,
  type OnecliCompatibilityReceipt,
  type OnecliRuntimeDependencies,
} from './onecli.js';
import type { OnecliRuntimeLayout } from './onecli-compose.js';
import {
  createOnecliRuntimeLayout,
  ONECLI_CLI_VERSION,
  ONECLI_GATEWAY_VERSION,
  ONECLI_SDK_VERSION,
} from './onecli-compose.js';
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
import { loadPrincipalSelection, persistPrincipalSelection } from './principal-selection.js';
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
import { holdReservedLoopbackPorts, type AllocatedPortName, type LoopbackPortLease } from './ports.js';
import {
  GwsEaError,
  PROVISION_PHASES,
  type InstanceReservation,
  type ProvisionJournal,
  type ProvisionPhase,
} from './types.js';
import { hasControlCharacters, isRecord } from './validation.js';
import {
  credentialMatchesMetadata,
  sameCredentialMetadata,
  type ProviderCredential,
  type ProviderCredentialMetadata,
} from '../provider-credential.js';
import { assertProviderProvisioningCapabilityDigest } from '../provider-provisioning-capability.js';
import { googleChatConfigurationUrl, isChatConfigurationConfirmed } from './chat-configuration.js';
import {
  parseGchatServiceAccountCredential,
  reconcileGcpProject,
  verifyGcpProject,
  type GcpProjectInput,
} from './gcloud.js';

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

export type ProvisionPortLease = LoopbackPortLease;

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
  readonly gcp: GcpProjectInput;
  readonly providerCredentialMetadata?: ProviderCredentialMetadata;
  readonly providerCredential?: ProviderCredential;
  readonly requestProviderCredential?: () => Promise<ProviderCredential>;
  readonly identity: MainIdentityInput;
  readonly adapterInstance: string;
  readonly provisioningStartedAt: string;
  readonly selectedMessagingGroupId?: string;
  readonly selectedPrincipal?: PrincipalCandidate;
  readonly bootstrapManifestFile?: string;
  readonly serviceDependencies: InstanceServiceDependencies;
  readonly onecliDependencies?: OnecliRuntimeDependencies;
  readonly identityDependencies?: MainIdentityDependencies;
  readonly principalDependencies?: PrincipalDiscoveryDependencies;
  readonly portLease?: ProvisionPortLease;
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
  readonly probeGcp: (context: ProductionProvisionContext) => Promise<PhaseProbeResult>;
  readonly reconcileGcpProject: typeof reconcileGcpProject;
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
  readonly isChatConfigurationConfirmed: typeof isChatConfigurationConfirmed;
  readonly verifyPrincipalBinding: (input: PrincipalBindingVerificationInput) => PrincipalBindingVerificationResult;
  readonly reconcilePrincipal: typeof reconcilePrincipalDm;
  readonly verifyConversation: (input: ConversationVerificationInput) => ConversationVerificationResult;
  readonly holdReservedLoopbackPorts: typeof holdReservedLoopbackPorts;
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
    await assertReleasePreflightReceipt(context);
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

interface ReleasePreflightReceipt extends ReleasePreflightResult {
  readonly schema_version: 1;
  readonly instance_id: string;
  readonly deployed_commit: string;
}

interface ReleasePreflightExpectation {
  readonly instanceId: string;
  readonly deployedCommit: string;
  readonly provider: string;
  readonly providerCapabilityDigest?: string;
  readonly providerCredential?: ProviderCredentialMetadata;
}

function credentialMetadataRecord(value: Record<string, unknown>): ProviderCredentialMetadata {
  const required = ['name', 'type', 'hostPattern'] as const;
  const optional = ['pathPattern', 'headerName', 'valueFormat', 'paramName', 'paramFormat'] as const;
  const keys = Object.keys(value);
  if (
    required.some((key) => typeof value[key] !== 'string' || value[key].length === 0) ||
    optional.some((key) => value[key] !== undefined && typeof value[key] !== 'string') ||
    keys.some((key) => ![...required, ...optional].includes(key as (typeof required)[number]))
  ) {
    throw new GwsEaError('invalid_release_preflight', 'Release provider credential metadata is invalid');
  }
  return {
    name: value.name as string,
    type: value.type as string,
    hostPattern: value.hostPattern as string,
    ...(typeof value.pathPattern === 'string' ? { pathPattern: value.pathPattern } : {}),
    ...(typeof value.headerName === 'string' ? { headerName: value.headerName } : {}),
    ...(typeof value.valueFormat === 'string' ? { valueFormat: value.valueFormat } : {}),
    ...(typeof value.paramName === 'string' ? { paramName: value.paramName } : {}),
    ...(typeof value.paramFormat === 'string' ? { paramFormat: value.paramFormat } : {}),
  };
}

function validateReleasePreflightReceipt(
  value: unknown,
  expectation: ReleasePreflightExpectation,
): ReleasePreflightReceipt {
  if (!isRecord(value) || !isRecord(value.onecli) || !isRecord(value.providerCredential)) {
    throw new GwsEaError('invalid_release_preflight', 'Release preflight receipt is invalid');
  }
  const expectedKeys = [
    'schema_version',
    'instance_id',
    'deployed_commit',
    'provider',
    'providerCapabilityDigest',
    'providerCredential',
    'packageManager',
    'onecli',
  ].sort();
  const actualKeys = Object.keys(value).sort();
  const onecliKeys = Object.keys(value.onecli).sort();
  const providerCredential = credentialMetadataRecord(value.providerCredential);
  let providerCapabilityDigest: string;
  try {
    providerCapabilityDigest = assertProviderProvisioningCapabilityDigest(value.providerCapabilityDigest);
  } catch {
    throw new GwsEaError('invalid_release_preflight', 'Release provider capability digest is invalid');
  }
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    onecliKeys.length !== 3 ||
    onecliKeys.some((key, index) => key !== ['cli', 'gateway', 'sdk'][index]) ||
    value.schema_version !== 1 ||
    value.instance_id !== expectation.instanceId ||
    value.deployed_commit !== expectation.deployedCommit ||
    value.provider !== expectation.provider ||
    (expectation.providerCapabilityDigest !== undefined &&
      providerCapabilityDigest !== expectation.providerCapabilityDigest) ||
    typeof value.packageManager !== 'string' ||
    value.onecli.gateway !== ONECLI_GATEWAY_VERSION ||
    value.onecli.cli !== ONECLI_CLI_VERSION ||
    value.onecli.sdk !== ONECLI_SDK_VERSION ||
    (expectation.providerCredential !== undefined &&
      !sameCredentialMetadata(providerCredential, expectation.providerCredential))
  ) {
    throw new GwsEaError('release_preflight_mismatch', 'Release preflight receipt does not match this instance');
  }
  return value as unknown as ReleasePreflightReceipt;
}

async function loadReleasePreflightReceipt(
  file: string,
  expectation: ReleasePreflightExpectation,
): Promise<ReleasePreflightReceipt> {
  let value: unknown;
  try {
    value = JSON.parse(await readOwnerOnlyFile(file)) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new GwsEaError('invalid_release_preflight', 'Release preflight receipt is invalid JSON');
    }
    throw error;
  }
  return validateReleasePreflightReceipt(value, expectation);
}

async function assertReleasePreflightReceipt(context: ProductionProvisionContext): Promise<void> {
  await loadReleasePreflightReceipt(context.operation.paths.releasePreflightFile(context.operation.instanceId), {
    instanceId: context.operation.instanceId,
    deployedCommit: context.input.release.commit,
    provider: context.input.releasePreflight.provider,
    providerCapabilityDigest: context.input.releasePreflight.providerCapabilityDigest,
    providerCredential: context.input.releasePreflight.providerCredential,
  });
}

async function persistReleasePreflightReceipt(
  context: ProductionProvisionContext,
  result: ReleasePreflightResult,
): Promise<void> {
  const receipt: ReleasePreflightReceipt = {
    schema_version: 1,
    instance_id: context.operation.instanceId,
    deployed_commit: context.input.release.commit,
    ...result,
  };
  await writePrivateTextFile(
    context.operation.paths.releasePreflightFile(context.operation.instanceId),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
}

async function ensureReleaseCheckout(
  context: ProductionProvisionContext,
  dependencies: ProductionProvisionDependencies,
): Promise<void> {
  try {
    await assertReleaseCheckoutAgreement(context.operation.paths, context.operation.instanceId);
  } catch (error) {
    const code = error instanceof GwsEaError ? error.code : (error as NodeJS.ErrnoException).code;
    if (!['ENOENT', 'marker_missing', 'checkout_exists', 'unsafe_checkout'].includes(code ?? '')) throw error;
    await dependencies.materializeReleaseCheckout(
      context.operation.paths,
      context.operation.instanceId,
      context.input.release,
    );
  }
  const result = await dependencies.runReleasePreflight(context.input.releasePreflight);
  await persistReleasePreflightReceipt(context, result);
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
      if (!match) return { status: 'absent' };
      if (!credential || !onecliSecretMatchesCredentialMetadata(match, credential)) {
        throw new GwsEaError('onecli_secret_conflict', 'Provider credential metadata does not match');
      }
      return { status: 'matched' };
    }
    if (!credential) return { status: 'absent' };
    const matches = value.filter((candidate) => candidate.name === credential.name);
    if (matches.length > 1) throw new GwsEaError('ambiguous_onecli_secret', 'Provider credential is ambiguous');
    const match = matches[0];
    if (!match) return { status: 'absent' };
    if (!onecliSecretMatchesCredentialMetadata(match, credential)) {
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

type MainAccessExpectation =
  | { readonly mode: 'all' }
  | { readonly mode: 'legacy-selective'; readonly providerSecretId: string };

async function runNanoclawProbeNcl(context: ProductionProvisionContext, args: readonly string[]): Promise<unknown> {
  const run = context.input.identityDependencies?.runNcl ?? runInstanceNclJson;
  return run(context.input.runtime, args);
}

async function runNanoclawProbeOnecli(context: ProductionProvisionContext, args: readonly string[]): Promise<unknown> {
  const run = context.input.identityDependencies?.runOnecliAdmin;
  if (run) return run(context.input.runtime, args);
  const result = await runInstanceOnecliAdminCommand(context.input.runtime, args);
  return parseJson(result.stdout, 'OneCLI');
}

async function probeNanoclawAccess(
  context: ProductionProvisionContext,
  expectation: MainAccessExpectation,
): Promise<PhaseProbeResult> {
  try {
    const profileValue = unwrapData(await runNanoclawProbeNcl(context, ['gws-ea-profile', 'get']));
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
    const [groupValue, configValue] = await Promise.all([
      runNanoclawProbeNcl(context, ['groups', 'get', '--id', mainAgentGroupId]).then(unwrapData),
      runNanoclawProbeNcl(context, ['groups', 'config', 'get', '--id', mainAgentGroupId]).then(unwrapData),
    ]);
    if (
      !isRecord(groupValue) ||
      groupValue.name !== 'main' ||
      !isRecord(configValue) ||
      configValue.provider !== context.input.runtime.selected_provider
    ) {
      return { status: 'absent' };
    }
    const agents = unwrapData(await runNanoclawProbeOnecli(context, ['agents', 'list', '--max', '0']));
    if (!Array.isArray(agents) || !agents.every(isRecord)) return { status: 'absent' };
    const matching = agents.filter((agent) => agent.identifier === mainAgentGroupId);
    const agent = matching[0];
    const agentId = agent ? stringField(agent, 'id') : undefined;
    if (matching.length !== 1 || !agentId || agent!.name !== 'main') {
      return { status: 'absent' };
    }
    if (expectation.mode === 'all') {
      if (agent!.secretMode !== 'all') return { status: 'absent' };
    } else {
      if (agent!.secretMode !== 'selective') return { status: 'absent' };
      const secrets = unwrapData(await runNanoclawProbeOnecli(context, ['agents', 'secrets', '--id', agentId]));
      if (!Array.isArray(secrets) || secrets.length !== 1 || secrets[0] !== expectation.providerSecretId) {
        return { status: 'absent' };
      }
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

async function defaultProbeNanoclaw(context: ProductionProvisionContext): Promise<PhaseProbeResult> {
  return probeNanoclawAccess(context, { mode: 'all' });
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

async function ensureGchatCredential(context: ProductionProvisionContext): Promise<void> {
  const target = context.input.runtime.secret_files.gchat_credentials;
  const contents = await readOwnerOnlyFile(target);
  const reservation = await getInstanceReservation(context.operation.paths, context.operation.instanceId);
  parseGchatServiceAccountCredential(contents, {
    projectId: reservation.exclusive_resource_claims.gcp_project_id,
    serviceAccountEmail: reservation.exclusive_resource_claims.gchat_service_account,
  });
}

const defaultProductionDependencies: ProductionProvisionDependencies = {
  probeCheckout: defaultProbeCheckout,
  materializeReleaseCheckout,
  runReleasePreflight,
  probeGcp: async (context) =>
    (await verifyGcpProject(context.input.gcp)) ? { status: 'matched' } : { status: 'absent' },
  reconcileGcpProject,
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
  isChatConfigurationConfirmed,
  verifyPrincipalBinding,
  reconcilePrincipal: reconcilePrincipalDm,
  verifyConversation: verifyTalkableConversation,
  holdReservedLoopbackPorts,
};

async function withRuntimePortLease<T>(
  context: ProductionProvisionContext,
  names: readonly AllocatedPortName[],
  claim: typeof holdReservedLoopbackPorts,
  effect: (beforeBind: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const lease =
    context.input.portLease ??
    (await claim(context.operation.instanceId, context.input.runtime.allocated_ports, names));
  let releasePromise: Promise<void> | undefined;
  const releaseBeforeBind = (): Promise<void> => {
    releasePromise ??= lease.release(names);
    return releasePromise;
  };
  try {
    return await effect(releaseBeforeBind);
  } finally {
    await releaseBeforeBind().catch(() => undefined);
  }
}

function beforeOnecliBind(
  dependencies: OnecliRuntimeDependencies | undefined,
  releaseLease: () => Promise<void>,
): OnecliRuntimeDependencies {
  return {
    ...dependencies,
    beforeBind: async () => {
      await dependencies?.beforeBind?.();
      await releaseLease();
    },
  };
}

function beforeNanoclawBind(
  dependencies: InstanceServiceDependencies,
  releaseLease: () => Promise<void>,
): InstanceServiceDependencies {
  return {
    ...dependencies,
    beforeBind: async () => {
      await dependencies.beforeBind?.();
      await releaseLease();
    },
  };
}

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
          label: candidate.senderName ? `${candidate.senderName} (${candidate.userId})` : candidate.userId,
        })),
      },
    };
  }
  context.state.mainAgentGroupId = result.agentGroupId;
  context.state.principal = result.candidate;
  context.state.welcomeEventId = result.eventId;
  return { status: 'matched' };
}

function chatConfigurationPause(input: ProductionProvisionInput): Extract<PhaseProbeResult, { status: 'paused' }> {
  return {
    status: 'paused',
    pause: {
      kind: 'human-action',
      phase: 'configure_channel',
      code: 'chat_configuration_required',
      message: "Finish this assistant's Google Chat app configuration, then confirm it.",
      details: [
        `App name: ${input.identity.assistantDisplayName}`,
        'Add a public HTTPS avatar URL and a short description.',
        `Enable interactive features and 1:1 messages, then use HTTP endpoint URL ${input.runtime.endpoint_url}`,
        'Limit visibility to the intended principal or Workspace domain.',
      ],
      actionUrl: googleChatConfigurationUrl(input.gcp.projectId),
      resumeFlag: '--chat-configured',
    },
  };
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
 * Production phase composition over the validated provisioning primitives. Dependencies are
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
      'Provisioning requires the registered Google Chat instance gchat',
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
        selectedCandidate: value.state.principal ?? value.input.selectedPrincipal,
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
        await ensureReleaseCheckout(value, dependencies);
        return { status: 'completed' };
      },
    },
    provision_gcp: {
      resourceKey: () => key('gcp', input.gcp.projectId),
      probe: dependencies.probeGcp,
      apply: async (value) => {
        await dependencies.reconcileGcpProject(value.input.gcp);
        return { status: 'completed' };
      },
    },
    start_onecli: {
      resourceKey: () =>
        key('onecli', JSON.stringify([input.onecli.project, input.onecli.appPort, input.onecli.gatewayPort])),
      probe: dependencies.probeOnecli,
      apply: async (value) => {
        const receipt = await withRuntimePortLease(
          value,
          ['onecli_app', 'onecli_gateway'],
          dependencies.holdReservedLoopbackPorts,
          (releaseLease) =>
            dependencies.reconcileOnecliRuntime(
              value.input.onecli,
              beforeOnecliBind(value.input.onecliDependencies, releaseLease),
            ),
        );
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
        const credential = value.input.providerCredential ?? (await value.input.requestProviderCredential?.());
        if (!credential) {
          return humanPause(
            'configure_provider',
            'provider_credential_required',
            'Authenticate the selected provider, then resume.',
          );
        }
        const expected = value.input.providerCredentialMetadata;
        if (expected && !credentialMatchesMetadata(credential, expected)) {
          throw new GwsEaError(
            'provider_credential_mismatch',
            'The selected provider returned credential metadata that does not match its definition',
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
          credential,
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
        await ensureGchatCredential(value);
        await withRuntimePortLease(
          value,
          ['nanoclaw_webhook'],
          dependencies.holdReservedLoopbackPorts,
          (releaseLease) =>
            dependencies.reconcileInstanceRuntime(
              value.input.runtime,
              beforeNanoclawBind(value.input.serviceDependencies, releaseLease),
            ),
        );
        const main = await dependencies.reconcileMainIdentity(
          value.input.runtime,
          value.input.identity,
          value.input.identityDependencies,
        );
        value.state.mainAgentGroupId = main.agentGroupId;
        if (value.input.bootstrapManifestFile) {
          await removePrivateFile(value.input.bootstrapManifestFile);
        }
        return { status: 'completed' };
      },
      reconcileCompletedPostcondition: async (value) => {
        const providerSecretId = value.state.providerSecretId;
        const legacyState = providerSecretId
          ? await probeNanoclawAccess(value, { mode: 'legacy-selective', providerSecretId })
          : { status: 'absent' as const };
        if (legacyState.status !== 'matched' || !(await bootstrapManifestRemoved(value.input.bootstrapManifestFile))) {
          throw new GwsEaError('postcondition_drift', 'Completed phase postcondition drifted: start_nanoclaw');
        }
        const main = await dependencies.reconcileMainIdentity(
          value.input.runtime,
          value.input.identity,
          value.input.identityDependencies,
        );
        value.state.mainAgentGroupId = main.agentGroupId;
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
      probe: async (value) => {
        if (!(await dependencies.isChatConfigurationConfirmed(value.operation.paths, value.operation.instanceId))) {
          return chatConfigurationPause(input);
        }
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
      apply: async (value) => {
        if (!(await dependencies.isChatConfigurationConfirmed(value.operation.paths, value.operation.instanceId))) {
          return chatConfigurationPause(input);
        }
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
              selectedCandidate: value.input.selectedPrincipal,
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
  let observation = await definition.probe(context);
  if (observation.status === 'matched') return;
  if (observation.status === 'absent' && definition.reconcileCompletedPostcondition) {
    await definition.reconcileCompletedPostcondition(context);
    observation = await definition.probe(context);
    if (observation.status === 'matched') return;
  }
  throw new GwsEaError('postcondition_drift', `Completed phase postcondition drifted: ${phase}`);
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
  readonly provider_capability_digest: string;
  readonly provider: {
    readonly id: string;
    readonly name: string;
    readonly type: string;
    readonly host_pattern: string;
    readonly header_name: string | null;
    readonly value_format: string | null;
    readonly path_pattern: string | null;
    readonly param_name: string | null;
    readonly param_format: string | null;
  };
  readonly identity: {
    readonly assistant_display_name: string;
    readonly principal_display_name: string;
    readonly principal_timezone: string;
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
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || hasControlCharacters(value)) {
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

export function validateProductionBootstrapManifest(value: unknown): ProductionBootstrapManifest {
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
      'provider_capability_digest',
      'provider',
      'identity',
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
  if (!isRecord(value.provider) || !isRecord(value.identity)) {
    throw new GwsEaError('invalid_bootstrap_manifest', 'Bootstrap nested input is invalid');
  }
  const provider = value.provider;
  const identity = value.identity;
  exactKeys(
    provider,
    ['id', 'name', 'type', 'host_pattern', 'header_name', 'value_format', 'path_pattern', 'param_name', 'param_format'],
    'provider',
  );
  exactKeys(identity, ['assistant_display_name', 'principal_display_name', 'principal_timezone'], 'identity');
  const selected = value.selected_messaging_group_id;
  if (selected !== null && typeof selected !== 'string') {
    throw new GwsEaError('invalid_bootstrap_manifest', 'selected_messaging_group_id is invalid');
  }
  const optionalProviderString = (key: string): string | null => {
    const candidate = provider[key];
    if (candidate === null) return null;
    return bootstrapString(candidate, `provider ${key}`, 512);
  };
  return {
    schema_version: BOOTSTRAP_SCHEMA_VERSION,
    onecli_cli_path: bootstrapPath(value.onecli_cli_path, 'onecli_cli_path'),
    node_path: bootstrapPath(value.node_path, 'node_path'),
    home_directory: bootstrapPath(value.home_directory, 'home_directory'),
    platform: value.platform,
    running_as_root: value.running_as_root,
    provider_capability_digest: (() => {
      try {
        return assertProviderProvisioningCapabilityDigest(value.provider_capability_digest);
      } catch {
        throw new GwsEaError('invalid_bootstrap_manifest', 'provider_capability_digest is invalid');
      }
    })(),
    provider: {
      id: bootstrapString(provider.id, 'provider id', 64),
      name: bootstrapString(provider.name, 'provider name', 256),
      type: bootstrapString(provider.type, 'provider type', 64),
      host_pattern: bootstrapString(provider.host_pattern, 'provider host_pattern', 512),
      header_name: optionalProviderString('header_name'),
      value_format: optionalProviderString('value_format'),
      path_pattern: optionalProviderString('path_pattern'),
      param_name: optionalProviderString('param_name'),
      param_format: optionalProviderString('param_format'),
    },
    identity: {
      assistant_display_name: bootstrapString(identity.assistant_display_name, 'assistant display name', 120),
      principal_display_name: bootstrapString(identity.principal_display_name, 'principal display name', 120),
      principal_timezone: bootstrapString(identity.principal_timezone, 'principal timezone', 128),
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
  return validateProductionBootstrapManifest(value);
}

function bootstrapProviderCredential(manifest: ProductionBootstrapManifest): ProviderCredentialMetadata {
  return {
    name: manifest.provider.name,
    type: manifest.provider.type,
    hostPattern: manifest.provider.host_pattern,
    ...(manifest.provider.header_name ? { headerName: manifest.provider.header_name } : {}),
    ...(manifest.provider.value_format ? { valueFormat: manifest.provider.value_format } : {}),
    ...(manifest.provider.path_pattern ? { pathPattern: manifest.provider.path_pattern } : {}),
    ...(manifest.provider.param_name ? { paramName: manifest.provider.param_name } : {}),
    ...(manifest.provider.param_format ? { paramFormat: manifest.provider.param_format } : {}),
  };
}

/** Copy validated, non-secret bootstrap metadata into instance-private state. */
export async function installProductionBootstrapManifest(
  paths: ControlPlanePaths,
  instanceId: string,
  input: ProductionBootstrapManifest,
): Promise<void> {
  assertInstanceId(instanceId);
  const manifest = validateProductionBootstrapManifest(input);
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
  let database: Database.Database;
  try {
    database = new Database(file, { readonly: true, fileMustExist: true });
  } catch (error) {
    if (!existsSync(file)) return undefined;
    throw error;
  }
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

function hydrateMainState(profile: PersistedProfileIdentity | undefined): ProductionProvisionState {
  if (!profile) return {};
  return { mainAgentGroupId: profile.main_agent_group_id };
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

/** Build the production context from temporary bootstrap input or authoritative instance state. */
export async function runProductionProvision(
  operation: InstanceOperation,
  selectedMessagingGroupId?: string,
  portLease?: ProvisionPortLease,
  authenticateProvider?: (provider: string) => Promise<ProviderCredential>,
): Promise<ProvisionResult> {
  const reservation = await getInstanceReservation(operation.paths, operation.instanceId);
  const provisioningStartedAt = await ensureTrustedProvisioningStart(operation, reservation);
  const principalSelection = await loadPrincipalSelection(
    operation.paths,
    operation.instanceId,
    'gchat',
    provisioningStartedAt,
  );
  if (
    principalSelection &&
    selectedMessagingGroupId !== undefined &&
    principalSelection.candidate.messagingGroupId !== selectedMessagingGroupId
  ) {
    throw new GwsEaError('principal_selection_mismatch', 'The principal selection is already fixed for this instance');
  }
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
  const persistedPreflight = manifest
    ? undefined
    : await loadReleasePreflightReceipt(operation.paths.releasePreflightFile(operation.instanceId), {
        instanceId: operation.instanceId,
        deployedCommit: reservation.deployed_commit,
        provider: runtime.selected_provider,
      });
  const providerCredentialMetadata = manifest
    ? bootstrapProviderCredential(manifest)
    : persistedPreflight!.providerCredential;
  const providerCapabilityDigest = manifest
    ? manifest.provider_capability_digest
    : persistedPreflight!.providerCapabilityDigest;
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
  const state = hydrateMainState(profile);
  const context: ProductionProvisionContext = {
    operation,
    state,
    input: {
      release: {
        sourceRemote: reservation.source_remote,
        releaseRef: reservation.release_track,
        commit: reservation.deployed_commit,
      },
      releasePreflight: {
        checkoutRoot: reservation.checkout_realpath,
        provider: runtime.selected_provider,
        providerCapabilityDigest,
        providerCredential: providerCredentialMetadata,
        onecliCliPath: runtime.onecli_cli_path,
      },
      onecli,
      runtime,
      gcp: {
        instanceId: reservation.instance_id,
        projectId: reservation.exclusive_resource_claims.gcp_project_id,
        account: reservation.exclusive_resource_claims.gcp_account,
        serviceAccountEmail: reservation.exclusive_resource_claims.gchat_service_account,
        credentialFile: runtime.secret_files.gchat_credentials,
        cwd: reservation.checkout_realpath,
      },
      providerCredentialMetadata,
      ...(manifest && authenticateProvider
        ? { requestProviderCredential: () => authenticateProvider(manifest.provider.id) }
        : {}),
      identity,
      adapterInstance: 'gchat',
      provisioningStartedAt,
      ...((principalSelection?.candidate.messagingGroupId ??
      selectedMessagingGroupId ??
      manifest?.selected_messaging_group_id)
        ? {
            selectedMessagingGroupId:
              principalSelection?.candidate.messagingGroupId ??
              selectedMessagingGroupId ??
              manifest!.selected_messaging_group_id!,
          }
        : {}),
      ...(principalSelection ? { selectedPrincipal: principalSelection.candidate } : {}),
      bootstrapManifestFile: operation.paths.bootstrapFile(operation.instanceId),
      serviceDependencies: {
        platform: manifest?.platform ?? (process.platform === 'darwin' ? 'macos' : 'linux'),
        homeDirectory: runtime.home_directory,
        runningAsRoot: manifest?.running_as_root ?? process.getuid?.() === 0,
      },
      principalDependencies: {
        persistSelection: (candidate) =>
          persistPrincipalSelection(operation.paths, operation.instanceId, 'gchat', provisioningStartedAt, candidate),
      },
      ...(portLease ? { portLease } : {}),
    },
  };
  return reconcileProvisioning(operation, context, createProductionProvisionRegistry(context));
}
