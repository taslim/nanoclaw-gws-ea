/**
 * `list` and `status` observe assistants built as create leaves them: a
 * registry reservation and journal, a Git checkout detached at its release
 * with its marker and runtime, the release receipt, and the OneCLI Compose
 * file. The host, service manager, Docker, OneCLI, and the callback are
 * faked at their boundaries; Git and SQLite are real.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { writePrivate } from '../community-portal/private-file.js';
import { getInstallScopedNames } from '../install-slug.js';
import { acquireInstanceOperation, recordPrincipalSelection, reserveInstance } from './journal.js';
import { createOnecliRuntimeLayout, renderOnecliCompose } from './onecli-compose.js';
import { wrapperImageTag } from './onecli-gateway-image.js';
import {
  advanceOperation,
  beginOperation,
  closeOperationFailed,
  commitOperationRelease,
  type OperationFollowUp,
  type OperationIntent,
  type OperationKind,
  type OperationPhase,
  type SnapshotManifest,
} from './operation.js';
import { instanceRuntimeFile, resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { PRESENT } from './phases.js';
import type { PrincipalCandidate } from './principal.js';
import { runSanitizedCommand, type SanitizedCommand } from './process.js';
import { redact } from './redact.js';
import { conversionRecordFile } from './release-convert.js';
import { operationName } from './release-layout.js';
import { writeInstanceMarker } from './registry.js';
import { createInstanceRuntimeConfig, persistInstanceRuntime, type HostStatusHelpers } from './service.js';
import type { NanoclawServiceHelpers } from './service-control.js';
import {
  LIST_USAGE,
  PROBE_NAMES,
  STATUS_USAGE,
  runListCommand,
  runStatusCommand,
  type ReadOnlyCommandRuntime,
  type StatusObservers,
} from './status.js';
import { commitAll, git } from './testing/cutover-fixture.js';
import { GwsEaError, releaseOf, type InstanceReservation, type ReleaseCoordinates } from './types.js';
import type { LatestDelivery } from './verify.js';

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const DOCKER = 'unix:///var/run/docker.sock';
const PINS = { gateway: '1.41.3' } as const;
const CREDENTIAL = { name: 'Anthropic', type: 'anthropic', hostPattern: 'api.anthropic.com', headerName: 'x-api-key' };
const MAIN = 'ag-main';
const EXTERNAL_EMAIL = 'ag-external-email';
const SESSION = 'sess-principal';
const LISTENER = '6f1c2b1e-8d4a-4c1e-9b7a-2f3e4d5c6b7a';
const NOW = new Date('2026-09-28T14:30:00.000Z');
const DELIVERED_AT = '2026-09-28T14:00:00.000Z';
const SENTINEL = 'sentinel-secret-value-7f3a9c';

/** The fields `list --json` prints for each assistant, in order, as its help documents them. */
const LIST_FIELDS = [
  'instance_id',
  'hostname',
  'track',
  'deployed_commit',
  'phase',
  'release',
  'service',
  'operation',
  'removal_in_progress',
] as const;

/** The fields `status --json` prints, in order, as its help documents them. */
const STATUS_FIELDS = [
  'instance_id',
  'observed_at',
  'phase',
  'registry',
  'operation',
  'removal_in_progress',
  'release',
  'rollback',
  'schema',
  'probes',
] as const;

/** A schema fingerprint as `status` prints it. */
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;

/** How the machine's shared connector differs from what this tool would run. */
const CONNECTOR_DRIFT = 'it was started with a different connector token';

interface Machine {
  readonly root: string;
  readonly paths: ControlPlanePaths;
  /** The tool's checkout: every assistant here runs its first release. */
  readonly tool: string;
  readonly release: string;
}

async function machine(): Promise<Machine> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gws-ea-status-')));
  roots.push(root);
  const paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'config'),
    stateRoot: path.join(root, 'state'),
  });
  const tool = path.join(root, 'tool');
  await mkdir(tool);
  git(tool, 'init', '--quiet', '-b', 'dogfood');
  await writeFile(path.join(tool, '.gitignore'), 'data/\nlogs/\ngroups/\n.env\n');
  await writeFile(path.join(tool, 'release.txt'), 'first\n');
  return { root, paths, tool, release: commitAll(tool, 'first release') };
}

async function nextRelease(host: Machine): Promise<string> {
  await writeFile(path.join(host.tool, 'release.txt'), 'second\n');
  return commitAll(host.tool, 'second release');
}

interface AssistantOptions {
  readonly label: string;
  readonly port: number;
  readonly ingress: 'existing' | 'managed-cloudflare';
  /** The repository it was created from and the release it runs: the tool's first release unless given. */
  readonly from?: { readonly repository: string; readonly commit: string };
}

/** Each fixture assistant's machine paths, by instance ID. */
const machineOf = new Map<string, ControlPlanePaths>();

/** The assistant's live link, which the host's status and `ncl` run through. */
function liveOf(reservation: InstanceReservation): string {
  return machineOf.get(reservation.instance_id)!.checkoutRoot(reservation.instance_id);
}

/** The assistant's physical state, which holds NanoClaw's `data`. */
function stateOf(reservation: InstanceReservation): string {
  return machineOf.get(reservation.instance_id)!.instanceLayout(reservation.instance_id).state;
}

/**
 * An assistant create finished: its reservation, its release live, its marker and runtime in its state, its
 * release receipt, and its Compose file.
 */
async function assistant(
  host: Machine,
  { label, port, ingress, from = { repository: host.tool, commit: host.release } }: AssistantOptions,
): Promise<InstanceReservation> {
  const { paths } = host;
  const instanceId = randomUUID();
  const callback = `https://${label}.example.test/webhook/gchat`;
  const reserved = await reserveInstance(paths, {
    instance_id: instanceId,
    source_remote: from.repository,
    release_track: 'dogfood',
    deployed_commit: from.commit,
    allocated_ports: { nanoclaw_webhook: port, onecli_app: port + 1, onecli_gateway: port + 2 },
    exclusive_resource_claims: {
      ingress:
        ingress === 'existing'
          ? { mode: 'existing', endpoint_url: callback }
          : {
              mode: 'managed-cloudflare',
              account_id: 'a'.repeat(32),
              zone_id: 'b'.repeat(32),
              zone_name: 'example.test',
              hostname: `${label}.example.test`,
              callback_url: callback,
              dns_record_id: 'd'.repeat(31) + String(port % 10),
            },
      gcp_project_id: `status-${port}`,
      gcp_account: 'operator@example.test',
      gchat_service_account: `gws-ea-chat@status-${port}.iam.gserviceaccount.com`,
      workspace_email: `${label}@example.test`,
      onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
    },
  });
  machineOf.set(instanceId, paths);
  const release = from.commit.slice(0, 8);
  const checkout = paths.instanceLayout(instanceId).release(release);
  git(host.root, 'clone', '--quiet', from.repository, checkout);
  git(checkout, 'checkout', '--quiet', '--detach', from.commit);
  await symlink(release, paths.checkoutRoot(instanceId));
  await writeInstanceMarker(paths, instanceId);
  const onecli = createOnecliRuntimeLayout({
    instanceId,
    instanceRoot: paths.instanceRoot(instanceId),
    project: reserved.exclusive_resource_claims.onecli_project,
    appPort: reserved.allocated_ports.onecli_app,
    gatewayPort: reserved.allocated_ports.onecli_gateway,
    dockerEndpoint: DOCKER,
  });
  await persistInstanceRuntime(
    createInstanceRuntimeConfig(paths, reserved, onecli, {
      nodePath: process.execPath,
      homeDirectory: host.root,
      selectedProvider: 'claude',
      dockerEndpoint: DOCKER,
    }),
    () => undefined,
  );
  const receipt = paths.releasePreflightFile(instanceId, from.commit);
  await mkdir(path.dirname(receipt), { recursive: true, mode: 0o700 });
  await writeFile(
    receipt,
    `${JSON.stringify({
      schema_version: 1,
      instance_id: instanceId,
      deployed_commit: from.commit,
      provider: 'claude',
      providerCredential: CREDENTIAL,
      packageManager: 'pnpm@10.34.5',
      onecli: { ...PINS, sdk: '0.4.0' },
    })}\n`,
    { mode: 0o600 },
  );
  await mkdir(onecli.rootDirectory, { recursive: true, mode: 0o700 });
  await writeFile(onecli.composeFile, renderOnecliCompose(onecli, PINS, wrapperImageTag('0'.repeat(16))), {
    mode: 0o600,
  });
  return reserved;
}

function principal(): PrincipalCandidate {
  return {
    messagingGroupId: 'mg-principal',
    platformId: 'gchat:spaces/dm-principal',
    userId: 'gchat:users/principal',
    senderName: 'Principal',
    authenticatedMessageId: 'spaces/dm-principal/messages/first',
    authenticatedMessageAt: new Date().toISOString(),
  };
}

/** The principal conversation bind_principal fixed in the journal. */
async function bound(paths: ControlPlanePaths, instanceId: string): Promise<void> {
  const operation = await acquireInstanceOperation(paths, instanceId);
  if (!operation) throw new Error('The test instance operation was busy');
  try {
    await recordPrincipalSelection(operation, principal());
  } finally {
    operation.release();
  }
}

/** The rollback point an update left: the release it left, and the snapshot it took, whose schema is `manifest`. */
async function keepRollbackPoint(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
  commit: string,
  manifest: SnapshotManifest = MANIFEST,
): Promise<void> {
  await writePrivate(paths.rollbackPointFile(reservation.instance_id), {
    schema_version: 1,
    instance_id: reservation.instance_id,
    release: { ...releaseOf(reservation), deployed_commit: commit },
    snapshot: operationName(NOW.toISOString()),
    manifest,
    taken_at: NOW.toISOString(),
  });
}

/** The release an update to `to` is moving this assistant towards, unfinished at `phase`. */
async function updateUnfinishedAt(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
  to: ReleaseCoordinates,
  phase: Exclude<OperationPhase, 'committed'> = 'fenced',
) {
  const operation = await acquireInstanceOperation(paths, reservation.instance_id, { command: 'update', target: to });
  if (!operation) throw new Error('The test instance operation was busy');
  try {
    await beginOperation(operation, { kind: 'update', from: releaseOf(reservation), to });
    await advanceOperation(operation, phase, { stop: { at: NOW.toISOString(), graceful: true } });
  } finally {
    operation.release();
  }
}

/** An update or rollback to `to` whose release is recorded, with `followUp` still to run. */
async function recordedWith(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
  { kind, to, followUp }: { kind: OperationKind; to: ReleaseCoordinates; followUp: OperationFollowUp },
): Promise<void> {
  const intent: OperationIntent = kind === 'update' ? { command: 'update', target: to } : { command: 'rollback' };
  const operation = await acquireInstanceOperation(paths, reservation.instance_id, intent);
  if (!operation) throw new Error('The test instance operation was busy');
  try {
    await beginOperation(operation, { kind, from: releaseOf(reservation), to });
    await advanceOperation(operation, 'verified', {
      stop: { at: NOW.toISOString(), graceful: true },
      manifest: MANIFEST,
      ...(kind === 'rollback' ? { mode: 'code_only' as const } : {}),
      follow_ups: [followUp],
    });
    await commitOperationRelease(operation);
  } finally {
    operation.release();
  }
}

/** A removal cut short: its receipt, which removal writes before it removes anything. */
async function removalStarted(paths: ControlPlanePaths, reservation: InstanceReservation): Promise<void> {
  await writePrivate(paths.removalFile(reservation.instance_id), {
    instance_id: reservation.instance_id,
    reservation,
    started_at: NOW.toISOString(),
  });
}

/**
 * An assistant still on the layout before releases: its registry entry
 * records the checkout that layout kept under `instances/<id>/`, and nothing
 * of it is in a short root.
 */
async function legacyAssistant(host: Machine, options: AssistantOptions): Promise<InstanceReservation> {
  const reservation = await assistant(host, options);
  const id = reservation.instance_id;
  await rm(host.paths.instanceRoot(id), { recursive: true, force: true });
  const registry = JSON.parse(await readFile(host.paths.registryFile, 'utf8')) as {
    instances: Record<string, Record<string, unknown>>;
  };
  const checkout = path.join(host.paths.stateRoot, 'instances', id, 'nanoclaw');
  registry.instances[id] = { ...registry.instances[id], checkout_realpath: checkout };
  await writePrivate(host.paths.registryFile, registry);
  return { ...reservation, checkout_realpath: checkout };
}

/** An update to `to` with no release to return to, whose release started and failed: closed for fix-forward. */
async function updateFailedWithoutReturn(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
  to: ReleaseCoordinates,
): Promise<void> {
  const operation = await acquireInstanceOperation(paths, reservation.instance_id, { command: 'update', target: to });
  if (!operation) throw new Error('The test instance operation was busy');
  try {
    await beginOperation(operation, { kind: 'update', from: releaseOf(reservation), to, no_rollback_target: true });
    await advanceOperation(operation, 'started', { stop: { at: NOW.toISOString(), graceful: true } });
    await closeOperationFailed(operation);
  } finally {
    operation.release();
  }
}

/** NanoClaw's install slug for an assistant: its instance ID without dashes. */
function installOf(reservation: InstanceReservation): string {
  return reservation.instance_id.replaceAll('-', '');
}

/** The agent image the release an assistant was created on runs, `<base>:r-<release>`. */
function liveImageOf(reservation: InstanceReservation): string {
  return `${getInstallScopedNames(installOf(reservation)).containerImageBase}:r-${reservation.deployed_commit.slice(0, 8)}`;
}

/** What each fake boundary reports, and what reached it. */
interface World {
  /** Installs with a NanoClaw service defined, by install slug. */
  readonly installed: ReadonlySet<string>;
  /** Installs whose service runs. */
  readonly active: Set<string>;
  /** Checkouts whose host answers on its socket, its webhook, and `ncl`. */
  readonly serving: Set<string>;
  readonly ports: Map<string, number>;
  /** The agent image tags Docker holds. */
  readonly images: Set<string>;
  readonly commands: SanitizedCommand[];
  readonly serviceEnvironments: NodeJS.ProcessEnv[];
}

function world(...assistants: readonly InstanceReservation[]): World {
  const checkouts = assistants.map(liveOf);
  return {
    installed: new Set(assistants.map(installOf)),
    active: new Set(assistants.map(installOf)),
    serving: new Set(checkouts),
    ports: new Map(
      assistants.map((reservation) => [liveOf(reservation), reservation.allocated_ports.nanoclaw_webhook]),
    ),
    images: new Set(assistants.map(liveImageOf)),
    commands: [],
    serviceEnvironments: [],
  };
}

function unused(): never {
  throw new Error('list and status never change a service');
}

/**
 * NanoClaw's service helpers, faked as its detection finds a service: by the
 * install slug and the home its definition lives under, which name launchd's
 * label and plist, never by the checkout.
 */
function serviceHelpers(state: World, home: string): NanoclawServiceHelpers {
  return {
    createCommandRunner: ({ env }) => {
      state.serviceEnvironments.push(env);
      return { run: unused, tryRun: unused };
    },
    detectService: (_root, env) => {
      if (env.home !== home || !state.installed.has(env.installSlug)) return { mode: 'none', active: false };
      const label = `com.nanoclaw-v2-${env.installSlug}`;
      return {
        mode: 'launchd',
        name: label,
        definition: path.join(env.home, 'Library', 'LaunchAgents', `${label}.plist`),
        active: state.active.has(env.installSlug),
      };
    },
    stopService: async () => unused(),
    startService: unused,
    drainContainers: async () => unused(),
    verifyServiceHealth: async () => unused(),
  };
}

function hostStatus(state: World): HostStatusHelpers {
  return {
    queryHost: async (root) => {
      if (!state.serving.has(root)) throw new Error('NanoClaw is not running; see logs/nanoclaw.error.log');
      return {
        pid: 4242,
        webhook: { port: state.ports.get(root), paths: ['/webhook/gchat'] },
        channels: [{ instance: 'gchat', connected: true }],
      };
    },
    waitForHost: async () => unused(),
  };
}

/** The callback as the internet reaches it: the host's listener answers while it serves, behind a working route. */
function callbackFetch(state: World): typeof globalThis.fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const local = url.hostname === '127.0.0.1';
    const serving = local
      ? [...state.ports].some(([root, port]) => String(port) === url.port && state.serving.has(root))
      : state.serving.size > 0;
    if (!serving) {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      });
    }
    if (init?.method === 'GET') return new Response('not found', { status: 404 });
    return new Response('', { status: 401, headers: { 'x-nanoclaw-webhook-id': LISTENER } });
  };
}

function ncl(state: World): StatusObservers['ncl'] {
  return async (runtime, args) => {
    if (!state.serving.has(runtime.checkout_root)) {
      throw new GwsEaError('command_failed', 'ncl exited with code 1', { details: { exitCode: 1 } });
    }
    switch (args.join(' ')) {
      case 'gws-ea-profile get':
        return { main_agent_group_id: MAIN, assistant_display_name: 'Aya' };
      case 'gws-ea-external-email health':
        return { agent_group_id: EXTERNAL_EMAIL, problems: [] };
      case 'gws-ea-inbox health':
        return HEALTHY_INBOX;
      case `groups get --id ${MAIN}`:
        return { id: MAIN, name: 'main' };
      case `groups config get --id ${MAIN}`:
        return { agent_group_id: MAIN, provider: 'claude' };
      default:
        throw new Error(`unexpected ncl ${args.join(' ')}`);
    }
  };
}

/** The inbox as the host's `getInboxHealth` reports a working one. */
const HEALTHY_INBOX = {
  state: 'healthy',
  reason: null,
  since: null,
  lastSuccessAt: '2026-09-28T14:29:00.000Z',
  consecutiveFailures: 0,
  calendarNotifications: { state: 'ok', reason: null },
} as const;

/** OneCLI's agents: main granted every secret, external-email in selective mode. */
const onecliAgents: StatusObservers['onecliAgents'] = async () => [
  { id: 'agent-main', identifier: MAIN, name: 'main', secretMode: 'all' },
  { id: 'agent-ee', identifier: EXTERNAL_EMAIL, name: 'external-email', secretMode: 'selective' },
];

const MANIFEST: SnapshotManifest = {
  central_migrations: ['initial-v2-schema', 'host-coordination'],
  session_tables: { 'inbound.delivered': ['delivered_at', 'message_out_id', 'status'] },
};

const DELIVERED: LatestDelivery = {
  mainAgentGroupId: MAIN,
  sessionId: SESSION,
  last: { messageOutId: 'out-welcome', status: 'delivered', at: DELIVERED_AT },
  retrying: 0,
  lastError: undefined,
};

/** Git for real; Docker answers that nothing runs, and holds the images `state` names. Every command is recorded. */
function recordingRunner(state: World): StatusObservers['runCommand'] {
  return async (command) => {
    state.commands.push(command);
    if (command.command === 'git') return runSanitizedCommand(command);
    if (command.command === 'docker' && command.args.slice(0, 2).join(' ') === 'image ls') {
      return { stdout: state.images.has(command.args.at(-1) ?? '') ? `sha256:${'0'.repeat(64)}\n` : '', stderr: '' };
    }
    if (command.command === 'docker') return { stdout: '', stderr: '' };
    throw new Error(`unexpected command ${command.command}`);
  };
}

/** A healthy assistant's boundaries: everything observed through `state`. */
function healthyObservers(state: World): StatusObservers {
  return {
    runCommand: recordingRunner(state),
    fetch: callbackFetch(state),
    ncl: ncl(state),
    onecliAgents,
    onecli: async () => PRESENT,
    connector: async () => ({ status: 'present' }),
    principalBinding: (input) => ({
      status: 'matched',
      agentGroupId: MAIN,
      candidate: input.selectedCandidate ?? principal(),
      welcomeEventId: 'gws-ea-welcome:stable',
    }),
    schema: () => MANIFEST,
    delivery: () => DELIVERED,
    google: async (_runtime, declaredEmail) => ({ status: 'connected', account: declaredEmail }),
  };
}

interface Output {
  readonly stdout: string[];
  readonly stderr: string[];
}

function command(host: Machine, state: World, observers: Partial<StatusObservers> = healthyObservers(state)) {
  const output: Output = { stdout: [], stderr: [] };
  const runtime: ReadOnlyCommandRuntime = {
    paths: host.paths,
    stdout: (line) => output.stdout.push(line),
    stderr: (line) => output.stderr.push(line),
    serviceHelpers: serviceHelpers(state, host.root),
    hostStatus: hostStatus(state),
    observers,
    toolRoot: host.tool,
    now: () => NOW,
    timezone: 'America/New_York',
    platform: 'darwin',
    uid: 501,
  };
  return { runtime, output };
}

async function statusJson(host: Machine, state: World, instanceId: string, observers?: Partial<StatusObservers>) {
  const { runtime, output } = command(host, state, observers);
  const exitCode = await runStatusCommand(runtime, { instanceId, json: true });
  return { exitCode, status: JSON.parse(output.stdout.join('\n')) as Record<string, unknown> & StatusShape, output };
}

type ProbeShape = { status: string; reason: string | null } & Record<string, unknown>;
interface StatusShape {
  probes: Record<string, ProbeShape>;
  release: Record<string, unknown>;
  rollback: Record<string, unknown>;
  operation: Record<string, unknown>;
  schema: Record<string, unknown>;
}

describe('status', () => {
  it('reports every probe as ok for a healthy assistant, with its release, rollback, and schema facts', async () => {
    const host = await machine();
    const reservation = await assistant(host, { label: 'alpha', port: 36_001, ingress: 'managed-cloudflare' });
    await bound(host.paths, reservation.instance_id);
    // Beside the healthy host: a removal cut short, and a drifted shared connector.
    await removalStarted(host.paths, reservation);
    const state = world(reservation);

    const { exitCode, status } = await statusJson(host, state, reservation.instance_id, {
      ...healthyObservers(state),
      connector: async () => ({ status: 'present', drift: CONNECTOR_DRIFT }),
    });

    expect(exitCode).toBe(0);
    expect(Object.keys(status.probes)).toEqual([...PROBE_NAMES]);
    for (const name of PROBE_NAMES) expect(status.probes[name], name).toMatchObject({ status: 'ok', reason: null });
    expect(status.probes.checkout).toMatchObject({ commit: host.release });
    expect(status.probes.image).toEqual({ status: 'ok', reason: null, tag: liveImageOf(reservation) });
    expect(status.probes.service).toMatchObject({ state: 'running' });
    expect(status.probes.main_identity).toMatchObject({ agent_group_id: MAIN });
    expect(status.probes.inbox).toEqual({
      status: 'ok',
      reason: null,
      state: 'healthy',
      since: null,
      last_success_at: HEALTHY_INBOX.lastSuccessAt,
      calendar_notifications: { state: 'ok', reason: null },
    });
    // A shared connector's drift is reported, never counted against this assistant (KTD11).
    expect(status.probes.connector).toEqual({ status: 'ok', reason: null, drift: CONNECTOR_DRIFT });
    expect(status.probes.delivery).toMatchObject({
      last: { status: 'delivered', message_out_id: 'out-welcome', at: DELIVERED_AT },
      retrying: 0,
    });
    expect(status).toMatchObject({
      instance_id: reservation.instance_id,
      observed_at: NOW.toISOString(),
      phase: { state: 'live', release: host.release.slice(0, 8) },
      registry: {
        hostname: 'alpha.example.test',
        endpoint_url: 'https://alpha.example.test/webhook/gchat',
        ingress_mode: 'managed-cloudflare',
        track: 'dogfood',
        source_remote: host.tool,
        deployed_commit: host.release,
      },
      operation: { state: 'none' },
      removal_in_progress: true,
      release: { deployed_commit: host.release, tool_commit: host.release, behind_tool_release: false, reason: null },
      rollback: {
        available: false,
        previous_commit: null,
        schema_moved: null,
        reason: `Assistant ${reservation.instance_id} keeps no rollback point, so there is nothing to roll back to.`,
      },
      schema: {
        central_fingerprint: expect.stringMatching(FINGERPRINT),
        session_fingerprint: expect.stringMatching(FINGERPRINT),
        latest_migration: 'host-coordination',
        reason: null,
      },
    });
  });

  it('reports a stopped host as a stopped service and an unreachable host, and still reports every other probe', async () => {
    const host = await machine();
    const reservation = await assistant(host, { label: 'alpha', port: 36_001, ingress: 'managed-cloudflare' });
    await bound(host.paths, reservation.instance_id);
    const state = world(reservation);
    state.active.clear();
    state.serving.clear();

    const { exitCode, status } = await statusJson(host, state, reservation.instance_id);

    expect(exitCode).toBe(0);
    expect(status.probes.service).toEqual({ status: 'degraded', reason: 'Its service is stopped.', state: 'stopped' });
    expect(status.probes.host).toEqual({
      status: 'degraded',
      reason: `The host is unreachable: NanoClaw is not running; see ${host.paths.instanceRoot(reservation.instance_id)}/logs/nanoclaw.error.log`,
    });
    expect(status.probes.main_identity).toMatchObject({ status: 'unknown', agent_group_id: null });
    expect(status.probes.route).toMatchObject({ status: 'degraded', reason: expect.stringMatching(/local listener/u) });
    for (const name of ['checkout', 'onecli', 'principal', 'connector', 'delivery']) {
      expect(status.probes[name], name).toMatchObject({ status: 'ok' });
    }
  });

  it("reports a Google connection that stopped working as the workspace probe's failure, naming the account", async () => {
    const host = await machine();
    const reservation = await assistant(host, { label: 'alpha', port: 36_001, ingress: 'existing' });
    await bound(host.paths, reservation.instance_id);
    const state = world(reservation);
    const reason = `Google no longer accepts the sign-in; connect it with gws-ea connect-google --id ${reservation.instance_id}`;

    const { exitCode, status } = await statusJson(host, state, reservation.instance_id, {
      ...healthyObservers(state),
      google: async (_runtime, declaredEmail) => ({ status: 'degraded', account: declaredEmail, reason }),
    });

    expect(exitCode).toBe(0);
    expect(status.probes.workspace).toEqual({
      status: 'degraded',
      reason,
      account: reservation.exclusive_resource_claims.workspace_email,
    });
    for (const name of Object.keys(status.probes).filter((probe) => probe !== 'workspace')) {
      expect(status.probes[name], name).toMatchObject({ status: 'ok' });
    }
  });

  it("reports main's identity as unknown, not degraded, when OneCLI does not answer for its agents", async () => {
    const host = await machine();
    const reservation = await assistant(host, { label: 'alpha', port: 36_001, ingress: 'existing' });
    await bound(host.paths, reservation.instance_id);
    const state = world(reservation);
    const refusal = 'OneCLI refused the agent list (HTTP 503)';

    const { exitCode, status } = await statusJson(host, state, reservation.instance_id, {
      ...healthyObservers(state),
      onecliAgents: async () => {
        throw new GwsEaError('onecli_request_failed', refusal);
      },
    });

    expect(exitCode).toBe(0);
    expect(status.probes.main_identity).toMatchObject({ status: 'unknown', reason: refusal });
  });

  it("reports a OneCLI unsafe-image refusal as that probe's failure without aborting the others", async () => {
    const host = await machine();
    const reservation = await assistant(host, { label: 'alpha', port: 36_001, ingress: 'existing' });
    await bound(host.paths, reservation.instance_id);
    const state = world(reservation);
    const refusal = 'OneCLI gateway image gws-ea-onecli-gateway:0 provenance label does not match its build content';

    const { exitCode, status } = await statusJson(host, state, reservation.instance_id, {
      ...healthyObservers(state),
      onecli: async () => {
        throw new GwsEaError('unsafe_onecli_image', refusal);
      },
    });

    expect(exitCode).toBe(0);
    expect(status.probes.onecli).toEqual({ status: 'degraded', reason: refusal });
    // An operator-managed endpoint has no connector to observe.
    expect(Object.keys(status.probes)).toEqual(PROBE_NAMES.filter((name) => name !== 'connector'));
    for (const name of Object.keys(status.probes).filter((probe) => probe !== 'onecli')) {
      expect(status.probes[name], name).toMatchObject({ status: 'ok' });
    }
  });

  it('reports external-email as the host reports it', async () => {
    const host = await machine();
    const reservation = await assistant(host, { label: 'alpha', port: 36_001, ingress: 'existing' });
    await bound(host.paths, reservation.instance_id);
    const state = world(reservation);
    const healthy = healthyObservers(state);
    const reporting =
      (health: unknown): StatusObservers['ncl'] =>
      async (runtime, args) =>
        args.join(' ') === 'gws-ea-external-email health' ? health : healthy.ncl(runtime, args);

    const ok = await statusJson(host, state, reservation.instance_id);
    expect(ok.status.probes.external_email).toEqual({ status: 'ok', reason: null, agent_group_id: EXTERNAL_EMAIL });

    const drifted = await statusJson(host, state, reservation.instance_id, {
      ...healthy,
      ncl: reporting({
        agent_group_id: EXTERNAL_EMAIL,
        problems: ['its configuration carries packages', 'destination main -> helper joins main and external-email'],
      }),
    });
    expect(drifted.status.probes.external_email).toEqual({
      status: 'degraded',
      reason: 'Its configuration carries packages. Destination main -> helper joins main and external-email.',
      agent_group_id: EXTERNAL_EMAIL,
    });

    const missing = await statusJson(host, state, reservation.instance_id, {
      ...healthy,
      ncl: reporting({ agent_group_id: null, problems: ['external-email has not been created'] }),
    });
    expect(missing.status.probes.external_email).toEqual({
      status: 'degraded',
      reason: 'External-email has not been created.',
      agent_group_id: null,
    });
    for (const name of Object.keys(missing.status.probes).filter((probe) => probe !== 'external_email')) {
      expect(missing.status.probes[name], name).toMatchObject({ status: 'ok' });
    }
  });

  it('reports the inbox as the host reports it, degraded while it fails, while calendar news is not on yet, or when its report is invalid', async () => {
    const host = await machine();
    const reservation = await assistant(host, { label: 'alpha', port: 36_001, ingress: 'existing' });
    await bound(host.paths, reservation.instance_id);
    const state = world(reservation);
    const healthy = healthyObservers(state);
    const reporting = (health: unknown) => ({
      ...healthy,
      ncl: (async (runtime, args) =>
        args.join(' ') === 'gws-ea-inbox health'
          ? health
          : healthy.ncl(runtime, args)) satisfies StatusObservers['ncl'],
    });

    const ok = command(host, state);
    await runStatusCommand(ok.runtime, { instanceId: reservation.instance_id, json: false });
    expect(ok.output.stdout).toContainEqual(expect.stringMatching(/^ {2}ok {8}inbox {11}last polled /u));

    const unhealthySince = '2026-09-28T13:00:00.000Z';
    const failing = await statusJson(
      host,
      state,
      reservation.instance_id,
      reporting({
        ...HEALTHY_INBOX,
        state: 'unhealthy',
        reason: 'Gmail answered 401',
        since: unhealthySince,
        calendarNotifications: { state: 'failing', reason: 'the calendar list refused the change' },
      }),
    );
    expect(failing.status.probes.inbox).toEqual({
      status: 'degraded',
      reason:
        'The inbox is unhealthy: Gmail answered 401. ' +
        "Calendar notifications for the principal's calendars could not be turned on: the calendar list refused the change.",
      state: 'unhealthy',
      since: unhealthySince,
      last_success_at: HEALTHY_INBOX.lastSuccessAt,
      calendar_notifications: { state: 'failing', reason: 'the calendar list refused the change' },
    });
    for (const name of Object.keys(failing.status.probes).filter((probe) => probe !== 'inbox')) {
      expect(failing.status.probes[name], name).toMatchObject({ status: 'ok' });
    }

    // Before the host first turns calendar notifications on, the inbox is not yet whole.
    const calendarPending = await statusJson(
      host,
      state,
      reservation.instance_id,
      reporting({ ...HEALTHY_INBOX, calendarNotifications: { state: 'unknown', reason: null } }),
    );
    expect(calendarPending.status.probes.inbox).toMatchObject({
      status: 'degraded',
      reason: "Calendar notifications for the principal's calendars are not on yet.",
      state: 'healthy',
    });

    const invalid = await statusJson(host, state, reservation.instance_id, reporting({ ...HEALTHY_INBOX, reason: 42 }));
    expect(invalid.status.probes.inbox).toEqual({
      status: 'degraded',
      reason: 'ncl returned an invalid inbox report',
      state: null,
      since: null,
      last_success_at: null,
      calendar_notifications: null,
    });
  });

  it("reports an assistant behind the tool's release with both commits", async () => {
    const host = await machine();
    const reservation = await assistant(host, { label: 'alpha', port: 36_001, ingress: 'existing' });
    const toolRelease = await nextRelease(host);
    const state = world(reservation);

    const { status } = await statusJson(host, state, reservation.instance_id);
    const { runtime, output } = command(host, state);
    await runStatusCommand(runtime, { instanceId: reservation.instance_id, json: false });

    expect(status.release).toEqual({
      deployed_commit: host.release,
      tool_commit: toolRelease,
      behind_tool_release: true,
      reason: null,
    });
    const text = output.stdout.join('\n');
    expect(text).toContain(host.release.slice(0, 12));
    expect(text).toContain(toolRelease.slice(0, 12));
    expect(text).toContain(`gws-ea update --id ${reservation.instance_id}`);
  });

  it('reports the rollback point, whether either schema moved since its snapshot, and a fingerprint of each', async () => {
    const host = await machine();
    const reservation = await assistant(host, { label: 'alpha', port: 36_001, ingress: 'existing' });
    const previousCommit = 'e'.repeat(40);
    await keepRollbackPoint(host.paths, reservation, previousCommit);
    const state = world(reservation);
    // The rollback point's snapshot records MANIFEST; each case sets what the live state's databases record.
    let live = MANIFEST;
    const observers: Partial<StatusObservers> = {
      ...healthyObservers(state),
      schema: (root) => (root === stateOf(reservation) ? live : MANIFEST),
    };
    const observe = async (manifest: SnapshotManifest): Promise<StatusShape> => {
      live = manifest;
      return (await statusJson(host, state, reservation.instance_id, observers)).status;
    };

    const unmoved = await observe(MANIFEST);
    const central = await observe({
      ...MANIFEST,
      central_migrations: [...MANIFEST.central_migrations, 'agent-grants'],
    });
    const session = await observe({
      ...MANIFEST,
      session_tables: { ...MANIFEST.session_tables, 'inbound.messages_in': ['id', 'on_wake'] },
    });

    expect(unmoved.rollback).toEqual({
      available: true,
      previous_commit: previousCommit,
      schema_moved: false,
      reason: null,
    });
    // Either schema moving alone makes a rollback restore the pre-update snapshot (KTD5).
    expect(central.rollback).toMatchObject({ available: true, previous_commit: previousCommit, schema_moved: true });
    expect(session.rollback).toMatchObject({ available: true, previous_commit: previousCommit, schema_moved: true });
    // Each fingerprint follows its own schema alone.
    expect(central.schema.central_fingerprint).not.toBe(unmoved.schema.central_fingerprint);
    expect(central.schema.session_fingerprint).toBe(unmoved.schema.session_fingerprint);
    expect(session.schema.session_fingerprint).not.toBe(unmoved.schema.session_fingerprint);
    expect(session.schema.central_fingerprint).toBe(unmoved.schema.central_fingerprint);
  });

  it.each([
    ['that names another assistant', 'other', /is not its own/u],
    ['that cannot be read', 'torn', /Rollback point/u],
  ] as const)('offers no rollback for a rollback point %s', async (_label, flaw, why) => {
    const host = await machine();
    const reservation = await assistant(host, { label: 'alpha', port: 36_001, ingress: 'existing' });
    const file = host.paths.rollbackPointFile(reservation.instance_id);
    await keepRollbackPoint(host.paths, reservation, 'e'.repeat(40));
    if (flaw === 'torn') await writeFile(file, '{torn', { mode: 0o600 });
    else {
      const point = JSON.parse(await readFile(file, 'utf8')) as object;
      await writePrivate(file, { ...point, instance_id: randomUUID() });
    }

    const { status } = await statusJson(host, world(reservation), reservation.instance_id);

    expect(status.rollback).toEqual({
      available: false,
      previous_commit: null,
      schema_moved: null,
      reason: expect.stringMatching(why),
    });
  });

  it('renders its observations as text, with times in the install timezone', async () => {
    const host = await machine();
    const reservation = await assistant(host, { label: 'alpha', port: 36_001, ingress: 'managed-cloudflare' });
    await bound(host.paths, reservation.instance_id);
    const state = world(reservation);
    const { runtime, output } = command(host, state, {
      ...healthyObservers(state),
      connector: async () => ({ status: 'present', drift: CONNECTOR_DRIFT }),
    });

    expect(await runStatusCommand(runtime, { instanceId: reservation.instance_id, json: false })).toBe(0);

    const text = output.stdout.join('\n');
    expect(text).toContain(`Assistant ${reservation.instance_id}`);
    expect(text).toContain('Observed: Sep 28, 2026, 10:30 AM');
    expect(text).toContain('Sep 28, 2026, 10:00 AM');
    for (const name of PROBE_NAMES) expect(text).toMatch(new RegExp(`^ {2}ok +${name}\\b`, 'mu'));
    expect(text).toMatch(
      new RegExp(`^ {2}ok +connector +${CONNECTOR_DRIFT}; it is shared, so it is left as it is$`, 'mu'),
    );
    expect(output.stderr).toEqual([]);
  });

  it.each([
    ['update', { kind: 'rebuild_group_image', agent_group_id: 'ag-research' }],
    ['rollback', { kind: 'prune' }],
  ] as const)("names a committed %s's own command as the one that retries its follow-ups", async (kind, followUp) => {
    const host = await machine();
    const reservation = await assistant(host, { label: 'alpha', port: 36_001, ingress: 'existing' });
    const to: ReleaseCoordinates = { ...releaseOf(reservation), deployed_commit: 'c'.repeat(40) };
    await recordedWith(host.paths, reservation, { kind, to, followUp });
    const { runtime, output } = command(host, world(reservation));

    expect(await runStatusCommand(runtime, { instanceId: reservation.instance_id, json: false })).toBe(0);

    // After a rollback, update --id would go on to stage a new update rather than only retry its follow-ups.
    expect(output.stdout).toContain(
      `  Operation: Its ${kind} to ${'c'.repeat(12)} is committed, with follow-ups still to run: ${followUp.kind}; ` +
        `the next gws-ea ${kind} --id ${reservation.instance_id} retries them.`,
    );
  });

  it('names a host never started as such', async () => {
    const host = await machine();
    const unstarted = await assistant(host, { label: 'beta', port: 36_011, ingress: 'existing' });
    // Its host never started, so it has no runtime record.
    await rm(instanceRuntimeFile(stateOf(unstarted)));
    const state = world(unstarted);
    const neverStarted = 'The assistant has no runtime record: its host has never been started.';

    const { status } = await statusJson(host, state, unstarted.instance_id);
    const listed = command(host, state);
    expect(await runListCommand(listed.runtime, { json: true })).toBe(0);
    const listing = JSON.parse(listed.output.stdout.join('\n')) as { assistants: Array<{ service: unknown }> };

    expect(status.probes.service).toEqual({ status: 'unknown', reason: neverStarted, state: 'unknown' });
    expect(listing.assistants.map(({ service }) => service)).toEqual([{ state: 'unknown', reason: neverStarted }]);
  });

  it('says an assistant a switch has fenced is fenced, observing its state and service physically', async () => {
    const host = await machine();
    const reservation = await assistant(host, { label: 'alpha', port: 36_001, ingress: 'existing' });
    await bound(host.paths, reservation.instance_id);
    // A switch has removed the live link; the runtime record and the databases stay in the assistant's state.
    await rm(liveOf(reservation));
    const state = world(reservation);
    state.active.clear();
    state.serving.clear();
    const read: string[] = [];
    const observers: Partial<StatusObservers> = {
      ...healthyObservers(state),
      schema: (root) => {
        read.push(root);
        return MANIFEST;
      },
      delivery: (root) => {
        read.push(root);
        return DELIVERED;
      },
    };

    const { exitCode, status } = await statusJson(host, state, reservation.instance_id, observers);
    const text = command(host, state, observers);
    expect(await runStatusCommand(text.runtime, { instanceId: reservation.instance_id, json: false })).toBe(0);
    const listed = command(host, state, observers);
    expect(await runListCommand(listed.runtime, { json: false })).toBe(0);

    expect(exitCode).toBe(0);
    expect(status).toMatchObject({ phase: { state: 'fenced' }, operation: { state: 'none' } });
    expect(new Set(read)).toEqual(new Set([stateOf(reservation)]));
    expect(status.probes.service).toEqual({ status: 'degraded', reason: 'Its service is stopped.', state: 'stopped' });
    expect(status.schema).toMatchObject({ latest_migration: 'host-coordination', reason: null });
    for (const name of ['onecli', 'principal', 'delivery'])
      expect(status.probes[name], name).toMatchObject({ status: 'ok' });
    expect(status.probes.checkout).toMatchObject({
      status: 'degraded',
      reason: `Assistant ${reservation.instance_id} has no live release: a switch has fenced it.`,
    });
    expect(status.probes.image).toEqual({
      status: 'unknown',
      reason: 'No release is live, so no agent image is in use.',
      tag: null,
    });
    expect(text.output.stdout).toContain(
      '  Phase:     No release is live: a switch has fenced it, so nothing can start its host.',
    );
    expect(listed.output.stdout.join('\n')).toMatch(
      new RegExp(
        `^${reservation.instance_id} +\\S+ +dogfood +${host.release.slice(0, 12)} +no +stopped +fenced +-$`,
        'mu',
      ),
    );
  });

  it("reports the live release's agent image as degraded when its tag is gone", async () => {
    const host = await machine();
    const reservation = await assistant(host, { label: 'alpha', port: 36_001, ingress: 'existing' });
    const state = world(reservation);
    state.images.clear();

    const { status } = await statusJson(host, state, reservation.instance_id);

    const tag = liveImageOf(reservation);
    expect(status.probes.image).toEqual({
      status: 'degraded',
      reason: `Its agent image ${tag} is missing, so no agent can start.`,
      tag,
    });
  });

  it('shows an assistant on the legacy layout by its record alone, with the update that converts it', async () => {
    const host = await machine();
    const reservation = await legacyAssistant(host, { label: 'alpha', port: 36_001, ingress: 'existing' });
    const state = world();
    const id = reservation.instance_id;
    const legacy = `It is on the legacy layout: run gws-ea update --id ${id} to convert it.`;

    const { exitCode, status } = await statusJson(host, state, id);
    const text = command(host, state);
    expect(await runStatusCommand(text.runtime, { instanceId: id, json: false })).toBe(0);
    const json = command(host, state);
    expect(await runListCommand(json.runtime, { json: true })).toBe(0);
    const listed = command(host, state);
    expect(await runListCommand(listed.runtime, { json: false })).toBe(0);

    expect(exitCode).toBe(0);
    expect(Object.keys(status)).toEqual(
      STATUS_FIELDS.filter((field) => !['rollback', 'schema', 'probes'].includes(field)),
    );
    expect(status).toMatchObject({
      phase: { state: 'legacy', convert_with: `gws-ea update --id ${id}` },
      registry: { deployed_commit: host.release },
      operation: { state: 'none' },
      release: { deployed_commit: host.release, behind_tool_release: false },
    });
    expect(text.output.stdout).toContain(`  Phase:     ${legacy}`);
    expect(text.output.stdout).not.toContain('Probes:');
    const listing = JSON.parse(json.output.stdout.join('\n')) as { assistants: Array<Record<string, unknown>> };
    expect(listing.assistants).toEqual([
      expect.objectContaining({
        phase: { state: 'legacy', convert_with: `gws-ea update --id ${id}` },
        service: { state: 'unknown', reason: legacy },
      }),
    ]);
    const lines = listed.output.stdout.join('\n');
    expect(lines).toMatch(
      new RegExp(`^${id} +\\S+ +dogfood +${host.release.slice(0, 12)} +no +unknown +legacy +-$`, 'mu'),
    );
    expect(listed.output.stdout).toContain(`${id}: ${legacy}`);
    // Nothing of its service or host was asked: only the tool's own history, to place its release.
    expect(state.serviceEnvironments).toEqual([]);
    expect(new Set(state.commands.map(({ command: tool }) => tool))).toEqual(new Set(['git']));
  });

  it('says converting while a conversion is under way, before and after it moves the registry entry', async () => {
    const host = await machine();
    const moving = await legacyAssistant(host, { label: 'alpha', port: 36_001, ingress: 'existing' });
    const moved = await assistant(host, { label: 'beta', port: 36_011, ingress: 'existing' });
    for (const { instance_id: id } of [moving, moved]) {
      await writePrivate(conversionRecordFile(host.paths, id), { step: 'moved', legacy_root: `instances/${id}` });
    }
    const state = world(moved);

    const before = await statusJson(host, state, moving.instance_id);
    const after = await statusJson(host, state, moved.instance_id);
    const text = command(host, state);
    expect(await runStatusCommand(text.runtime, { instanceId: moving.instance_id, json: false })).toBe(0);
    const listed = command(host, state);
    expect(await runListCommand(listed.runtime, { json: false })).toBe(0);

    for (const [{ status }, { instance_id: id }] of [
      [before, moving],
      [after, moved],
    ] as const) {
      expect(status.phase).toEqual({ state: 'converting', continue_with: `gws-ea update --id ${id}` });
    }
    // Until the registry entry moves, its state is not all in its root, so only its record is shown.
    expect(before.status).not.toHaveProperty('probes');
    expect(after.status.probes.service).toMatchObject({ status: 'ok', state: 'running' });
    const unfinished = (id: string): string =>
      `Its conversion to the release layout is unfinished; continue it with gws-ea update --id ${id}.`;
    expect(text.output.stdout).toContain(`  Phase:     ${unfinished(moving.instance_id)}`);
    for (const { instance_id: id } of [moving, moved]) {
      expect(listed.output.stdout).toContain(`${id}: ${unfinished(id)}`);
    }
  });

  it('names the fix-forward command for an update that failed and left no release to return to', async () => {
    const host = await machine();
    const reservation = await assistant(host, { label: 'alpha', port: 36_001, ingress: 'existing' });
    const target: ReleaseCoordinates = { ...releaseOf(reservation), deployed_commit: 'c'.repeat(40) };
    await updateFailedWithoutReturn(host.paths, reservation, target);
    const state = world(reservation);
    const id = reservation.instance_id;
    const fixForward =
      `Its update to dogfood ${'c'.repeat(12)} failed and left no release to return to (started); ` +
      `fix it forward to a newer release with gws-ea update --id ${id}.`;

    const { status } = await statusJson(host, state, id);
    const text = command(host, state);
    expect(await runStatusCommand(text.runtime, { instanceId: id, json: false })).toBe(0);
    const listed = command(host, state);
    expect(await runListCommand(listed.runtime, { json: false })).toBe(0);

    expect(status.operation).toMatchObject({
      state: 'failed',
      kind: 'update',
      continue_with: `gws-ea update --id ${id}`,
      revert_with: null,
    });
    expect(text.output.stdout).toContain(`  Operation: ${fixForward}`);
    expect(listed.output.stdout.join('\n')).toMatch(new RegExp(` +update failed$`, 'mu'));
    expect(listed.output.stdout).toContain(`${id}: ${fixForward}`);
  });

  it('refuses an unknown assistant ID with exit code 1', async () => {
    const host = await machine();
    const state = world();
    const { runtime, output } = command(host, state);
    const unknown = randomUUID();

    expect(await runStatusCommand(runtime, { instanceId: unknown, json: true })).toBe(1);
    expect(await runStatusCommand(runtime, { instanceId: 'not-an-id', json: false })).toBe(1);

    expect(output.stdout).toEqual([]);
    expect(output.stderr.join('\n')).toContain(`No assistant ${unknown} is registered on this machine`);
    expect(output.stderr.join('\n')).toContain('gws-ea list');
  });
});

describe('list', () => {
  it('shows every assistant, the phase of one mid-update, and the removal another left', async () => {
    const host = await machine();
    const alpha = await assistant(host, { label: 'alpha', port: 36_001, ingress: 'managed-cloudflare' });
    const beta = await assistant(host, { label: 'beta', port: 36_011, ingress: 'existing' });
    const target: ReleaseCoordinates = { ...releaseOf(beta), deployed_commit: 'c'.repeat(40) };
    await updateUnfinishedAt(host.paths, beta, target);
    await removalStarted(host.paths, alpha);
    const state = world(alpha, beta);
    state.active.delete(installOf(beta));

    const json = command(host, state);
    expect(await runListCommand(json.runtime, { json: true })).toBe(0);
    const listing = JSON.parse(json.output.stdout.join('\n')) as { assistants: Array<Record<string, unknown>> };
    const current = {
      deployed_commit: host.release,
      tool_commit: host.release,
      behind_tool_release: false,
      reason: null,
    };

    expect(listing.assistants).toHaveLength(2);
    for (const entry of listing.assistants) expect(Object.keys(entry)).toEqual([...LIST_FIELDS]);
    expect(listing.assistants).toEqual(
      expect.arrayContaining([
        {
          instance_id: alpha.instance_id,
          hostname: 'alpha.example.test',
          track: 'dogfood',
          deployed_commit: host.release,
          phase: { state: 'live', release: host.release.slice(0, 8) },
          release: current,
          service: { state: 'running', reason: null },
          operation: { state: 'none' },
          removal_in_progress: true,
        },
        {
          instance_id: beta.instance_id,
          hostname: 'beta.example.test',
          track: 'dogfood',
          deployed_commit: host.release,
          phase: { state: 'live', release: host.release.slice(0, 8) },
          release: current,
          service: { state: 'stopped', reason: 'Its service is stopped.' },
          operation: {
            state: 'open',
            kind: 'update',
            phase: 'fenced',
            from: releaseOf(beta),
            to: target,
            started_at: expect.any(String),
            updated_at: expect.any(String),
            continue_with: `gws-ea update --id ${beta.instance_id}`,
            revert_with: `gws-ea rollback --id ${beta.instance_id}`,
          },
          removal_in_progress: false,
        },
      ]),
    );

    const text = command(host, state);
    expect(await runListCommand(text.runtime, { json: false })).toBe(0);
    const lines = text.output.stdout.join('\n');
    expect(lines).toMatch(
      new RegExp(
        `${alpha.instance_id} +alpha\\.example\\.test +dogfood +${host.release.slice(0, 12)} +no +running +live +removing`,
        'u',
      ),
    );
    expect(lines).toMatch(
      new RegExp(
        `${beta.instance_id} +beta\\.example\\.test +dogfood +${host.release.slice(0, 12)} +no +stopped +live +update fenced`,
        'u',
      ),
    );
    // Each thing left under way is named beside the table, with the command that settles it.
    expect(text.output.stdout).toContain(
      `${beta.instance_id}: Its update to dogfood ${'c'.repeat(12)} is unfinished (fenced); ` +
        `continue it with gws-ea update --id ${beta.instance_id}, or revert it with gws-ea rollback --id ${beta.instance_id}.`,
    );
    expect(lines).toMatch(new RegExp(`^${alpha.instance_id}: Removal .*gws-ea remove --id ${alpha.instance_id}`, 'mu'));
  });

  it("says whether each assistant is behind the tool's release, from the tool's own history", async () => {
    const host = await machine();
    const behind = await assistant(host, { label: 'alpha', port: 36_001, ingress: 'existing' });
    const toolRelease = await nextRelease(host);
    const current = await assistant(host, {
      label: 'beta',
      port: 36_011,
      ingress: 'existing',
      from: { repository: host.tool, commit: toolRelease },
    });
    // A release of a repository the tool's checkout never fetched, so its history cannot place it.
    const elsewhere = path.join(host.root, 'elsewhere');
    await mkdir(elsewhere);
    git(elsewhere, 'init', '--quiet', '-b', 'dogfood');
    await writeFile(path.join(elsewhere, 'release.txt'), 'elsewhere\n');
    const foreign = commitAll(elsewhere, 'a release the tool never saw');
    const unplaced = await assistant(host, {
      label: 'gamma',
      port: 36_021,
      ingress: 'existing',
      from: { repository: elsewhere, commit: foreign },
    });
    const state = world(behind, current, unplaced);

    const json = command(host, state);
    expect(await runListCommand(json.runtime, { json: true })).toBe(0);
    const text = command(host, state);
    expect(await runListCommand(text.runtime, { json: false })).toBe(0);

    const listing = JSON.parse(json.output.stdout.join('\n')) as {
      assistants: Array<{ instance_id: string; release: unknown }>;
    };
    expect(Object.fromEntries(listing.assistants.map(({ instance_id, release }) => [instance_id, release]))).toEqual({
      [behind.instance_id]: {
        deployed_commit: host.release,
        tool_commit: toolRelease,
        behind_tool_release: true,
        reason: null,
      },
      [current.instance_id]: {
        deployed_commit: toolRelease,
        tool_commit: toolRelease,
        behind_tool_release: false,
        reason: null,
      },
      [unplaced.instance_id]: {
        deployed_commit: foreign,
        tool_commit: toolRelease,
        behind_tool_release: null,
        reason: `The tool's checkout does not hold ${foreign.slice(0, 12)}, so it cannot tell.`,
      },
    });
    const lines = text.output.stdout.join('\n');
    expect(lines).toMatch(/^INSTANCE ID +HOSTNAME +TRACK +COMMIT +BEHIND TOOL +SERVICE +PHASE +OPERATION$/mu);
    for (const [reservation, cell] of [
      [behind, 'yes'],
      [current, 'no'],
      [unplaced, 'unknown'],
    ] as const) {
      expect(lines).toMatch(
        new RegExp(
          `^${reservation.instance_id} +\\S+ +dogfood +${reservation.deployed_commit.slice(0, 12)} +${cell} +running +live +-$`,
          'mu',
        ),
      );
    }
  });

  it('says so when no assistant is registered', async () => {
    const host = await machine();
    const { runtime, output } = command(host, world());

    expect(await runListCommand(runtime, { json: false })).toBe(0);
    expect(output.stdout).toEqual(['No assistants are registered on this machine.']);
  });
});

/** Every entry under `root`: its type, mode, modification time, and content hash. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  const walk = async (target: string): Promise<void> => {
    const info = await lstat(target);
    const key = path.relative(root, target) || '.';
    if (info.isSymbolicLink()) {
      entries.set(key, `link ${await readlink(target)} ${info.mtimeMs}`);
    } else if (info.isFile()) {
      const digest = createHash('sha256')
        .update(await readFile(target))
        .digest('hex');
      entries.set(key, `file ${info.mode} ${info.mtimeMs} ${digest}`);
    } else {
      entries.set(key, `dir ${info.mode} ${info.mtimeMs}`);
      for (const name of await readdir(target)) await walk(path.join(target, name));
    }
  };
  await walk(root);
  return entries;
}

/** The central database a host left closed (WAL, no side files), and main's session mailbox. */
function hostDatabases(checkout: string, migrations: readonly string[]): void {
  const central = new Database(path.join(checkout, 'data', 'v2.db'));
  try {
    central.pragma('journal_mode = WAL');
    central.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied TEXT NOT NULL);
      CREATE TABLE gws_ea_profile (singleton INTEGER PRIMARY KEY, main_agent_group_id TEXT);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, agent_group_id TEXT, messaging_group_id TEXT, thread_id TEXT, status TEXT, created_at TEXT
      );
      CREATE TABLE delivery_attempts (
        message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT, next_attempt_at TEXT, last_error TEXT
      );
    `);
    migrations.forEach((name, index) =>
      central.prepare('INSERT INTO schema_version VALUES (?, ?, ?)').run(index + 1, name, NOW.toISOString()),
    );
    central.prepare('INSERT INTO gws_ea_profile VALUES (1, ?)').run(MAIN);
    central
      .prepare("INSERT INTO sessions VALUES (?, ?, 'mg-principal', NULL, 'active', ?)")
      .run(SESSION, MAIN, NOW.toISOString());
  } finally {
    central.close();
  }
}

async function sessionMailbox(checkout: string): Promise<void> {
  const directory = path.join(checkout, 'data', 'v2-sessions', MAIN, SESSION);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const inbound = new Database(path.join(directory, 'inbound.db'));
  try {
    inbound.exec(`CREATE TABLE delivered (
      message_out_id TEXT PRIMARY KEY, platform_message_id TEXT, status TEXT NOT NULL, delivered_at TEXT NOT NULL
    )`);
    inbound.prepare("INSERT INTO delivered VALUES ('out-welcome', NULL, 'delivered', ?)").run(DELIVERED_AT);
  } finally {
    inbound.close();
  }
}

/** What observing may ask Docker and Git: the read-only verbs the observers use, and nothing that changes state. */
const READ_ONLY_VERBS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['docker', new Set(['container ls', 'container inspect', 'image inspect', 'image ls'])],
  ['git', new Set(['rev-parse', 'status', 'cat-file', 'merge-base'])],
]);

/** A command's verb: Docker's object and action, or Git's subcommand after its global options. */
function verbOf({ command, args }: SanitizedCommand): string {
  return command === 'docker' ? args.slice(0, 2).join(' ') : (args.find((arg) => !arg.startsWith('-')) ?? '');
}

describe('read-only commands', () => {
  it('write no file, load no secret, pass no secret environment variable, and ask Docker and Git only to read', async () => {
    const host = await machine();
    const alpha = await assistant(host, { label: 'alpha', port: 36_001, ingress: 'managed-cloudflare' });
    const beta = await assistant(host, { label: 'beta', port: 36_011, ingress: 'existing' });
    await bound(host.paths, alpha.instance_id);
    hostDatabases(stateOf(alpha), ['initial-v2-schema', 'host-coordination']);
    await sessionMailbox(stateOf(alpha));
    await keepRollbackPoint(host.paths, alpha, 'e'.repeat(40), {
      central_migrations: ['initial-v2-schema'],
      session_tables: {},
    });
    const secretsFile = path.join(host.paths.configRoot, 'secrets.env');
    await writeFile(secretsFile, `GWS_EA_PROVIDER_CREDENTIAL=${SENTINEL}\n`, { mode: 0o600 });
    vi.stubEnv('GWS_EA_PROVIDER_CREDENTIAL', SENTINEL);
    vi.stubEnv('GWS_EA_CLOUDFLARE_API_TOKEN', SENTINEL);
    const state = world(alpha, beta);
    // Only the external boundaries are faked; every reader of the fixture is real.
    const observers: Partial<StatusObservers> = {
      runCommand: recordingRunner(state),
      fetch: callbackFetch(state),
      ncl: ncl(state),
      onecliAgents,
    };
    // Stale stat entries make an ordinary `git status` rewrite each index; a read-only one must not.
    const later = new Date(Date.now() + 60_000);
    for (const repository of [liveOf(alpha), host.tool]) {
      await utimes(path.join(repository, 'release.txt'), later, later);
    }
    const before = await snapshot(host.root);
    expect([...before.keys()]).not.toContain(path.relative(host.root, `${stateOf(alpha)}/data/v2.db-wal`));

    const outputs: Output[] = [];
    for (const json of [true, false]) {
      const listed = command(host, state, observers);
      expect(await runListCommand(listed.runtime, { json })).toBe(0);
      outputs.push(listed.output);
      for (const reservation of [alpha, beta]) {
        const observed = command(host, state, observers);
        expect(await runStatusCommand(observed.runtime, { instanceId: reservation.instance_id, json })).toBe(0);
        outputs.push(observed.output);
      }
    }

    expect(await snapshot(host.root)).toEqual(before);
    // Neither the secrets file nor the environment was loaded: loading registers every secret for redaction.
    expect(redact(SENTINEL)).toBe(SENTINEL);
    expect(new Set(state.commands.map(({ command: tool }) => tool))).toEqual(new Set(['docker', 'git']));
    for (const run of state.commands) {
      expect(READ_ONLY_VERBS.get(run.command)?.has(verbOf(run)), [run.command, ...run.args].join(' ')).toBe(true);
    }
    const everything = JSON.stringify({ outputs, commands: state.commands, env: state.serviceEnvironments });
    expect(everything).not.toContain(SENTINEL);
    expect(everything).not.toContain('GWS_EA_');
    // The real readers did observe the fixture.
    const status = JSON.parse(outputs[1]!.stdout.join('\n')) as StatusShape;
    expect(status.probes.delivery).toMatchObject({ status: 'ok', last: { message_out_id: 'out-welcome' } });
    expect(status.rollback).toMatchObject({ available: true, schema_moved: true });
    expect(status.probes.checkout).toMatchObject({ status: 'ok', commit: host.release });
    expect(status.probes.onecli).toMatchObject({ status: 'degraded', reason: 'It has not been created.' });
  });
});

describe('help', () => {
  it('names every JSON field the commands print', () => {
    const help = [...LIST_USAGE, ...STATUS_USAGE].join('\n');
    for (const field of [
      ...LIST_FIELDS,
      ...STATUS_FIELDS,
      ...PROBE_NAMES,
      'tool_commit',
      'behind_tool_release',
      'previous_commit',
      'schema_moved',
      'drift',
      'last_success_at',
      'calendar_notifications',
    ]) {
      expect(help, field).toContain(field);
    }
  });

  it('pins the order of the fields status prints', async () => {
    const host = await machine();
    const reservation = await assistant(host, { label: 'alpha', port: 36_001, ingress: 'managed-cloudflare' });
    const { status } = await statusJson(host, world(reservation), reservation.instance_id);

    expect(Object.keys(status)).toEqual([...STATUS_FIELDS]);
  });
});
