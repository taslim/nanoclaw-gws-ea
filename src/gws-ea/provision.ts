import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { mkdir, rmdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import {
  readProvisionJournal,
  recordChatConfigurationConfirmed,
  recordPrincipalChatAddress,
  type InstanceOperation,
  type ProvisionJournal,
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
import { assertReleaseCheckoutAgreement, type ResolvedRelease } from './checkout.js';
import { loadReleasePreflightReceipt, type ReleasePreflightReceipt } from './kept-release.js';
import type { DeployedSetup, ReleasePreflightInput } from './release-preflight.js';
import { applyReleaseEnvironment, stageRelease } from './release-stage.js';
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
import {
  createOnecliRuntimeLayout,
  parseOnecliComposeImages,
  type OnecliPins,
  type OnecliRuntimeLayout,
} from './onecli-compose.js';
import {
  reconcileInstanceRuntime,
  instanceOnecliAdmin,
  createInstanceRuntimeConfig,
  hostLogFiles,
  instanceServicePid,
  loadInstanceRuntimeConfig,
  type HostStatusHelpers,
  type InstanceRuntimeConfig,
  type InstanceRuntimeDependencies,
  type UpsertEnvVars,
} from './service.js';
import { createServiceControl, runtimeServiceTarget, type NanoclawServiceHelpers } from './service-control.js';
import { instanceServicePlatform } from './service-coordinates.js';
import { runInstanceNclJson } from './ncl.js';
import { reconcileMainIdentity, type MainIdentityDependencies, type MainIdentityInput } from './identity.js';
import type { OnecliAgent } from './onecli-admin.js';
import {
  bindPrincipal,
  type PrincipalBinding,
  type PrincipalBindingDependencies,
  type PrincipalBindingResult,
} from './principal.js';
import {
  centralDatabaseFile,
  instanceErrorsSince,
  openWithoutSideFiles,
  verifyPrincipalBinding,
  verifyTalkableConversation,
  type ConversationVerificationInput,
  type ConversationNotReadyReason,
  type ConversationVerificationResult,
  type PrincipalBindingVerificationInput,
  type PrincipalBindingVerificationResult,
} from './verify.js';
import { readOwnerOnlyFile, readOwnerOnlyJson, removePrivateFile, writePrivateTextFile } from './secrets.js';
import { assertInstanceId, getInstanceReservation, writeInstanceMarker } from './registry.js';
import { isErrno } from '../community-portal/errors.js';
import { preparePrivateDirectory, type ControlPlanePaths } from './paths.js';
import { createState, pointCurrent, readCurrent, releaseName } from './release-layout.js';
import { pollUntil } from './poll.js';
import { GwsEaError, type InstanceReservation, type ProvisionStepId } from './types.js';
import {
  isRecord,
  normalizePrincipalEmail,
  optionalString,
  requireDockerEndpoint,
  requirePath,
  requireRecord,
  requireString,
  unwrapData,
} from './validation.js';
import {
  credentialMatchesMetadata,
  type ProviderCredential,
  type ProviderCredentialMetadata,
} from '../provider-credential.js';
import { googleChatConfigurationUrl } from './chat-configuration.js';
import { googleSignInPause, type Interaction } from './events.js';
import {
  GOOGLE_CLIENT_FILE_FLAG,
  googleAccessResources,
  googleClientNeeded,
  googleClientSteps,
  googleSignInResources,
  type GoogleConnectionInput,
} from './google-connection.js';
import { googleCloudResources, parseGchatServiceAccountCredential, type GcpProjectInput } from './gcloud.js';

export interface ProductionProvisionOptions {
  /** Upstream's `.env` upsert, injected by the driver (`src/` cannot import `setup/`). */
  readonly upsertEnvVars: UpsertEnvVars;
  /** Upstream's host readiness helpers, injected by the driver. */
  readonly hostStatus: HostStatusHelpers;
  /** NanoClaw's service helpers, injected by the driver: the host starts as `gws-ea start` starts it. */
  readonly serviceHelpers: NanoclawServiceHelpers;
  /** Human input: credentials, sign-in, and decisions supplied on re-entry. */
  readonly interaction?: Interaction;
  readonly runtime?: ProvisionRuntime;
}

export interface ProductionProvisionInput {
  readonly release: ResolvedRelease;
  /** The provider setup the release's receipt records. */
  readonly releasePreflight: Pick<ReleasePreflightInput, 'provider' | 'providerCredential'>;
  readonly onecli: OnecliRuntimeLayout;
  readonly runtime: InstanceRuntimeConfig;
  readonly gcp: GcpProjectInput;
  readonly providerCredentialMetadata?: ProviderCredentialMetadata;
  readonly requestProviderCredential?: () => Promise<ProviderCredential>;
  readonly identity: MainIdentityInput;
  /** The principal's name in the operator's messages: the published profile's, or create's before. */
  readonly principalDisplayName: string;
  /** The address the principal uses for Google Chat, as create named it: the assistant opens its DM there (KTD11). */
  readonly principalChatEmail: string;
  readonly adapterInstance: string;
  /** The journal's start: only a principal bound after it counts. */
  readonly provisioningStartedAt: string;
  /** The operator confirmed the Google Chat API configuration (`--chat-configured`). */
  readonly chatConfigured: boolean;
  readonly bootstrapManifestFile?: string;
  readonly serviceDependencies: InstanceRuntimeDependencies;
  readonly onecliDependencies?: OnecliRuntimeDependencies;
  readonly identityDependencies?: MainIdentityDependencies;
  readonly principalDependencies?: PrincipalBindingDependencies;
  readonly hostStatus: HostStatusHelpers;
  /** The assistant's Google sign-in (`sign_in_google`), and agents' access to it (`connect_google`; KTD2, KTD5). */
  readonly google: GoogleConnectionInput;
}

export interface ProductionProvisionState {
  onecliReceipt?: OnecliRuntimeReceipt;
  providerSecretId?: string;
  mainAgentGroupId?: string;
  principal?: PrincipalBinding;
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
  readonly stageRelease: typeof stageRelease;
  /** `provision_gcp`'s resources. */
  readonly googleCloudResources: typeof googleCloudResources;
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
  readonly reconcileMainIdentity: typeof reconcileMainIdentity;
  readonly verifyPrincipalBinding: (input: PrincipalBindingVerificationInput) => PrincipalBindingVerificationResult;
  readonly bindPrincipal: typeof bindPrincipal;
  readonly verifyConversation: (input: ConversationVerificationInput) => ConversationVerificationResult;
  /** `sign_in_google`'s resources. */
  readonly googleSignInResources: typeof googleSignInResources;
  /** `connect_google`'s resources. */
  readonly googleAccessResources: typeof googleAccessResources;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

/**
 * The release step's postcondition: the assistant's `state/` carries its
 * marker, and the live link names the reservation's release, complete, at its
 * commit with a clean tree, whose receipt is this instance's.
 */
async function defaultObserveCheckout(context: ProductionProvisionContext): Promise<Observation> {
  const { paths, instanceId } = context.operation;
  try {
    if ((await readCurrent(paths.instanceLayout(instanceId))) !== releaseName(context.input.release.commit)) {
      return ABSENT;
    }
    await assertReleaseCheckoutAgreement(paths, instanceId);
    await instanceReleaseReceipt(context);
    return PRESENT;
  } catch (error) {
    if (error instanceof GwsEaError && ['marker_missing', 'unsafe_checkout'].includes(error.code)) return ABSENT;
    if (isErrno(error, 'ENOENT')) return ABSENT;
    throw error;
  }
}

/** The receipt create's staging kept with this instance's release, checked against it. */
function instanceReleaseReceipt(context: ProductionProvisionContext): Promise<ReleasePreflightReceipt> {
  const { paths, instanceId } = context.operation;
  return loadReleasePreflightReceipt(paths.releasePreflightFile(instanceId, context.input.release.commit), {
    instanceId: context.operation.instanceId,
    deployedCommits: [context.input.release.commit],
    provider: context.input.releasePreflight.provider,
    providerCredential: context.input.releasePreflight.providerCredential,
  });
}

/** The OneCLI version this instance's release pinned: its runtime runs it, not the launcher's. */
async function instanceOnecliPins(context: ProductionProvisionContext): Promise<OnecliPins> {
  const { onecli } = await instanceReleaseReceipt(context);
  return { gateway: onecli.gateway };
}

/**
 * Create's first release (KTD1): the assistant's `state/`, its marker first so
 * a `state/` there always names its assistant, then the reservation's release
 * staged as every release is (`stageRelease`), and the live link pointed at
 * it. Of the files kept with the release, create applies only gws-ea's `.env`
 * keys here: its OneCLI step renders and starts the Compose file and its
 * service step installs the service definition, each as the release kept it,
 * and installing the definition before the host can start would have launchd
 * start it at the next login. Run again, it finishes what a run cut short
 * began, restaging a release left incomplete.
 */
async function ensureRelease(
  context: ProductionProvisionContext,
  dependencies: ProductionProvisionDependencies,
): Promise<void> {
  const { paths, instanceId } = context.operation;
  const { runtime, onecli, release, releasePreflight, serviceDependencies } = context.input;
  const layout = paths.instanceLayout(instanceId);
  const name = releaseName(release.commit);
  await writeInstanceMarker(paths, instanceId);
  await createState(layout);
  await dependencies.stageRelease({
    paths,
    view: await getInstanceReservation(paths, instanceId),
    runtime,
    onecli,
    service: serviceDependencies,
    provider: releasePreflight,
  });
  await applyReleaseEnvironment(runtime, name, serviceDependencies.upsertEnvVars);
  await pointCurrent(layout, name);
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
    const secrets = await (await instanceOnecliAdmin(context.input.runtime)).listSecrets();
    if (context.state.providerSecretId) {
      const match = secrets.find((candidate) => candidate.id === context.state.providerSecretId);
      if (!match) return ABSENT;
      if (!credential || !onecliSecretMatchesCredentialMetadata(match, credential)) {
        throw new GwsEaError('onecli_secret_conflict', 'Provider credential metadata does not match');
      }
      return PRESENT;
    }
    if (!credential) return ABSENT;
    const match = findCredentialSecret(secrets, credential, {
      ambiguous: 'Provider credential is ambiguous',
      conflict: 'Provider credential metadata does not match',
    });
    if (!match) return ABSENT;
    const id = optionalString(match.id);
    if (!id) throw new GwsEaError('invalid_child_output', 'OneCLI provider secret has no ID');
    context.state.providerSecretId = id;
    return PRESENT;
  } catch (error) {
    if (error instanceof GwsEaError && error.code === 'onecli_request_failed') return ABSENT;
    throw error;
  }
}

async function runNanoclawProbeNcl(context: ProductionProvisionContext, args: readonly string[]): Promise<unknown> {
  const run = context.input.identityDependencies?.runNcl ?? runInstanceNclJson;
  return run(context.input.runtime, args);
}

/** How long a (re)started host may take to answer and connect Google Chat. */
const HOST_READY_TIMEOUT_MS = 60_000;

/** Upstream's messages name the checkout-relative error log; point at this instance's physical one. */
function hostReason(error: unknown, runtime: InstanceRuntimeConfig): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll('logs/nanoclaw.error.log', hostLogFiles(runtime.instance_root).errors);
}

/**
 * The host as its own status reports it (upstream `queryHost`, which accepts
 * only a host identifying this checkout). A host that does not answer is
 * starting while its service runs a process, and stopped otherwise; one that
 * answers is present once its Google Chat channel is connected, and still
 * starting until then. Chat's events are pulled, so no Chat route is served.
 */
async function observeInstanceHost(
  context: ProductionProvisionContext,
  dependencies: ProductionProvisionDependencies,
): Promise<Observation> {
  const { runtime, hostStatus, serviceDependencies } = context.input;
  const errorLog = hostLogFiles(runtime.instance_root).errors;
  let status: unknown;
  try {
    status = await hostStatus.queryHost(runtime.checkout_root);
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
  const channels = isRecord(status) && Array.isArray(status.channels) ? status.channels : [];
  const pid = isRecord(status) ? status.pid : undefined;
  const starting = (reason: string): Observation => ({
    status: 'unknown',
    reason,
    evidence: `host pid ${String(pid)}; see ${errorLog}`,
  });
  if (!channels.some((channel) => isRecord(channel) && channel.instance === 'gchat' && channel.connected === true)) {
    return starting('Channel gchat is not connected in the running host');
  }
  return PRESENT;
}

/**
 * Start the host and wait, with upstream `waitForHost`, until it answers and
 * connects Google Chat. A host that does not become ready stops the run with
 * its reason.
 */
async function startInstanceHost(
  context: ProductionProvisionContext,
  dependencies: ProductionProvisionDependencies,
  emit: ProvisionRuntime['emit'],
): Promise<void> {
  const { runtime, hostStatus, serviceDependencies, release } = context.input;
  const { pid } = await dependencies.reconcileInstanceRuntime(runtime, release.commit, serviceDependencies);
  emit?.({ type: 'step-waiting', step: 'start_nanoclaw', reason: 'Waiting for the assistant to connect Google Chat…' });
  try {
    await hostStatus.waitForHost(runtime.checkout_root, {
      channel: 'gchat',
      ...(pid === undefined ? {} : { pid, alive: () => processAlive(pid) }),
      timeoutMs: HOST_READY_TIMEOUT_MS,
    });
  } catch (error) {
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

async function listOnecliAgents(context: ProductionProvisionContext): Promise<readonly OnecliAgent[]> {
  const admin = context.input.identityDependencies?.onecliAdmin ?? instanceOnecliAdmin;
  return (await admin(context.input.runtime)).listAgents();
}

/**
 * Main exists as published, runs in the principal's timezone as the profile
 * holds it, and its OneCLI agent injects every matching secret (all mode).
 * The principal's name and timezone are theirs to change through main, so
 * only the profile's own values count (KTD9).
 */
async function defaultObserveMainIdentity(context: ProductionProvisionContext): Promise<Observation> {
  try {
    const profileValue = unwrapData(await runNanoclawProbeNcl(context, ['gws-ea-profile', 'get']));
    if (!isRecord(profileValue)) return ABSENT;
    const mainAgentGroupId = optionalString(profileValue.main_agent_group_id);
    if (
      !mainAgentGroupId ||
      profileValue.assistant_display_name !== context.input.identity.assistantDisplayName ||
      profileValue.assistant_workspace_email !== context.input.identity.assistantWorkspaceEmail.toLowerCase()
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
      configValue.provider !== context.input.runtime.selected_provider ||
      !optionalString(profileValue.principal_timezone) ||
      configValue.timezone !== profileValue.principal_timezone
    ) {
      return ABSENT;
    }
    const matching = (await listOnecliAgents(context)).filter((agent) => agent.identifier === mainAgentGroupId);
    const agent = matching[0];
    if (matching.length !== 1 || agent?.name !== 'main' || agent.secretMode !== 'all') return ABSENT;
    context.state.mainAgentGroupId = mainAgentGroupId;
    return PRESENT;
  } catch (error) {
    if (
      error instanceof GwsEaError &&
      ['command_failed', 'command_timeout', 'ncl_failed', 'onecli_request_failed'].includes(error.code)
    ) {
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

/** The subscriber key the host pulls Chat's events with is this assistant's own, before the host starts. */
async function ensureGchatCredential(context: ProductionProvisionContext): Promise<void> {
  const target = context.input.runtime.secret_files.gchat_subscriber_key;
  const contents = await readOwnerOnlyFile(target);
  const reservation = await getInstanceReservation(context.operation.paths, context.operation.instanceId);
  parseGchatServiceAccountCredential(contents, {
    projectId: reservation.exclusive_resource_claims.gcp_project_id,
    serviceAccountEmail: reservation.exclusive_resource_claims.gchat_subscriber_account,
  });
}

const defaultProductionDependencies: ProductionProvisionDependencies = {
  observeCheckout: defaultObserveCheckout,
  stageRelease,
  googleCloudResources,
  observeOnecli: defaultObserveOnecli,
  reconcileOnecliRuntime,
  verifyOnecliRuntime,
  persistOnecliApiKeyFiles,
  observeProvider: defaultObserveProvider,
  importProviderCredential,
  observeMainIdentity: defaultObserveMainIdentity,
  reconcileInstanceRuntime,
  instanceServicePid,
  reconcileMainIdentity,
  verifyPrincipalBinding,
  bindPrincipal,
  verifyConversation: verifyTalkableConversation,
  googleSignInResources,
  googleAccessResources,
  sleep: delay,
};

function humanPause(phase: ProvisionStepId, code: string, message: string): ProvisionHumanPause {
  return { kind: 'human-action', phase, code, message };
}

/**
 * Conversation states the assistant resolves by itself before anyone else
 * is involved, waited on briefly rather than handed to a person.
 */
const DELIVERY_REASONS: ReadonlySet<ConversationNotReadyReason> = new Set([
  'binding_not_ready',
  'session_not_ready',
  'welcome_not_delivered',
]);
const DELIVERY_WAIT_MS = 60_000;
const DELIVERY_POLL_MS = 2_000;

/**
 * The exchange after the welcome: the principal's reply, then the
 * assistant's answer, which can take minutes of work. One watched pause
 * covers both, so the run finishes once the answer is there.
 */
const EXCHANGE_REASONS: ReadonlySet<ConversationNotReadyReason> = new Set([
  'later_principal_message_missing',
  'reply_not_delivered',
]);

/** What a person is told when the conversation is still not ready. */
const CONVERSATION_PAUSES: Readonly<Record<ConversationNotReadyReason, string>> = {
  binding_not_ready: 'The principal conversation is not ready yet; check the errors below, then resume.',
  session_not_ready:
    "The assistant has not opened the principal's conversation yet; check the errors below, then resume.",
  welcome_not_delivered: 'The assistant has not delivered its welcome; check the errors below, then resume.',
  // A watch that stops reports this pause as it was given, so it stays true once the principal has replied.
  later_principal_message_missing:
    "Ask the principal to reply to the assistant's welcome in Google Chat, if they have not yet; setup finishes " +
    "once the assistant answers them. If they are outside the assistant's Google Workspace organization, the " +
    'welcome reaches them as a message request to accept first.',
  reply_not_delivered:
    'The principal has replied; setup finishes once the assistant answers them. If it does not, check the errors below.',
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
  const errors = await instanceErrorsSince(context.input.runtime.instance_root, since);
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

/** The principal in a pause before they are bound: their name and the address the assistant opens its DM with. */
function unboundPrincipal(input: ProductionProvisionInput): string {
  return `Principal: ${input.principalDisplayName} (${input.principalChatEmail})`;
}

/** A pause while the principal's DM cannot be opened yet; otherwise the binding joins the run state. */
async function principalResult(
  context: ProductionProvisionContext,
  result: PrincipalBindingResult,
): Promise<ProvisionHumanPause | undefined> {
  const name = context.input.principalDisplayName;
  switch (result.status) {
    case 'unavailable':
      return principalPause(
        context,
        'bind_principal',
        'google_chat_unavailable',
        `Google Chat did not answer while the assistant opened its direct message with ${name} ` +
          `(${result.reason}). Resume to try again.`,
        unboundPrincipal(context.input),
      );
    case 'bound':
      context.state.mainAgentGroupId = result.agentGroupId;
      context.state.principal = result.principal;
      context.state.welcomeEventId = result.eventId;
      return undefined;
    default: {
      const unhandled: never = result;
      throw new GwsEaError('invalid_child_output', `Unknown principal binding ${String(unhandled)}`);
    }
  }
}

/**
 * Google Chat API configuration has no API (chat-configuration.ts): the
 * assistant's name, an avatar, and a description, with interactive features
 * off, since the assistant talks in Chat as its own account. When the
 * assistant's sign-in still needs its client, which has no API either, the
 * same visit to the project's console creates it, and the pause takes its
 * file with the confirmation, so the operator returns to the terminal once.
 * Each task's link comes first and alone on its line, so it is the first
 * thing to click and nothing after it joins the link.
 */
async function chatConfigurationPause(input: ProductionProvisionInput): Promise<ProvisionHumanPause> {
  const chat = [
    googleChatConfigurationUrl(input.gcp.projectId),
    `App name: ${input.identity.assistantDisplayName}`,
    'Avatar URL: a public HTTPS image of the assistant',
    `Description: a short line, such as "Executive assistant to ${input.principalDisplayName}"`,
    'Interactive features: off, since the assistant talks in Chat as its own account, not as a Chat app',
    'Save',
  ];
  if (!(await googleClientNeeded(input.google))) {
    return {
      ...humanPause(
        'configure_channel',
        'chat_configuration_required',
        "Configure the Google Chat API for this assistant's project, then confirm it.",
      ),
      details: chat,
      resumeFlag: '--chat-configured',
    };
  }
  const indented = (lines: readonly string[]): string[] => lines.map((line) => `   ${line}`);
  return {
    ...humanPause(
      'configure_channel',
      'chat_configuration_required',
      "Do two things in this assistant's Google Cloud project, then confirm the first and give the second's file.",
    ),
    details: [
      '1. Configure the Google Chat API:',
      ...indented(chat),
      "2. Create the assistant's Google sign-in client:",
      ...indented(googleClientSteps(input.gcp, input.identity.assistantDisplayName)),
    ],
    resumeFlag: `--chat-configured ${GOOGLE_CLIENT_FILE_FLAG} <file>`,
  };
}

function bindingObservation(
  context: ProductionProvisionContext,
  result: PrincipalBindingVerificationResult,
): Observation {
  if (result.status === 'absent') return ABSENT;
  context.state.mainAgentGroupId = result.agentGroupId;
  context.state.principal = result.principal;
  context.state.welcomeEventId = result.welcomeEventId;
  return PRESENT;
}

/** When the bind step began: every attempt binds the principal as verified then, so a retry changes nothing. */
async function bindStepStart(context: ProductionProvisionContext): Promise<string> {
  const journal = await readProvisionJournal(context.operation.paths, context.operation.instanceId);
  const started = journal.steps.bind_principal?.started_at;
  if (!started) throw new GwsEaError('step_not_started', 'The principal binding step has not started');
  return started;
}

function conversationInput(context: ProductionProvisionContext): ConversationVerificationInput | undefined {
  const mainAgentGroupId = context.state.mainAgentGroupId;
  const principal = context.state.principal;
  const welcomeEventId = context.state.welcomeEventId;
  if (!mainAgentGroupId || !principal || !welcomeEventId) return undefined;
  return {
    stateRoot: context.input.runtime.state_root,
    mainAgentGroupId,
    messagingGroupId: principal.messagingGroupId,
    principalUserId: principal.userId,
    adapterInstance: context.input.adapterInstance,
    boundAt: principal.boundAt,
    welcomeEventId,
  };
}

/**
 * Production step composition over the validated provisioning primitives.
 * Each existing probe is one resource's observation. Dependencies are
 * injectable for boundary tests; omitted functions are the real checkout,
 * OneCLI, runtime, identity, principal, and mailbox implementations.
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
  const awaitDelivery = (value: ProductionProvisionContext): Promise<ConversationVerificationResult | undefined> =>
    pollUntil(
      () => verifyConversation(value),
      (result) => !result || result.ready || !DELIVERY_REASONS.has(result.reason),
      { intervalMs: DELIVERY_POLL_MS, limitMs: DELIVERY_WAIT_MS, sleep: dependencies.sleep },
    );
  /** The host opens the principal's DM and pulls their messages: a pause for them needs it running. */
  const principalPauseNeeds = ['start_nanoclaw'] as const;

  return {
    materialize_checkout: {
      label: 'Preparing assistant files…',
      resources: [
        {
          name: 'the release checkout',
          observe: dependencies.observeCheckout,
          apply: async (value) => {
            await ensureRelease(value, dependencies);
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
            const credential = await value.input.requestProviderCredential?.();
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
    configure_channel: {
      label: 'Checking Google Chat configuration…',
      resources: [
        {
          name: 'the Google Chat API configuration',
          observe: async (value) =>
            value.input.chatConfigured
              ? PRESENT
              : { status: 'pause', pause: await chatConfigurationPause(value.input) },
          apply: async (value) => (value.input.chatConfigured ? undefined : chatConfigurationPause(value.input)),
        },
      ],
    },
    sign_in_google: {
      label: 'Signing the assistant in to Google…',
      resources: dependencies.googleSignInResources(),
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
    connect_google: {
      label: "Connecting agents to the assistant's Google account…",
      resources: dependencies.googleAccessResources(),
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
              await dependencies.bindPrincipal(
                value.input.runtime,
                {
                  adapterInstance: value.input.adapterInstance,
                  chatEmail: value.input.principalChatEmail,
                  verifiedAt: await bindStepStart(value),
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
              `Bound principal: ${value.input.principalDisplayName} (${principal.userId})`,
            );
            if (!EXCHANGE_REASONS.has(result.reason)) return pause;
            return {
              ...pause,
              settled: async () => {
                const now = await verifyConversation(value);
                return !now || now.ready || !EXCHANGE_REASONS.has(now.reason);
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
  readonly node_path: string;
  readonly home_directory: string;
  readonly platform: 'macos' | 'linux';
  readonly running_as_root: boolean;
  /** The local Docker endpoint prerequisites resolved at create. */
  readonly docker_endpoint: string;
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
    /** The principal's addresses create collected: one or more, lowercased, each once. */
    readonly principal_emails: readonly string[];
    /** The one of them the principal uses for Google Chat, which the assistant opens its DM with (KTD11). */
    readonly principal_chat_email: string;
  };
}

const INVALID_BOOTSTRAP = 'invalid_bootstrap_manifest';

function bootstrapString(value: unknown, label: string, maximum?: number): string {
  return requireString(value, label, INVALID_BOOTSTRAP, maximum);
}

function bootstrapPrincipalEmails(value: unknown): readonly string[] {
  const invalid = (): GwsEaError =>
    new GwsEaError(INVALID_BOOTSTRAP, 'Bootstrap principal email addresses must be one or more email addresses');
  if (!Array.isArray(value) || value.length === 0) throw invalid();
  const emails = value.map((candidate) => {
    const email = typeof candidate === 'string' ? normalizePrincipalEmail(candidate) : undefined;
    if (email === undefined) throw invalid();
    return email;
  });
  return [...new Set(emails)];
}

function bootstrapPrincipalChatEmail(value: unknown, principalEmails: readonly string[]): string {
  const email = typeof value === 'string' ? normalizePrincipalEmail(value) : undefined;
  if (email === undefined || !principalEmails.includes(email)) {
    throw new GwsEaError(
      INVALID_BOOTSTRAP,
      "Bootstrap principal Chat address must be one of the principal's email addresses",
    );
  }
  return email;
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
  const principalEmails = bootstrapPrincipalEmails(identity.principal_emails);
  return {
    schema_version: BOOTSTRAP_SCHEMA_VERSION,
    node_path: requirePath(manifest.node_path, 'node_path', INVALID_BOOTSTRAP),
    home_directory: requirePath(manifest.home_directory, 'home_directory', INVALID_BOOTSTRAP),
    platform: manifest.platform,
    running_as_root: manifest.running_as_root,
    docker_endpoint: requireDockerEndpoint(manifest.docker_endpoint, 'docker_endpoint', INVALID_BOOTSTRAP),
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
      principal_emails: principalEmails,
      principal_chat_email: bootstrapPrincipalChatEmail(identity.principal_chat_email, principalEmails),
    },
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
  await preparePrivateDirectory(paths.stateRoot);
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
  readonly main_agent_group_id: string;
  readonly updated_at: string;
}

function readPersistedProfile(runtime: InstanceRuntimeConfig): PersistedProfileIdentity | undefined {
  const file = centralDatabaseFile(runtime.state_root);
  let database: Database.Database;
  try {
    database = openWithoutSideFiles(file);
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
                principal_display_name, main_agent_group_id, updated_at
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
  readonly identity: MainIdentityInput;
  /** The principal's name in the operator's messages. */
  readonly principalDisplayName: string;
  /** Main's published profile, once there is one. */
  readonly profile: PersistedProfileIdentity | undefined;
}

/**
 * Create's principal seeds the profile once (KTD9). After main is
 * published, the profile is the one source of the principal's name,
 * timezone and addresses: the principal changes them through main and the
 * operator through `gws-ea ncl`, so they are read only from there. A
 * manifest that outlived publication (its removal was interrupted) seeds
 * nothing, so it cannot undo a change made since.
 */
export async function resolveProvisionSource(
  operation: InstanceOperation,
  reservation: InstanceReservation,
  runtime: InstanceRuntimeConfig,
  manifest: ProductionBootstrapManifest | undefined,
): Promise<ProvisionSource> {
  if (manifest) {
    const profile = readPersistedProfile(runtime);
    const { identity } = manifest;
    return {
      providerCredentialMetadata: bootstrapProviderCredential(manifest),
      profile,
      identity: {
        assistantDisplayName: identity.assistant_display_name,
        assistantWorkspaceEmail: reservation.exclusive_resource_claims.workspace_email,
        ...(profile
          ? {}
          : {
              principal: {
                displayName: identity.principal_display_name,
                timezone: identity.principal_timezone,
                emails: identity.principal_emails,
              },
            }),
      },
      principalDisplayName: profile?.principal_display_name ?? identity.principal_display_name,
    };
  }
  const receipt = operation.paths.releasePreflightFile(operation.instanceId, reservation.deployed_commit);
  const preflight = await loadReleasePreflightReceipt(receipt, {
    instanceId: operation.instanceId,
    deployedCommits: [reservation.deployed_commit],
    provider: runtime.selected_provider,
  });
  const profile = readPersistedProfile(runtime);
  if (!profile) {
    throw new GwsEaError('bootstrap_required', 'The temporary bootstrap manifest is required until main is published');
  }
  return {
    providerCredentialMetadata: preflight.providerCredential,
    profile,
    identity: {
      assistantDisplayName: profile.assistant_display_name,
      assistantWorkspaceEmail: profile.assistant_workspace_email,
    },
    principalDisplayName: profile.principal_display_name,
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
    loadInstanceRuntimeConfig(paths.runtimeFile(reservation.instance_id)).catch(absent),
  ]);
  return { ...(manifest ? { manifest } : {}), ...(runtime ? { runtime } : {}) };
}

/** The instance's OneCLI layout, run through the Docker endpoint it records. */
export function instanceOnecliLayout(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
  dockerEndpoint: string,
): OnecliRuntimeLayout {
  return createOnecliRuntimeLayout({
    instanceId: reservation.instance_id,
    instanceRoot: paths.instanceRoot(reservation.instance_id),
    project: reservation.exclusive_resource_claims.onecli_project,
    appPort: reservation.allocated_ports.onecli_app,
    gatewayPort: reservation.allocated_ports.onecli_gateway,
    dockerEndpoint,
  });
}

/**
 * What a created assistant's own record says it runs (KTD6): the provider,
 * credential metadata, and OneCLI cohort the receipt kept with the
 * reservation's release records, and the Postgres image its Compose file
 * names. An update holds the tool's release to these, never to the tool's
 * own tree. Everything is read physically, so it is there while no release
 * is live.
 */
export async function readDeployedSetup(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
): Promise<DeployedSetup> {
  const commit = reservation.deployed_commit;
  const runtime = await loadInstanceRuntimeConfig(paths.runtimeFile(reservation.instance_id));
  const receipt = await loadReleasePreflightReceipt(paths.releasePreflightFile(reservation.instance_id, commit), {
    instanceId: reservation.instance_id,
    deployedCommits: [commit],
    provider: runtime.selected_provider,
  });
  const onecli = instanceOnecliLayout(paths, reservation, runtime.docker_endpoint);
  const images = parseOnecliComposeImages(await readOwnerOnlyFile(onecli.composeFile));
  return {
    onecli: receipt.onecli,
    postgresImage: images.postgres,
    provider: receipt.provider,
    providerCredential: receipt.providerCredential,
  };
}

/**
 * The host coordinates create recorded for this instance: the runtime's once
 * the host has started, the bootstrap manifest's before. Once recorded,
 * resume probes the Docker endpoint rather than re-resolving the active
 * context.
 */
export async function recordedHost(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
): Promise<{ readonly dockerEndpoint?: string }> {
  const { manifest, runtime } = await readInstanceState(paths, reservation);
  const dockerEndpoint = runtime?.docker_endpoint ?? manifest?.docker_endpoint;
  return dockerEndpoint ? { dockerEndpoint } : {};
}

/**
 * The address the principal uses for Google Chat (KTD11). Create's setup file
 * names it, but the setup file is gone once main is published, before the
 * principal is bound, so the first run fixes it in the journal, which every
 * later run reads.
 */
export async function fixPrincipalChatAddress(
  operation: InstanceOperation,
  journal: ProvisionJournal,
  manifest: ProductionBootstrapManifest | undefined,
): Promise<string> {
  const fixed = journal.decisions.principal_chat_email;
  if (fixed !== undefined) return fixed;
  if (!manifest) {
    throw new GwsEaError(
      'bootstrap_required',
      "The principal's Google Chat address is missing: the temporary bootstrap manifest is gone and the journal has none",
    );
  }
  await recordPrincipalChatAddress(operation, manifest.identity.principal_chat_email);
  return manifest.identity.principal_chat_email;
}

/** Build the production context from temporary bootstrap input or authoritative instance state. */
export async function runProductionProvision(
  operation: InstanceOperation,
  options: ProductionProvisionOptions,
): Promise<ProvisionResult> {
  const { interaction } = options;
  const provisionRuntime = options.runtime ?? {};
  const journal = interaction?.decisions.chatConfigured
    ? await recordChatConfigurationConfirmed(operation)
    : await readProvisionJournal(operation.paths, operation.instanceId);
  const provisioningStartedAt = journal.started_at;
  const reservation = await getInstanceReservation(operation.paths, operation.instanceId);
  const { manifest, runtime: persistedRuntime } = await readInstanceState(operation.paths, reservation);
  const principalChatEmail = await fixPrincipalChatAddress(operation, journal, manifest);
  let runtime: InstanceRuntimeConfig;
  let onecli: OnecliRuntimeLayout;
  if (persistedRuntime) {
    runtime = persistedRuntime;
    onecli = instanceOnecliLayout(operation.paths, reservation, runtime.docker_endpoint);
  } else {
    if (!manifest) throw new GwsEaError('bootstrap_required', 'The temporary bootstrap manifest is missing');
    // The runtime records this layout's Docker endpoint verbatim, so the layout matches it too.
    onecli = instanceOnecliLayout(operation.paths, reservation, manifest.docker_endpoint);
    runtime = createInstanceRuntimeConfig(operation.paths, reservation, onecli, {
      nodePath: manifest.node_path,
      homeDirectory: manifest.home_directory,
      selectedProvider: manifest.provider.id,
      dockerEndpoint: manifest.docker_endpoint,
    });
  }
  const source = await resolveProvisionSource(operation, reservation, runtime, manifest);
  const state = hydrateMainState(source.profile);
  const billingAccount = interaction?.decisions.billingAccount;
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
        provider: runtime.selected_provider,
        providerCredential: source.providerCredentialMetadata,
      },
      onecli,
      runtime,
      gcp: {
        instanceId: reservation.instance_id,
        projectId: reservation.exclusive_resource_claims.gcp_project_id,
        account: reservation.exclusive_resource_claims.gcp_account,
        serviceAccountEmail: reservation.exclusive_resource_claims.gchat_subscriber_account,
        credentialFile: runtime.secret_files.gchat_subscriber_key,
        cwd: runtime.instance_root,
        ...(billingAccount ? { billingAccount } : {}),
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
      principalDisplayName: source.principalDisplayName,
      principalChatEmail,
      adapterInstance: 'gchat',
      provisioningStartedAt,
      chatConfigured: journal.decisions.chat_configuration_confirmed_at !== undefined,
      bootstrapManifestFile: operation.paths.bootstrapFile(operation.instanceId),
      serviceDependencies: {
        upsertEnvVars: options.upsertEnvVars,
        restartService: (config) =>
          createServiceControl(options.serviceHelpers, runtimeServiceTarget(config)).restart(),
        platform: manifest?.platform ?? instanceServicePlatform(),
        homeDirectory: runtime.home_directory,
        runningAsRoot: manifest?.running_as_root ?? process.getuid?.() === 0,
      },
      hostStatus: options.hostStatus,
      google: {
        runtime,
        assistantWorkspaceEmail: source.identity.assistantWorkspaceEmail,
        assistantName: source.identity.assistantDisplayName,
        ...(interaction?.decisions.googleClientFile ? { clientFile: interaction.decisions.googleClientFile } : {}),
        signIn: (request) => {
          if (interaction) return interaction.signInAssistantToGoogle(request);
          throw googleSignInPause(request);
        },
        resumeCommand: `gws-ea resume --id ${operation.instanceId}`,
      },
    },
  };
  const gcpAccount = reservation.exclusive_resource_claims.gcp_account;
  return runProvisionSteps(operation, context, createProductionProvisionSteps(context, {}, provisionRuntime), {
    ...provisionRuntime,
    ...(interaction ? { signIn: () => interaction.signInToGoogleCloud(gcpAccount) } : {}),
  });
}
