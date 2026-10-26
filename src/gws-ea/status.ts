import { managedResult, resultJson, type NextAction } from './result.js';
/**
 * `list` and `status`: the operator's read-only view of the assistants on
 * this machine. Both read only local state and what each assistant's own
 * observers report. They start no run log, take no lock, repair nothing, and
 * write no file; observers may read the instance-held credentials they
 * already use, but never the operator's secrets file or secret environment
 * variables. The browser isolation probe runs only with status --details.
 *
 * Every observation is live, and registry values are shown as the record,
 * never as health. A probe that throws becomes its own result, so one failing
 * observation never hides another. An unfinished update or rollback never
 * stops either command: both show it, with the command that continues or
 * reverts it. Both work in every phase: while a switch has fenced the
 * assistant they read its `state/` and `logs/` physically. Both exit 0 once
 * they observed, whatever the health; an unknown assistant ID exits 1.
 */
import { createHash } from 'node:crypto';

import { errorCode, isErrno } from '../community-portal/errors.js';
import { getInstallScopedNames } from '../install-slug.js';
import type { ProviderTurnCause } from '../mailbox/model.js';
import { browserAvailability } from '../modules/gws-ea-browser/availability.js';
import path from 'node:path';
import {
  inspectBrowserIsolation,
  type BrowserIsolationObservation,
  type BrowserIsolationInspection,
} from './browser-isolation.js';
import { CONNECTOR_ACTIONS, CONNECTOR_NAMES, connectorDefinition } from './connectors.js';
import { inspectConnector, type ConnectorObservation, type ConnectorInspection } from './connector-inspection.js';
import type { ChatSubscriptionState } from '../modules/gws-ea-chat/health.js';
import { formatLocalTime } from '../timezone.js';
import { taggedImageId } from './agent-image.js';
import { releaseImageTag } from './agent-image-release.js';
import { aliasHost } from './alias.js';
import { CHAT_HEALTH_ARGS, chatReceiving, parseChatHealth } from './chat-health.js';
import { locateAgainstToolRelease, observeLiveCheckout } from './checkout.js';
import { MAIN_GROUP_NAME } from './identity.js';
import { readProvisionJournal } from './journal.js';
import { observeLocalVoice, type VoiceObservation } from './local-voice.js';
import { runInstanceNclJson } from './ncl.js';
import { observeOnecliRuntime } from './onecli.js';
import type { OnecliAgent } from './onecli-admin.js';
import { observeGoogleConnection, type GoogleConnectionReport } from './google-connection.js';
import { createOnecliRuntimeLayout, type OnecliPins, type OnecliRuntimeLayout } from './onecli-compose.js';
import {
  failedOutcome,
  inspectOperation,
  liveCheckoutCommits,
  operationContinuationArgv,
  readRollbackPoint,
  recoveryCommandLine,
  type OperationFollowUp,
  type OperationInspection,
  type OperationKind,
  type OperationPhase,
  type OperationRecord,
  type SnapshotManifest,
} from './operation.js';
import { CONTROL_PLANE_ROOT, isRegularFile, type ControlPlanePaths } from './paths.js';
import type { Observation } from './phases.js';
import { buildToolEnvironment, runSanitizedCommand, type SanitizedCommandRunner } from './process.js';
import { readDeployedSetup } from './provision.js';
import { redact, safeErrorMessage } from './redact.js';
import { assertInstanceId, readRegistry } from './registry.js';
import { readCurrent } from './release-layout.js';
import { sameSchema } from './rollback.js';
import {
  hostLogFiles,
  instanceOnecliAdmin,
  loadInstanceRuntimeConfig,
  type HostStatusHelpers,
  type InstanceRuntimeConfig,
} from './service.js';
import {
  createServiceControl,
  runtimeServiceTarget,
  type NanoclawServiceHandle,
  type NanoclawServiceHelpers,
} from './service-control.js';
import { GwsEaError, shortCommit, type InstanceReservation, type ReleaseCoordinates } from './types.js';
import { isRecord, optionalString, unwrapData } from './validation.js';
import {
  readLatestDelivery,
  readLatestProviderTurn,
  readSchemaManifest,
  verifyPrincipalBinding,
  type LatestDelivery,
  type LatestProviderTurn,
  type PrincipalBindingVerificationInput,
  type PrincipalBindingVerificationResult,
} from './verify.js';

const OBSERVED = 0;
const FAILED = 1;

/** The Google Chat adapter instance create registers. */
const ADAPTER_INSTANCE = 'gchat';
/** Command failures that mean a probe could not run its observation, not that it saw something wrong. */
const UNOBSERVABLE_CODES: ReadonlySet<string> = new Set([
  'command_failed',
  'command_timeout',
  'command_output_limit',
  'service_unobservable',
  'onecli_request_failed',
]);

/** `ok`: observed healthy; `degraded`: observed something wrong; `unknown`: could not observe. */
export type ProbeStatus = 'ok' | 'degraded' | 'unknown';

export interface ProbeResult {
  readonly status: ProbeStatus;
  /** Why the probe is not ok: what it saw, or why it could not see. Null when ok. */
  readonly reason: string | null;
}

/** `unmanaged` is a host running outside its service. */
export type ServiceState = 'running' | 'stopped' | 'not_installed' | 'unmanaged' | 'unknown';

export interface DeliveryView {
  /** `delivered` or `failed`, as the mailbox recorded it. */
  readonly status: string;
  readonly message_out_id: string;
  readonly at: string;
}

/** Historical provider evidence; it does not establish current conversation readiness. */
export interface MainTurnView {
  readonly provider: string | null;
  readonly last: {
    readonly status: 'completed' | 'failed';
    readonly at: string;
    readonly cause: ProviderTurnCause | null;
  } | null;
  readonly reason: string | null;
}

/** The facts a probe reports beside its status; each is null when it could not observe them. */
export interface CheckoutFacts {
  readonly commit: string | null;
}
export interface ImageFacts {
  /** The live release's tag, `<base>:r-<release>`. */
  readonly tag: string | null;
}
export interface ServiceFacts {
  readonly state: ServiceState;
}
export interface MainIdentityFacts {
  readonly agent_group_id: string | null;
}
export interface ExternalEmailFacts {
  readonly agent_group_id: string | null;
}
export interface WhatsAppFacts {
  readonly state: 'unlinked' | 'linking' | 'connected' | 'needs-relink' | null;
  readonly number: string | null;
}
export interface ChatAgentView extends ProbeResult {
  readonly agent_group_id: string | null;
  readonly messaging_group_id: string | null;
  readonly state: string | null;
}
export interface JobAgentFacts {
  readonly count: number | null;
  readonly jobs: readonly ChatAgentView[] | null;
}
/** Calendar notifications for the principal's calendars, as the inbox records turning them on. */
export interface CalendarNotificationsView {
  readonly state: 'unknown' | 'ok' | 'failing';
  readonly reason: string | null;
}
/** What the assistant can do with one principal address's main calendar, as the inbox last read it from Google. */
export interface CalendarAccessView {
  readonly address: string;
  readonly access: 'unchecked' | 'bookable' | 'readable' | 'free-busy' | 'none';
  /** When Google last answered for it; null while unchecked. */
  readonly checked_at: string | null;
}
export interface InboxFacts {
  /** The inbox's polling, as the host records it. */
  readonly state: 'healthy' | 'unhealthy' | null;
  /** When it became unhealthy; null while healthy. */
  readonly since: string | null;
  readonly last_success_at: string | null;
  readonly calendar_notifications: CalendarNotificationsView | null;
  /** Shown beside the inbox's health, never a fault. */
  readonly calendar_access: readonly CalendarAccessView[] | null;
}
/** Google Chat as the host reports it; each fact is null when the host did not report it. */
export interface ChatFacts {
  /** The pull consumer is connected to Pub/Sub. */
  readonly consumer_connected: boolean | null;
  readonly last_pull_at: string | null;
  /** The Workspace Events subscription's state, as the host last saw it. */
  readonly subscription_state: ChatSubscriptionState | null;
  /** When the subscription expires unless the host renews it. */
  readonly subscription_expire_time: string | null;
  /** Only a new Google sign-in brings Chat back. */
  readonly sign_in_needed: boolean | null;
}
export interface DeliveryFacts {
  readonly last: DeliveryView | null;
  readonly retrying: number | null;
}
export interface WorkspaceFacts {
  /** The Google account the assistant is signed in as. */
  readonly account: string | null;
}
/** Optional web identity, as the running host records it. */
export interface WebAliasFacts {
  /** An unrequested alias is not configured; an outstanding candidate is pending. */
  readonly state: 'not_configured' | 'pending' | 'configured' | null;
  /** The configured alias, or the address the operator was asked to add; null when there is neither. */
  readonly address: string | null;
}

export interface BrowserStatus extends ProbeResult {
  readonly chrome: 'available' | 'missing' | 'unavailable' | 'not_checked';
  readonly isolation: BrowserIsolationObservation | null;
}

export interface AssistantProbes {
  readonly browser: BrowserStatus;
  readonly voice: VoiceObservation;
  /** The live checkout agrees with its record: marker, detached commit, no tracked changes. */
  readonly checkout: ProbeResult & CheckoutFacts;
  readonly image: ProbeResult & ImageFacts;
  readonly service: ProbeResult & ServiceFacts;
  /** The host's own status over its CLI socket, answering for this assistant's checkout. */
  readonly host: ProbeResult;
  /** Google Chat receiving: the host's pull consumer connected, and its subscription active. */
  readonly chat: ProbeResult & ChatFacts;
  /** The OneCLI runtime, as the instance's own Compose file names it. */
  readonly onecli: ProbeResult;
  /** Main as published, on the assistant's provider, with its OneCLI agent granted every secret. */
  readonly main_identity: ProbeResult & MainIdentityFacts;
  /** external-email as the host stamped it, with no destination breaking its separation. */
  readonly external_email: ProbeResult & ExternalEmailFacts;
  readonly whatsapp: ProbeResult & WhatsAppFacts;
  readonly external_chat: ProbeResult & MainIdentityFacts;
  readonly job_agents: ProbeResult & JobAgentFacts;
  /** The assistant's inbox polling healthy, and calendar notifications on for the principal's calendars. */
  readonly inbox: ProbeResult & InboxFacts;
  /** The assistant's Google connection whole, as `observeGoogleConnection` judges it. */
  readonly workspace: ProbeResult & WorkspaceFacts;
  /** The principal binding and its queued welcome. */
  readonly principal: ProbeResult;
  /** Main's latest delivery result, and the replies the host is still retrying. */
  readonly delivery: ProbeResult & DeliveryFacts;
  /** Optional alias identity, with an owed confirmation when a candidate exists. */
  readonly web_alias: ProbeResult & WebAliasFacts;
}

export const PROBE_NAMES = [
  'checkout',
  'image',
  'service',
  'host',
  'chat',
  'onecli',
  'main_identity',
  'external_email',
  'whatsapp',
  'external_chat',
  'job_agents',
  'inbox',
  'workspace',
  'principal',
  'delivery',
  'web_alias',
  'browser',
  'voice',
] as const satisfies readonly (keyof AssistantProbes)[];

interface OperationRecordFacts {
  readonly kind: OperationKind;
  readonly phase: OperationPhase;
  readonly from: ReleaseCoordinates;
  readonly to: ReleaseCoordinates;
  readonly started_at: string;
  readonly updated_at: string;
}

export type OperationView =
  | { readonly state: 'none' }
  | ({ readonly state: 'open' } & OperationRecordFacts & {
        readonly continue_with: string;
        readonly revert_with: string | null;
      })
  | ({ readonly state: 'failed' } & OperationRecordFacts & {
        readonly continue_with: string;
        readonly revert_with: string | null;
        /** How it failed, after the word "failed" (`failedOutcome`). */
        readonly outcome: string;
      })
  | ({ readonly state: 'committed' } & OperationRecordFacts & {
        readonly follow_ups: readonly OperationFollowUp[];
      })
  | { readonly state: 'unreadable'; readonly code: string; readonly message: string };

/**
 * `live` while the live link names a release; `fenced` while a switch has
 * removed it, so nothing can start the host; `unknown` when that cannot be
 * read.
 */
export type PhaseView =
  | { readonly state: 'live'; readonly release: string }
  | { readonly state: 'fenced' }
  | { readonly state: 'unknown'; readonly reason: string };

export interface ListedAssistant {
  readonly instance_id: string;
  /** The assistant's own Google Workspace account. */
  readonly account: string;
  readonly track: string;
  readonly deployed_commit: string;
  readonly phase: PhaseView;
  readonly release: ReleaseView;
  readonly service: { readonly state: ServiceState; readonly reason: string | null };
  readonly operation: OperationView;
  readonly removal_in_progress: boolean;
}

export interface AssistantListing {
  readonly observed_at: string;
  readonly assistants: readonly ListedAssistant[];
}

/** What the registry records: the reservation, never presented as health. */
export interface RegistryView {
  /** The assistant's own Google Workspace account. */
  readonly account: string;
  readonly track: string;
  readonly source_remote: string;
  readonly deployed_commit: string;
}

export interface ReleaseView {
  readonly deployed_commit: string;
  readonly tool_commit: string | null;
  /** Whether an update can move the assistant forward to the tool's release; null when unknown. */
  readonly behind_tool_release: boolean | null;
  readonly reason: string | null;
}

export interface RollbackView {
  /** Whether the assistant keeps a rollback point. */
  readonly available: boolean;
  readonly previous_commit: string | null;
  /** Whether either schema fingerprint moved since it: a rollback then restores the pre-update snapshot. */
  readonly schema_moved: boolean | null;
  readonly reason: string | null;
}

export interface SchemaView {
  readonly central_fingerprint: string | null;
  readonly session_fingerprint: string | null;
  readonly latest_migration: string | null;
  readonly reason: string | null;
}

export interface AssistantStatus {
  readonly instance_id: string;
  readonly observed_at: string;
  readonly phase: PhaseView;
  readonly registry: RegistryView;
  readonly operation: OperationView;
  readonly removal_in_progress: boolean;
  readonly release: ReleaseView;
  readonly rollback: RollbackView;
  readonly schema: SchemaView;
  readonly main_turn: MainTurnView;
  readonly probes: AssistantProbes;
  readonly connectors: readonly ConnectorObservation[];
}

export interface StatusObservers {
  readonly runCommand: SanitizedCommandRunner;
  readonly fetch?: typeof globalThis.fetch;
  /** `ncl <args> --json` through the assistant's own host. */
  readonly ncl: (runtime: InstanceRuntimeConfig, args: readonly string[]) => Promise<unknown>;
  readonly onecliAgents: (runtime: InstanceRuntimeConfig) => Promise<readonly OnecliAgent[]>;
  readonly onecli: (layout: OnecliRuntimeLayout, pins: OnecliPins) => Promise<Observation>;
  readonly principalBinding: (input: PrincipalBindingVerificationInput) => PrincipalBindingVerificationResult;
  readonly schema: (stateRoot: string) => SnapshotManifest;
  readonly delivery: (stateRoot: string) => LatestDelivery | undefined;
  readonly mainTurn: (stateRoot: string) => LatestProviderTurn | undefined;
  /** The assistant's Google connection, observed without changing it. */
  readonly google: (runtime: InstanceRuntimeConfig, declaredEmail: string) => Promise<GoogleConnectionReport>;
}

export interface ObservationContext {
  readonly details?: boolean;
  readonly connectorInspection?: ConnectorInspection;
  readonly browserInspection?: BrowserIsolationInspection;
  readonly paths: ControlPlanePaths;
  /** NanoClaw's service helpers (`scripts/update/service.ts`); without them service state is unknown. */
  readonly serviceHelpers?: NanoclawServiceHelpers;
  /** Upstream's host status helpers (`setup/lib/host-status.mjs`); without them the host is unknown. */
  readonly hostStatus?: HostStatusHelpers;
  readonly observers?: Partial<StatusObservers>;
  /** The tool's checkout, whose commit is the release an update deploys; this control plane's by default. */
  readonly toolRoot?: string;
  readonly now?: () => Date;
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
}

type LineWriter = (line: string) => void;

export interface ReadOnlyCommandRuntime extends ObservationContext {
  readonly stdout: LineWriter;
  readonly stderr: LineWriter;
  /** Where human output renders times; this machine's timezone by default. JSON stays ISO-8601 UTC. */
  readonly timezone?: string;
  /** Available output width; narrow and redirected output keeps full identities in stacked records. */
  readonly columns?: number;
}

/** Thrown by a probe that could not observe: its result is unknown, with this message as the reason. */
class Unobservable extends Error {}

const OK: ProbeResult = Object.freeze({ status: 'ok', reason: null });

function sentence(clause: string): string {
  const text = clause.trim();
  const capitalized = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  return /[.!?]$/u.test(capitalized) ? capitalized : `${capitalized}.`;
}

function failure(error: unknown): ProbeResult {
  if (error instanceof Unobservable) return { status: 'unknown', reason: error.message };
  if (error instanceof GwsEaError) {
    return { status: UNOBSERVABLE_CODES.has(error.code) ? 'unknown' : 'degraded', reason: safeErrorMessage(error) };
  }
  const code = errorCode(error, '');
  return { status: 'unknown', reason: code ? `The observation failed (${code}).` : safeErrorMessage(error) };
}

async function probe<Facts extends object>(
  observe: () => Promise<ProbeResult & Facts>,
  unobserved: Facts,
): Promise<ProbeResult & Facts> {
  try {
    return await observe();
    // eslint-disable-next-line no-catch-all/no-catch-all -- A probe's failure is its result; it never hides the other probes.
  } catch (error) {
    return { ...unobserved, ...failure(error) };
  }
}

function resolveObservers(overrides: Partial<StatusObservers> = {}): StatusObservers {
  const runCommand = overrides.runCommand ?? runSanitizedCommand;
  return {
    runCommand,
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    ncl: overrides.ncl ?? runInstanceNclJson,
    onecliAgents: overrides.onecliAgents ?? (async (runtime) => (await instanceOnecliAdmin(runtime)).listAgents()),
    onecli:
      overrides.onecli ?? ((layout, pins) => observeOnecliRuntime(layout, pins, { dockerCommandRunner: runCommand })),
    principalBinding: overrides.principalBinding ?? verifyPrincipalBinding,
    google:
      overrides.google ??
      ((runtime, declaredEmail) =>
        observeGoogleConnection(runtime, declaredEmail, overrides.fetch ? { fetch: overrides.fetch } : {})),
    schema: overrides.schema ?? readSchemaManifest,
    delivery: overrides.delivery ?? readLatestDelivery,
    mainTurn: overrides.mainTurn ?? readLatestProviderTurn,
  };
}

type RuntimeRecord =
  | { readonly state: 'recorded'; readonly config: InstanceRuntimeConfig }
  | { readonly state: 'missing'; readonly why: string }
  | { readonly state: 'unreadable'; readonly error: unknown };

const MISSING_RUNTIME = 'The assistant has no runtime record: its host has never been started.';

async function readRuntimeRecord(paths: ControlPlanePaths, reservation: InstanceReservation): Promise<RuntimeRecord> {
  try {
    const file = paths.runtimeFile(reservation.instance_id);
    return { state: 'recorded', config: await loadInstanceRuntimeConfig(file) };
    // eslint-disable-next-line no-catch-all/no-catch-all -- An unreadable runtime is reported by each probe that needs it.
  } catch (error) {
    return isErrno(error, 'ENOENT') ? { state: 'missing', why: MISSING_RUNTIME } : { state: 'unreadable', error };
  }
}

function requireRuntime(record: RuntimeRecord): InstanceRuntimeConfig {
  switch (record.state) {
    case 'recorded':
      return record.config;
    case 'missing':
      throw new Unobservable(record.why);
    case 'unreadable':
      throw record.error;
  }
}

async function inspect(paths: ControlPlanePaths, reservation: InstanceReservation): Promise<OperationInspection> {
  try {
    return await inspectOperation(paths, reservation);
    // eslint-disable-next-line no-catch-all/no-catch-all -- What cannot be inspected is reported, never thrown.
  } catch (error) {
    return { state: 'unreadable', code: errorCode(error, 'unexpected'), message: failure(error).reason ?? '' };
  }
}

function operationFacts(record: OperationRecord): OperationRecordFacts {
  return {
    kind: record.kind,
    phase: record.phase,
    from: record.from,
    to: record.to,
    started_at: record.started_at,
    updated_at: record.updated_at,
  };
}

function operationView(inspection: OperationInspection): OperationView {
  switch (inspection.state) {
    case 'none':
      return { state: 'none' };
    case 'open':
      return {
        state: 'open',
        ...operationFacts(inspection.record),
        continue_with: inspection.next.continueWith,
        revert_with: inspection.next.revertWith ?? null,
      };
    case 'failed':
      return {
        state: 'failed',
        ...operationFacts(inspection.record),
        continue_with: inspection.next.continueWith,
        revert_with: inspection.next.revertWith ?? null,
        outcome: failedOutcome(inspection.record),
      };
    case 'committed':
      return {
        state: 'committed',
        ...operationFacts(inspection.record),
        follow_ups: inspection.record.follow_ups,
      };
    case 'unreadable':
      return { state: 'unreadable', code: inspection.code, message: redact(inspection.message) };
  }
}

function unknownAssistant(instanceId: string): GwsEaError {
  return new GwsEaError(
    'unknown_instance',
    `No assistant ${instanceId} is registered on this machine; gws-ea list shows every assistant registered here.`,
  );
}

const LAUNCHER_REQUIRED = 'Run gws-ea through its launcher, which supplies NanoClaw';

function serviceObservation(handle: NanoclawServiceHandle): ProbeResult & ServiceFacts {
  switch (handle.mode) {
    case 'none':
      return { status: 'degraded', reason: 'No NanoClaw service is installed for it.', state: 'not_installed' };
    case 'unmanaged':
      return {
        status: 'degraded',
        reason: `A NanoClaw host runs from its checkout outside its service (PID ${handle.pid ?? handle.name ?? 'unknown'}).`,
        state: 'unmanaged',
      };
    case 'launchd':
    case 'systemd-user':
    case 'systemd-system':
    case 'nohup':
      return handle.active
        ? { ...OK, state: 'running' }
        : { status: 'degraded', reason: 'Its service is stopped.', state: 'stopped' };
  }
}

function observeService(
  context: ObservationContext,
  runtimeRecord: RuntimeRecord,
): Promise<ProbeResult & ServiceFacts> {
  return probe<ServiceFacts>(
    async () => {
      if (!context.serviceHelpers) throw new Unobservable(`${LAUNCHER_REQUIRED}'s service helpers.`);
      const runtime = requireRuntime(runtimeRecord);
      const control = createServiceControl(context.serviceHelpers, runtimeServiceTarget(runtime), {
        platform: context.platform,
        uid: context.uid,
      });
      return serviceObservation(control.detect());
    },
    { state: 'unknown' },
  );
}

function removalInProgress(paths: ControlPlanePaths, instanceId: string): Promise<boolean> {
  return isRegularFile(paths.removalFile(instanceId));
}

function liveRelease(paths: ControlPlanePaths, instanceId: string): () => Promise<string | undefined> {
  return once(() => readCurrent(paths.instanceLayout(instanceId)));
}

/** Read physically, never through the live link. */
async function observePhase(current: () => Promise<string | undefined>): Promise<PhaseView> {
  try {
    const live = await current();
    return live === undefined ? { state: 'fenced' } : { state: 'live', release: live };
    // eslint-disable-next-line no-catch-all/no-catch-all -- A phase that cannot be read is reported, never thrown.
  } catch (error) {
    return { state: 'unknown', reason: failure(error).reason ?? '' };
  }
}

function phaseDetail(phase: PhaseView): string {
  switch (phase.state) {
    case 'live':
      return `Release ${phase.release} is live.`;
    case 'fenced':
      return 'No release is live: a switch has fenced it, so nothing can start its host.';
    case 'unknown':
      return `Which release is live cannot be read: ${phase.reason}`;
  }
}

interface Subject {
  readonly context: ObservationContext;
  readonly observers: StatusObservers;
  readonly reservation: InstanceReservation;
  readonly inspection: OperationInspection;
  readonly runtime: RuntimeRecord;
  /** The live release, the one read the phase also reports. */
  readonly current: () => Promise<string | undefined>;
}

function fromObservation(seen: Observation): ProbeResult {
  switch (seen.status) {
    case 'present':
      return OK;
    case 'absent':
      return { status: 'degraded', reason: sentence(seen.reason ?? 'it is absent') };
    case 'unknown':
      return { status: 'unknown', reason: sentence(redact(`${seen.reason} (${seen.evidence})`)) };
    case 'pause':
      return { status: 'unknown', reason: sentence(seen.pause.message) };
  }
}

async function checkoutProbe({
  context,
  reservation,
  inspection,
  observers,
}: Subject): Promise<ProbeResult & CheckoutFacts> {
  const record = inspection.state === 'open' || inspection.state === 'failed' ? inspection.record : undefined;
  try {
    const commit = await observeLiveCheckout(context.paths, reservation, liveCheckoutCommits(reservation, record), {
      runCommand: observers.runCommand,
    });
    return { ...OK, commit };
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return { status: 'degraded', reason: 'The live checkout is missing.', commit: null };
    throw error;
  }
}

async function imageProbe({ runtime: record, observers, current }: Subject): Promise<ProbeResult & ImageFacts> {
  const runtime = requireRuntime(record);
  const live = await current();
  if (live === undefined) throw new Unobservable('No release is live, so no agent image is in use.');
  const tag = releaseImageTag(getInstallScopedNames(runtime.install_id).containerImageBase, live);
  const docker = {
    run: observers.runCommand,
    cwd: CONTROL_PLANE_ROOT,
    env: buildToolEnvironment(process.env, { DOCKER_HOST: runtime.docker_endpoint }),
  };
  if ((await taggedImageId(docker, tag)) === undefined) {
    return { status: 'degraded', reason: `Its agent image ${tag} is missing, so no agent can start.`, tag };
  }
  return { ...OK, tag };
}

/** Upstream's messages name the checkout-relative error log; point at this assistant's physical one. */
function hostFailure(error: unknown, instanceRoot: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return redact(message.replaceAll('logs/nanoclaw.error.log', hostLogFiles(instanceRoot).errors));
}

async function hostProbe({ context, reservation }: Subject): Promise<ProbeResult> {
  if (!context.hostStatus) throw new Unobservable(`${LAUNCHER_REQUIRED}'s host status helpers.`);
  try {
    await context.hostStatus.queryHost(context.paths.checkoutRoot(reservation.instance_id));
    // eslint-disable-next-line no-catch-all/no-catch-all -- Upstream queryHost reports every failure as a plain Error meaning the host is not answering.
  } catch (error) {
    return {
      status: 'degraded',
      reason: `The host is unreachable: ${hostFailure(error, context.paths.instanceRoot(reservation.instance_id))}`,
    };
  }
  return OK;
}

async function chatProbe({ reservation, runtime: record, observers }: Subject): Promise<ProbeResult & ChatFacts> {
  const health = parseChatHealth(unwrapData(await observers.ncl(requireRuntime(record), CHAT_HEALTH_ARGS)));
  const facts: ChatFacts = {
    consumer_connected: health.consumer.connected,
    last_pull_at: health.consumer.lastPullAt,
    subscription_state: health.subscription.state,
    subscription_expire_time: health.subscription.expireTime,
    sign_in_needed: health.signInNeeded,
  };
  const receiving = chatReceiving(health, reservation.instance_id);
  return receiving.state === 'receiving'
    ? { ...OK, ...facts }
    : { status: 'degraded', reason: sentence(receiving.reason), ...facts };
}

async function onecliProbe({ context, reservation, runtime: record, observers }: Subject): Promise<ProbeResult> {
  const runtime = requireRuntime(record);
  const setup = await readDeployedSetup(context.paths, reservation);
  const layout = createOnecliRuntimeLayout({
    instanceId: reservation.instance_id,
    instanceRoot: context.paths.instanceRoot(reservation.instance_id),
    project: reservation.exclusive_resource_claims.onecli_project,
    appPort: reservation.allocated_ports.onecli_app,
    gatewayPort: reservation.allocated_ports.onecli_gateway,
    dockerEndpoint: runtime.docker_endpoint,
  });
  return fromObservation(await observers.onecli(layout, { gateway: setup.onecli.gateway }));
}

async function publishedMain({ runtime: record, observers }: Subject): Promise<string> {
  const profile = unwrapData(await observers.ncl(requireRuntime(record), ['gws-ea-profile', 'get']));
  const main = isRecord(profile) ? optionalString(profile.main_agent_group_id) : undefined;
  if (!main)
    throw new GwsEaError('main_unpublished', 'Main is not published: the assistant profile names no main group.');
  return main;
}

function onecliAgents({ runtime: record, observers }: Subject): Promise<readonly OnecliAgent[]> {
  return observers.onecliAgents(requireRuntime(record));
}

async function mainIdentityProbe(
  subject: Subject,
  main: () => Promise<string>,
  listAgents: () => Promise<readonly OnecliAgent[]>,
): Promise<ProbeResult & MainIdentityFacts> {
  const runtime = requireRuntime(subject.runtime);
  const { ncl } = subject.observers;
  const agentGroupId = await main();
  const degraded = (reason: string): ProbeResult & MainIdentityFacts => ({
    status: 'degraded',
    reason,
    agent_group_id: agentGroupId,
  });
  const [group, config] = await Promise.all([
    ncl(runtime, ['groups', 'get', '--id', agentGroupId]).then(unwrapData),
    ncl(runtime, ['groups', 'config', 'get', '--id', agentGroupId]).then(unwrapData),
  ]);
  if (!isRecord(group) || group.name !== MAIN_GROUP_NAME) {
    return degraded(`Agent group ${agentGroupId}, which the profile names as main, is not the main group.`);
  }
  const provider = isRecord(config) ? optionalString(config.provider) : undefined;
  if (provider !== runtime.selected_provider) {
    return degraded(`Main runs provider ${provider ?? '(none)'}, not the assistant's ${runtime.selected_provider}.`);
  }
  const matching = (await listAgents()).filter((agent) => agent.identifier === agentGroupId);
  const [agent] = matching;
  if (!agent) return degraded('Main has no OneCLI agent.');
  if (matching.length > 1) return degraded('Several OneCLI agents claim main.');
  if (agent.name !== MAIN_GROUP_NAME) return degraded("Main's OneCLI agent is not named main.");
  if (agent.secretMode !== 'all') {
    return degraded(`Main's OneCLI agent is granted ${agent.secretMode} secrets, not all.`);
  }
  return { ...OK, agent_group_id: agentGroupId };
}

async function externalEmailProbe(subject: Subject): Promise<ProbeResult & ExternalEmailFacts> {
  const runtime = requireRuntime(subject.runtime);
  const health = unwrapData(await subject.observers.ncl(runtime, ['gws-ea-external-email', 'health']));
  if (
    !isRecord(health) ||
    !Array.isArray(health.problems) ||
    !health.problems.every((problem): problem is string => typeof problem === 'string')
  ) {
    throw new GwsEaError('invalid_child_output', 'ncl returned an invalid external-email report');
  }
  const agentGroupId = optionalString(health.agent_group_id) ?? null;
  const degraded = (reason: string): ProbeResult & ExternalEmailFacts => ({
    status: 'degraded',
    reason,
    agent_group_id: agentGroupId,
  });
  if (health.problems.length > 0) return degraded(health.problems.map(sentence).join(' '));
  if (agentGroupId === null) return degraded('External-email has not been created.');
  return { ...OK, agent_group_id: agentGroupId };
}

async function whatsAppProbe(subject: Subject): Promise<ProbeResult & WhatsAppFacts> {
  const report = unwrapData(
    await subject.observers.ncl(requireRuntime(subject.runtime), ['gws-ea-whatsapp', 'status']),
  );
  if (
    !isRecord(report) ||
    !oneOf(['unlinked', 'linking', 'connected', 'needs-relink'] as const, report.state) ||
    (report.number !== undefined && typeof report.number !== 'string')
  )
    throw new Unobservable('ncl returned an invalid WhatsApp report');
  const facts = { state: report.state, number: optionalString(report.number) ?? null };
  return report.state === 'needs-relink' || report.state === 'linking'
    ? { ...facts, status: 'degraded', reason: `WhatsApp ${report.state}${facts.number ? ` (${facts.number})` : ''}.` }
    : { ...OK, ...facts };
}

/** Every group retains its own failed observation; one malformed row cannot hide the others. */
function reportedChatAgent(value: unknown): ProbeResult {
  if (
    !isRecord(value) ||
    !oneOf(['ok', 'degraded', 'unknown'] as const, value.status) ||
    !(value.reason === null || typeof value.reason === 'string')
  )
    return { status: 'unknown', reason: 'ncl returned an invalid chat-agent observation' };
  return { status: value.status, reason: value.reason };
}
async function externalChatProbe(report: () => Promise<unknown>): Promise<ProbeResult & MainIdentityFacts> {
  const data = await report();
  const external = isRecord(data) && isRecord(data.external_chat) ? data.external_chat : undefined;
  if (!external || !(typeof external.agent_group_id === 'string' || external.agent_group_id === null))
    return { status: 'unknown', reason: 'ncl returned an invalid external-chat observation', agent_group_id: null };
  return { ...reportedChatAgent(external), agent_group_id: optionalString(external?.agent_group_id) ?? null };
}
async function jobAgentsProbe(report: () => Promise<unknown>): Promise<ProbeResult & JobAgentFacts> {
  const data = await report();
  if (!isRecord(data) || !Array.isArray(data.jobs)) throw new Unobservable('ncl returned an invalid job-agent report');
  const jobs: ChatAgentView[] = data.jobs.map((value: unknown) => {
    const row = isRecord(value) ? value : undefined;
    const valid =
      row &&
      optionalString(row.agent_group_id) &&
      optionalString(row.messaging_group_id) &&
      oneOf(['creating', 'active', 'retiring', 'retired'] as const, row.state);
    return {
      ...(valid
        ? reportedChatAgent(row.health)
        : { status: 'unknown' as const, reason: 'ncl returned an invalid job-agent observation' }),
      agent_group_id: optionalString(row?.agent_group_id) ?? null,
      messaging_group_id: optionalString(row?.messaging_group_id) ?? null,
      state: optionalString(row?.state) ?? null,
    };
  });
  const status = jobs.some((job) => job.status === 'degraded')
    ? 'degraded'
    : jobs.some((job) => job.status === 'unknown')
      ? 'unknown'
      : 'ok';
  return {
    status,
    reason:
      status === 'ok'
        ? null
        : jobs
            .filter((job) => job.status !== 'ok')
            .map((job) => `${job.agent_group_id ?? 'Unknown job'}: ${job.reason ?? job.status}`)
            .join('; '),
    count: jobs.length,
    jobs,
  };
}

const INBOX_STATES = ['healthy', 'unhealthy'] as const;
const CALENDAR_NOTIFICATION_STATES = ['unknown', 'ok', 'failing'] as const;
const CALENDAR_ACCESS = ['unchecked', 'bookable', 'readable', 'free-busy', 'none'] as const;

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/** As the host's `getInboxHealth` reports it. */
interface InboxHealthReport {
  readonly state: (typeof INBOX_STATES)[number];
  readonly reason: string | null;
  readonly since: string | null;
  readonly lastSuccessAt: string | null;
  readonly calendarNotifications: CalendarNotificationsView;
  /** Null from a release that reports none: one from before calendar access. */
  readonly calendarAccess: readonly CalendarAccessView[] | null;
}

/** Undefined when any of it is malformed. */
function parseCalendarAccess(value: unknown): CalendarAccessView[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const views: CalendarAccessView[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.address !== 'string' ||
      !oneOf(CALENDAR_ACCESS, item.access) ||
      !nullableString(item.checkedAt)
    ) {
      return undefined;
    }
    views.push({ address: item.address, access: item.access, checked_at: item.checkedAt });
  }
  return views;
}

function parseInboxHealth(value: unknown): InboxHealthReport {
  const invalid = () => new GwsEaError('invalid_child_output', 'ncl returned an invalid inbox report');
  if (!isRecord(value) || !isRecord(value.calendarNotifications)) throw invalid();
  const { state, reason, since, lastSuccessAt } = value;
  const calendar = value.calendarNotifications;
  // A release from before calendar access sends none; its inbox still reads as it is.
  const calendarAccess = value.calendarAccess === undefined ? null : parseCalendarAccess(value.calendarAccess);
  if (
    !oneOf(INBOX_STATES, state) ||
    !nullableString(reason) ||
    !nullableString(since) ||
    !nullableString(lastSuccessAt) ||
    !oneOf(CALENDAR_NOTIFICATION_STATES, calendar.state) ||
    !nullableString(calendar.reason) ||
    calendarAccess === undefined
  ) {
    throw invalid();
  }
  return {
    state,
    reason,
    since,
    lastSuccessAt,
    calendarNotifications: { state: calendar.state, reason: calendar.reason },
    calendarAccess,
  };
}

function because(clause: string, reason: string | null): string {
  return reason ? `${clause}: ${redact(reason)}` : clause;
}

function webAliasArgv(instanceId: string, facts: WebAliasFacts): string[] {
  const command = ['gws-ea', 'alias', '--id', instanceId];
  return facts.address !== null ? [...command, '--alias-added'] : command;
}

/** Alias identity is independent of browser availability. An unrequested alias is informational. */
async function webAliasProbe(subject: Subject): Promise<ProbeResult & WebAliasFacts> {
  const runtime = requireRuntime(subject.runtime);
  const setup = await aliasHost((args) => subject.observers.ncl(runtime, args)).setup();
  if (setup.alias !== null) return { ...OK, state: 'configured', address: setup.alias };
  if (setup.candidate === null) return { ...OK, state: 'not_configured', address: null };
  const facts: WebAliasFacts = { state: 'pending', address: setup.candidate };
  return {
    status: 'degraded',
    reason: `The web alias ${setup.candidate} needs confirmation. Add it in Google Admin, then run ${webAliasArgv(subject.reservation.instance_id, facts).join(' ')}.`,
    ...facts,
  };
}

async function browserProbe(subject: Subject, active: boolean): Promise<BrowserStatus> {
  const availability = await browserAvailability(path.join(requireRuntime(subject.runtime).instance_root, 'browser'));
  const isolation =
    active && subject.context.details
      ? await inspectBrowserIsolation(subject.context.paths, subject.reservation.instance_id, {
          ...subject.context.browserInspection,
          ncl: subject.observers.ncl,
          check: true,
        })
      : null;
  if (!availability.available)
    return {
      status: 'degraded',
      reason:
        availability.reason === 'chrome-missing'
          ? 'Install Google Chrome at /Applications/Google Chrome.app. Ask your operator to install it; gws-ea does not install browsers.'
          : availability.reason === 'chrome-not-launchable'
            ? 'Chrome is installed but cannot be launched. Ask your operator to inspect its file permissions and diagnostics.'
            : 'The browser root is unavailable. Ask your operator to inspect this assistant’s state.',
      chrome:
        availability.reason === 'chrome-missing'
          ? 'missing'
          : availability.reason === 'chrome-not-launchable'
            ? 'unavailable'
            : 'not_checked',
      isolation,
    };
  if (!active)
    return {
      status: 'unknown',
      reason: 'Assistant is stopped; browser readiness was not checked.',
      chrome: 'available',
      isolation: null,
    };
  if (isolation?.chrome.status === 'unavailable')
    return { status: 'degraded', reason: isolation.chrome.reason, chrome: 'unavailable', isolation };
  const health = unwrapData(await subject.observers.ncl(requireRuntime(subject.runtime), ['gws-ea-browser-health']));
  const available = isRecord(health) ? (health.available === undefined ? health.enabled : health.available) : undefined;
  if (!isRecord(health) || typeof available !== 'boolean')
    throw new Unobservable('Browser readiness could not be observed.');
  if (!available || (isRecord(health.chrome) && health.chrome.state === 'unavailable'))
    return {
      status: 'degraded',
      reason: 'The host browser cannot launch Chrome. Ask your operator to inspect its browser diagnostics.',
      chrome: 'available',
      isolation,
    };
  if (isolation?.isolation.status === 'failed' || isolation?.isolation.status === 'unknown')
    return {
      status: isolation.isolation.status === 'failed' ? 'degraded' : 'unknown',
      reason: isolation.isolation.reason,
      chrome: 'available',
      isolation,
    };
  return { ...OK, chrome: 'available', isolation };
}

/**
 * Calendar access never degrades the inbox: a calendar not shared is a fact,
 * and only a failing sync is a fault.
 */
async function inboxProbe(subject: Subject): Promise<ProbeResult & InboxFacts> {
  const runtime = requireRuntime(subject.runtime);
  const health = parseInboxHealth(unwrapData(await subject.observers.ncl(runtime, ['gws-ea-inbox', 'health'])));
  const facts: InboxFacts = {
    state: health.state,
    since: health.since,
    last_success_at: health.lastSuccessAt,
    calendar_notifications: health.calendarNotifications,
    calendar_access: health.calendarAccess,
  };
  const problems: string[] = [];
  if (health.state === 'unhealthy') problems.push(because('the inbox is unhealthy', health.reason));
  const calendar = health.calendarNotifications;
  if (calendar.state === 'failing') {
    problems.push(
      because("calendar notifications for the principal's calendars could not be turned on", calendar.reason),
    );
  } else if (calendar.state === 'unknown') {
    problems.push(because("calendar notifications for the principal's calendars are not on yet", calendar.reason));
  }
  if (problems.length > 0) return { status: 'degraded', reason: problems.map(sentence).join(' '), ...facts };
  return { ...OK, ...facts };
}

async function workspaceProbe({
  reservation,
  runtime: record,
  observers,
}: Subject): Promise<ProbeResult & WorkspaceFacts> {
  const runtime = requireRuntime(record);
  const report = await observers.google(runtime, reservation.exclusive_resource_claims.workspace_email);
  return report.status === 'connected'
    ? { ...OK, account: report.account }
    : { status: 'degraded', reason: report.reason, account: report.account };
}

async function principalProbe({ context, reservation, observers }: Subject): Promise<ProbeResult> {
  const journal = await readProvisionJournal(context.paths, reservation.instance_id);
  const result = observers.principalBinding({
    runtime: {
      state_root: context.paths.instanceLayout(reservation.instance_id).state,
      instance_id: reservation.instance_id,
    },
    adapterInstance: ADAPTER_INSTANCE,
    provisioningStartedAt: journal.started_at,
  });
  return result.status === 'matched'
    ? OK
    : { status: 'degraded', reason: "The principal's direct message, its binding, or its welcome is missing." };
}

async function deliveryProbe({ context, reservation, observers }: Subject): Promise<ProbeResult & DeliveryFacts> {
  const seen = observers.delivery(context.paths.instanceLayout(reservation.instance_id).state);
  if (!seen) return { status: 'unknown', reason: 'Main is not published yet.', last: null, retrying: null };
  const facts: DeliveryFacts = {
    last: seen.last ? { status: seen.last.status, message_out_id: seen.last.messageOutId, at: seen.last.at } : null,
    retrying: seen.retrying,
  };
  if (!seen.sessionId) return { status: 'unknown', reason: 'Main has no conversation yet.', ...facts };
  if (!seen.last) return { status: 'unknown', reason: 'Nothing has been delivered yet.', ...facts };
  if (seen.last.status !== 'delivered') {
    return {
      status: 'degraded',
      reason: `The latest reply was not delivered (${seen.last.status}).`,
      ...facts,
    };
  }
  if (seen.retrying > 0) {
    const replies = seen.retrying === 1 ? 'reply is' : 'replies are';
    const error = seen.lastError ? `: ${seen.lastError}` : '';
    return {
      status: 'degraded',
      reason: `${seen.retrying} ${replies} awaiting another delivery attempt${error}.`,
      ...facts,
    };
  }
  return { ...OK, ...facts };
}

function observeMainTurn({ context, reservation, observers }: Subject): MainTurnView {
  let seen: LatestProviderTurn | undefined;
  try {
    seen = observers.mainTurn(context.paths.instanceLayout(reservation.instance_id).state);
    // eslint-disable-next-line no-catch-all/no-catch-all -- Observation failure is unknown; raw diagnostics must not enter operator output.
  } catch {
    return { reason: "Main's last provider turn could not be read.", provider: null, last: null };
  }
  const provider = seen?.provider ?? null;
  if (!seen?.last || !provider || seen.last.provider !== provider)
    return {
      reason: 'No valid terminal turn is recorded for main’s current provider.',
      provider,
      last: null,
    };
  return {
    provider,
    last: { status: seen.last.status, at: seen.last.observedAt, cause: seen.last.cause },
    reason: null,
  };
}

/** From the tool's history alone: local and read-only, so `list` asks it of every assistant. */
async function observeRelease({
  context,
  reservation,
  observers,
}: Pick<Subject, 'context' | 'reservation' | 'observers'>): Promise<ReleaseView> {
  const deployed = reservation.deployed_commit;
  try {
    const { toolCommit, position } = await locateAgainstToolRelease(context.toolRoot ?? CONTROL_PLANE_ROOT, deployed, {
      runCommand: observers.runCommand,
    });
    return position === 'unknown'
      ? {
          deployed_commit: deployed,
          tool_commit: toolCommit,
          behind_tool_release: null,
          reason: `The tool's checkout does not hold ${shortCommit(deployed)}, so it cannot tell.`,
        }
      : {
          deployed_commit: deployed,
          tool_commit: toolCommit,
          behind_tool_release: position === 'behind',
          reason: null,
        };
    // eslint-disable-next-line no-catch-all/no-catch-all -- The tool's release that cannot be read is reported, never thrown.
  } catch (error) {
    return { deployed_commit: deployed, tool_commit: null, behind_tool_release: null, reason: failure(error).reason };
  }
}

type SchemaRead = { readonly manifest: SnapshotManifest } | { readonly error: unknown };

function readSchema(observers: StatusObservers, stateRoot: string): SchemaRead {
  try {
    return { manifest: observers.schema(stateRoot) };
    // eslint-disable-next-line no-catch-all/no-catch-all -- A schema that cannot be read is reported, never thrown.
  } catch (error) {
    return { error };
  }
}

function fingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function fingerprints(manifest: SnapshotManifest): { readonly central: string; readonly session: string } {
  return {
    central: fingerprint([...manifest.central_migrations].sort()),
    session: fingerprint(
      Object.entries(manifest.session_tables)
        .map(([table, columns]) => [table, [...columns].sort()] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

function schemaView(read: SchemaRead): SchemaView {
  if ('error' in read) {
    return {
      central_fingerprint: null,
      session_fingerprint: null,
      latest_migration: null,
      reason: failure(read.error).reason,
    };
  }
  const { central, session } = fingerprints(read.manifest);
  return {
    central_fingerprint: central,
    session_fingerprint: session,
    latest_migration: read.manifest.central_migrations.at(-1) ?? null,
    reason: null,
  };
}

async function observeRollback({ context, reservation }: Subject, live: SchemaRead): Promise<RollbackView> {
  let point;
  try {
    point = await readRollbackPoint(context.paths, reservation.instance_id);
    // eslint-disable-next-line no-catch-all/no-catch-all -- A rollback point that cannot be read is reported, never thrown.
  } catch (error) {
    return { available: false, previous_commit: null, schema_moved: null, reason: failure(error).reason };
  }
  if (!point) {
    return {
      available: false,
      previous_commit: null,
      schema_moved: null,
      reason: `Assistant ${reservation.instance_id} keeps no rollback point, so there is nothing to roll back to.`,
    };
  }
  const commit = point.release.deployed_commit;
  if ('error' in live) {
    return { available: true, previous_commit: commit, schema_moved: null, reason: failure(live.error).reason };
  }
  return {
    available: true,
    previous_commit: commit,
    schema_moved: sameSchema(live.manifest, point.manifest) !== 'same',
    reason: null,
  };
}

function once<T>(observe: () => Promise<T>): () => Promise<T> {
  let result: Promise<T> | undefined;
  return () => (result ??= observe());
}

async function findReservation(paths: ControlPlanePaths, instanceId: string): Promise<InstanceReservation> {
  assertInstanceId(instanceId);
  const reservation = (await readRegistry(paths)).instances[instanceId];
  if (!reservation) throw unknownAssistant(instanceId);
  return reservation;
}

/** Throws only when the assistant cannot be found in the registry. */
export async function observeAssistantStatus(
  context: ObservationContext,
  instanceId: string,
): Promise<AssistantStatus> {
  const reservation = await findReservation(context.paths, instanceId);
  const observedAt = (context.now ?? (() => new Date()))().toISOString();
  const observers = resolveObservers(context.observers);
  const inspection = await inspect(context.paths, reservation);
  const current = liveRelease(context.paths, reservation.instance_id);
  const [phase, removal, release] = await Promise.all([
    observePhase(current),
    removalInProgress(context.paths, instanceId),
    observeRelease({ context, reservation, observers }),
  ]);
  const record = {
    instance_id: reservation.instance_id,
    observed_at: observedAt,
    phase,
    registry: {
      account: reservation.exclusive_resource_claims.workspace_email,
      track: reservation.release_track,
      source_remote: reservation.source_remote,
      deployed_commit: reservation.deployed_commit,
    },
    operation: operationView(inspection),
    removal_in_progress: removal,
    release,
  };
  const runtime = await readRuntimeRecord(context.paths, reservation);
  const subject: Subject = { context, observers, reservation, inspection, runtime, current };
  const serviceObservation = await observeService(context, runtime);
  const active = serviceObservation.state === 'running';
  const connectors = await Promise.all(
    CONNECTOR_NAMES.map(async (name): Promise<ConnectorObservation> => {
      try {
        return await inspectConnector(context.paths, name, {
          ...context.connectorInspection,
          instanceId,
          check: active,
          serviceHelpers: context.serviceHelpers,
          hostStatus: context.hostStatus,
          voice: { ...context.connectorInspection?.voice, ncl: observers.ncl },
        });
        // eslint-disable-next-line no-catch-all/no-catch-all -- Each optional connector is an independent observation; invalid local records cannot hide the other status probes.
      } catch (_error) {
        const definition = connectorDefinition(name);
        const reason = `${name} records could not be observed. Ask your operator to inspect its owner-only local configuration.`;
        return {
          name,
          summary: definition.summary,
          observed_at: observedAt,
          target: instanceId,
          actions: CONNECTOR_ACTIONS,
          scope: definition.scope,
          account: definition.account,
          compatibility: 'unknown',
          prerequisites: definition.prerequisites.map((requirement) => ({ requirement, status: 'unknown', reason })),
          setup: 'unknown',
          readiness: { status: 'unknown', checked: false },
          assistants: [
            {
              instance_id: instanceId,
              compatibility: 'unknown',
              setup: 'unknown',
              readiness: { status: 'unknown', checked: false },
              reasons: [reason],
              next_actions: [],
            },
          ],
          reasons: [reason],
          next_actions: [{ kind: 'external', instruction: reason }],
          details: [],
        };
      }
    }),
  );

  const main = once(() => publishedMain(subject));
  const agents = once(() => onecliAgents(subject));
  const chatAgents = once(async () =>
    unwrapData(await observers.ncl(requireRuntime(runtime), ['gws-ea-chat-agents', 'health'])),
  );
  const live = readSchema(observers, context.paths.instanceLayout(instanceId).state);
  const [
    checkout,
    image,
    service,
    host,
    chat,
    onecli,
    mainIdentity,
    externalEmail,
    whatsapp,
    externalChat,
    jobAgents,
    inbox,
    workspace,
    principal,
    delivery,
    webAlias,
    browser,
    voice,
    rollback,
  ] = await Promise.all([
    probe<CheckoutFacts>(() => checkoutProbe(subject), { commit: null }),
    probe<ImageFacts>(() => imageProbe(subject), { tag: null }),
    Promise.resolve(serviceObservation),
    probe(() => hostProbe(subject), {}),
    probe<ChatFacts>(() => chatProbe(subject), {
      consumer_connected: null,
      last_pull_at: null,
      subscription_state: null,
      subscription_expire_time: null,
      sign_in_needed: null,
    }),
    probe(() => onecliProbe(subject), {}),
    probe<MainIdentityFacts>(() => mainIdentityProbe(subject, main, agents), { agent_group_id: null }),
    probe<ExternalEmailFacts>(() => externalEmailProbe(subject), { agent_group_id: null }),
    probe<WhatsAppFacts>(() => whatsAppProbe(subject), { state: null, number: null }),
    probe<MainIdentityFacts>(() => externalChatProbe(chatAgents), { agent_group_id: null }),
    probe<JobAgentFacts>(() => jobAgentsProbe(chatAgents), { count: null, jobs: null }),
    probe<InboxFacts>(() => inboxProbe(subject), {
      state: null,
      since: null,
      last_success_at: null,
      calendar_notifications: null,
      calendar_access: null,
    }),
    probe<WorkspaceFacts>(() => workspaceProbe(subject), { account: null }),
    probe(() => principalProbe(subject), {}),
    probe<DeliveryFacts>(() => deliveryProbe(subject), { last: null, retrying: null }),
    active
      ? probe<WebAliasFacts>(() => webAliasProbe(subject), { state: null, address: null })
      : Promise.resolve({
          status: 'unknown' as const,
          reason: 'Assistant is stopped; alias identity was not checked.',
          state: reservation.exclusive_resource_claims.alias_email ? null : ('not_configured' as const),
          address: reservation.exclusive_resource_claims.alias_email ?? null,
        }),
    probe<Omit<BrowserStatus, 'status' | 'reason'>>(() => browserProbe(subject, active), {
      chrome: 'not_checked' as const,
      isolation: null,
    }),
    probe<Omit<VoiceObservation, 'status' | 'reason'>>(
      async () => {
        const observation = connectors.find((entry) => entry.name === 'voice')!;
        if (!('assets' in observation.details)) throw new Unobservable('Voice records could not be read.');
        if (active)
          return observeLocalVoice(context.paths, requireRuntime(runtime), observers.ncl, observation.details);
        return {
          status: observation.setup === 'not_installed' ? 'ok' : 'unknown',
          reason: 'Assistant is stopped; voice readiness was not checked.',
          enabled: observation.details.activation.enabled,
          assets: observation.details.assets.status === 'recorded' ? 'unknown' : observation.details.assets.status,
          compatibility: observation.assistants[0]?.compatibility ?? 'unknown',
          readiness: 'unknown',
          queued: null,
          inflight: null,
          last_outcome: null,
          last_failure: null,
        } as const;
      },
      {
        enabled: null,
        assets: 'unknown' as const,
        compatibility: 'unknown' as const,
        readiness: 'unknown' as const,
        queued: null,
        inflight: null,
        last_outcome: null,
        last_failure: null,
      },
    ),
    observeRollback(subject, live),
  ]);
  return {
    ...record,
    connectors,
    rollback,
    schema: schemaView(live),
    main_turn: observeMainTurn(subject),
    probes: {
      checkout,
      image,
      service,
      host,
      chat,
      onecli,
      main_identity: mainIdentity,
      external_email: externalEmail,
      whatsapp,
      external_chat: externalChat,
      job_agents: jobAgents,
      inbox,
      workspace,
      principal,
      delivery,
      web_alias: webAlias,
      browser,
      voice,
    },
  };
}

/** Every registered assistant, from local state only. */
export async function listAssistants(context: ObservationContext): Promise<AssistantListing> {
  const observedAt = (context.now ?? (() => new Date()))().toISOString();
  const registry = await readRegistry(context.paths);
  const observers = resolveObservers(context.observers);
  const reservations = Object.values(registry.instances).sort(
    (left, right) =>
      left.exclusive_resource_claims.workspace_email.localeCompare(right.exclusive_resource_claims.workspace_email) ||
      left.instance_id.localeCompare(right.instance_id),
  );
  const assistants = await Promise.all(
    reservations.map(async (reservation): Promise<ListedAssistant> => {
      const inspection = await inspect(context.paths, reservation);
      const [phase, removal, release, service] = await Promise.all([
        observePhase(liveRelease(context.paths, reservation.instance_id)),
        removalInProgress(context.paths, reservation.instance_id),
        observeRelease({ context, reservation, observers }),
        readRuntimeRecord(context.paths, reservation).then((runtime) => observeService(context, runtime)),
      ]);
      return {
        instance_id: reservation.instance_id,
        account: reservation.exclusive_resource_claims.workspace_email,
        track: reservation.release_track,
        deployed_commit: reservation.deployed_commit,
        phase,
        release,
        service: { state: service.state, reason: service.reason },
        operation: operationView(inspection),
        removal_in_progress: removal,
      };
    }),
  );
  return { observed_at: observedAt, assistants };
}

function operationSummary(operation: OperationView): string {
  switch (operation.state) {
    case 'none':
      return '-';
    case 'open':
      return `${operation.kind} ${operation.phase}`;
    case 'failed':
      return `${operation.kind} failed`;
    case 'committed':
      return 'follow-ups';
    case 'unreadable':
      return 'unreadable';
  }
}

/** Shared so every command that reports an unfinished operation words it alike. */
export function unfinishedOperation(
  operation: Extract<OperationView, { readonly state: 'open' | 'failed' | 'unreadable' }>,
): string {
  switch (operation.state) {
    case 'open': {
      const revert = operation.revert_with ? `, or revert it with ${operation.revert_with}` : '';
      return (
        `Its ${operation.kind} to ${operation.to.release_track} ${shortCommit(operation.to.deployed_commit)} is unfinished ` +
        `(${operation.phase}); continue it with ${operation.continue_with}${revert}.`
      );
    }
    case 'failed':
      return (
        `Its ${operation.kind} to ${operation.to.release_track} ${shortCommit(operation.to.deployed_commit)} failed${operation.outcome} ` +
        `(${operation.phase}); fix it forward to a newer release with ${operation.continue_with}.`
      );
    case 'unreadable':
      return `Its update or rollback record cannot be read: ${operation.message}`;
  }
}

function operationDetail(instanceId: string, operation: OperationView, removal: boolean): string[] {
  const lines: string[] = [];
  if (removal) lines.push(`Removal is in progress; finish it with gws-ea remove --id ${instanceId}.`);
  switch (operation.state) {
    case 'none':
      break;
    case 'open':
    case 'failed':
    case 'unreadable':
      lines.push(unfinishedOperation(operation));
      break;
    case 'committed':
      lines.push(
        `Its ${operation.kind} to ${shortCommit(operation.to.deployed_commit)} is committed, with follow-ups still to run: ` +
          `${operation.follow_ups.map((followUp) => followUp.kind).join(', ')}; the next gws-ea ${operation.kind} --id ${instanceId} retries them.`,
      );
      break;
  }
  return lines;
}

function table(rows: readonly (readonly string[])[]): string[] {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map((row) =>
    row
      .map((cell, column) => cell.padEnd(widths[column]!))
      .join('  ')
      .trimEnd(),
  );
}

function behindCell(release: ReleaseView): string {
  if (release.behind_tool_release === null) return 'unknown';
  return release.behind_tool_release ? 'yes' : 'no';
}

function renderList(listing: AssistantListing, columns: number, timezone: string): string[] {
  if (listing.assistants.length === 0) return ['No assistants are registered on this machine.'];
  const rows = [
    ['INSTANCE ID', 'ACCOUNT', 'TRACK', 'COMMIT', 'BEHIND TOOL', 'SERVICE', 'PHASE', 'OPERATION'],
    ...listing.assistants.map((assistant) => [
      assistant.instance_id,
      assistant.account,
      assistant.track,
      shortCommit(assistant.deployed_commit),
      behindCell(assistant.release),
      assistant.service.state,
      assistant.phase.state,
      assistant.removal_in_progress ? 'removing' : operationSummary(assistant.operation),
    ]),
  ];
  // Beside the table: a phase that cannot be read. A fenced assistant's operation names what moves it on.
  const details = listing.assistants.flatMap(({ instance_id: id, phase, operation, removal_in_progress: removal }) =>
    [...(phase.state === 'unknown' ? [phaseDetail(phase)] : []), ...operationDetail(id, operation, removal)].map(
      (line) => `${id}: ${line}`,
    ),
  );
  const rendered = table(rows);
  const records = rendered.some((line) => line.length > columns)
    ? listing.assistants.flatMap((assistant, index) => [
        ...(index === 0 ? [] : ['']),
        `Assistant ${assistant.instance_id}`,
        `  Account: ${assistant.account}`,
        `  Release: ${assistant.track} ${shortCommit(assistant.deployed_commit)}; behind tool: ${behindCell(assistant.release)}`,
        `  Service: ${assistant.service.state}${assistant.service.reason ? `; ${assistant.service.reason}` : ''}`,
        `  Phase: ${phaseDetail(assistant.phase)}`,
        `  Operation: ${assistant.removal_in_progress ? 'removing' : operationSummary(assistant.operation)}`,
        `  Next: gws-ea status --id ${assistant.instance_id}`,
      ])
    : rendered;
  return [
    ...records,
    ...(details.length > 0 ? ['', ...details] : []),
    `Observed: ${formatLocalTime(listing.observed_at, timezone)}`,
  ];
}

function releaseLine(instanceId: string, release: ReleaseView): string {
  const runs = `runs ${shortCommit(release.deployed_commit)}`;
  if (release.behind_tool_release === null || release.tool_commit === null) return `${runs}; ${release.reason ?? ''}`;
  if (release.behind_tool_release) {
    return `${runs}; the tool's release ${shortCommit(release.tool_commit)} is newer: update it with gws-ea update --id ${instanceId}`;
  }
  return release.tool_commit === release.deployed_commit
    ? `${runs}, the tool's release`
    : `${runs}; the tool's release ${shortCommit(release.tool_commit)} is not ahead of it`;
}

function rollbackLine(rollback: RollbackView): string {
  if (!rollback.available || rollback.previous_commit === null) return rollback.reason ?? 'none';
  const to = `to ${shortCommit(rollback.previous_commit)}`;
  if (rollback.schema_moved === null) return `${to}; whether the schema moved is unknown: ${rollback.reason ?? ''}`;
  return rollback.schema_moved
    ? `${to}: the schema moved, so it restores the pre-update snapshot`
    : `${to}: code only, keeping every change since`;
}

function probeDetail(name: (typeof PROBE_NAMES)[number], probes: AssistantProbes, timezone: string): string {
  switch (name) {
    case 'checkout':
      return probes.checkout.commit ? `at ${shortCommit(probes.checkout.commit)}` : '';
    case 'image':
      return probes.image.tag ?? '';
    case 'service':
      return probes.service.state;
    case 'main_identity':
      return probes.main_identity.agent_group_id ?? '';
    case 'external_email':
      return probes.external_email.agent_group_id ?? '';
    case 'whatsapp':
      return [probes.whatsapp.state ?? 'unknown', probes.whatsapp.number].filter(Boolean).join(' ');
    case 'external_chat':
      return probes.external_chat.agent_group_id ?? '';
    case 'job_agents':
      return probes.job_agents.count === null ? 'unknown' : `${probes.job_agents.count} registered`;
    case 'inbox': {
      const polled = probes.inbox.last_success_at;
      return polled ? `last polled ${formatLocalTime(polled, timezone)}` : '';
    }
    case 'workspace':
      return probes.workspace.account ?? '';
    case 'chat':
      return chatDetail(probes.chat, timezone);
    case 'delivery': {
      const last = probes.delivery.last;
      return last ? `${last.status} ${formatLocalTime(last.at, timezone)} (${last.message_out_id})` : '';
    }
    case 'web_alias':
      return webAliasSummary(probes.web_alias);
    case 'browser':
      return `Chrome ${probes.browser.chrome}${probes.browser.isolation ? `; isolation ${probes.browser.isolation.isolation.status}` : ''}`;
    case 'voice': {
      const voice = probes.voice;
      const enabled =
        voice.enabled === null ? 'host enablement unknown' : voice.enabled ? 'enabled host-wide' : 'disabled host-wide';
      return [
        enabled,
        `assets ${voice.assets}`,
        `release ${voice.compatibility}`,
        `readiness ${voice.readiness}`,
        ...(voice.queued === null ? [] : [`queued ${voice.queued}`]),
        ...(voice.inflight === null ? [] : [`active ${voice.inflight}`]),
        ...(voice.last_outcome
          ? [`last ${voice.last_outcome.status} ${formatLocalTime(voice.last_outcome.at, timezone)}`]
          : []),
        ...(voice.last_failure
          ? [`last failure ${voice.last_failure.reason} ${formatLocalTime(voice.last_failure.at, timezone)}`]
          : []),
      ].join('; ');
    }
    case 'host':
    case 'onecli':
    case 'principal':
      return '';
  }
}

function webAliasSummary(alias: WebAliasFacts): string {
  if (alias.state === null) return alias.address ? `not observed; claimed ${alias.address}` : 'not observed';
  if (alias.state === 'not_configured') return 'not set';
  return alias.address === null ? alias.state.replace('_', ' ') : `${alias.state} ${alias.address}`;
}

function chatDetail(chat: ChatFacts, timezone: string): string {
  const expires = chat.subscription_expire_time;
  const pulled = chat.last_pull_at;
  return [
    ...(expires ? [`subscription active until ${formatLocalTime(expires, timezone)}`] : []),
    ...(pulled ? [`last pulled ${formatLocalTime(pulled, timezone)}`] : []),
  ].join('; ');
}

function probeLine(status: string, name: string, detail: string): string {
  return `  ${status.padEnd(8)}  ${name.padEnd(14)}  ${detail}`.trimEnd();
}

const ACCESS_WORDS: Readonly<Record<CalendarAccessView['access'], string>> = {
  unchecked: 'not checked yet',
  bookable: 'bookable',
  readable: 'readable, not bookable',
  'free-busy': 'free/busy only',
  none: 'no access',
};

/** Shown whatever the inbox probe's status. */
function calendarAccessLines(views: readonly CalendarAccessView[] | null, timezone: string): string[] {
  return (views ?? []).map(({ address, access, checked_at: checkedAt }) =>
    probeLine(
      '',
      '',
      `calendar of ${address}: ${ACCESS_WORDS[access]}${checkedAt === null ? '' : ` (checked ${formatLocalTime(checkedAt, timezone)})`}`,
    ),
  );
}

function jobAgentLine(job: ChatAgentView): string {
  return `    ${job.agent_group_id ?? '(unknown)'}: ${job.state ?? 'unknown'}; chat ${job.messaging_group_id ?? '(unknown)'}; ${job.status}${job.reason ? `; ${job.reason}` : ''}`;
}

function mainTurnLine({ provider, last, reason }: MainTurnView, timezone: string): string {
  const detail = last
    ? `${provider}: ${last.status} ${formatLocalTime(last.at, timezone)}${last.cause ? ` (${last.cause})` : ''}`
    : reason;
  return `  Last observed agent outcome (main): ${detail}`;
}

function renderStatusDetails(status: AssistantStatus, timezone: string): string[] {
  const { registry, schema } = status;
  const operation = operationDetail(status.instance_id, status.operation, status.removal_in_progress);
  const schemaLine =
    schema.central_fingerprint === null || schema.session_fingerprint === null
      ? `unknown: ${schema.reason ?? ''}`
      : `latest migration ${schema.latest_migration ?? '(none)'}; central ${schema.central_fingerprint.slice(0, 19)}, sessions ${schema.session_fingerprint.slice(0, 19)}`;
  const lines = [
    `Assistant ${status.instance_id}`,
    `  Account:   ${registry.account}`,
    `  Track:     ${registry.track} from ${registry.source_remote}`,
    `  Phase:     ${phaseDetail(status.phase)}`,
    `  Release:   ${releaseLine(status.instance_id, status.release)}`,
    `  Rollback:  ${rollbackLine(status.rollback)}`,
    `  Operation: ${operation.length === 0 ? 'none' : operation[0]!}`,
    ...operation.slice(1).map((line) => `             ${line}`),
    `  Schema:    ${schemaLine}`,
    mainTurnLine(status.main_turn, timezone),
    ...status.connectors.map(
      (entry) =>
        `  ${entry.name}: ${entry.setup.replaceAll('_', ' ')}; ${entry.readiness.status.replaceAll('_', ' ')}${entry.reasons.length ? `; ${entry.reasons.join(' ')}` : ''}`,
    ),
    ...statusActions(status).flatMap((action) =>
      action.kind === 'command' ? [`  Next: ${recoveryCommandLine(action.argv)}`] : [`  Next: ${action.instruction}`],
    ),
    'Probes:',
  ];
  for (const name of PROBE_NAMES) {
    const result = status.probes[name];
    const detail =
      name === 'voice'
        ? [probeDetail(name, status.probes, timezone), ...(result.reason ? [result.reason] : [])].join('; ')
        : (result.reason ?? probeDetail(name, status.probes, timezone));
    lines.push(probeLine(result.status, name, detail));
    if (name === 'job_agents') lines.push(...(status.probes.job_agents.jobs ?? []).map(jobAgentLine));
    if (name === 'inbox') lines.push(...calendarAccessLines(status.probes.inbox.calendar_access, timezone));
  }
  lines.push(`Observed: ${formatLocalTime(status.observed_at, timezone)}`);
  return lines;
}

/** Conversation health requires every part of the observed path; missing facts remain unknown. */
function conversationSummary(status: AssistantStatus): string {
  const names = [
    'host',
    'chat',
    'onecli',
    'main_identity',
    'external_email',
    'inbox',
    'workspace',
    'principal',
    'delivery',
  ] as const;
  const degraded = [
    ...names.filter((name) => status.probes[name].status === 'degraded'),
    ...status.connectors
      .filter(
        (entry) =>
          ['pending', 'failed', 'uninstall_incomplete'].includes(entry.setup) ||
          entry.next_actions.some((action) => action.kind === 'external'),
      )
      .map((entry) => entry.name),
  ];
  const unknown = names.filter((name) => status.probes[name].status === 'unknown');
  if (degraded.length === 0 && unknown.length === 0)
    return 'ready (observed host, Chat, identities, authorization, and delivery)';
  return [
    ...(degraded.length ? [`degraded (${degraded.join(', ')})`] : []),
    ...(unknown.length ? [`unknown (${unknown.join(', ')})`] : []),
    ...(status.probes.chat.sign_in_needed === true ? ['Google sign-in needed'] : []),
  ].join('; ');
}

function renderStatus(status: AssistantStatus, timezone: string, details: boolean): string[] {
  if (details) return renderStatusDetails(status, timezone);
  const operation = operationDetail(status.instance_id, status.operation, status.removal_in_progress);
  const actions = statusActions(status).flatMap((action) =>
    action.kind === 'command' ? [recoveryCommandLine(action.argv)] : [action.instruction],
  );
  return [
    `Assistant ${status.instance_id}`,
    `  Account: ${status.registry.account}`,
    ...status.connectors.map(
      (entry) =>
        `  ${entry.name}: ${entry.setup.replaceAll('_', ' ')}; ${entry.assistants[0]?.readiness.status.replaceAll('_', ' ') ?? entry.readiness.status.replaceAll('_', ' ')}${entry.reasons.length ? `; ${entry.reasons.join(' ')}` : ''}`,
    ),
    `  Browser: ${status.probes.browser.status}; Chrome ${status.probes.browser.chrome}${status.probes.browser.reason ? `; ${status.probes.browser.reason}` : ''}`,
    `  Service: ${status.probes.service.state}${status.probes.service.reason ? `; ${status.probes.service.reason}` : ''}`,
    `  Conversation: ${conversationSummary(status)}`,
    mainTurnLine(status.main_turn, timezone),
    `  WhatsApp: ${probeDetail('whatsapp', status.probes, timezone)}${status.probes.whatsapp.reason ? `; ${status.probes.whatsapp.reason}` : ''}`,
    `  External chat: ${status.probes.external_chat.agent_group_id ?? 'unknown'}; ${status.probes.external_chat.status}${status.probes.external_chat.reason ? `; ${status.probes.external_chat.reason}` : ''}`,
    `  Job agents: ${probeDetail('job_agents', status.probes, timezone)}; ${status.probes.job_agents.status}`,
    ...(status.probes.job_agents.jobs ?? []).map(jobAgentLine),
    `  Web alias: ${webAliasSummary(status.probes.web_alias)}`,
    `  Phase: ${phaseDetail(status.phase)}`,
    `  Release: ${status.registry.track} ${shortCommit(status.release.deployed_commit)}; ${status.release.behind_tool_release === null ? 'tool comparison unknown (see --details)' : status.release.behind_tool_release ? 'tool release is newer' : 'not behind tool release'}`,
    `  Operation: ${operation.length === 0 ? 'none' : operation[0]!}`,
    ...operation.slice(1).map((line) => `             ${line}`),
    ...actions.map((action) => `  Next: ${action}`),
    `  Details: gws-ea status --id ${status.instance_id} --details`,
    `Observed: ${formatLocalTime(status.observed_at, timezone)}`,
  ];
}

function timezoneOf(runtime: ReadOnlyCommandRuntime): string {
  return runtime.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Recovery comes from native operation/probe facts, never their display strings. */
function statusActions(status: AssistantStatus): NextAction[] {
  const command = (verb: string): NextAction => ({
    kind: 'command',
    argv: ['gws-ea', verb, '--id', status.instance_id],
  });
  if (status.removal_in_progress) return [command('remove')];
  const operation = status.operation;
  if (operation.state === 'open')
    return [
      { kind: 'command', argv: operationContinuationArgv(status.instance_id, operation) },
      ...(operation.revert_with !== null ? [command('rollback')] : []),
    ];
  if (operation.state === 'failed') return [command('update')];
  if (operation.state === 'committed') return [command(operation.kind)];
  const actions: NextAction[] = status.connectors.flatMap((entry) =>
    entry.next_actions.filter(
      (action) => entry.setup !== 'not_installed' || action.kind === 'external' || action.argv.includes('--abandon'),
    ),
  );
  if (status.probes.service.state === 'not_installed') actions.push(command('resume'));
  if (status.probes.chat.sign_in_needed === true || status.probes.workspace.status === 'degraded')
    actions.push(command('connect-google'));
  if (status.probes.browser.status === 'degraded')
    actions.push({
      kind: 'external',
      instruction:
        status.probes.browser.chrome === 'missing'
          ? 'Ask your operator to install Google Chrome at /Applications/Google Chrome.app, then run gws-ea status --id ' +
            status.instance_id +
            ' --details.'
          : 'Ask your operator to inspect the browser diagnostics and Docker network isolation, then run gws-ea status --id ' +
            status.instance_id +
            ' --details.',
    });
  if (
    status.probes.web_alias.state === 'pending' ||
    (status.probes.web_alias.state === 'not_configured' &&
      ['running', 'unmanaged'].includes(status.probes.service.state))
  )
    actions.push({ kind: 'command', argv: webAliasArgv(status.instance_id, status.probes.web_alias) });
  if (status.main_turn.last?.cause === 'credentials')
    actions.push({
      kind: 'external',
      instruction:
        "For the recorded credential failure, check this assistant's provider sign-in in its operator credential console. A later successful turn confirms recovery. Keep credentials out of chat.",
    });
  // Voice is optional, and a web alias still pending is setup to finish: neither sends the operator to the logs.
  if (PROBE_NAMES.some((name) => name !== 'voice' && name !== 'web_alias' && status.probes[name].status !== 'ok'))
    actions.push({ kind: 'command', argv: ['gws-ea', 'logs', '--id', status.instance_id, '--errors'] });
  return actions;
}

export async function runListCommand(
  runtime: ReadOnlyCommandRuntime,
  options: { readonly json: boolean },
): Promise<number> {
  let listing: AssistantListing;
  try {
    listing = await listAssistants(runtime);
    // eslint-disable-next-line no-catch-all/no-catch-all -- The command boundary turns a failure into a redacted message and exit code.
  } catch (error) {
    if (options.json) runtime.stdout(resultJson(managedResult('list', { outcome: 'failed', error })));
    else runtime.stderr(safeErrorMessage(error));
    return FAILED;
  }
  for (const line of options.json
    ? [resultJson(managedResult('list', { outcome: 'succeeded', data: listing }))]
    : renderList(listing, runtime.columns ?? process.stdout.columns ?? 80, timezoneOf(runtime)))
    runtime.stdout(line);
  return OBSERVED;
}

export async function runStatusCommand(
  runtime: ReadOnlyCommandRuntime,
  options: { readonly instanceId: string; readonly json: boolean; readonly details?: boolean },
): Promise<number> {
  let status: AssistantStatus;
  try {
    status = await observeAssistantStatus({ ...runtime, details: options.details }, options.instanceId);
    // eslint-disable-next-line no-catch-all/no-catch-all -- The command boundary turns a failure into a redacted message and exit code.
  } catch (error) {
    if (options.json) runtime.stdout(resultJson(managedResult('status', { outcome: 'failed', error })));
    else runtime.stderr(safeErrorMessage(error));
    return FAILED;
  }
  const lines = options.json
    ? [resultJson(managedResult('status', { outcome: 'succeeded', data: status, next_actions: statusActions(status) }))]
    : renderStatus(status, timezoneOf(runtime), options.details === true);
  for (const line of lines) runtime.stdout(line);
  return OBSERVED;
}
