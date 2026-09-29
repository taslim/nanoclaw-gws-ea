/**
 * `list` and `status` observe assistants built as create leaves them: a
 * registry reservation and journal, a Git checkout detached at its release
 * with its marker and runtime, the release receipt, and the OneCLI Compose
 * file. The host, service manager, Docker, OneCLI, and the callback are
 * faked at their boundaries; Git and SQLite are real.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { writePrivate } from '../community-portal/private-file.js';
import { acquireInstanceOperation, recordPrincipalSelection, reserveInstance } from './journal.js';
import { createOnecliRuntimeLayout, renderOnecliCompose } from './onecli-compose.js';
import { wrapperImageTag } from './onecli-gateway-image.js';
import { advanceOperation, beginOperation, type SnapshotManifest } from './operation.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { PRESENT } from './phases.js';
import type { PrincipalCandidate } from './principal.js';
import { runSanitizedCommand, type SanitizedCommand } from './process.js';
import { redact } from './redact.js';
import { allocateInstanceId, writeInstanceMarker } from './registry.js';
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
const ONECLI_CLI = '/usr/local/bin/onecli';
const PINS = { gateway: '1.41.3', cli: '2.2.4' } as const;
const CREDENTIAL = { name: 'Anthropic', type: 'anthropic', hostPattern: 'api.anthropic.com', headerName: 'x-api-key' };
const MAIN = 'ag-main';
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
  'service',
  'operation',
  'removal_in_progress',
] as const;

/** The fields `status --json` prints, in order, as its help documents them. */
const STATUS_FIELDS = [
  'instance_id',
  'observed_at',
  'registry',
  'operation',
  'removal_in_progress',
  'release',
  'rollback',
  'templates',
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
}

/** An assistant create finished: its reservation, checkout, marker, runtime, release receipt, and Compose file. */
async function assistant(host: Machine, { label, port, ingress }: AssistantOptions): Promise<InstanceReservation> {
  const { paths } = host;
  const instanceId = allocateInstanceId();
  const callback = `https://${label}.example.test/webhook/gchat`;
  const reserved = await reserveInstance(paths, {
    instance_id: instanceId,
    checkout_realpath: paths.checkoutRoot(instanceId),
    source_remote: host.tool,
    release_track: 'dogfood',
    deployed_commit: host.release,
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
  const checkout = paths.checkoutRoot(instanceId);
  git(host.root, 'clone', '--quiet', host.tool, checkout);
  git(checkout, 'checkout', '--quiet', '--detach', host.release);
  await writeInstanceMarker(paths, instanceId);
  const onecli = createOnecliRuntimeLayout({
    instanceId,
    instanceRoot: paths.instanceRoot(instanceId),
    project: reserved.exclusive_resource_claims.onecli_project,
    appPort: reserved.allocated_ports.onecli_app,
    gatewayPort: reserved.allocated_ports.onecli_gateway,
    cliExecutable: ONECLI_CLI,
    dockerEndpoint: DOCKER,
  });
  await persistInstanceRuntime(
    createInstanceRuntimeConfig(reserved, onecli, {
      nodePath: process.execPath,
      homeDirectory: host.root,
      selectedProvider: 'claude',
      dockerEndpoint: DOCKER,
    }),
    () => undefined,
  );
  await writeFile(
    paths.releasePreflightFile(instanceId),
    `${JSON.stringify({
      schema_version: 1,
      instance_id: instanceId,
      deployed_commit: host.release,
      provider: 'claude',
      providerCapabilityDigest: 'c'.repeat(64),
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

/** A previous release an update kept: its checkout's marker, its manifest naming this assistant, and its receipt. */
async function keepPrevious(paths: ControlPlanePaths, reservation: InstanceReservation, commit: string): Promise<void> {
  const id = reservation.instance_id;
  const previous = paths.releaseCheckoutRoot(id, 'previous');
  await writePrivate(path.join(previous, 'data', 'gws-ea', 'instance.json'), {
    schema_version: 1,
    instance_id: id,
    deployed_commit: commit,
  });
  const root = paths.releaseRoot(id, 'previous');
  await writePrivate(path.join(root, 'release-manifest.json'), {
    schema_version: 1,
    instance_id: id,
    release: { ...releaseOf(reservation), deployed_commit: commit },
    snapshot_at: NOW.toISOString(),
  });
  await writePrivate(path.join(root, 'release-preflight.json'), { instance_id: id, deployed_commit: commit });
}

/** The release an update to `to` is moving this assistant towards, unfinished at `stopped`. */
async function updateStoppedAt(paths: ControlPlanePaths, reservation: InstanceReservation, to: ReleaseCoordinates) {
  const operation = await acquireInstanceOperation(paths, reservation.instance_id, { command: 'update', target: to });
  if (!operation) throw new Error('The test instance operation was busy');
  try {
    await beginOperation(operation, { kind: 'update', from: releaseOf(reservation), to });
    await advanceOperation(operation, 'stopped', { stop: { at: NOW.toISOString(), graceful: true } });
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

/** The staging an interrupted update left behind: `next/`, with no operation record. */
async function stagingLeft(paths: ControlPlanePaths, reservation: InstanceReservation): Promise<void> {
  await mkdir(paths.releaseCheckoutRoot(reservation.instance_id, 'next'), { recursive: true, mode: 0o700 });
}

/** NanoClaw's install slug for an assistant: its instance ID without dashes. */
function installOf(reservation: InstanceReservation): string {
  return reservation.instance_id.replaceAll('-', '');
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
  readonly commands: SanitizedCommand[];
  readonly serviceEnvironments: NodeJS.ProcessEnv[];
}

function world(...assistants: readonly InstanceReservation[]): World {
  const checkouts = assistants.map((reservation) => reservation.checkout_realpath);
  return {
    installed: new Set(assistants.map(installOf)),
    active: new Set(assistants.map(installOf)),
    serving: new Set(checkouts),
    ports: new Map(
      assistants.map((reservation) => [reservation.checkout_realpath, reservation.allocated_ports.nanoclaw_webhook]),
    ),
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

/** NanoClaw's restamp plan for main: its persona is left to the file comparison, its task is its own. */
const RESTAMP_PLAN = {
  group: { id: MAIN, name: 'main' },
  plugin: 'gws-ea-main',
  applied: false,
  changes: [
    { surface: 'plugin', name: 'plugins/gws-ea-main', action: 'unchanged' },
    { surface: 'persona', name: 'instructions.prepend.md', action: 'update', customized: true },
    { surface: 'task', name: 'Weekly review', action: 'update', customized: true },
  ],
  report: [],
  note: 'Dry run.',
};

const EDITED_PERSONA = { surface: 'persona', name: 'instructions.prepend.md', change: 'changed' } as const;
const EDITED_TASK = { surface: 'task', name: 'Weekly review', change: 'changed' } as const;

function ncl(state: World): StatusObservers['ncl'] {
  return async (runtime, args) => {
    if (!state.serving.has(runtime.checkout_realpath)) {
      throw new GwsEaError('command_failed', 'ncl exited with code 1', { details: { exitCode: 1 } });
    }
    switch (args.join(' ')) {
      case 'gws-ea-profile get':
        return { main_agent_group_id: MAIN, assistant_display_name: 'Aya' };
      case `groups get --id ${MAIN}`:
        return { id: MAIN, name: 'main' };
      case `groups config get --id ${MAIN}`:
        return { agent_group_id: MAIN, provider: 'claude' };
      case `groups create --template gws-ea/main --id ${MAIN}`:
        return RESTAMP_PLAN;
      default:
        throw new Error(`unexpected ncl ${args.join(' ')}`);
    }
  };
}

const onecliAdmin: StatusObservers['onecliAdmin'] = async (_runtime, args) => {
  if (args.join(' ') !== 'agents list --max 0') throw new Error(`unexpected onecli ${args.join(' ')}`);
  return { data: [{ id: 'agent-main', identifier: MAIN, name: 'main', secretMode: 'all' }] };
};

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

/** Git for real; Docker answers that nothing runs. Every command is recorded. */
function recordingRunner(state: World): StatusObservers['runCommand'] {
  return async (command) => {
    state.commands.push(command);
    if (command.command === 'git') return runSanitizedCommand(command);
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
    onecliAdmin,
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
    mainTemplate: async () => ({ kind: 'stamped', customized: [EDITED_PERSONA] }),
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
  templates: Record<string, unknown>;
  operation: Record<string, unknown>;
  schema: Record<string, unknown>;
}

describe('status', () => {
  it('reports every probe as ok for a healthy assistant, with its release, rollback, template, and schema facts', async () => {
    const host = await machine();
    const reservation = await assistant(host, { label: 'alpha', port: 36_001, ingress: 'managed-cloudflare' });
    await bound(host.paths, reservation.instance_id);
    // Beside the healthy host: a removal cut short, staging an interrupted update left, and a drifted shared connector.
    await removalStarted(host.paths, reservation);
    await stagingLeft(host.paths, reservation);
    const state = world(reservation);

    const { exitCode, status } = await statusJson(host, state, reservation.instance_id, {
      ...healthyObservers(state),
      connector: async () => ({ status: 'present', drift: CONNECTOR_DRIFT }),
    });

    expect(exitCode).toBe(0);
    expect(Object.keys(status.probes)).toEqual([...PROBE_NAMES]);
    for (const name of PROBE_NAMES) expect(status.probes[name], name).toMatchObject({ status: 'ok', reason: null });
    expect(status.probes.checkout).toMatchObject({ commit: host.release });
    expect(status.probes.service).toMatchObject({ state: 'running' });
    expect(status.probes.main_identity).toMatchObject({ agent_group_id: MAIN });
    // A shared connector's drift is reported, never counted against this assistant (KTD11).
    expect(status.probes.connector).toEqual({ status: 'ok', reason: null, drift: CONNECTOR_DRIFT });
    expect(status.probes.delivery).toMatchObject({
      last: { status: 'delivered', message_out_id: 'out-welcome', at: DELIVERED_AT },
      retrying: 0,
    });
    expect(status).toMatchObject({
      instance_id: reservation.instance_id,
      observed_at: NOW.toISOString(),
      registry: {
        hostname: 'alpha.example.test',
        endpoint_url: 'https://alpha.example.test/webhook/gchat',
        ingress_mode: 'managed-cloudflare',
        track: 'dogfood',
        source_remote: host.tool,
        deployed_commit: host.release,
      },
      operation: { state: 'none', abandoned_staging: true },
      removal_in_progress: true,
      release: { deployed_commit: host.release, tool_commit: host.release, behind_tool_release: false, reason: null },
      rollback: {
        available: false,
        previous_commit: null,
        schema_moved: null,
        reason: `Assistant ${reservation.instance_id} keeps no previous release, so there is nothing to roll back to.`,
      },
      templates: { customized: [EDITED_PERSONA, EDITED_TASK], reason: null },
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
      reason: `The host is unreachable: NanoClaw is not running; see ${reservation.checkout_realpath}/logs/nanoclaw.error.log`,
    });
    expect(status.probes.main_identity).toMatchObject({ status: 'unknown', agent_group_id: null });
    expect(status.probes.route).toMatchObject({ status: 'degraded', reason: expect.stringMatching(/local listener/u) });
    for (const name of ['checkout', 'onecli', 'principal', 'connector', 'delivery']) {
      expect(status.probes[name], name).toMatchObject({ status: 'ok' });
    }
    // Main's files are read without the host; only its skills, MCP servers, and tasks need it.
    expect(status.templates).toEqual({
      customized: [EDITED_PERSONA],
      reason: expect.stringMatching(/^Only its files were compared; its skills, MCP servers, and tasks were not: /u),
    });
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

  it('reports the kept previous release, whether either schema moved since it, and a fingerprint of each', async () => {
    const host = await machine();
    const reservation = await assistant(host, { label: 'alpha', port: 36_001, ingress: 'existing' });
    const previousCommit = 'e'.repeat(40);
    await keepPrevious(host.paths, reservation, previousCommit);
    const state = world(reservation);
    // The kept release's databases record MANIFEST; each case sets what the live checkout's record.
    let live = MANIFEST;
    const observers: Partial<StatusObservers> = {
      ...healthyObservers(state),
      schema: (root) => (root === reservation.checkout_realpath ? live : MANIFEST),
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
    ['without its manifest', 'manifest', /keeps a previous release without its manifest/u],
    ['whose manifest names another assistant', 'other', /belongs to another assistant/u],
    ['without its receipt', 'receipt', /keeps a previous release without its receipt/u],
  ] as const)(
    'offers no rollback for a previous release %s, as rollback would refuse it',
    async (_label, flaw, why) => {
      const host = await machine();
      const reservation = await assistant(host, { label: 'alpha', port: 36_001, ingress: 'existing' });
      const root = host.paths.releaseRoot(reservation.instance_id, 'previous');
      await keepPrevious(host.paths, reservation, 'e'.repeat(40));
      if (flaw === 'manifest') await rm(path.join(root, 'release-manifest.json'));
      if (flaw === 'receipt') await rm(path.join(root, 'release-preflight.json'));
      if (flaw === 'other') {
        const manifest = JSON.parse(await readFile(path.join(root, 'release-manifest.json'), 'utf8')) as object;
        await writePrivate(path.join(root, 'release-manifest.json'), {
          ...manifest,
          instance_id: allocateInstanceId(),
        });
      }

      const { status } = await statusJson(host, world(reservation), reservation.instance_id);

      expect(status.rollback).toEqual({
        available: false,
        previous_commit: null,
        schema_moved: null,
        reason: expect.stringMatching(why),
      });
    },
  );

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
    expect(text).toContain(
      'Templates: customized, kept by updates: instructions.prepend.md (changed), task Weekly review (changed)',
    );
    expect(output.stderr).toEqual([]);
  });

  it('refuses an unknown assistant ID with exit code 1', async () => {
    const host = await machine();
    const state = world();
    const { runtime, output } = command(host, state);
    const unknown = allocateInstanceId();

    expect(await runStatusCommand(runtime, { instanceId: unknown, json: true })).toBe(1);
    expect(await runStatusCommand(runtime, { instanceId: 'not-an-id', json: false })).toBe(1);

    expect(output.stdout).toEqual([]);
    expect(output.stderr.join('\n')).toContain(`No assistant ${unknown} is registered on this machine`);
    expect(output.stderr.join('\n')).toContain('gws-ea list');
  });
});

describe('list', () => {
  it('shows every assistant, the phase of one mid-update, and the removal and staging another left', async () => {
    const host = await machine();
    const alpha = await assistant(host, { label: 'alpha', port: 36_001, ingress: 'managed-cloudflare' });
    const beta = await assistant(host, { label: 'beta', port: 36_011, ingress: 'existing' });
    const target: ReleaseCoordinates = { ...releaseOf(beta), deployed_commit: 'c'.repeat(40) };
    await updateStoppedAt(host.paths, beta, target);
    await removalStarted(host.paths, alpha);
    await stagingLeft(host.paths, alpha);
    const state = world(alpha, beta);
    state.active.delete(installOf(beta));

    const json = command(host, state);
    expect(await runListCommand(json.runtime, { json: true })).toBe(0);
    const listing = JSON.parse(json.output.stdout.join('\n')) as { assistants: Array<Record<string, unknown>> };

    expect(listing.assistants).toHaveLength(2);
    for (const entry of listing.assistants) expect(Object.keys(entry)).toEqual([...LIST_FIELDS]);
    expect(listing.assistants).toEqual(
      expect.arrayContaining([
        {
          instance_id: alpha.instance_id,
          hostname: 'alpha.example.test',
          track: 'dogfood',
          deployed_commit: host.release,
          service: { state: 'running', reason: null },
          operation: { state: 'none', abandoned_staging: true },
          removal_in_progress: true,
        },
        {
          instance_id: beta.instance_id,
          hostname: 'beta.example.test',
          track: 'dogfood',
          deployed_commit: host.release,
          service: { state: 'stopped', reason: 'Its service is stopped.' },
          operation: {
            state: 'open',
            kind: 'update',
            phase: 'stopped',
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
        `${alpha.instance_id} +alpha\\.example\\.test +dogfood +${host.release.slice(0, 12)} +running +removing`,
        'u',
      ),
    );
    expect(lines).toMatch(
      new RegExp(
        `${beta.instance_id} +beta\\.example\\.test +dogfood +${host.release.slice(0, 12)} +stopped +update stopped`,
        'u',
      ),
    );
    expect(lines).toContain(`continue with gws-ea update --id ${beta.instance_id}`);
    // Each thing left under way is named beside the table, with the command that settles it.
    expect(lines).toMatch(new RegExp(`^${alpha.instance_id}: Removal .*gws-ea remove --id ${alpha.instance_id}`, 'mu'));
    expect(lines).toMatch(
      new RegExp(`^${alpha.instance_id}: .*staging .*gws-ea update --id ${alpha.instance_id}`, 'mu'),
    );
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

/**
 * Main stamped from its template, as create leaves it, then customized: its
 * persona edited and a note added beside its operating procedure.
 */
async function stampedMain(checkout: string): Promise<void> {
  const central = new Database(path.join(checkout, 'data', 'v2.db'));
  try {
    central.exec(`CREATE TABLE agent_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE)`);
    central.prepare("INSERT INTO agent_groups VALUES (?, 'main', 'main')").run(MAIN);
  } finally {
    central.close();
  }
  const main = path.join(checkout, 'groups', 'main');
  const plugin = path.join(main, 'plugins', 'gws-ea-main');
  const context = path.join(plugin, 'ai.nanoco.nanoclaw', 'context');
  await mkdir(path.join(context, 'additional_context'), { recursive: true });
  await writeFile(path.join(plugin, 'plugin.json'), '{"name":"gws-ea-main"}\n');
  await writeFile(path.join(context, 'instructions.md'), '# Main\n\nStamped instructions.\n');
  await writeFile(path.join(context, 'additional_context', 'procedure.md'), 'Stamped procedure.\n');
  await mkdir(path.join(main, 'additional_context'), { recursive: true });
  await writeFile(path.join(main, 'instructions.prepend.md'), '# Main\n\nMy own instructions.\n');
  await writeFile(path.join(main, 'additional_context', 'procedure.md'), 'Stamped procedure.\n');
  await writeFile(path.join(main, 'additional_context', 'notes.md'), 'Notes.\n');
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
  ['docker', new Set(['container ls', 'container inspect', 'image inspect'])],
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
    hostDatabases(alpha.checkout_realpath, ['initial-v2-schema', 'host-coordination']);
    await sessionMailbox(alpha.checkout_realpath);
    await stampedMain(alpha.checkout_realpath);
    const previous = host.paths.releaseCheckoutRoot(alpha.instance_id, 'previous');
    await keepPrevious(host.paths, alpha, 'e'.repeat(40));
    hostDatabases(previous, ['initial-v2-schema']);
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
      onecliAdmin,
    };
    // Stale stat entries make an ordinary `git status` rewrite each index; a read-only one must not.
    const later = new Date(Date.now() + 60_000);
    for (const repository of [alpha.checkout_realpath, host.tool]) {
      await utimes(path.join(repository, 'release.txt'), later, later);
    }
    const before = await snapshot(host.root);
    expect([...before.keys()]).not.toContain(path.relative(host.root, `${alpha.checkout_realpath}/data/v2.db-wal`));

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
    expect(status.templates).toEqual({
      customized: [
        { surface: 'context', name: 'additional_context/notes.md', change: 'added' },
        { surface: 'persona', name: 'instructions.prepend.md', change: 'changed' },
        EDITED_TASK,
      ],
      reason: null,
    });
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
      'customized',
      'drift',
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
