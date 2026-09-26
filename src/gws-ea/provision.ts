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
  type StepResource,
} from './phases.js';
import { assertReleaseCheckoutAgreement, materializeReleaseCheckout, type ResolvedRelease } from './checkout.js';
import { runReleasePreflight, type ReleasePreflightInput, type ReleasePreflightResult } from './release-preflight.js';
import {
  findCredentialSecret,
  importProviderCredential,
  observeOnecliRuntime,
  persistOnecliApiKeyFiles,
  reconcileOnecliRuntime,
  verifyOnecliRuntime,
  onecliSecretMatchesCredentialMetadata,
  type OnecliRuntimeReceipt,
  type OnecliRuntimeDependencies,
} from './onecli.js';
import { createOnecliRuntimeLayout, type OnecliPins, type OnecliRuntimeLayout } from './onecli-compose.js';
import {
  reconcileInstanceRuntime,
  runInstanceOnecliAdminCommand,
  createInstanceRuntimeConfig,
  googleChatProjectNumberFile,
  instanceServicePid,
  loadInstanceRuntimeConfig,
  type HostStatusHelpers,
  type InstanceRuntimeConfig,
  type InstanceRuntimeDependencies,
  type UpsertEnvVars,
} from './service.js';
import { instanceServicePlatform } from './service-coordinates.js';
import { runInstanceNclJson } from './ncl.js';
import { reconcileMainIdentity, type MainIdentityDependencies, type MainIdentityInput } from './identity.js';
import {
  listPrincipalCandidates,
  reconcilePrincipalDm,
  type PrincipalCandidate,
  type PrincipalDiscoveryDependencies,
} from './principal.js';
import { verifyExistingGchatEndpoint, verifyExistingGchatRoute, validateExistingGchatEndpoint } from './endpoint.js';
import {
  instanceErrorsSince,
  verifyPrincipalBinding,
  verifyTalkableConversation,
  type ConversationVerificationInput,
  type ConversationNotReadyReason,
  type ConversationVerificationResult,
  type PrincipalBindingVerificationInput,
  type PrincipalBindingVerificationResult,
} from './verify.js';
import { readOwnerOnlyFile, readOwnerOnlyJson, removePrivateFile, writePrivateTextFile } from './secrets.js';
import { assertInstanceId, getInstanceReservation } from './registry.js';
import { isErrno } from '../community-portal/errors.js';
import { isRegularFile, preparePrivateDirectory, type ControlPlanePaths } from './paths.js';
import { findPortHolder, portInUseError } from './ports.js';
import {
  GwsEaError,
  ingressEndpointUrl,
  type IngressClaim,
  type InstanceReservation,
  type ProvisionStepId,
} from './types.js';
import {
  isRecord,
  optionalString,
  parseJson,
  requireDockerEndpoint,
  requirePath,
  requireRecord,
  requireString,
  unwrapData,
} from './validation.js';
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
  getOwnedGcpProjectNumber,
  googleCloudResources,
  parseGchatServiceAccountCredential,
  type GcpProjectInput,
} from './gcloud.js';
import type { RetainedManagedIngressSetupSession } from './cloudflare-api.js';
import { forgetAccountToken, keepAccountToken, usableKeptAccountToken } from './cloudflare-token.js';
import { managedTransportResources } from './cloudflare-ingress.js';

export interface ProductionProvisionOptions {
  /** Upstream's `.env` upsert, injected by the driver (`src/` cannot import `setup/`). */
  readonly upsertEnvVars: UpsertEnvVars;
  /** Upstream's host readiness helpers, injected by the driver. */
  readonly hostStatus: HostStatusHelpers;
  /** Human input: credentials, sign-in, and decisions supplied on re-entry. */
  readonly interaction?: Interaction;
  readonly managedIngress?: {
    readonly setupSession?: ManagedAccountTokenSession;
  };
  readonly runtime?: ProvisionRuntime;
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
  /** The journal's start: only principal messages after it count. */
  readonly provisioningStartedAt: string;
  /** The operator confirmed the Google Chat app configuration (`--chat-configured`). */
  readonly chatConfigured: boolean;
  readonly selectedMessagingGroupId?: string;
  readonly selectedPrincipal?: PrincipalCandidate;
  readonly bootstrapManifestFile?: string;
  readonly serviceDependencies: InstanceRuntimeDependencies;
  readonly onecliDependencies?: OnecliRuntimeDependencies;
  readonly identityDependencies?: MainIdentityDependencies;
  readonly principalDependencies?: PrincipalDiscoveryDependencies;
  readonly hostStatus: HostStatusHelpers;
  readonly ingress: IngressClaim;
  readonly managedIngressSetup?: ManagedAccountTokenSession;
  readonly requestCloudflareAccountToken?: (accountId: string, observation: string) => Promise<string>;
}

export interface ProductionProvisionState {
  onecliReceipt?: OnecliRuntimeReceipt;
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

type Observe = (context: ProductionProvisionContext) => Promise<Observation>;

export interface ProductionProvisionDependencies {
  readonly observeCheckout: Observe;
  readonly materializeReleaseCheckout: typeof materializeReleaseCheckout;
  readonly runReleasePreflight: typeof runReleasePreflight;
  /** `provision_gcp`'s resources. */
  readonly googleCloudResources: typeof googleCloudResources;
  readonly getOwnedGcpProjectNumber: typeof getOwnedGcpProjectNumber;
  readonly observeOnecli: Observe;
  readonly reconcileOnecliRuntime: typeof reconcileOnecliRuntime;
  readonly verifyOnecliRuntime: typeof verifyOnecliRuntime;
  readonly persistOnecliApiKeyFiles: typeof persistOnecliApiKeyFiles;
  readonly observeProvider: Observe;
  readonly importProviderCredential: typeof importProviderCredential;
  /** Main's published identity and access, observed through the running host. */
  readonly observeMainIdentity: Observe;
  readonly reconcileInstanceRuntime: typeof reconcileInstanceRuntime;
  /** Tells a host that is starting (its service runs a process) from one that is stopped. */
  readonly instanceServicePid: typeof instanceServicePid;
  /** Names the process on a port when the host does not come up. */
  readonly findPortHolder: typeof findPortHolder;
  readonly reconcileMainIdentity: typeof reconcileMainIdentity;
  readonly verifyRoute: typeof verifyExistingGchatRoute;
  readonly verifyEndpoint: typeof verifyExistingGchatEndpoint;
  readonly verifyPrincipalBinding: (input: PrincipalBindingVerificationInput) => PrincipalBindingVerificationResult;
  readonly reconcilePrincipal: typeof reconcilePrincipalDm;
  readonly verifyConversation: (input: ConversationVerificationInput) => ConversationVerificationResult;
  /** `establish_transport`'s resources in managed mode. */
  readonly managedTransportResources: typeof managedTransportResources;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

async function defaultObserveCheckout(context: ProductionProvisionContext): Promise<Observation> {
  try {
    await assertReleaseCheckoutAgreement(context.operation.paths, context.operation.instanceId);
    await instanceReleaseReceipt(context);
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

const INVALID_RECEIPT = 'invalid_release_preflight';

const OPTIONAL_CREDENTIAL_FIELDS = ['pathPattern', 'headerName', 'valueFormat', 'paramName', 'paramFormat'] as const;

function credentialMetadataRecord(value: unknown): ProviderCredentialMetadata {
  const metadata = requireRecord(value, 'Release provider credential metadata', INVALID_RECEIPT);
  const field = (key: string): string =>
    requireString(metadata[key], `Release provider credential ${key}`, INVALID_RECEIPT);
  const optional: { [Key in (typeof OPTIONAL_CREDENTIAL_FIELDS)[number]]?: string } = {};
  for (const key of OPTIONAL_CREDENTIAL_FIELDS) if (metadata[key] !== undefined) optional[key] = field(key);
  return { name: field('name'), type: field('type'), hostPattern: field('hostPattern'), ...optional };
}

/**
 * The receipt records what create's release preflight established, including
 * the OneCLI cohort the release pinned. The instance's OneCLI runtime runs
 * that cohort; resume never compares it with this launcher's pins, so a
 * launcher upgrade neither blocks nor upgrades an instance it did not create.
 */
function validateReleasePreflightReceipt(
  value: unknown,
  expectation: ReleasePreflightExpectation,
): ReleasePreflightReceipt {
  const receipt = requireRecord(value, 'Release preflight receipt', INVALID_RECEIPT);
  const onecli = requireRecord(receipt.onecli, 'Release preflight OneCLI cohort', INVALID_RECEIPT);
  let providerCapabilityDigest: string;
  try {
    providerCapabilityDigest = assertProviderProvisioningCapabilityDigest(receipt.providerCapabilityDigest);
  } catch {
    throw new GwsEaError(INVALID_RECEIPT, 'Release provider capability digest is invalid');
  }
  const validated: ReleasePreflightReceipt = {
    schema_version: 1,
    instance_id: requireString(receipt.instance_id, 'Release preflight instance_id', INVALID_RECEIPT),
    deployed_commit: requireString(receipt.deployed_commit, 'Release preflight deployed_commit', INVALID_RECEIPT),
    provider: requireString(receipt.provider, 'Release preflight provider', INVALID_RECEIPT),
    providerCapabilityDigest,
    providerCredential: credentialMetadataRecord(receipt.providerCredential),
    packageManager: requireString(receipt.packageManager, 'Release preflight packageManager', INVALID_RECEIPT),
    onecli: {
      gateway: requireString(onecli.gateway, 'Release preflight OneCLI gateway', INVALID_RECEIPT),
      cli: requireString(onecli.cli, 'Release preflight OneCLI CLI', INVALID_RECEIPT),
      sdk: requireString(onecli.sdk, 'Release preflight OneCLI SDK', INVALID_RECEIPT),
    },
  };
  if (
    receipt.schema_version !== 1 ||
    validated.instance_id !== expectation.instanceId ||
    validated.deployed_commit !== expectation.deployedCommit ||
    validated.provider !== expectation.provider ||
    (expectation.providerCapabilityDigest !== undefined &&
      providerCapabilityDigest !== expectation.providerCapabilityDigest) ||
    (expectation.providerCredential !== undefined &&
      !sameCredentialMetadata(validated.providerCredential, expectation.providerCredential))
  ) {
    throw new GwsEaError('release_preflight_mismatch', 'Release preflight receipt does not match this instance');
  }
  return validated;
}

async function loadReleasePreflightReceipt(
  file: string,
  expectation: ReleasePreflightExpectation,
): Promise<ReleasePreflightReceipt> {
  return validateReleasePreflightReceipt(
    await readOwnerOnlyJson(file, 'Release preflight receipt', INVALID_RECEIPT),
    expectation,
  );
}

/** The receipt create's release preflight wrote for this instance, checked against it. */
function instanceReleaseReceipt(context: ProductionProvisionContext): Promise<ReleasePreflightReceipt> {
  return loadReleasePreflightReceipt(context.operation.paths.releasePreflightFile(context.operation.instanceId), {
    instanceId: context.operation.instanceId,
    deployedCommit: context.input.release.commit,
    provider: context.input.releasePreflight.provider,
    providerCapabilityDigest: context.input.releasePreflight.providerCapabilityDigest,
    providerCredential: context.input.releasePreflight.providerCredential,
  });
}

/** The OneCLI versions this instance's release pinned: its runtime runs these, not the launcher's. */
async function instanceOnecliPins(context: ProductionProvisionContext): Promise<OnecliPins> {
  const { onecli } = await instanceReleaseReceipt(context);
  return { gateway: onecli.gateway, cli: onecli.cli };
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

/** The OneCLI runtime at the instance's pins, and the API key files the host and admin commands read. */
async function defaultObserveOnecli(context: ProductionProvisionContext): Promise<Observation> {
  const seen = await observeOnecliRuntime(
    context.input.onecli,
    await instanceOnecliPins(context),
    context.input.onecliDependencies,
  );
  if (seen.status !== 'present') return seen;
  const read = (file: string): Promise<string> =>
    readOwnerOnlyFile(file).then(
      (value) => value.trim(),
      (error: unknown) => {
        if (isErrno(error, 'ENOENT')) return '';
        throw error;
      },
    );
  const { onecli_runtime_api_key: runtimeFile, onecli_admin_api_key: adminFile } = context.input.runtime.secret_files;
  const [runtimeKey, adminKey] = await Promise.all([read(runtimeFile), read(adminFile)]);
  return runtimeKey && runtimeKey === adminKey
    ? PRESENT
    : { status: 'absent', reason: 'its API key files are missing' };
}

async function defaultObserveProvider(context: ProductionProvisionContext): Promise<Observation> {
  const credential = context.input.providerCredentialMetadata;
  try {
    const result = await runInstanceOnecliAdminCommand(context.input.runtime, ['secrets', 'list', '--max', '0']);
    const value = unwrapData(parseJson(result.stdout, 'OneCLI output', 'invalid_child_output'));
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
    const match = findCredentialSecret(value, credential, {
      ambiguous: 'Provider credential is ambiguous',
      conflict: 'Provider credential metadata does not match',
    });
    if (!match) return ABSENT;
    const id = optionalString(match.id);
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

/** How long a (re)started host may take to answer and connect Google Chat. */
const HOST_READY_TIMEOUT_MS = 60_000;

/** Upstream's messages name the checkout-relative error log; point at this instance's. */
function hostReason(error: unknown, runtime: InstanceRuntimeConfig): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(
    'logs/nanoclaw.error.log',
    path.join(runtime.checkout_realpath, 'logs', 'nanoclaw.error.log'),
  );
}

/**
 * The host as its own status reports it (upstream `queryHost`, which accepts
 * only a host identifying this checkout). A host that does not answer is
 * starting while its service runs a process, and stopped otherwise; one that
 * answers is present once it serves the Google Chat webhook on its allocated
 * port with the channel connected, and still starting until then.
 */
async function observeInstanceHost(
  context: ProductionProvisionContext,
  dependencies: ProductionProvisionDependencies,
): Promise<Observation> {
  const { runtime, hostStatus, serviceDependencies } = context.input;
  const errorLog = path.join(runtime.checkout_realpath, 'logs', 'nanoclaw.error.log');
  let status: unknown;
  try {
    status = await hostStatus.queryHost(runtime.checkout_realpath);
    // eslint-disable-next-line no-catch-all/no-catch-all -- Upstream queryHost reports every failure as a plain Error meaning the host is not answering; its service manager then tells starting from stopped.
  } catch (error) {
    const pid = await dependencies.instanceServicePid(runtime, serviceDependencies);
    if (pid === undefined) return { status: 'absent', reason: 'its service is not running' };
    return {
      status: 'unknown',
      reason: `The assistant is starting (pid ${pid})`,
      evidence: `${hostReason(error, runtime)}; see ${errorLog}`,
    };
  }
  const webhook = isRecord(status) ? status.webhook : undefined;
  const channels = isRecord(status) && Array.isArray(status.channels) ? status.channels : [];
  const pid = isRecord(status) ? status.pid : undefined;
  if (isRecord(webhook) && webhook.port !== runtime.allocated_ports.nanoclaw_webhook) {
    throw new GwsEaError('unsafe_runtime', 'NanoClaw is listening on an unexpected webhook port');
  }
  const starting = (reason: string): Observation => ({
    status: 'unknown',
    reason,
    evidence: `host pid ${String(pid)}; see ${errorLog}`,
  });
  if (!isRecord(webhook) || !Array.isArray(webhook.paths) || !webhook.paths.includes('/webhook/gchat')) {
    return starting('The assistant has not opened its Google Chat webhook yet');
  }
  if (!channels.some((channel) => isRecord(channel) && channel.instance === 'gchat' && channel.connected === true)) {
    return starting('Channel gchat is not connected in the running host');
  }
  return PRESENT;
}

/**
 * Start the host and wait, with upstream `waitForHost`, until it answers and
 * connects Google Chat. A host that does not become ready stops the run with
 * its reason; when a process other than the host holds the webhook port, that
 * process is named instead. The port is never bound here to test it: the
 * host's own status says whose it is.
 */
async function startInstanceHost(
  context: ProductionProvisionContext,
  dependencies: ProductionProvisionDependencies,
  emit: ProvisionRuntime['emit'],
): Promise<void> {
  const { runtime, hostStatus, serviceDependencies } = context.input;
  const { pid } = await dependencies.reconcileInstanceRuntime(runtime, serviceDependencies);
  emit?.({ type: 'step-waiting', step: 'start_nanoclaw', reason: 'Waiting for the assistant to connect Google Chat…' });
  try {
    await hostStatus.waitForHost(runtime.checkout_realpath, {
      channel: 'gchat',
      ...(pid === undefined ? {} : { pid, alive: () => processAlive(pid) }),
      timeoutMs: HOST_READY_TIMEOUT_MS,
    });
  } catch (error) {
    const port = runtime.allocated_ports.nanoclaw_webhook;
    const holder = await dependencies.findPortHolder(port);
    if (holder && holder.pid !== pid) throw portInUseError('webhook', port, holder, error);
    throw new GwsEaError('nanoclaw_not_ready', hostReason(error, runtime), { cause: error });
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrno(error, 'ESRCH')) return false;
    if (isErrno(error, 'EPERM')) return true;
    throw error;
  }
}

async function runNanoclawProbeOnecli(context: ProductionProvisionContext, args: readonly string[]): Promise<unknown> {
  const run = context.input.identityDependencies?.runOnecliAdmin;
  if (run) return run(context.input.runtime, args);
  const result = await runInstanceOnecliAdminCommand(context.input.runtime, args);
  return parseJson(result.stdout, 'OneCLI output', 'invalid_child_output');
}

/** Main exists as published, and its OneCLI agent injects every matching secret (all mode). */
async function defaultObserveMainIdentity(context: ProductionProvisionContext): Promise<Observation> {
  try {
    const profileValue = unwrapData(await runNanoclawProbeNcl(context, ['gws-ea-profile', 'get']));
    if (!isRecord(profileValue)) return ABSENT;
    const mainAgentGroupId = optionalString(profileValue.main_agent_group_id);
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
    const agentId = optionalString(agent?.id);
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
  googleCloudResources,
  getOwnedGcpProjectNumber,
  observeOnecli: defaultObserveOnecli,
  reconcileOnecliRuntime,
  verifyOnecliRuntime,
  persistOnecliApiKeyFiles,
  observeProvider: defaultObserveProvider,
  importProviderCredential,
  observeMainIdentity: defaultObserveMainIdentity,
  reconcileInstanceRuntime,
  instanceServicePid,
  findPortHolder,
  reconcileMainIdentity,
  verifyRoute: verifyExistingGchatRoute,
  verifyEndpoint: verifyExistingGchatEndpoint,
  verifyPrincipalBinding,
  reconcilePrincipal: reconcilePrincipalDm,
  verifyConversation: verifyTalkableConversation,
  managedTransportResources,
  sleep: delay,
};

function humanPause(phase: ProvisionStepId, code: string, message: string): ProvisionHumanPause {
  return { kind: 'human-action', phase, code, message };
}

/** The run's Cloudflare token session: it checks a token against the account before holding it. */
type ManagedAccountTokenSession = Pick<
  RetainedManagedIngressSetupSession,
  'discoverZones' | 'retainAccountToken' | 'requireAccountToken'
>;

function retainedAccountToken(session: ManagedAccountTokenSession | undefined, accountId: string): string | undefined {
  try {
    return session?.requireAccountToken(accountId);
  } catch (error) {
    if (!(error instanceof GwsEaError) || error.code !== 'cloudflare_token_required') throw error;
    return undefined;
  }
}

/** The kept token when it still reaches the account; one Cloudflare refuses is forgotten, so the operator is asked. */
async function restoreKeptAccountToken(
  file: string,
  session: ManagedAccountTokenSession,
  accountId: string,
): Promise<string | undefined> {
  const kept = await usableKeptAccountToken(file, accountId, (token) => session.discoverZones(token));
  if (!kept) return undefined;
  session.retainAccountToken(kept.token);
  return session.requireAccountToken(accountId);
}

/**
 * The Cloudflare account token for one managed-ingress change: the one this
 * run already holds for the account, else the one this create kept, else one
 * asked for with `reason`. Whichever is used is kept until the route is set up.
 */
async function requireManagedAccountToken(
  context: ProductionProvisionContext,
  accountId: string,
  reason: string,
): Promise<string> {
  const file = context.operation.paths.keptCloudflareTokenFile(context.operation.instanceId);
  const session = context.input.managedIngressSetup;
  const held =
    retainedAccountToken(session, accountId) ??
    (session ? await restoreKeptAccountToken(file, session, accountId) : undefined);
  if (held !== undefined) {
    await keepAccountToken(file, held);
    return held;
  }
  if (!context.input.requestCloudflareAccountToken) {
    throw new GwsEaError('cloudflare_token_required', `${reason}. A fresh Cloudflare API token is required.`);
  }
  const asked = await context.input.requestCloudflareAccountToken(accountId, reason);
  await keepAccountToken(file, asked);
  return asked;
}

/** Once the route is set up, no Cloudflare account token stays on disk. */
function keptAccountTokenForgotten(context: ProductionProvisionContext): StepResource<ProductionProvisionContext> {
  const file = context.operation.paths.keptCloudflareTokenFile(context.operation.instanceId);
  return {
    name: 'the Cloudflare token kept for setup',
    absentMeansStopped: true,
    observe: async () =>
      (await isRegularFile(file)) ? { status: 'absent', reason: 'setup no longer needs it' } : PRESENT,
    apply: async () => {
      await forgetAccountToken(file);
      return undefined;
    },
  };
}

/** Conversation states the assistant resolves by itself, waited on rather than handed to a person. */
const DELIVERY_REASONS: ReadonlySet<ConversationNotReadyReason> = new Set([
  'binding_not_ready',
  'session_not_ready',
  'welcome_not_delivered',
  'reply_not_delivered',
]);
const DELIVERY_WAIT_MS = 60_000;
const DELIVERY_POLL_MS = 2_000;

/** What a person is told when the conversation is still not ready. */
const CONVERSATION_PAUSES: Readonly<Record<ConversationNotReadyReason, string>> = {
  binding_not_ready: 'The principal conversation is not ready yet; check the errors below, then resume.',
  session_not_ready:
    "The assistant has not opened the principal's conversation yet; check the errors below, then resume.",
  welcome_not_delivered: 'The assistant has not delivered its welcome; check the errors below, then resume.',
  later_principal_message_missing: 'Send the assistant another message in Google Chat, such as a reply to its welcome.',
  reply_not_delivered: 'The assistant has not answered the principal yet; check the errors below, then resume.',
};

/**
 * A pause while the principal's conversation is awaited. It names the person
 * and shows what the host logged as errors since the step began, which is
 * usually why a message has not arrived or been answered.
 */
async function principalPause(
  context: ProductionProvisionContext,
  phase: 'bind_principal' | 'verify_conversation',
  code: string,
  message: string,
  person: string,
): Promise<ProvisionHumanPause> {
  const journal = await readProvisionJournal(context.operation.paths, context.operation.instanceId);
  const since = journal.steps[phase]?.started_at ?? new Date().toISOString();
  const errors = await instanceErrorsSince(context.input.runtime.checkout_realpath, since);
  return {
    ...humanPause(phase, code, message),
    details: [
      person,
      ...(errors.lines.length === 0
        ? [`No errors logged since ${since} in ${errors.file}`]
        : [`Errors logged since ${since} in ${errors.file}:`, ...errors.lines.map((line) => `  ${line}`)]),
    ],
  };
}

/** A pause while the principal DM is awaited or chosen; otherwise the binding joins the run state. */
async function principalResult(
  context: ProductionProvisionContext,
  result: Awaited<ReturnType<typeof reconcilePrincipalDm>>,
): Promise<ProvisionHumanPause | undefined> {
  if (result.status === 'waiting') {
    return {
      ...(await principalPause(
        context,
        'bind_principal',
        'principal_dm_required',
        'Ask the principal to send a direct message to the configured Google Chat app.',
        `Principal: ${context.input.identity.principalDisplayName} (not bound yet)`,
      )),
      settled: async () =>
        (
          await listPrincipalCandidates(
            context.input.runtime,
            {
              adapterInstance: context.input.adapterInstance,
              provisioningStartedAt: context.input.provisioningStartedAt,
            },
            context.input.principalDependencies,
          )
        ).length > 0,
    };
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
  const { ingress } = input;
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
    receipt: OnecliRuntimeReceipt,
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
  /** Until the assistant has delivered what it owes, re-check rather than hand the person a pause. */
  const awaitDelivery = async (
    value: ProductionProvisionContext,
  ): Promise<ConversationVerificationResult | undefined> => {
    let result = await verifyConversation(value);
    for (
      let waited = 0;
      result && !result.ready && DELIVERY_REASONS.has(result.reason) && waited < DELIVERY_WAIT_MS;
      waited += DELIVERY_POLL_MS
    ) {
      await dependencies.sleep(DELIVERY_POLL_MS);
      result = await verifyConversation(value);
    }
    return result;
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
      resources: dependencies.googleCloudResources({
        onWait: (reason) => runtime.emit?.({ type: 'step-waiting', step: 'provision_gcp', reason }),
      }),
    },
    start_onecli: {
      label: 'Starting the credential vault…',
      liveness: { label: 'Checking the credential vault…' },
      resources: [
        {
          name: 'the OneCLI runtime',
          absentMeansStopped: true,
          observe: dependencies.observeOnecli,
          apply: async (value) => {
            await retainOnecliReceipt(
              value,
              await dependencies.reconcileOnecliRuntime(
                value.input.onecli,
                await instanceOnecliPins(value),
                value.input.onecliDependencies,
              ),
            );
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
              (await dependencies.verifyOnecliRuntime(
                value.input.onecli,
                await instanceOnecliPins(value),
                value.input.onecliDependencies,
              ));
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
          absentMeansStopped: true,
          observe: (value) => observeInstanceHost(value, dependencies),
          apply: async (value) => {
            await ensureGchatCredential(value);
            await ensureGchatProjectNumber(value, dependencies);
            await startInstanceHost(value, dependencies, runtime.emit);
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
      ingress.mode === 'existing'
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
              ...dependencies.managedTransportResources({
                paths: context.operation.paths,
                instanceId: context.operation.instanceId,
                claim: ingress,
                platform: input.serviceDependencies.platform,
                webhookPort: input.runtime.allocated_ports.nanoclaw_webhook,
                dockerEndpoint: input.runtime.docker_endpoint,
                accountToken: (reason) => requireManagedAccountToken(context, ingress.account_id, reason),
              }),
              keptAccountTokenForgotten(context),
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
            const result = await awaitDelivery(value);
            const principal = value.state.principal;
            if (!result || !principal) {
              throw new GwsEaError('principal_not_ready', 'Principal binding is not available');
            }
            if (result.ready) return undefined;
            const pause = await principalPause(
              value,
              'verify_conversation',
              result.reason,
              CONVERSATION_PAUSES[result.reason],
              `Bound principal: ${principal.senderName ?? value.input.identity.principalDisplayName} (${principal.userId})`,
            );
            if (result.reason !== 'later_principal_message_missing') return pause;
            return {
              ...pause,
              settled: async () => {
                const now = await verifyConversation(value);
                return !now || now.ready || now.reason !== 'later_principal_message_missing';
              },
            };
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
  /** The local Docker endpoint prerequisites resolved at create. */
  readonly docker_endpoint: string;
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

const INVALID_BOOTSTRAP = 'invalid_bootstrap_manifest';

function bootstrapString(value: unknown, label: string, maximum?: number): string {
  return requireString(value, label, INVALID_BOOTSTRAP, maximum);
}

export function validateProductionBootstrapManifest(value: unknown): ProductionBootstrapManifest {
  const manifest = requireRecord(value, 'Bootstrap manifest', INVALID_BOOTSTRAP);
  if (manifest.schema_version !== BOOTSTRAP_SCHEMA_VERSION) {
    throw new GwsEaError(INVALID_BOOTSTRAP, 'Bootstrap manifest schema is unsupported');
  }
  if (manifest.platform !== 'macos' && manifest.platform !== 'linux') {
    throw new GwsEaError(INVALID_BOOTSTRAP, 'Bootstrap platform is invalid');
  }
  if (typeof manifest.running_as_root !== 'boolean') {
    throw new GwsEaError(INVALID_BOOTSTRAP, 'Bootstrap running_as_root is invalid');
  }
  const provider = requireRecord(manifest.provider, 'Bootstrap provider', INVALID_BOOTSTRAP);
  const identity = requireRecord(manifest.identity, 'Bootstrap identity', INVALID_BOOTSTRAP);
  const optionalProviderString = (key: string): string | null => {
    const candidate = provider[key];
    return candidate === null || candidate === undefined ? null : bootstrapString(candidate, `provider ${key}`, 512);
  };
  const selected = manifest.selected_messaging_group_id;
  let providerCapabilityDigest: string;
  try {
    providerCapabilityDigest = assertProviderProvisioningCapabilityDigest(manifest.provider_capability_digest);
  } catch {
    throw new GwsEaError(INVALID_BOOTSTRAP, 'provider_capability_digest is invalid');
  }
  return {
    schema_version: BOOTSTRAP_SCHEMA_VERSION,
    onecli_cli_path: requirePath(manifest.onecli_cli_path, 'onecli_cli_path', INVALID_BOOTSTRAP),
    node_path: requirePath(manifest.node_path, 'node_path', INVALID_BOOTSTRAP),
    home_directory: requirePath(manifest.home_directory, 'home_directory', INVALID_BOOTSTRAP),
    platform: manifest.platform,
    running_as_root: manifest.running_as_root,
    docker_endpoint: requireDockerEndpoint(manifest.docker_endpoint, 'docker_endpoint', INVALID_BOOTSTRAP),
    provider_capability_digest: providerCapabilityDigest,
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
      selected === null || selected === undefined
        ? null
        : bootstrapString(selected, 'selected messaging group ID', 512),
  };
}

export async function loadProductionBootstrapManifest(file: string): Promise<ProductionBootstrapManifest> {
  return validateProductionBootstrapManifest(await readOwnerOnlyJson(file, 'Bootstrap manifest', INVALID_BOOTSTRAP));
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
  await preparePrivateDirectory(paths.instancesRoot);
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

/**
 * What provisioning reads from the bootstrap manifest until main is
 * published, and from the release receipt and main's profile after.
 */
interface ProvisionSource {
  readonly providerCredentialMetadata: ProviderCredentialMetadata;
  readonly providerCapabilityDigest: string;
  readonly identity: MainIdentityInput;
  /** The messaging group create's bootstrap input selected, if any. */
  readonly bootstrapMessagingGroupId: string | null;
  /** Main's published profile, once there is one. */
  readonly profile: PersistedProfileIdentity | undefined;
}

async function resolveProvisionSource(
  operation: InstanceOperation,
  reservation: InstanceReservation,
  runtime: InstanceRuntimeConfig,
  manifest: ProductionBootstrapManifest | undefined,
): Promise<ProvisionSource> {
  if (manifest) {
    return {
      providerCredentialMetadata: bootstrapProviderCredential(manifest),
      providerCapabilityDigest: manifest.provider_capability_digest,
      profile: readPersistedProfile(runtime),
      identity: {
        assistantDisplayName: manifest.identity.assistant_display_name,
        assistantWorkspaceEmail: reservation.exclusive_resource_claims.workspace_email,
        principalDisplayName: manifest.identity.principal_display_name,
        principalTimezone: manifest.identity.principal_timezone,
      },
      bootstrapMessagingGroupId: manifest.selected_messaging_group_id,
    };
  }
  const preflight = await loadReleasePreflightReceipt(operation.paths.releasePreflightFile(operation.instanceId), {
    instanceId: operation.instanceId,
    deployedCommit: reservation.deployed_commit,
    provider: runtime.selected_provider,
  });
  const profile = readPersistedProfile(runtime);
  if (!profile) {
    throw new GwsEaError('bootstrap_required', 'The temporary bootstrap manifest is required until main is published');
  }
  return {
    providerCredentialMetadata: preflight.providerCredential,
    providerCapabilityDigest: preflight.providerCapabilityDigest,
    profile,
    identity: {
      assistantDisplayName: profile.assistant_display_name,
      assistantWorkspaceEmail: profile.assistant_workspace_email,
      principalDisplayName: profile.principal_display_name,
      principalTimezone: profile.principal_timezone,
    },
    bootstrapMessagingGroupId: null,
  };
}

interface InstanceState {
  /** The temporary bootstrap input, until main is published. */
  readonly manifest?: ProductionBootstrapManifest;
  /** The persisted runtime, once the host was first started. */
  readonly runtime?: InstanceRuntimeConfig;
}

async function readInstanceState(paths: ControlPlanePaths, reservation: InstanceReservation): Promise<InstanceState> {
  const absent = (error: unknown): undefined => {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  };
  const [manifest, runtime] = await Promise.all([
    loadProductionBootstrapManifest(paths.bootstrapFile(reservation.instance_id)).catch(absent),
    loadInstanceRuntimeConfig(path.join(reservation.checkout_realpath, 'data', 'gws-ea', 'runtime.json')).catch(absent),
  ]);
  return { ...(manifest ? { manifest } : {}), ...(runtime ? { runtime } : {}) };
}

/**
 * The host coordinates create recorded for this instance: the runtime's once
 * the host has started, the bootstrap manifest's before. Once recorded,
 * resume probes the Docker endpoint rather than re-resolving the active
 * context, and runs the OneCLI CLI this instance was created with.
 */
export async function recordedHost(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
): Promise<{ readonly dockerEndpoint?: string; readonly onecliCliPath?: string }> {
  const { manifest, runtime } = await readInstanceState(paths, reservation);
  const dockerEndpoint = runtime?.docker_endpoint ?? manifest?.docker_endpoint;
  const onecliCliPath = runtime?.onecli_cli_path ?? manifest?.onecli_cli_path;
  return { ...(dockerEndpoint ? { dockerEndpoint } : {}), ...(onecliCliPath ? { onecliCliPath } : {}) };
}

/** Build the production context from temporary bootstrap input or authoritative instance state. */
export async function runProductionProvision(
  operation: InstanceOperation,
  options: ProductionProvisionOptions,
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
  const { manifest, runtime: persistedRuntime } = await readInstanceState(operation.paths, reservation);
  const onecliLayout = (cliExecutable: string, dockerEndpoint: string): OnecliRuntimeLayout =>
    createOnecliRuntimeLayout({
      instanceId: reservation.instance_id,
      instanceRoot: operation.paths.instanceRoot(reservation.instance_id),
      project: reservation.exclusive_resource_claims.onecli_project,
      appPort: reservation.allocated_ports.onecli_app,
      gatewayPort: reservation.allocated_ports.onecli_gateway,
      cliExecutable,
      dockerEndpoint,
    });
  let runtime: InstanceRuntimeConfig;
  let onecli: OnecliRuntimeLayout;
  if (persistedRuntime) {
    runtime = persistedRuntime;
    onecli = onecliLayout(runtime.onecli_cli_path, runtime.docker_endpoint);
  } else {
    if (!manifest) throw new GwsEaError('bootstrap_required', 'The temporary bootstrap manifest is missing');
    // The runtime records this layout's CLI path and Docker endpoint verbatim, so the layout matches it too.
    onecli = onecliLayout(manifest.onecli_cli_path, manifest.docker_endpoint);
    runtime = createInstanceRuntimeConfig(reservation, onecli, {
      nodePath: manifest.node_path,
      homeDirectory: manifest.home_directory,
      selectedProvider: manifest.provider.id,
      dockerEndpoint: manifest.docker_endpoint,
    });
  }
  const source = await resolveProvisionSource(operation, reservation, runtime, manifest);
  const state = hydrateMainState(source.profile);
  // The fixed principal's conversation wins, then this run's selection, then create's.
  const messagingGroupId =
    selectedPrincipal?.messagingGroupId ?? selectedMessagingGroupId ?? source.bootstrapMessagingGroupId;
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
        providerCapabilityDigest: source.providerCapabilityDigest,
        providerCredential: source.providerCredentialMetadata,
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
      providerCredentialMetadata: source.providerCredentialMetadata,
      ...(manifest && interaction
        ? {
            requestProviderCredential: () =>
              interaction.requestProviderCredential({
                providerId: manifest.provider.id,
                metadata: source.providerCredentialMetadata,
              }),
          }
        : {}),
      identity: source.identity,
      adapterInstance: 'gchat',
      provisioningStartedAt,
      chatConfigured: journal.decisions.chat_configuration_confirmed_at !== undefined,
      ...(messagingGroupId ? { selectedMessagingGroupId: messagingGroupId } : {}),
      ...(selectedPrincipal ? { selectedPrincipal } : {}),
      bootstrapManifestFile: operation.paths.bootstrapFile(operation.instanceId),
      serviceDependencies: {
        upsertEnvVars: options.upsertEnvVars,
        platform: manifest?.platform ?? instanceServicePlatform(),
        homeDirectory: runtime.home_directory,
        runningAsRoot: manifest?.running_as_root ?? process.getuid?.() === 0,
      },
      principalDependencies: {
        persistSelection: async (candidate) => {
          await recordPrincipalSelection(operation, candidate);
          return candidate;
        },
      },
      hostStatus: options.hostStatus,
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
