/**
 * `list` and `status` observe assistants built as create leaves them: a
 * registry reservation and journal, a Git checkout detached at its release
 * with its marker and runtime, the release receipt, and the OneCLI Compose
 * file. The host, service manager, Docker, OneCLI, and the callback are
 * faked at their boundaries; Git and SQLite are real.
 */
import { execFileSync } from 'node:child_process';
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
import { allocateInstanceId, writeInstanceMarker } from './registry.js';
import { createInstanceRuntimeConfig, persistInstanceRuntime, type HostStatusHelpers } from './service.js';
import type { NanoclawServiceHelpers } from './service-control.js';
import {
  LIST_JSON_FIELDS,
  LIST_USAGE,
  PROBE_NAMES,
  STATUS_JSON_FIELDS,
  STATUS_USAGE,
  runListCommand,
  runStatusCommand,
  type ReadOnlyCommandRuntime,
  type StatusObservers,
} from './status.js';
import { GwsEaError, releaseOf, type InstanceReservation, type ReleaseCoordinates } from './types.js';
import type { LatestDelivery } from './verify.js';

/** Every file `list` and `status` open through `node:fs/promises`, so a test can prove what they never read. */
const opened = vi.hoisted((): string[] => []);
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const recorded = <F extends (...args: never[]) => unknown>(original: F): F =>
    ((...args: Parameters<F>) => {
      opened.push(String(args[0]));
      return original(...args);
    }) as F;
  return { ...actual, open: recorded(actual.open), readFile: recorded(actual.readFile) };
});

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

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commitAll(repository: string, message: string): string {
  git(repository, 'add', '.');
  git(repository, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', message);
  return git(repository, 'rev-parse', 'HEAD');
}

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
  await writeFile(path.join(tool, '.gitignore'), 'data/\nlogs/\n.env\n');
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

/** What each fake boundary reports, per checkout, and what reached it. */
interface World {
  /** Checkouts whose service runs. */
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
    active: new Set(checkouts),
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

function serviceHelpers(state: World): NanoclawServiceHelpers {
  return {
    createCommandRunner: ({ env }) => {
      state.serviceEnvironments.push(env);
      return { run: unused, tryRun: unused };
    },
    detectService: (root) => ({
      mode: 'launchd',
      name: `com.nanoclaw.${path.basename(root)}`,
      active: state.active.has(root),
    }),
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

const RESTAMP_PLAN = {
  group: { id: MAIN, name: 'main' },
  plugin: 'gws-ea-main',
  applied: false,
  changes: [
    { surface: 'plugin', name: 'plugins/gws-ea-main', action: 'unchanged' },
    { surface: 'persona', name: 'PREPEND.md', action: 'update', customized: true },
  ],
  report: [],
  note: 'Dry run.',
};

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
    serviceHelpers: serviceHelpers(state),
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
}

describe('status', () => {
  it('reports every probe as ok for a healthy assistant, with its release, rollback, and template facts', async () => {
    const host = await machine();
    const reservation = await assistant(host, { label: 'alpha', port: 36_001, ingress: 'managed-cloudflare' });
    await bound(host.paths, reservation.instance_id);
    const state = world(reservation);

    const { exitCode, status } = await statusJson(host, state, reservation.instance_id);

    expect(exitCode).toBe(0);
    expect(Object.keys(status.probes)).toEqual([...PROBE_NAMES]);
    for (const name of PROBE_NAMES) expect(status.probes[name], name).toMatchObject({ status: 'ok', reason: null });
    expect(status.probes.checkout).toMatchObject({ commit: host.release });
    expect(status.probes.service).toMatchObject({ state: 'running' });
    expect(status.probes.main_identity).toMatchObject({ agent_group_id: MAIN });
    expect(status.probes.connector).toMatchObject({ drift: null });
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
      operation: { state: 'none', abandoned_staging: false },
      removal_in_progress: false,
      release: { deployed_commit: host.release, tool_commit: host.release, behind_tool_release: false, reason: null },
      rollback: { available: false, previous_commit: null, schema_moved: null, reason: 'No previous release is kept.' },
      templates: { customized: [{ surface: 'persona', name: 'PREPEND.md' }], reason: null },
      schema: { latest_migration: 'host-coordination', reason: null },
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
    expect(status.templates).toMatchObject({ customized: null, reason: expect.any(String) });
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

  it('reports the kept previous release and whether either schema moved since it', async () => {
    const host = await machine();
    const reservation = await assistant(host, { label: 'alpha', port: 36_001, ingress: 'existing' });
    const previous = host.paths.releaseCheckoutRoot(reservation.instance_id, 'previous');
    const previousCommit = 'e'.repeat(40);
    await writePrivate(path.join(previous, 'data', 'gws-ea', 'instance.json'), {
      schema_version: 1,
      instance_id: reservation.instance_id,
      deployed_commit: previousCommit,
    });
    const state = world(reservation);
    const manifests = new Map<string, SnapshotManifest>([
      [reservation.checkout_realpath, MANIFEST],
      [previous, { ...MANIFEST, central_migrations: ['initial-v2-schema'] }],
    ]);
    const observers = { ...healthyObservers(state), schema: (root: string) => manifests.get(root) ?? MANIFEST };

    const moved = await statusJson(host, state, reservation.instance_id, observers);
    manifests.set(previous, MANIFEST);
    const unmoved = await statusJson(host, state, reservation.instance_id, observers);

    expect(moved.status.rollback).toEqual({
      available: true,
      previous_commit: previousCommit,
      schema_moved: true,
      reason: null,
    });
    expect(unmoved.status.rollback).toMatchObject({ available: true, schema_moved: false });
  });

  it('renders its observations as text, with times in the install timezone', async () => {
    const host = await machine();
    const reservation = await assistant(host, { label: 'alpha', port: 36_001, ingress: 'managed-cloudflare' });
    await bound(host.paths, reservation.instance_id);
    const state = world(reservation);
    const { runtime, output } = command(host, state);

    expect(await runStatusCommand(runtime, { instanceId: reservation.instance_id, json: false })).toBe(0);

    const text = output.stdout.join('\n');
    expect(text).toContain(`Assistant ${reservation.instance_id}`);
    expect(text).toContain('Observed: Sep 28, 2026, 10:30 AM');
    expect(text).toContain('Sep 28, 2026, 10:00 AM');
    for (const name of PROBE_NAMES) expect(text).toMatch(new RegExp(`^ {2}ok +${name}\\b`, 'mu'));
    expect(text).toContain('persona PREPEND.md');
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
  it('shows every assistant, and the phase of one mid-update', async () => {
    const host = await machine();
    const alpha = await assistant(host, { label: 'alpha', port: 36_001, ingress: 'managed-cloudflare' });
    const beta = await assistant(host, { label: 'beta', port: 36_011, ingress: 'existing' });
    const target: ReleaseCoordinates = { ...releaseOf(beta), deployed_commit: 'c'.repeat(40) };
    await updateStoppedAt(host.paths, beta, target);
    const state = world(alpha, beta);
    state.active.delete(beta.checkout_realpath);

    const json = command(host, state);
    expect(await runListCommand(json.runtime, { json: true })).toBe(0);
    const listing = JSON.parse(json.output.stdout.join('\n')) as { assistants: Array<Record<string, unknown>> };

    expect(listing.assistants).toHaveLength(2);
    for (const entry of listing.assistants) expect(Object.keys(entry)).toEqual([...LIST_JSON_FIELDS]);
    expect(listing.assistants).toEqual(
      expect.arrayContaining([
        {
          instance_id: alpha.instance_id,
          hostname: 'alpha.example.test',
          track: 'dogfood',
          deployed_commit: host.release,
          service: { state: 'running', reason: null },
          operation: { state: 'none', abandoned_staging: false },
          removal_in_progress: false,
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
        `${alpha.instance_id} +alpha\\.example\\.test +dogfood +${host.release.slice(0, 12)} +running +-`,
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

describe('read-only commands', () => {
  it('write no file, read no secrets file, and pass no secret environment variable', async () => {
    const host = await machine();
    const alpha = await assistant(host, { label: 'alpha', port: 36_001, ingress: 'managed-cloudflare' });
    const beta = await assistant(host, { label: 'beta', port: 36_011, ingress: 'existing' });
    await bound(host.paths, alpha.instance_id);
    hostDatabases(alpha.checkout_realpath, ['initial-v2-schema', 'host-coordination']);
    await sessionMailbox(alpha.checkout_realpath);
    const previous = host.paths.releaseCheckoutRoot(alpha.instance_id, 'previous');
    await writePrivate(path.join(previous, 'data', 'gws-ea', 'instance.json'), {
      schema_version: 1,
      instance_id: alpha.instance_id,
      deployed_commit: 'e'.repeat(40),
    });
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
    opened.length = 0;

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

    const reads = [...opened];
    expect(await snapshot(host.root)).toEqual(before);
    expect(reads).not.toContain(secretsFile);
    expect(reads).toContain(host.paths.registryFile);
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
      ...LIST_JSON_FIELDS,
      ...STATUS_JSON_FIELDS,
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

    expect(Object.keys(status)).toEqual([...STATUS_JSON_FIELDS]);
  });
});
