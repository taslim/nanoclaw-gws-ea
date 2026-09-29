/**
 * `list` and `status`: the operator's read-only view of the assistants on
 * this machine (R1, R2, KTD10). Both read only local state and what each
 * assistant's own observers report. They load no secrets, start no run log,
 * take no lock, repair nothing, and write no file: observers may read the
 * instance-held OneCLI admin key and the stored connector token they already
 * use, but never the operator's secrets file or secret environment variables.
 * The isolation probe stays a create and update gate.
 *
 * Every observation is live, and registry values are shown as the record,
 * never as health. Each probe reports ok, degraded, or unknown with its
 * reason; a probe that throws becomes its own result, so one failing
 * observation never hides another. An unfinished update or rollback never
 * stops either command (R16): both show it, with the command that continues
 * or reverts it. Both exit 0 once they observed, whatever the health; an
 * unknown assistant ID exits 1.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { errorCode, isErrno } from '../community-portal/errors.js';
import { formatLocalTime } from '../timezone.js';
import { locateAgainstToolRelease, observeLiveCheckout } from './checkout.js';
import {
  createCloudflareConnectorLayout,
  observeCloudflareConnector,
  type CloudflareConnectorLayout,
  type CloudflareConnectorObservation,
} from './cloudflare-connector.js';
import { observeManagedGchatRoute, verifyExistingGchatEndpoint } from './endpoint.js';
import { MAIN_GROUP_NAME } from './identity.js';
import { readProvisionJournal } from './journal.js';
import {
  describeCustomized,
  inspectMainTemplate,
  planMainRestamp,
  type CustomizedTemplateFile,
  type MainTemplateInspection,
} from './main-template.js';
import { runInstanceNclJson } from './ncl.js';
import { observeOnecliRuntime } from './onecli.js';
import { createOnecliRuntimeLayout, type OnecliPins, type OnecliRuntimeLayout } from './onecli-compose.js';
import {
  inspectOperation,
  liveCheckoutCommits,
  type OperationFollowUp,
  type OperationInspection,
  type OperationKind,
  type OperationPhase,
  type OperationRecord,
  type SnapshotManifest,
} from './operation.js';
import { CONTROL_PLANE_ROOT, instanceRuntimeFile, isRegularFile, type ControlPlanePaths } from './paths.js';
import type { Observation } from './phases.js';
import { runSanitizedCommand, type SanitizedCommandRunner } from './process.js';
import { readDeployedSetup } from './provision.js';
import { redact, safeErrorMessage } from './redact.js';
import { assertInstanceId, readRegistry } from './registry.js';
import { readKeptPreviousRelease, sameSchema } from './rollback.js';
import {
  loadInstanceRuntimeConfig,
  runInstanceOnecliAdminCommand,
  type HostStatusHelpers,
  type InstanceRuntimeConfig,
} from './service.js';
import {
  createServiceControl,
  runtimeServiceTarget,
  type NanoclawServiceHandle,
  type NanoclawServiceHelpers,
} from './service-control.js';
import { instanceServicePlatform } from './service-coordinates.js';
import {
  GwsEaError,
  ingressEndpointUrl,
  shortCommit,
  type IngressClaim,
  type InstanceReservation,
  type ReleaseCoordinates,
} from './types.js';
import { isRecord, optionalString, parseJson, unwrapData } from './validation.js';
import {
  readLatestDelivery,
  readSchemaManifest,
  verifyPrincipalBinding,
  type LatestDelivery,
  type PrincipalBindingVerificationInput,
  type PrincipalBindingVerificationResult,
} from './verify.js';

/** `0` once the command observed, whatever the health; `1` when it could not (such as an unknown ID). */
const OBSERVED = 0;
const FAILED = 1;

/** The Google Chat adapter instance create registers. */
const ADAPTER_INSTANCE = 'gchat';
/** Command failures that mean a probe could not run its observation, not that it saw something wrong. */
const UNOBSERVABLE_CODES: ReadonlySet<string> = new Set(['command_failed', 'command_timeout', 'command_output_limit']);

/** `ok`: observed healthy; `degraded`: observed something wrong; `unknown`: could not observe. */
export type ProbeStatus = 'ok' | 'degraded' | 'unknown';

export interface ProbeResult {
  readonly status: ProbeStatus;
  /** Why the probe is not ok: what it saw, or why it could not see. Null when ok. */
  readonly reason: string | null;
}

/** The host's service as NanoClaw detects it; `unmanaged` is a host running outside its service. */
export type ServiceState = 'running' | 'stopped' | 'not_installed' | 'unmanaged' | 'unknown';

export interface DeliveryView {
  /** `delivered` or `failed`, as the mailbox recorded it. */
  readonly status: string;
  readonly message_out_id: string;
  readonly at: string;
}

/** The facts a probe reports beside its status; each is null when it could not observe them. */
export interface CheckoutFacts {
  readonly commit: string | null;
}
export interface ServiceFacts {
  readonly state: ServiceState;
}
export interface MainIdentityFacts {
  readonly agent_group_id: string | null;
}
export interface ConnectorFacts {
  readonly drift: string | null;
}
export interface DeliveryFacts {
  readonly last: DeliveryView | null;
  readonly retrying: number | null;
}

export interface AssistantProbes {
  /** The live checkout agrees with its record: marker, detached commit, no tracked changes. */
  readonly checkout: ProbeResult & CheckoutFacts;
  /** The host's service, as NanoClaw's own service helpers detect it. */
  readonly service: ProbeResult & ServiceFacts;
  /** The host's own status over its CLI socket: webhook open, Google Chat connected. */
  readonly host: ProbeResult;
  /** The OneCLI runtime, as the instance's own Compose file names it. */
  readonly onecli: ProbeResult;
  /** Main as published, on the assistant's provider, with its OneCLI agent granted every secret. */
  readonly main_identity: ProbeResult & MainIdentityFacts;
  /** The principal binding and its queued welcome. */
  readonly principal: ProbeResult;
  /** The callback: the managed route from outside, or the operator's endpoint. */
  readonly route: ProbeResult;
  /** The machine's shared connector; managed Cloudflare ingress only. */
  readonly connector?: ProbeResult & ConnectorFacts;
  /** Main's latest delivery result, and the replies the host is still retrying. */
  readonly delivery: ProbeResult & DeliveryFacts;
}

export const PROBE_NAMES = [
  'checkout',
  'service',
  'host',
  'onecli',
  'main_identity',
  'principal',
  'route',
  'connector',
  'delivery',
] as const satisfies readonly (keyof AssistantProbes)[];

interface OperationRecordFacts {
  readonly kind: OperationKind;
  readonly phase: OperationPhase;
  readonly from: ReleaseCoordinates;
  readonly to: ReleaseCoordinates;
  readonly started_at: string;
  readonly updated_at: string;
}

/** An assistant's update or rollback, as the operation record and the registry show it. */
export type OperationView =
  | { readonly state: 'none'; readonly abandoned_staging: boolean }
  | ({ readonly state: 'open' } & OperationRecordFacts & {
        readonly continue_with: string;
        readonly revert_with: string | null;
      })
  | ({ readonly state: 'recorded' } & OperationRecordFacts & {
        readonly follow_ups: readonly OperationFollowUp[];
        readonly abandoned_staging: boolean;
      })
  | { readonly state: 'unreadable'; readonly code: string; readonly message: string };

export interface ListedAssistant {
  readonly instance_id: string;
  readonly hostname: string;
  readonly track: string;
  readonly deployed_commit: string;
  readonly service: { readonly state: ServiceState; readonly reason: string | null };
  readonly operation: OperationView;
  readonly removal_in_progress: boolean;
}

export interface AssistantListing {
  readonly assistants: readonly ListedAssistant[];
}

/** What the registry records: the reservation, never presented as health. */
export interface RegistryView {
  readonly hostname: string;
  readonly endpoint_url: string;
  readonly ingress_mode: IngressClaim['mode'];
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
  /** A previous release of this assistant is kept to roll back to. */
  readonly available: boolean;
  readonly previous_commit: string | null;
  /** Whether either schema fingerprint moved since it: a rollback then restores the pre-update snapshot. */
  readonly schema_moved: boolean | null;
  readonly reason: string | null;
}

export type { CustomizedTemplateFile } from './main-template.js';

export interface TemplatesView {
  /**
   * What of main's template is customized, which updates keep (R11): its
   * files, compared with what the plugin it was stamped from stamps, and the
   * skills, MCP servers, and tasks NanoClaw's restamp plan flags. Null when
   * unknown.
   */
  readonly customized: readonly CustomizedTemplateFile[] | null;
  /** Why the list is unknown, or what it leaves out; null when it is whole. */
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
  readonly registry: RegistryView;
  readonly operation: OperationView;
  readonly removal_in_progress: boolean;
  readonly release: ReleaseView;
  readonly rollback: RollbackView;
  readonly templates: TemplatesView;
  readonly schema: SchemaView;
  readonly probes: AssistantProbes;
}

/** The boundaries `status` observes through; each defaults to the real one. */
export interface StatusObservers {
  /** Runs Git (the checkout, the tool's release) and Docker (OneCLI, the connector). */
  readonly runCommand: SanitizedCommandRunner;
  /** Reaches the callback as the internet does; public DNS by default. */
  readonly fetch?: typeof globalThis.fetch;
  /** `ncl <args> --json` through the assistant's own host. */
  readonly ncl: (runtime: InstanceRuntimeConfig, args: readonly string[]) => Promise<unknown>;
  /** The assistant's OneCLI CLI, with the instance-held admin key. */
  readonly onecliAdmin: (runtime: InstanceRuntimeConfig, args: readonly string[]) => Promise<unknown>;
  readonly onecli: (layout: OnecliRuntimeLayout, pins: OnecliPins) => Promise<Observation>;
  readonly connector: (
    layout: CloudflareConnectorLayout,
    dockerEndpoint: string,
  ) => Promise<CloudflareConnectorObservation>;
  readonly principalBinding: (input: PrincipalBindingVerificationInput) => PrincipalBindingVerificationResult;
  /** The schema a checkout's databases record. */
  readonly schema: (checkoutRoot: string) => SnapshotManifest;
  readonly delivery: (checkoutRoot: string) => LatestDelivery | undefined;
  /** Main's template files in a checkout, compared with the plugin they were stamped from. */
  readonly mainTemplate: (checkoutRoot: string) => Promise<MainTemplateInspection>;
}

/** What `list` and `status` observe with. The driver supplies NanoClaw's helpers; the rest default. */
export interface ObservationContext {
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
}

/** A probe that could not observe: its result is unknown, for this reason. */
class Unobservable extends Error {}

const OK: ProbeResult = Object.freeze({ status: 'ok', reason: null });

/** `clause` as a sentence: capitalized, ending in a full stop. */
function sentence(clause: string): string {
  const text = clause.trim();
  const capitalized = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  return /[.!?]$/u.test(capitalized) ? capitalized : `${capitalized}.`;
}

/** What a probe that threw reports: unknown when it could not observe, degraded when it saw something wrong. */
function failure(error: unknown): ProbeResult {
  if (error instanceof Unobservable) return { status: 'unknown', reason: error.message };
  if (error instanceof GwsEaError) {
    return { status: UNOBSERVABLE_CODES.has(error.code) ? 'unknown' : 'degraded', reason: safeErrorMessage(error) };
  }
  const code = errorCode(error, '');
  return { status: 'unknown', reason: code ? `The observation failed (${code}).` : safeErrorMessage(error) };
}

/** Run one probe; whatever it throws becomes its result, with `unobserved` as its facts. */
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
    onecliAdmin:
      overrides.onecliAdmin ??
      (async (runtime, args) =>
        parseJson(
          (await runInstanceOnecliAdminCommand(runtime, args, { runCommand })).stdout,
          'OneCLI output',
          'invalid_child_output',
        )),
    onecli:
      overrides.onecli ??
      ((layout, pins) => observeOnecliRuntime(layout, pins, { dockerCommandRunner: runCommand, runCommand })),
    connector:
      overrides.connector ??
      ((layout, dockerEndpoint) => observeCloudflareConnector(layout, { runCommand, dockerEndpoint })),
    principalBinding: overrides.principalBinding ?? verifyPrincipalBinding,
    schema: overrides.schema ?? readSchemaManifest,
    delivery: overrides.delivery ?? readLatestDelivery,
    mainTemplate: overrides.mainTemplate ?? inspectMainTemplate,
  };
}

/** The runtime create recorded once the host first started; absent before. */
type RuntimeRecord =
  | { readonly state: 'recorded'; readonly config: InstanceRuntimeConfig }
  | { readonly state: 'missing' }
  | { readonly state: 'unreadable'; readonly error: unknown };

async function readRuntimeRecord(reservation: InstanceReservation): Promise<RuntimeRecord> {
  try {
    const file = instanceRuntimeFile(reservation.checkout_realpath);
    return { state: 'recorded', config: await loadInstanceRuntimeConfig(file) };
    // eslint-disable-next-line no-catch-all/no-catch-all -- An unreadable runtime is reported by each probe that needs it.
  } catch (error) {
    return isErrno(error, 'ENOENT') ? { state: 'missing' } : { state: 'unreadable', error };
  }
}

function requireRuntime(record: RuntimeRecord): InstanceRuntimeConfig {
  switch (record.state) {
    case 'recorded':
      return record.config;
    case 'missing':
      throw new Unobservable('The assistant has no runtime record: its host has never been started.');
    case 'unreadable':
      throw record.error;
  }
}

/** The operation as the lock-free inspection sees it; a record that cannot be inspected is shown as such. */
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
      return { state: 'none', abandoned_staging: inspection.abandonedStaging };
    case 'open':
      return {
        state: 'open',
        ...operationFacts(inspection.record),
        continue_with: inspection.next.continueWith,
        revert_with: inspection.next.revertWith ?? null,
      };
    case 'recorded':
      return {
        state: 'recorded',
        ...operationFacts(inspection.record),
        follow_ups: inspection.record.follow_ups,
        abandoned_staging: inspection.abandonedStaging,
      };
    case 'unreadable':
      return { state: 'unreadable', code: inspection.code, message: redact(inspection.message) };
  }
}

function hostnameOf(ingress: IngressClaim): string {
  return ingress.mode === 'managed-cloudflare' ? ingress.hostname : new URL(ingress.endpoint_url).hostname;
}

function unknownAssistant(instanceId: string): GwsEaError {
  return new GwsEaError(
    'unknown_instance',
    `No assistant ${instanceId} is registered on this machine; gws-ea list shows every assistant registered here.`,
  );
}

const LAUNCHER_REQUIRED = 'Run gws-ea through its launcher, which supplies NanoClaw';

/** The host's service, as NanoClaw's own service helpers detect it (KTD3). */
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

/** Whether a removal receipt says this assistant's removal is under way. */
function removalInProgress(paths: ControlPlanePaths, instanceId: string): Promise<boolean> {
  return isRegularFile(paths.removalFile(instanceId));
}

/** Everything one status observation shares, read once. */
interface Subject {
  readonly context: ObservationContext;
  readonly observers: StatusObservers;
  readonly reservation: InstanceReservation;
  readonly inspection: OperationInspection;
  readonly runtime: RuntimeRecord;
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

async function checkoutProbe({ reservation, inspection, observers }: Subject): Promise<ProbeResult & CheckoutFacts> {
  const record = inspection.state === 'open' ? inspection.record : undefined;
  try {
    const commit = await observeLiveCheckout(reservation, liveCheckoutCommits(reservation, record), {
      runCommand: observers.runCommand,
    });
    return { ...OK, commit };
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return { status: 'degraded', reason: 'The live checkout is missing.', commit: null };
    throw error;
  }
}

/** Upstream's messages name the checkout-relative error log; point at this assistant's. */
function hostFailure(error: unknown, checkoutRoot: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return redact(message.replaceAll('logs/nanoclaw.error.log', path.join(checkoutRoot, 'logs', 'nanoclaw.error.log')));
}

/** The host's own status over its CLI socket, which answers only for this checkout (upstream `queryHost`). */
async function hostProbe({ context, reservation }: Subject): Promise<ProbeResult> {
  if (!context.hostStatus) throw new Unobservable(`${LAUNCHER_REQUIRED}'s host status helpers.`);
  let status: unknown;
  try {
    status = await context.hostStatus.queryHost(reservation.checkout_realpath);
    // eslint-disable-next-line no-catch-all/no-catch-all -- Upstream queryHost reports every failure as a plain Error meaning the host is not answering.
  } catch (error) {
    return {
      status: 'degraded',
      reason: `The host is unreachable: ${hostFailure(error, reservation.checkout_realpath)}`,
    };
  }
  const webhook = isRecord(status) ? status.webhook : undefined;
  const channels = isRecord(status) && Array.isArray(status.channels) ? status.channels : [];
  const port = reservation.allocated_ports.nanoclaw_webhook;
  if (isRecord(webhook) && webhook.port !== port) {
    return { status: 'degraded', reason: `The host listens on webhook port ${String(webhook.port)}, not its ${port}.` };
  }
  if (!isRecord(webhook) || !Array.isArray(webhook.paths) || !webhook.paths.includes('/webhook/gchat')) {
    return { status: 'degraded', reason: 'The host has not opened its Google Chat webhook.' };
  }
  if (
    !channels.some(
      (channel) => isRecord(channel) && channel.instance === ADAPTER_INSTANCE && channel.connected === true,
    )
  ) {
    return { status: 'degraded', reason: 'Google Chat is not connected in the running host.' };
  }
  return OK;
}

/**
 * OneCLI at the pins the live release's receipt records and the images its own
 * Compose file names (KTD6); mid-update that receipt may be the release the
 * update placed live (KTD17).
 */
async function onecliProbe({
  context,
  reservation,
  inspection,
  runtime: record,
  observers,
}: Subject): Promise<ProbeResult> {
  const runtime = requireRuntime(record);
  const open = inspection.state === 'open' ? inspection.record : undefined;
  const setup = await readDeployedSetup(context.paths, reservation, liveCheckoutCommits(reservation, open));
  const layout = createOnecliRuntimeLayout({
    instanceId: reservation.instance_id,
    instanceRoot: context.paths.instanceRoot(reservation.instance_id),
    project: reservation.exclusive_resource_claims.onecli_project,
    appPort: reservation.allocated_ports.onecli_app,
    gatewayPort: reservation.allocated_ports.onecli_gateway,
    cliExecutable: runtime.onecli_cli_path,
    dockerEndpoint: runtime.docker_endpoint,
  });
  return fromObservation(await observers.onecli(layout, { gateway: setup.onecli.gateway, cli: setup.onecli.cli }));
}

/** Main's agent group ID, as the profile the running host serves names it. */
async function publishedMain({ runtime: record, observers }: Subject): Promise<string> {
  const profile = unwrapData(await observers.ncl(requireRuntime(record), ['gws-ea-profile', 'get']));
  const main = isRecord(profile) ? optionalString(profile.main_agent_group_id) : undefined;
  if (!main)
    throw new GwsEaError('main_unpublished', 'Main is not published: the assistant profile names no main group.');
  return main;
}

/** Main as published, on the assistant's provider, with its OneCLI agent granted every secret. */
async function mainIdentityProbe(
  subject: Subject,
  main: () => Promise<string>,
): Promise<ProbeResult & MainIdentityFacts> {
  const runtime = requireRuntime(subject.runtime);
  const { ncl, onecliAdmin } = subject.observers;
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
  const agents = unwrapData(await onecliAdmin(runtime, ['agents', 'list', '--max', '0']));
  if (!Array.isArray(agents) || !agents.every(isRecord)) {
    throw new GwsEaError('invalid_child_output', 'OneCLI returned an invalid agent list');
  }
  const matching = agents.filter((agent) => agent.identifier === agentGroupId);
  const [agent] = matching;
  if (!agent) return degraded('Main has no OneCLI agent.');
  if (matching.length > 1) return degraded('Several OneCLI agents claim main.');
  if (agent.name !== MAIN_GROUP_NAME) return degraded("Main's OneCLI agent is not named main.");
  if (agent.secretMode !== 'all') {
    return degraded(`Main's OneCLI agent is granted ${optionalString(agent.secretMode) ?? 'no'} secrets, not all.`);
  }
  return { ...OK, agent_group_id: agentGroupId };
}

/** The principal conversation bind_principal fixed, still bound, with its welcome queued. */
async function principalProbe({ context, reservation, observers }: Subject): Promise<ProbeResult> {
  const journal = await readProvisionJournal(context.paths, reservation.instance_id);
  const candidate = journal.decisions.principal;
  if (!candidate) return { status: 'degraded', reason: 'No principal conversation is bound yet.' };
  const result = observers.principalBinding({
    runtime: { checkout_realpath: reservation.checkout_realpath, instance_id: reservation.instance_id },
    adapterInstance: ADAPTER_INSTANCE,
    provisioningStartedAt: journal.started_at,
    selectedCandidate: candidate,
  });
  return result.status === 'matched'
    ? OK
    : {
        status: 'degraded',
        reason: `The binding of ${candidate.senderName ?? candidate.userId} or its welcome is missing.`,
      };
}

/** The managed route observed from outside, or the operator's endpoint refusing unsigned traffic. */
async function routeProbe({ reservation, observers }: Subject): Promise<ProbeResult> {
  const ingress = reservation.exclusive_resource_claims.ingress;
  const dependencies = observers.fetch ? { fetch: observers.fetch } : {};
  if (ingress.mode === 'existing') {
    await verifyExistingGchatEndpoint(
      { endpointUrl: ingress.endpoint_url, audienceUrl: ingress.endpoint_url },
      dependencies,
    );
    return OK;
  }
  const seen = await observeManagedGchatRoute(
    {
      endpointUrl: ingress.callback_url,
      localEndpointUrl: `http://127.0.0.1:${reservation.allocated_ports.nanoclaw_webhook}/webhook/gchat`,
    },
    dependencies,
  );
  return seen.status === 'routed' ? OK : { status: 'degraded', reason: sentence(seen.observed) };
}

/** The shared connector; one on another image or token is drift, reported and never replaced (KTD11). */
async function connectorProbe({ context, runtime: record, observers }: Subject): Promise<ProbeResult & ConnectorFacts> {
  const runtime = requireRuntime(record);
  const layout = createCloudflareConnectorLayout({
    cloudflareRoot: context.paths.cloudflareRoot,
    platform: instanceServicePlatform(context.platform),
  });
  const seen = await observers.connector(layout, runtime.docker_endpoint);
  return seen.status === 'present' ? { ...OK, drift: seen.drift ?? null } : { ...fromObservation(seen), drift: null };
}

/** Main's latest delivery result, and the replies the host is still retrying. */
async function deliveryProbe({ reservation, observers }: Subject): Promise<ProbeResult & DeliveryFacts> {
  const seen = observers.delivery(reservation.checkout_realpath);
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

/** Whether the tool's own release is ahead of the assistant's, from the tool's history alone. */
async function observeRelease({ context, reservation, observers }: Subject): Promise<ReleaseView> {
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

function readSchema(observers: StatusObservers, checkoutRoot: string): SchemaRead {
  try {
    return { manifest: observers.schema(checkoutRoot) };
    // eslint-disable-next-line no-catch-all/no-catch-all -- A schema that cannot be read is reported, never thrown.
  } catch (error) {
    return { error };
  }
}

function fingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

/** The two schema fingerprints (KTD5): the central migrations applied, and every session table's columns. */
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

/**
 * The kept previous release, and whether either schema moved since it (R13,
 * R15), decided as `rollback` decides it. It is available exactly when
 * `rollback` would take it: kept whole, with its manifest naming this
 * assistant and its marker's release.
 */
async function observeRollback({ context, reservation, observers }: Subject, live: SchemaRead): Promise<RollbackView> {
  const previous = context.paths.releaseCheckoutRoot(reservation.instance_id, 'previous');
  let commit: string;
  try {
    commit = (await readKeptPreviousRelease(context.paths, reservation.instance_id)).release.deployed_commit;
    // eslint-disable-next-line no-catch-all/no-catch-all -- A previous release that cannot be read is reported, never thrown.
  } catch (error) {
    return { available: false, previous_commit: null, schema_moved: null, reason: failure(error).reason };
  }
  const unknownMove = (error: unknown): RollbackView => ({
    available: true,
    previous_commit: commit,
    schema_moved: null,
    reason: failure(error).reason,
  });
  if ('error' in live) return unknownMove(live.error);
  const kept = readSchema(observers, previous);
  if ('error' in kept) return unknownMove(kept.error);
  return {
    available: true,
    previous_commit: commit,
    schema_moved: sameSchema(live.manifest, kept.manifest) !== 'same',
    reason: null,
  };
}

/**
 * What of main's template the operator customized, which updates keep (R11):
 * its files, read from main's folder whether or not the host runs, and the
 * skills, MCP servers, and tasks NanoClaw's restamp plan flags, which only
 * the running host can plan. Planned with the group named and without
 * `--yes`, the restamp only plans: nothing is stamped or changed.
 */
async function observeTemplates(subject: Subject, main: () => Promise<string>): Promise<TemplatesView> {
  let files: readonly CustomizedTemplateFile[];
  try {
    const inspected = await subject.observers.mainTemplate(subject.reservation.checkout_realpath);
    if (inspected.kind === 'not_stamped') return { customized: null, reason: sentence(inspected.reason) };
    files = inspected.customized;
    // eslint-disable-next-line no-catch-all/no-catch-all -- Customization that cannot be observed is reported, never thrown.
  } catch (error) {
    return { customized: null, reason: failure(error).reason };
  }
  try {
    const runtime = requireRuntime(subject.runtime);
    return {
      customized: [...files, ...(await planMainRestamp(runtime, await main(), subject.observers.ncl))],
      reason: null,
    };
    // eslint-disable-next-line no-catch-all/no-catch-all -- What the host cannot plan is reported beside the files it read.
  } catch (error) {
    return {
      customized: files,
      reason: `Only its files were compared; its skills, MCP servers, and tasks were not: ${failure(error).reason ?? 'unknown'}`,
    };
  }
}

/** Run `observe` once, however many probes ask for its result. */
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

/** One assistant's live, read-only observations (R2). Throws only when the assistant cannot be found. */
export async function observeAssistantStatus(
  context: ObservationContext,
  instanceId: string,
): Promise<AssistantStatus> {
  const reservation = await findReservation(context.paths, instanceId);
  const observedAt = (context.now ?? (() => new Date()))().toISOString();
  const observers = resolveObservers(context.observers);
  const [inspection, runtime, removal] = await Promise.all([
    inspect(context.paths, reservation),
    readRuntimeRecord(reservation),
    removalInProgress(context.paths, instanceId),
  ]);
  const subject: Subject = { context, observers, reservation, inspection, runtime };
  const main = once(() => publishedMain(subject));
  const live = readSchema(observers, reservation.checkout_realpath);
  const managed = reservation.exclusive_resource_claims.ingress.mode === 'managed-cloudflare';
  const [
    checkout,
    service,
    host,
    onecli,
    mainIdentity,
    principal,
    route,
    connector,
    delivery,
    release,
    rollback,
    templates,
  ] = await Promise.all([
    probe<CheckoutFacts>(() => checkoutProbe(subject), { commit: null }),
    observeService(context, runtime),
    probe(() => hostProbe(subject), {}),
    probe(() => onecliProbe(subject), {}),
    probe<MainIdentityFacts>(() => mainIdentityProbe(subject, main), { agent_group_id: null }),
    probe(() => principalProbe(subject), {}),
    probe(() => routeProbe(subject), {}),
    managed ? probe<ConnectorFacts>(() => connectorProbe(subject), { drift: null }) : undefined,
    probe<DeliveryFacts>(() => deliveryProbe(subject), { last: null, retrying: null }),
    observeRelease(subject),
    observeRollback(subject, live),
    observeTemplates(subject, main),
  ]);
  const ingress = reservation.exclusive_resource_claims.ingress;
  return {
    instance_id: reservation.instance_id,
    observed_at: observedAt,
    registry: {
      hostname: hostnameOf(ingress),
      endpoint_url: ingressEndpointUrl(ingress),
      ingress_mode: ingress.mode,
      track: reservation.release_track,
      source_remote: reservation.source_remote,
      deployed_commit: reservation.deployed_commit,
    },
    operation: operationView(inspection),
    removal_in_progress: removal,
    release,
    rollback,
    templates,
    schema: schemaView(live),
    probes: {
      checkout,
      service,
      host,
      onecli,
      main_identity: mainIdentity,
      principal,
      route,
      ...(connector ? { connector } : {}),
      delivery,
    },
  };
}

/** Every registered assistant, from local state and cheap service detection only (R1). */
export async function listAssistants(context: ObservationContext): Promise<AssistantListing> {
  const registry = await readRegistry(context.paths);
  const reservations = Object.values(registry.instances).sort(
    (left, right) =>
      hostnameOf(left.exclusive_resource_claims.ingress).localeCompare(
        hostnameOf(right.exclusive_resource_claims.ingress),
      ) || left.instance_id.localeCompare(right.instance_id),
  );
  const assistants = await Promise.all(
    reservations.map(async (reservation): Promise<ListedAssistant> => {
      const [inspection, runtime, removal] = await Promise.all([
        inspect(context.paths, reservation),
        readRuntimeRecord(reservation),
        removalInProgress(context.paths, reservation.instance_id),
      ]);
      const service = await observeService(context, runtime);
      return {
        instance_id: reservation.instance_id,
        hostname: hostnameOf(reservation.exclusive_resource_claims.ingress),
        track: reservation.release_track,
        deployed_commit: reservation.deployed_commit,
        service: { state: service.state, reason: service.reason },
        operation: operationView(inspection),
        removal_in_progress: removal,
      };
    }),
  );
  return { assistants };
}

function operationSummary(operation: OperationView): string {
  switch (operation.state) {
    case 'none':
      return operation.abandoned_staging ? 'staging left' : '-';
    case 'open':
      return `${operation.kind} ${operation.phase}`;
    case 'recorded':
      return 'follow-ups';
    case 'unreadable':
      return 'unreadable';
  }
}

/** What an operator does about an assistant's update, rollback, or removal, if anything. */
function operationDetail(instanceId: string, operation: OperationView, removal: boolean): string[] {
  const lines: string[] = [];
  if (removal) lines.push(`Removal is in progress; finish it with gws-ea remove --id ${instanceId}.`);
  switch (operation.state) {
    case 'none':
      if (operation.abandoned_staging) {
        lines.push(`An interrupted update left staging behind; the next gws-ea update --id ${instanceId} removes it.`);
      }
      break;
    case 'open': {
      const revert = operation.revert_with ? `, or revert with ${operation.revert_with}` : '';
      lines.push(
        `${sentence(operation.kind)} to ${operation.to.release_track} ${shortCommit(operation.to.deployed_commit)} is unfinished ` +
          `(${operation.phase}); continue with ${operation.continue_with}${revert}.`,
      );
      break;
    }
    case 'recorded':
      lines.push(
        `Its ${operation.kind} to ${shortCommit(operation.to.deployed_commit)} is recorded, with follow-ups still to run: ` +
          `${operation.follow_ups.map((followUp) => followUp.kind).join(', ')}; the next gws-ea ${operation.kind} --id ${instanceId} retries them.`,
      );
      if (operation.abandoned_staging) {
        lines.push(`An interrupted update left staging behind; the next gws-ea update --id ${instanceId} removes it.`);
      }
      break;
    case 'unreadable':
      lines.push(`Its update or rollback record cannot be read: ${operation.message}`);
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

function renderList(listing: AssistantListing): string[] {
  if (listing.assistants.length === 0) return ['No assistants are registered on this machine.'];
  const rows = [
    ['INSTANCE ID', 'HOSTNAME', 'TRACK', 'COMMIT', 'SERVICE', 'OPERATION'],
    ...listing.assistants.map((assistant) => [
      assistant.instance_id,
      assistant.hostname,
      assistant.track,
      shortCommit(assistant.deployed_commit),
      assistant.service.state,
      assistant.removal_in_progress ? 'removing' : operationSummary(assistant.operation),
    ]),
  ];
  const details = listing.assistants.flatMap((assistant) =>
    operationDetail(assistant.instance_id, assistant.operation, assistant.removal_in_progress).map(
      (line) => `${assistant.instance_id}: ${line}`,
    ),
  );
  return [...table(rows), ...(details.length > 0 ? ['', ...details] : [])];
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
    case 'service':
      return probes.service.state;
    case 'main_identity':
      return probes.main_identity.agent_group_id ?? '';
    case 'connector':
      return probes.connector?.drift ? `${probes.connector.drift}; it is shared, so it is left as it is` : '';
    case 'delivery': {
      const last = probes.delivery.last;
      return last ? `${last.status} ${formatLocalTime(last.at, timezone)} (${last.message_out_id})` : '';
    }
    case 'host':
    case 'onecli':
    case 'principal':
    case 'route':
      return '';
  }
}

function renderStatus(status: AssistantStatus, timezone: string): string[] {
  const { registry, templates, schema } = status;
  const ingress = registry.ingress_mode === 'managed-cloudflare' ? 'managed Cloudflare' : 'operator endpoint';
  const operation = operationDetail(status.instance_id, status.operation, status.removal_in_progress);
  const listed =
    templates.customized === null
      ? `unknown: ${templates.reason ?? ''}`
      : templates.customized.length === 0
        ? 'none customized'
        : `customized, kept by updates: ${describeCustomized(templates.customized)}`;
  const customized = templates.customized !== null && templates.reason ? `${listed}. ${templates.reason}` : listed;
  const schemaLine =
    schema.central_fingerprint === null || schema.session_fingerprint === null
      ? `unknown: ${schema.reason ?? ''}`
      : `latest migration ${schema.latest_migration ?? '(none)'}; central ${schema.central_fingerprint.slice(0, 19)}, sessions ${schema.session_fingerprint.slice(0, 19)}`;
  const lines = [
    `Assistant ${status.instance_id}`,
    `  Hostname:  ${registry.hostname} (${ingress})`,
    `  Endpoint:  ${registry.endpoint_url}`,
    `  Track:     ${registry.track} from ${registry.source_remote}`,
    `  Release:   ${releaseLine(status.instance_id, status.release)}`,
    `  Rollback:  ${rollbackLine(status.rollback)}`,
    `  Operation: ${operation.length === 0 ? 'none' : operation[0]!}`,
    ...operation.slice(1).map((line) => `             ${line}`),
    `  Templates: ${customized}`,
    `  Schema:    ${schemaLine}`,
    'Probes:',
  ];
  for (const name of PROBE_NAMES) {
    const result = status.probes[name];
    if (!result) continue;
    const detail = result.reason ?? probeDetail(name, status.probes, timezone);
    lines.push(`  ${result.status.padEnd(8)}  ${name.padEnd(13)}  ${detail}`.trimEnd());
  }
  lines.push(`Observed: ${formatLocalTime(status.observed_at, timezone)}`);
  return lines;
}

/**
 * `list`'s and `status`'s lines in `gws-ea --help`, naming every JSON field
 * they print. `--help` indents each line by two spaces.
 */
export const LIST_USAGE: readonly string[] = [
  'list [--json]',
  '       Every assistant on this machine, from local state only. JSON: {"assistants": [...]}, each with',
  '       instance_id, hostname, track, deployed_commit, service (state: running|stopped|not_installed|',
  '       unmanaged|unknown, reason), operation (state: none|open|recorded|unreadable), removal_in_progress.',
];

export const STATUS_USAGE: readonly string[] = [
  'status --id <instance_id> [--json]',
  '       One assistant, observed live and read-only; it never repairs. JSON: instance_id, observed_at,',
  '       registry (the record, not health), operation, removal_in_progress, release (deployed_commit,',
  '       tool_commit, behind_tool_release), rollback (available, previous_commit, schema_moved),',
  '       templates (customized: surface, name, change changed|deleted|added; reason), schema',
  '       (central_fingerprint, session_fingerprint, latest_migration),',
  '       probes: checkout, service, host, onecli, main_identity, principal, route, connector (managed',
  '       Cloudflare only, with drift), delivery; each probe has status ok|degraded|unknown and a reason.',
  '       list and status exit 0 once they observed, whatever the health; status exits 1 for an unknown ID.',
];

function timezoneOf(runtime: ReadOnlyCommandRuntime): string {
  return runtime.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** `gws-ea list [--json]`: prints the listing, and returns the exit code. */
export async function runListCommand(
  runtime: ReadOnlyCommandRuntime,
  options: { readonly json: boolean },
): Promise<number> {
  let listing: AssistantListing;
  try {
    listing = await listAssistants(runtime);
    // eslint-disable-next-line no-catch-all/no-catch-all -- The command boundary turns a failure into a redacted message and exit code.
  } catch (error) {
    runtime.stderr(safeErrorMessage(error));
    return FAILED;
  }
  for (const line of options.json ? [JSON.stringify(listing, null, 2)] : renderList(listing)) runtime.stdout(line);
  return OBSERVED;
}

/** `gws-ea status --id <id> [--json]`: prints the observations, and returns the exit code. */
export async function runStatusCommand(
  runtime: ReadOnlyCommandRuntime,
  options: { readonly instanceId: string; readonly json: boolean },
): Promise<number> {
  let status: AssistantStatus;
  try {
    status = await observeAssistantStatus(runtime, options.instanceId);
    // eslint-disable-next-line no-catch-all/no-catch-all -- The command boundary turns a failure into a redacted message and exit code.
  } catch (error) {
    runtime.stderr(safeErrorMessage(error));
    return FAILED;
  }
  const lines = options.json ? [JSON.stringify(status, null, 2)] : renderStatus(status, timezoneOf(runtime));
  for (const line of lines) runtime.stdout(line);
  return OBSERVED;
}
