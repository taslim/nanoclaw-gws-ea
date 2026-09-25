import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { mkdir, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  readProvisionJournal,
  recordChatConfigurationConfirmed,
  recordPrincipalSelection,
  type InstanceOperation,
} from './journal.js';
import {
  ABSENT,
  PRESENT,
  runProvisionSteps,
  type Observation,
  type ProvisionHumanPause,
  type ProvisionResult,
  type ProvisionRuntime,
  type ProvisionSteps,
} from './phases.js';
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
  type ObservedOnecliRuntime,
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
  googleChatProjectNumberFile,
  loadInstanceRuntimeConfig,
  type InstanceRuntimeConfig,
  type InstanceServiceDependencies,
} from './service.js';
import { runInstanceNclJson } from './ncl.js';
import { reconcileMainIdentity, type MainIdentityDependencies, type MainIdentityInput } from './identity.js';
import { reconcilePrincipalDm, type PrincipalCandidate, type PrincipalDiscoveryDependencies } from './principal.js';
import {
  verifyExistingGchatEndpoint,
  verifyExistingGchatRoute,
  verifyManagedGchatRoute,
  validateExistingGchatEndpoint,
} from './endpoint.js';
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
import { GwsEaError, ingressEndpointUrl, type IngressClaim, type ProvisionStepId } from './types.js';
import { hasControlCharacters, isRecord } from './validation.js';
import { parseGcpProjectNumber } from './gcp-identity.js';
import {
  credentialMatchesMetadata,
  sameCredentialMetadata,
  type ProviderCredential,
  type ProviderCredentialMetadata,
} from '../provider-credential.js';
import { assertProviderProvisioningCapabilityDigest } from '../provider-provisioning-capability.js';
import { googleChatConfigurationUrl } from './chat-configuration.js';
import type { Interaction } from './events.js';
import {
  parseGchatServiceAccountCredential,
  getOwnedGcpProjectNumber,
  probeGcpProjectForCreate,
  reconcileGcpProject,
  type GcloudReadbackResource,
  type GcpProjectInput,
} from './gcloud.js';
import { createCloudflareApi, type RetainedManagedIngressSetupSession } from './cloudflare-api.js';
import { reconcileManagedCloudflareIngress } from './cloudflare-ingress.js';
import {
  createCloudflareConnectorLayout,
  inspectCloudflareConnector,
  reconcileCloudflareConnector,
  validateCloudflareConnectorState,
  validateObservedCloudflareConnector,
} from './cloudflare-connector.js';

const GCP_WAIT_REASONS: Readonly<Record<GcloudReadbackResource, string>> = {
  project: 'Waiting for the Google Cloud project…',
  apis: 'Waiting for the required Google Cloud APIs…',
  'service-account': 'Waiting for the Google Chat service account…',
  'credential-policy': 'Updating the dedicated project’s Google Chat credential policy…',
  'service-account-keys': 'Waiting for Google Cloud IAM…',
  'credential-key': 'Waiting for the Google Chat credential…',
};

export interface ProductionProvisionOptions {
  readonly portLease?: ProvisionPortLease;
  /** Human input: credentials, sign-in, and decisions supplied on re-entry. */
  readonly interaction?: Interaction;
  readonly managedIngress?: {
    readonly setupSession?: Pick<RetainedManagedIngressSetupSession, 'requireAccountToken'>;
  };
  readonly runtime?: ProvisionRuntime;
}

export type ProvisionPortLease = LoopbackPortLease;

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
  /** The journal's start: only principal messages after it count. */
  readonly provisioningStartedAt: string;
  /** The operator confirmed the Google Chat app configuration (`--chat-configured`). */
  readonly chatConfigured: boolean;
  readonly selectedMessagingGroupId?: string;
  readonly selectedPrincipal?: PrincipalCandidate;
  readonly bootstrapManifestFile?: string;
  readonly serviceDependencies: InstanceServiceDependencies;
  readonly onecliDependencies?: OnecliRuntimeDependencies;
  readonly identityDependencies?: MainIdentityDependencies;
  readonly principalDependencies?: PrincipalDiscoveryDependencies;
  readonly portLease?: ProvisionPortLease;
  readonly ingress: IngressClaim;
  readonly managedIngressSetup?: Pick<RetainedManagedIngressSetupSession, 'requireAccountToken'>;
  readonly requestCloudflareAccountToken?: (accountId: string, observation: string) => Promise<string>;
}

export interface ProductionProvisionState {
  onecliReceipt?: OnecliCompatibilityReceipt;
  providerSecretId?: string;
  mainAgentGroupId?: string;
  principal?: PrincipalCandidate;
  welcomeEventId?: string;
  managedTransportObservation?: string;
}

export interface ProductionProvisionContext {
  readonly operation: InstanceOperation;
  readonly input: ProductionProvisionInput;
  readonly state: ProductionProvisionState;
}

type Observe = (context: ProductionProvisionContext) => Promise<Observation>;

export interface ProductionProvisionDependencies {
  readonly observeCheckout: Observe;
  readonly materializeReleaseCheckout: typeof materializeReleaseCheckout;
  readonly runReleasePreflight: typeof runReleasePreflight;
  readonly observeGcp: Observe;
  readonly reconcileGcpProject: typeof reconcileGcpProject;
  readonly getOwnedGcpProjectNumber: typeof getOwnedGcpProjectNumber;
  readonly observeOnecli: Observe;
  readonly reconcileOnecliRuntime: typeof reconcileOnecliRuntime;
  readonly inspectOnecliRuntime: (layout: OnecliRuntimeLayout) => Promise<ObservedOnecliRuntime>;
  readonly validateObservedOnecliRuntime: typeof validateObservedOnecliRuntime;
  readonly persistOnecliApiKeyFiles: typeof persistOnecliApiKeyFiles;
  readonly observeProvider: Observe;
  readonly importProviderCredential: typeof importProviderCredential;
  /** Main's published identity and access, observed through the running host. */
  readonly observeMainIdentity: Observe;
  readonly reconcileInstanceRuntime: typeof reconcileInstanceRuntime;
  readonly reconcileMainIdentity: typeof reconcileMainIdentity;
  readonly verifyRoute: typeof verifyExistingGchatRoute;
  readonly verifyManagedRoute: typeof verifyManagedGchatRoute;
  readonly verifyEndpoint: typeof verifyExistingGchatEndpoint;
  readonly verifyPrincipalBinding: (input: PrincipalBindingVerificationInput) => PrincipalBindingVerificationResult;
  readonly reconcilePrincipal: typeof reconcilePrincipalDm;
  readonly verifyConversation: (input: ConversationVerificationInput) => ConversationVerificationResult;
  readonly holdReservedLoopbackPorts: typeof holdReservedLoopbackPorts;
  readonly createCloudflareApi: typeof createCloudflareApi;
  readonly reconcileManagedCloudflareIngress: typeof reconcileManagedCloudflareIngress;
  readonly createCloudflareConnectorLayout: typeof createCloudflareConnectorLayout;
  readonly inspectCloudflareConnector: typeof inspectCloudflareConnector;
  readonly validateCloudflareConnectorState: typeof validateCloudflareConnectorState;
  readonly validateObservedCloudflareConnector: typeof validateObservedCloudflareConnector;
  readonly reconcileCloudflareConnector: typeof reconcileCloudflareConnector;
  readonly managedTransportDelay: (milliseconds: number) => Promise<void>;
  readonly nanoclawStartupDelay: (milliseconds: number) => Promise<void>;
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

async function defaultObserveCheckout(context: ProductionProvisionContext): Promise<Observation> {
  try {
    await assertReleaseCheckoutAgreement(context.operation.paths, context.operation.instanceId);
    await assertReleasePreflightReceipt(context);
    return PRESENT;
  } catch (error) {
    if (error instanceof GwsEaError && ['marker_missing', 'checkout_exists', 'unsafe_checkout'].includes(error.code)) {
      return ABSENT;
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return ABSENT;
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

async function defaultObserveOnecli(context: ProductionProvisionContext): Promise<Observation> {
  try {
    const observed = await inspectOnecliRuntime(context.input.onecli);
    validateObservedOnecliRuntime(context.input.onecli, observed);
    const [runtimeKey, adminKey] = await Promise.all([
      readOwnerOnlyFile(context.input.runtime.secret_files.onecli_runtime_api_key),
      readOwnerOnlyFile(context.input.runtime.secret_files.onecli_admin_api_key),
    ]);
    if (!runtimeKey.trim() || runtimeKey.trim() !== adminKey.trim()) return ABSENT;
    return PRESENT;
  } catch (error) {
    if (error instanceof GwsEaError && error.code.startsWith('unsafe_')) throw error;
    return ABSENT;
  }
}

async function defaultObserveProvider(context: ProductionProvisionContext): Promise<Observation> {
  const credential = context.input.providerCredentialMetadata;
  try {
    const result = await runInstanceOnecliAdminCommand(context.input.runtime, ['secrets', 'list', '--max', '0']);
    const value = unwrapData(parseJson(result.stdout, 'OneCLI'));
    if (!Array.isArray(value) || !value.every(isRecord)) {
      throw new GwsEaError('invalid_child_output', 'OneCLI returned an invalid secret list');
    }
    if (context.state.providerSecretId) {
      const match = value.find((candidate) => candidate.id === context.state.providerSecretId);
      if (!match) return ABSENT;
      if (!credential || !onecliSecretMatchesCredentialMetadata(match, credential)) {
        throw new GwsEaError('onecli_secret_conflict', 'Provider credential metadata does not match');
      }
      return PRESENT;
    }
    if (!credential) return ABSENT;
    const matches = value.filter((candidate) => candidate.name === credential.name);
    if (matches.length > 1) throw new GwsEaError('ambiguous_onecli_secret', 'Provider credential is ambiguous');
    const match = matches[0];
    if (!match) return ABSENT;
    if (!onecliSecretMatchesCredentialMetadata(match, credential)) {
      throw new GwsEaError('onecli_secret_conflict', 'Provider credential metadata does not match');
    }
    const id = stringField(match, 'id');
    if (!id) throw new GwsEaError('invalid_child_output', 'OneCLI provider secret has no ID');
    context.state.providerSecretId = id;
    return PRESENT;
  } catch (error) {
    if (error instanceof GwsEaError && ['command_failed', 'command_timeout'].includes(error.code)) {
      return ABSENT;
    }
    throw error;
  }
}

async function runNanoclawProbeNcl(context: ProductionProvisionContext, args: readonly string[]): Promise<unknown> {
  const run = context.input.identityDependencies?.runNcl ?? runInstanceNclJson;
  return run(context.input.runtime, args);
}

async function observeInstanceHost(context: ProductionProvisionContext): Promise<boolean> {
  let status: unknown;
  try {
    status = unwrapData(await runNanoclawProbeNcl(context, ['status']));
  } catch (error) {
    if (error instanceof GwsEaError && ['command_failed', 'command_timeout', 'ncl_failed'].includes(error.code)) {
      return false;
    }
    throw error;
  }
  if (!isRecord(status) || typeof status.project_root !== 'string') {
    throw new GwsEaError('invalid_child_output', 'NanoClaw returned invalid host status');
  }
  if (status.project_root !== context.input.runtime.checkout_realpath) {
    throw new GwsEaError('unsafe_runtime', 'NanoClaw status belongs to a different checkout');
  }
  if (status.webhook === null) return false;
  if (!isRecord(status.webhook) || !Array.isArray(status.webhook.paths) || !Array.isArray(status.channels)) {
    throw new GwsEaError('invalid_child_output', 'NanoClaw returned invalid webhook status');
  }
  if (status.webhook.port !== context.input.runtime.allocated_ports.nanoclaw_webhook) {
    throw new GwsEaError('unsafe_runtime', 'NanoClaw is listening on an unexpected webhook port');
  }
  return (
    status.webhook.paths.includes('/webhook/gchat') &&
    status.channels.some(
      (channel) =>
        isRecord(channel) && channel.instance === 'gchat' && channel.type === 'gchat' && channel.connected === true,
    )
  );
}

async function waitForInstanceHost(
  context: ProductionProvisionContext,
  sleep: (milliseconds: number) => Promise<void>,
  attempts: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await observeInstanceHost(context)) return true;
    if (attempt + 1 < attempts) await sleep(1_000);
  }
  return false;
}

async function runNanoclawProbeOnecli(context: ProductionProvisionContext, args: readonly string[]): Promise<unknown> {
  const run = context.input.identityDependencies?.runOnecliAdmin;
  if (run) return run(context.input.runtime, args);
  const result = await runInstanceOnecliAdminCommand(context.input.runtime, args);
  return parseJson(result.stdout, 'OneCLI');
}

/** Main exists as published, and its OneCLI agent injects every matching secret (all mode). */
async function defaultObserveMainIdentity(context: ProductionProvisionContext): Promise<Observation> {
  try {
    const profileValue = unwrapData(await runNanoclawProbeNcl(context, ['gws-ea-profile', 'get']));
    if (!isRecord(profileValue)) return ABSENT;
    const mainAgentGroupId = stringField(profileValue, 'main_agent_group_id');
    if (
      !mainAgentGroupId ||
      profileValue.assistant_display_name !== context.input.identity.assistantDisplayName ||
      profileValue.assistant_workspace_email !== context.input.identity.assistantWorkspaceEmail.toLowerCase() ||
      profileValue.principal_display_name !== context.input.identity.principalDisplayName ||
      profileValue.principal_timezone !== context.input.identity.principalTimezone
    ) {
      return ABSENT;
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
      return ABSENT;
    }
    const agents = unwrapData(await runNanoclawProbeOnecli(context, ['agents', 'list', '--max', '0']));
    if (!Array.isArray(agents) || !agents.every(isRecord)) return ABSENT;
    const matching = agents.filter((agent) => agent.identifier === mainAgentGroupId);
    const agent = matching[0];
    const agentId = agent ? stringField(agent, 'id') : undefined;
    if (matching.length !== 1 || !agentId || agent!.name !== 'main' || agent!.secretMode !== 'all') {
      return ABSENT;
    }
    context.state.mainAgentGroupId = mainAgentGroupId;
    return PRESENT;
  } catch (error) {
    if (error instanceof GwsEaError && ['command_failed', 'command_timeout', 'ncl_failed'].includes(error.code)) {
      return ABSENT;
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

async function ensureGchatCredential(context: ProductionProvisionContext): Promise<void> {
  const target = context.input.runtime.secret_files.gchat_credentials;
  const contents = await readOwnerOnlyFile(target);
  const reservation = await getInstanceReservation(context.operation.paths, context.operation.instanceId);
  parseGchatServiceAccountCredential(contents, {
    projectId: reservation.exclusive_resource_claims.gcp_project_id,
    serviceAccountEmail: reservation.exclusive_resource_claims.gchat_service_account,
  });
}

async function ensureGchatProjectNumber(
  context: ProductionProvisionContext,
  dependencies: ProductionProvisionDependencies,
): Promise<void> {
  const file = googleChatProjectNumberFile(context.input.runtime);
  try {
    const current = (await readOwnerOnlyFile(file)).trim();
    if (!parseGcpProjectNumber(current)) {
      throw new GwsEaError('invalid_runtime_config', 'Google Chat project number is invalid');
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const number = await dependencies.getOwnedGcpProjectNumber(context.input.gcp);
  if (!parseGcpProjectNumber(number)) {
    throw new GwsEaError('invalid_child_output', 'Google Cloud returned an invalid project number');
  }
  await writePrivateTextFile(file, `${number}\n`);
}

const defaultProductionDependencies: ProductionProvisionDependencies = {
  observeCheckout: defaultObserveCheckout,
  materializeReleaseCheckout,
  runReleasePreflight,
  observeGcp: async (context) => ((await probeGcpProjectForCreate(context.input.gcp)) ? PRESENT : ABSENT),
  reconcileGcpProject,
  getOwnedGcpProjectNumber,
  observeOnecli: defaultObserveOnecli,
  reconcileOnecliRuntime,
  inspectOnecliRuntime,
  validateObservedOnecliRuntime,
  persistOnecliApiKeyFiles,
  observeProvider: defaultObserveProvider,
  importProviderCredential,
  observeMainIdentity: defaultObserveMainIdentity,
  reconcileInstanceRuntime,
  reconcileMainIdentity,
  verifyRoute: verifyExistingGchatRoute,
  verifyManagedRoute: verifyManagedGchatRoute,
  verifyEndpoint: verifyExistingGchatEndpoint,
  verifyPrincipalBinding,
  reconcilePrincipal: reconcilePrincipalDm,
  verifyConversation: verifyTalkableConversation,
  holdReservedLoopbackPorts,
  createCloudflareApi,
  reconcileManagedCloudflareIngress,
  createCloudflareConnectorLayout,
  inspectCloudflareConnector,
  validateCloudflareConnectorState,
  validateObservedCloudflareConnector,
  reconcileCloudflareConnector,
  managedTransportDelay: delay,
  nanoclawStartupDelay: delay,
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

async function ensureInstanceHostStarted(
  context: ProductionProvisionContext,
  dependencies: ProductionProvisionDependencies,
): Promise<void> {
  if (await observeInstanceHost(context)) return;
  try {
    await withRuntimePortLease(context, ['nanoclaw_webhook'], dependencies.holdReservedLoopbackPorts, (releaseLease) =>
      dependencies.reconcileInstanceRuntime(
        context.input.runtime,
        beforeNanoclawBind(context.input.serviceDependencies, releaseLease),
      ),
    );
  } catch (error) {
    if (
      !(error instanceof GwsEaError) ||
      !['port_claim_lost', 'command_failed', 'command_timeout'].includes(error.code) ||
      !(await waitForInstanceHost(context, dependencies.nanoclawStartupDelay, 5))
    ) {
      throw error;
    }
  }
  if (!(await waitForInstanceHost(context, dependencies.nanoclawStartupDelay, 20))) {
    throw new GwsEaError('nanoclaw_not_ready', 'NanoClaw did not become ready; resume after checking its service log');
  }
}

function humanPause(phase: ProvisionStepId, code: string, message: string): ProvisionHumanPause {
  return { kind: 'human-action', phase, code, message };
}

const MANAGED_TRANSPORT_ATTEMPTS = 30;
const MANAGED_TRANSPORT_DELAY_MS = 1_000;

function managedLocalEndpoint(context: ProductionProvisionContext): string {
  return `http://127.0.0.1:${context.input.runtime.allocated_ports.nanoclaw_webhook}/webhook/gchat`;
}

const REPAIRABLE_MANAGED_TRANSPORT_CODES = new Set([
  'cloudflare_connector_missing',
  'cloudflare_connector_state_missing',
  'cloudflare_connector_state_drift',
  'unhealthy_connector',
  'endpoint_unreachable',
  'endpoint_redirect',
  'endpoint_auth_bypass',
  'managed_catch_all_unreachable',
  'managed_catch_all_mismatch',
  'managed_listener_id_missing',
  'managed_listener_mismatch',
]);

function isRepairableManagedTransportObservation(error: unknown): error is GwsEaError {
  return error instanceof GwsEaError && REPAIRABLE_MANAGED_TRANSPORT_CODES.has(error.code);
}

async function observeManagedTransport(
  context: ProductionProvisionContext,
  dependencies: ProductionProvisionDependencies,
): Promise<Observation> {
  const layout = dependencies.createCloudflareConnectorLayout({
    cloudflareRoot: context.operation.paths.cloudflareRoot,
    platform: context.input.serviceDependencies.platform,
  });
  try {
    const connector = await dependencies.inspectCloudflareConnector(layout);
    if (!connector) {
      throw new GwsEaError('cloudflare_connector_missing', 'The shared Cloudflare connector is not running');
    }
    dependencies.validateObservedCloudflareConnector(layout, connector);
    await dependencies.validateCloudflareConnectorState(layout);
    await dependencies.verifyManagedRoute({
      endpointUrl: context.input.runtime.endpoint_url,
      localEndpointUrl: managedLocalEndpoint(context),
    });
    context.state.managedTransportObservation = undefined;
    return PRESENT;
  } catch (error) {
    if (!isRepairableManagedTransportObservation(error)) throw error;
    context.state.managedTransportObservation = error.message;
    return ABSENT;
  }
}

async function requireManagedAccountToken(context: ProductionProvisionContext, accountId: string): Promise<string> {
  try {
    const retained = context.input.managedIngressSetup?.requireAccountToken(accountId);
    if (retained !== undefined) return retained;
  } catch (error) {
    if (!(error instanceof GwsEaError) || error.code !== 'cloudflare_token_required') throw error;
  }
  const observation =
    context.state.managedTransportObservation ?? 'Managed Cloudflare transport requires reconciliation';
  if (!context.input.requestCloudflareAccountToken) {
    throw new GwsEaError(
      'cloudflare_token_required',
      `${observation}. A fresh Cloudflare API token is required to repair managed ingress.`,
    );
  }
  return context.input.requestCloudflareAccountToken(accountId, observation);
}

async function waitForManagedTransport(
  context: ProductionProvisionContext,
  dependencies: ProductionProvisionDependencies,
): Promise<void> {
  for (let attempt = 0; attempt < MANAGED_TRANSPORT_ATTEMPTS; attempt += 1) {
    if ((await observeManagedTransport(context, dependencies)).status === 'present') return;
    if (attempt + 1 < MANAGED_TRANSPORT_ATTEMPTS) {
      await dependencies.managedTransportDelay(MANAGED_TRANSPORT_DELAY_MS);
    }
  }
  throw new GwsEaError(
    'managed_transport_not_ready',
    context.state.managedTransportObservation ?? 'Managed Cloudflare transport did not become ready',
  );
}

async function reconcileManagedTransport(
  context: ProductionProvisionContext,
  dependencies: ProductionProvisionDependencies,
): Promise<void> {
  const claim = context.input.ingress;
  if (claim.mode !== 'managed-cloudflare') {
    throw new GwsEaError('invalid_registry', 'Managed transport requires a managed Cloudflare claim');
  }
  const accountToken = await requireManagedAccountToken(context, claim.account_id);
  const api = dependencies.createCloudflareApi({ accountToken });
  const platform = context.input.serviceDependencies.platform;
  const reconciled = await dependencies.reconcileManagedCloudflareIngress(context.operation.paths, api, {
    originHost: platform === 'macos' ? 'host.docker.internal' : '127.0.0.1',
  });
  const connectorToken = await api.getTunnelToken(claim.account_id, reconciled.tunnelId);
  const layout = dependencies.createCloudflareConnectorLayout({
    cloudflareRoot: context.operation.paths.cloudflareRoot,
    platform,
  });
  await dependencies.reconcileCloudflareConnector(layout, connectorToken);
  await waitForManagedTransport(context, dependencies);
}

/** A pause while the principal DM is awaited or chosen; otherwise the binding joins the run state. */
function principalResult(
  context: ProductionProvisionContext,
  result: Awaited<ReturnType<typeof reconcilePrincipalDm>>,
): ProvisionHumanPause | undefined {
  if (result.status === 'waiting') {
    return humanPause(
      'bind_principal',
      'principal_dm_required',
      'Ask the principal to send a direct message to the configured Google Chat app, then resume.',
    );
  }
  if (result.status === 'selection-required') {
    return {
      ...humanPause(
        'bind_principal',
        'principal_selection_required',
        'Select the principal direct-message conversation, then resume.',
      ),
      choices: result.candidates.map((candidate) => ({
        id: candidate.messagingGroupId,
        label: candidate.senderName ? `${candidate.senderName} (${candidate.userId})` : candidate.userId,
      })),
    };
  }
  context.state.mainAgentGroupId = result.agentGroupId;
  context.state.principal = result.candidate;
  context.state.welcomeEventId = result.eventId;
  return undefined;
}

function chatConfigurationPause(input: ProductionProvisionInput): ProvisionHumanPause {
  return {
    ...humanPause(
      'configure_channel',
      'chat_configuration_required',
      "Finish this assistant's Google Chat app configuration, then confirm it.",
    ),
    details: [
      `App name: ${input.identity.assistantDisplayName}`,
      'Add a public HTTPS avatar URL and a short description.',
      'Keep “Build this Chat app as a Google Workspace add-on” enabled.',
      `Enable interactive features and 1:1 messages, then use HTTP endpoint URL ${input.runtime.endpoint_url}`,
      'Limit visibility to the intended principal or Workspace domain.',
    ],
    actionUrl: googleChatConfigurationUrl(input.gcp.projectId),
    resumeFlag: '--chat-configured',
  };
}

function bindingObservation(
  context: ProductionProvisionContext,
  result: PrincipalBindingVerificationResult,
): Observation {
  if (result.status === 'absent') return ABSENT;
  context.state.mainAgentGroupId = result.agentGroupId;
  context.state.principal = result.candidate;
  context.state.welcomeEventId = result.welcomeEventId;
  return PRESENT;
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
 * Production step composition over the validated provisioning primitives.
 * Each existing probe is one resource's observation. Dependencies are
 * injectable for boundary tests; omitted functions are the real checkout,
 * OneCLI, runtime, identity, principal, endpoint, and mailbox implementations.
 */
export function createProductionProvisionSteps(
  context: ProductionProvisionContext,
  overrides: Partial<ProductionProvisionDependencies> = {},
  runtime: ProvisionRuntime = {},
): ProvisionSteps<ProductionProvisionContext> {
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
  if (input.runtime.endpoint_url !== ingressEndpointUrl(input.ingress)) {
    throw new GwsEaError('endpoint_mismatch', 'Runtime endpoint does not match the reserved ingress claim');
  }
  if (input.adapterInstance !== 'gchat') {
    throw new GwsEaError(
      'adapter_instance_mismatch',
      'Provisioning requires the registered Google Chat instance gchat',
    );
  }

  const retainOnecliReceipt = async (
    value: ProductionProvisionContext,
    receipt: OnecliCompatibilityReceipt,
  ): Promise<void> => {
    value.state.onecliReceipt = receipt;
    await dependencies.persistOnecliApiKeyFiles(receipt, {
      runtime: value.input.runtime.secret_files.onecli_runtime_api_key,
      admin: value.input.runtime.secret_files.onecli_admin_api_key,
    });
  };
  const observeBinding = async (value: ProductionProvisionContext): Promise<Observation> =>
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
  /** The conversation check needs the binding, which an earlier run may have made. */
  const verifyConversation = async (
    value: ProductionProvisionContext,
  ): Promise<ConversationVerificationResult | undefined> => {
    if (!conversationInput(value)) await observeBinding(value);
    const verificationInput = conversationInput(value);
    return verificationInput ? dependencies.verifyConversation(verificationInput) : undefined;
  };
  /** The principal's messages reach the assistant only through its host, and the connector when managed. */
  const principalPauseNeeds = ['start_nanoclaw', 'establish_transport'] as const;

  return {
    materialize_checkout: {
      label: 'Preparing assistant files…',
      resources: [
        {
          name: 'the release checkout',
          observe: dependencies.observeCheckout,
          apply: async (value) => {
            await ensureReleaseCheckout(value, dependencies);
            return undefined;
          },
        },
      ],
    },
    provision_gcp: {
      label: 'Configuring Google Cloud…',
      resources: [
        {
          name: 'the Google Cloud project',
          observe: dependencies.observeGcp,
          apply: async (value) => {
            await dependencies.reconcileGcpProject(value.input.gcp, {
              onProgress: ({ resource }) =>
                runtime.emit?.({ type: 'step-waiting', step: 'provision_gcp', reason: GCP_WAIT_REASONS[resource] }),
            });
            return undefined;
          },
        },
      ],
    },
    start_onecli: {
      label: 'Starting the credential vault…',
      liveness: { label: 'Checking the credential vault…' },
      resources: [
        {
          name: 'the OneCLI runtime',
          observe: dependencies.observeOnecli,
          apply: async (value) => {
            let receipt: OnecliCompatibilityReceipt;
            try {
              receipt = await withRuntimePortLease(
                value,
                ['onecli_app', 'onecli_gateway'],
                dependencies.holdReservedLoopbackPorts,
                (releaseLease) =>
                  dependencies.reconcileOnecliRuntime(
                    value.input.onecli,
                    beforeOnecliBind(value.input.onecliDependencies, releaseLease),
                  ),
              );
            } catch (error) {
              if (!(error instanceof GwsEaError) || error.code !== 'port_claim_lost') throw error;
              let observed: ObservedOnecliRuntime;
              try {
                observed = await dependencies.inspectOnecliRuntime(value.input.onecli);
              } catch {
                throw error;
              }
              dependencies.validateObservedOnecliRuntime(value.input.onecli, observed);
              receipt = await dependencies.reconcileOnecliRuntime(value.input.onecli, value.input.onecliDependencies);
            }
            await retainOnecliReceipt(value, receipt);
            return undefined;
          },
        },
      ],
    },
    configure_provider: {
      label: 'Connecting the AI provider…',
      resources: [
        {
          name: 'the provider credential',
          observe: dependencies.observeProvider,
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
            await retainOnecliReceipt(value, receipt);
            const imported = await dependencies.importProviderCredential(
              receipt,
              credential,
              value.input.onecliDependencies,
            );
            value.state.providerSecretId = imported.id;
            return undefined;
          },
        },
      ],
    },
    start_nanoclaw: {
      label: 'Starting the assistant…',
      liveness: { label: 'Checking the assistant…' },
      resources: [
        {
          name: 'the NanoClaw host',
          observe: async (value) => ((await observeInstanceHost(value)) ? PRESENT : ABSENT),
          apply: async (value) => {
            await ensureGchatCredential(value);
            await ensureGchatProjectNumber(value, dependencies);
            await ensureInstanceHostStarted(value, dependencies);
            return undefined;
          },
        },
        {
          name: "main's identity",
          observe: async (value) => {
            const observed = await dependencies.observeMainIdentity(value);
            if (observed.status !== 'present') return observed;
            return (await bootstrapManifestRemoved(value.input.bootstrapManifestFile)) ? observed : ABSENT;
          },
          apply: async (value) => {
            const main = await dependencies.reconcileMainIdentity(
              value.input.runtime,
              value.input.identity,
              value.input.identityDependencies,
            );
            value.state.mainAgentGroupId = main.agentGroupId;
            if (value.input.bootstrapManifestFile) await removePrivateFile(value.input.bootstrapManifestFile);
            return undefined;
          },
        },
      ],
    },
    establish_transport:
      input.ingress.mode === 'existing'
        ? {
            label: 'Publishing the secure callback…',
            resources: [
              {
                name: 'the published callback route',
                observe: async () => {
                  try {
                    await dependencies.verifyRoute({ endpointUrl: input.runtime.endpoint_url });
                    return PRESENT;
                    /* eslint-disable-next-line no-catch-all/no-catch-all -- Any route-probe failure means the external postcondition is absent. */
                  } catch {
                    return ABSENT;
                  }
                },
                apply: async () =>
                  humanPause(
                    'establish_transport',
                    'existing_endpoint_required',
                    'Publish the claimed HTTPS /webhook/gchat route without redirects, then resume.',
                  ),
              },
            ],
          }
        : {
            label: 'Publishing the secure callback…',
            liveness: { label: 'Checking the secure callback…' },
            resources: [
              {
                name: 'the managed Cloudflare transport',
                observe: (value) => observeManagedTransport(value, dependencies),
                apply: async (value) => {
                  await reconcileManagedTransport(value, dependencies);
                  return undefined;
                },
              },
            ],
          },
    configure_channel: {
      label: 'Checking Google Chat configuration…',
      resources: [
        {
          name: 'the Google Chat app configuration',
          observe: async (value) => {
            if (!value.input.chatConfigured) return { status: 'pause', pause: chatConfigurationPause(value.input) };
            try {
              await dependencies.verifyEndpoint({
                endpointUrl: input.runtime.endpoint_url,
                audienceUrl: input.runtime.endpoint_url,
              });
              return PRESENT;
              /* eslint-disable-next-line no-catch-all/no-catch-all -- Any auth-probe failure means the external postcondition is absent. */
            } catch {
              return ABSENT;
            }
          },
          apply: async (value) => {
            if (!value.input.chatConfigured) return chatConfigurationPause(value.input);
            await dependencies.verifyEndpoint({
              endpointUrl: input.runtime.endpoint_url,
              audienceUrl: input.runtime.endpoint_url,
            });
            return undefined;
          },
        },
      ],
    },
    bind_principal: {
      label: 'Connecting the principal conversation…',
      pauseNeeds: principalPauseNeeds,
      resources: [
        {
          name: 'the principal binding',
          observe: observeBinding,
          apply: async (value) =>
            principalResult(
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
            ),
        },
      ],
    },
    verify_conversation: {
      label: 'Verifying the conversation…',
      pauseNeeds: principalPauseNeeds,
      resources: [
        {
          name: 'the talkable conversation',
          observe: async (value) => ((await verifyConversation(value))?.ready ? PRESENT : ABSENT),
          apply: async (value) => {
            const result = await verifyConversation(value);
            if (!result) throw new GwsEaError('principal_not_ready', 'Principal binding is not available');
            return result.ready
              ? undefined
              : humanPause(
                  'verify_conversation',
                  result.reason,
                  'Wait for the delivered welcome, then ask the principal to send a later Google Chat message and resume.',
                );
          },
        },
      ],
    },
  };
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
    const profileTable = database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gws_ea_profile'")
      .get();
    if (!profileTable) return undefined;
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

/** Build the production context from temporary bootstrap input or authoritative instance state. */
export async function runProductionProvision(
  operation: InstanceOperation,
  options: ProductionProvisionOptions = {},
): Promise<ProvisionResult> {
  const { interaction, managedIngress } = options;
  const provisionRuntime = options.runtime ?? {};
  const selectedMessagingGroupId = interaction?.decisions.messagingGroupId;
  const journal = interaction?.decisions.chatConfigured
    ? await recordChatConfigurationConfirmed(operation)
    : await readProvisionJournal(operation.paths, operation.instanceId);
  const provisioningStartedAt = journal.started_at;
  const selectedPrincipal = journal.decisions.principal;
  if (
    selectedPrincipal &&
    selectedMessagingGroupId !== undefined &&
    selectedPrincipal.messagingGroupId !== selectedMessagingGroupId
  ) {
    throw new GwsEaError('principal_selection_mismatch', 'The principal selection is already fixed for this instance');
  }
  const reservation = await getInstanceReservation(operation.paths, operation.instanceId);
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
      ...(manifest && interaction
        ? {
            requestProviderCredential: () =>
              interaction.requestProviderCredential({
                providerId: manifest.provider.id,
                metadata: providerCredentialMetadata,
              }),
          }
        : {}),
      identity,
      adapterInstance: 'gchat',
      provisioningStartedAt,
      chatConfigured: journal.decisions.chat_configuration_confirmed_at !== undefined,
      ...((selectedPrincipal?.messagingGroupId ?? selectedMessagingGroupId ?? manifest?.selected_messaging_group_id)
        ? {
            selectedMessagingGroupId:
              selectedPrincipal?.messagingGroupId ?? selectedMessagingGroupId ?? manifest!.selected_messaging_group_id!,
          }
        : {}),
      ...(selectedPrincipal ? { selectedPrincipal } : {}),
      bootstrapManifestFile: operation.paths.bootstrapFile(operation.instanceId),
      serviceDependencies: {
        platform: manifest?.platform ?? (process.platform === 'darwin' ? 'macos' : 'linux'),
        homeDirectory: runtime.home_directory,
        runningAsRoot: manifest?.running_as_root ?? process.getuid?.() === 0,
      },
      principalDependencies: {
        persistSelection: async (candidate) => {
          await recordPrincipalSelection(operation, candidate);
          return candidate;
        },
      },
      ...(options.portLease ? { portLease: options.portLease } : {}),
      ingress: reservation.exclusive_resource_claims.ingress,
      ...(managedIngress?.setupSession ? { managedIngressSetup: managedIngress.setupSession } : {}),
      ...(interaction
        ? {
            requestCloudflareAccountToken: (accountId: string, reason: string) =>
              interaction.requestCloudflareAccountToken({ accountId, reason }),
          }
        : {}),
    },
  };
  const gcpAccount = reservation.exclusive_resource_claims.gcp_account;
  return runProvisionSteps(operation, context, createProductionProvisionSteps(context, {}, provisionRuntime), {
    ...provisionRuntime,
    ...(interaction ? { signIn: () => interaction.signInToGoogleCloud(gcpAccount) } : {}),
  });
}
