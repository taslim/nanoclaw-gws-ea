/**
 * `update` stages the tool's release beside an assistant built as create
 * leaves it: a registry reservation and completed journal, a Git checkout
 * detached at its release with its marker, runtime, and `.env`, the release
 * receipt, the OneCLI Compose file, and a central database the host left
 * closed. It then stops the assistant, carries its state across, swaps the
 * checkouts, starts and verifies the release, and records it. Git, SQLite,
 * and the files are real; the service manager, Docker, `ps`, `lsof`, the
 * release's install, build, migration, and tripwire scripts, the host's
 * status and listener, OneCLI, and `ncl` are faked at their boundaries.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { materializeReleaseCheckout } from './checkout.js';
import { runCli, type CliRuntime } from './cli.js';
import { acquireInstanceOperation, recordStepCompleted, reserveInstance } from './journal.js';
import { createOnecliRuntimeLayout, renderOnecliCompose } from './onecli-compose.js';
import { resolveWrapperGatewayImage, wrapperImageTag } from './onecli-gateway-image.js';
import {
  advanceOperation,
  beginOperation,
  inspectOperation,
  readOperationRecord,
  type OperationPhase,
} from './operation.js';
import { CONTROL_PLANE_ROOT, instanceMarkerFile, resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { LAUNCHER_PINS, ONECLI_SDK_VERSION } from './pins.js';
import { runSanitizedCommand, type SanitizedCommand, type SanitizedCommandRunner } from './process.js';
import { allocateInstanceId, getInstanceReservation, swapInstanceRelease } from './registry.js';
import type { ReleasePreflightInput } from './release-preflight.js';
import type { ToolProviderSetup } from './release-target.js';
import {
  createInstanceRuntimeConfig,
  persistInstanceRuntime,
  type HostStatusHelpers,
  type InstanceRuntimeConfig,
  type UpsertEnvVars,
} from './service.js';
import type { NanoclawServiceHelpers } from './service-control.js';
import { observeAssistantStatus } from './status.js';
import { GwsEaError, PROVISION_STEPS, releaseOf, type ReleaseCoordinates } from './types.js';
import {
  confirmStagedUpdate,
  continueUpdate,
  dryRunReleaseMigrations,
  prepareUpdate,
  resolveUpdateIntent,
  updatePreviewLines,
  type StagedUpdate,
  type UpdateDependencies,
} from './update.js';
import { readCentralMigrations } from './verify.js';
import { getInstallScopedNames } from '../install-slug.js';

/** Upstream's `.env` writer, which the driver injects; loaded by path because `src/` cannot import `setup/`. */
const { upsertEnvVars } = (await import(path.join(CONTROL_PLANE_ROOT, 'setup', 'set-env.ts'))) as {
  readonly upsertEnvVars: UpsertEnvVars;
};

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const TRACK_BRANCH = 'rebuild-v2';
const DOCKER = 'unix:///var/run/docker.sock';
const ONECLI_CLI = '/usr/local/bin/onecli';
const CREDENTIAL = { name: 'Anthropic', type: 'anthropic', hostPattern: 'api.anthropic.com', headerName: 'x-api-key' };
const COHORT = { gateway: LAUNCHER_PINS.onecliGateway, cli: LAUNCHER_PINS.onecliCli, sdk: ONECLI_SDK_VERSION };
/** The gateway the assistant's Compose file names: one an earlier release built. */
const DEPLOYED_GATEWAY = wrapperImageTag('0'.repeat(16));
const RELEASE_GATEWAY = (await resolveWrapperGatewayImage(COHORT)).image;
const LIVE_MIGRATIONS = ['initial-v2-schema', 'host-coordination'] as const;
const ADDED_MIGRATION = 'module:gws-ea-profile:add-notes';
const FAILING_MIGRATION = 'module:gws-ea-profile:add-reminders';
const IMAGE_BYTES = 1_500_000_000;
const LOCKFILE = 'container/agent-runner/bun.lock';
const SESSION_SCHEMA_SOURCES = [
  'src/mailbox/sqlite/schema.ts',
  'src/mailbox/sqlite/session-db.ts',
  'container/agent-runner/src/mailbox/sqlite/connection.ts',
] as const;
const PROVIDER_SETUP: ToolProviderSetup = {
  capabilityDigest: 'd'.repeat(64),
  credentialMetadata: (provider) => (provider === 'claude' ? CREDENTIAL : undefined),
};
const SESSION = path.join('data', 'v2-sessions', 'ag-main', 'session-1');
const MEMORY = path.join('groups', 'main', 'CLAUDE.local.md');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commitAll(repository: string, message: string): string {
  git(repository, 'add', '.');
  git(repository, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', message);
  return git(repository, 'rev-parse', 'HEAD');
}

async function write(root: string, relativePath: string, contents: string): Promise<void> {
  const file = path.join(root, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

async function exists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
}

interface Machine {
  readonly root: string;
  readonly paths: ControlPlanePaths;
  /** The release repository, as a hosted one serves it. */
  readonly remote: string;
  /** A working clone that commits each release and pushes it to the track. */
  readonly work: string;
  /** The release every assistant here was created at. */
  readonly first: string;
}

async function machine(): Promise<Machine> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gws-ea-update-')));
  roots.push(root);
  const paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'config'),
    stateRoot: path.join(root, 'state'),
  });
  const work = path.join(root, 'work');
  await mkdir(work);
  git(work, 'init', '--quiet', '-b', TRACK_BRANCH);
  await write(work, '.gitignore', 'data/\nlogs/\ngroups/\nstore/\n.env\n');
  await write(work, 'package.json', '{"version":"2.0.0"}\n');
  await write(work, 'release.txt', 'first\n');
  await write(work, LOCKFILE, 'lock 1\n');
  for (const source of SESSION_SCHEMA_SOURCES) await write(work, source, `// ${source} 1\n`);
  // Never run: the tests' runner stands in for the release's own image build.
  await write(work, 'container/build.sh', '#!/bin/bash\nexit 99\n');
  const first = commitAll(work, 'first release');
  const remote = path.join(root, 'remote.git');
  git(root, 'clone', '--quiet', '--bare', work, remote);
  git(remote, 'config', 'uploadpack.allowFilter', 'true');
  git(work, 'remote', 'add', 'origin', remote);
  return { root, paths, remote, work, first };
}

interface Release {
  readonly commit: string;
  /** A clone at the release: the gws-ea the operator updates with. */
  readonly tool: string;
}

let releases = 0;

/** Push the next release to the track, changing `files`. */
async function nextRelease(host: Machine, files: Readonly<Record<string, string>> = {}): Promise<Release> {
  releases += 1;
  await write(host.work, 'release.txt', `release ${releases}\n`);
  for (const [file, contents] of Object.entries(files)) await write(host.work, file, contents);
  const commit = commitAll(host.work, `release ${releases}`);
  git(host.work, 'push', '--quiet', 'origin', `HEAD:refs/heads/${TRACK_BRANCH}`);
  const tool = path.join(host.root, `tool-${commit.slice(0, 8)}`);
  git(host.root, 'clone', '--quiet', host.remote, tool);
  git(tool, 'checkout', '--quiet', '--detach', commit);
  return { commit, tool };
}

function imageBase(runtime: Pick<InstanceRuntimeConfig, 'install_id'>): string {
  return getInstallScopedNames(runtime.install_id).containerImageBase;
}

/**
 * The central database a host left closed (WAL, no side files): the live
 * migrations, and three agent groups, one of them running a per-group image
 * NanoClaw built on the base, and one an image of its own.
 */
function centralDatabase(runtime: InstanceRuntimeConfig): void {
  const database = new Database(path.join(runtime.checkout_realpath, 'data', 'v2.db'));
  try {
    database.pragma('journal_mode = WAL');
    database.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied TEXT NOT NULL);
      CREATE TABLE agent_groups (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE, agent_provider TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE container_configs (agent_group_id TEXT PRIMARY KEY, image_tag TEXT);
    `);
    LIVE_MIGRATIONS.forEach((name, index) =>
      database.prepare('INSERT INTO schema_version VALUES (?, ?, ?)').run(index + 1, name, '2026-09-01T00:00:00.000Z'),
    );
    for (const [id, name, image] of [
      ['ag-main', 'main', null],
      ['ag-research', 'research', `${imageBase(runtime)}:ag-research`],
      ['ag-scratch', 'scratch', 'someone-elses-image:latest'],
    ] as const) {
      database
        .prepare('INSERT INTO agent_groups VALUES (?, ?, ?, NULL, ?)')
        .run(id, name, id, '2026-09-01T00:00:00.000Z');
      database.prepare('INSERT INTO container_configs VALUES (?, ?)').run(id, image);
    }
  } finally {
    database.close();
  }
}

/** An assistant create finished at the machine's first release. */
async function assistant(host: Machine, port = 37_001): Promise<InstanceRuntimeConfig> {
  const { paths } = host;
  const instanceId = allocateInstanceId();
  const reserved = await reserveInstance(paths, {
    instance_id: instanceId,
    checkout_realpath: paths.checkoutRoot(instanceId),
    source_remote: host.remote,
    release_track: 'dogfood',
    deployed_commit: host.first,
    allocated_ports: { nanoclaw_webhook: port, onecli_app: port + 1, onecli_gateway: port + 2 },
    exclusive_resource_claims: {
      ingress: { mode: 'existing', endpoint_url: `https://a${port}.example.test/webhook/gchat` },
      gcp_project_id: `update-${port}`,
      gcp_account: 'operator@example.test',
      gchat_service_account: `gws-ea-chat@update-${port}.iam.gserviceaccount.com`,
      workspace_email: `a${port}@example.test`,
      onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
    },
  });
  const operation = await acquireInstanceOperation(paths, instanceId);
  if (!operation) throw new Error('The test instance operation was busy');
  try {
    for (const step of PROVISION_STEPS) await recordStepCompleted(operation, step);
  } finally {
    operation.release();
  }
  await materializeReleaseCheckout(paths, reserved);
  const onecli = createOnecliRuntimeLayout({
    instanceId,
    instanceRoot: paths.instanceRoot(instanceId),
    project: reserved.exclusive_resource_claims.onecli_project,
    appPort: reserved.allocated_ports.onecli_app,
    gatewayPort: reserved.allocated_ports.onecli_gateway,
    cliExecutable: ONECLI_CLI,
    dockerEndpoint: DOCKER,
  });
  const runtime = createInstanceRuntimeConfig(reserved, onecli, {
    nodePath: process.execPath,
    homeDirectory: host.root,
    selectedProvider: 'claude',
    dockerEndpoint: DOCKER,
  });
  await persistInstanceRuntime(runtime, (values, root) =>
    writeFileSync(
      path.join(root, '.env'),
      `INSTALL_CJK_FONTS=true\n${Object.entries(values)
        .map(([key, value]) => `${key}=${value}\n`)
        .join('')}`,
      { mode: 0o600 },
    ),
  );
  await writeFile(
    paths.releasePreflightFile(instanceId),
    `${JSON.stringify({
      schema_version: 1,
      instance_id: instanceId,
      deployed_commit: host.first,
      provider: 'claude',
      providerCapabilityDigest: 'c'.repeat(64),
      providerCredential: CREDENTIAL,
      packageManager: 'pnpm@10.34.5',
      onecli: COHORT,
    })}\n`,
    { mode: 0o600 },
  );
  await mkdir(onecli.rootDirectory, { recursive: true, mode: 0o700 });
  await writeFile(onecli.composeFile, renderOnecliCompose(onecli, COHORT, DEPLOYED_GATEWAY), { mode: 0o600 });
  centralDatabase(runtime);
  return runtime;
}

/** What the assistant's conversations and memory hold: a session message row and a memory file. */
async function converse(runtime: InstanceRuntimeConfig, ...messages: readonly string[]): Promise<void> {
  const session = path.join(runtime.checkout_realpath, SESSION);
  await mkdir(session, { recursive: true, mode: 0o700 });
  const database = new Database(path.join(session, 'inbound.db'));
  try {
    database.pragma('journal_mode = DELETE');
    database.exec('CREATE TABLE IF NOT EXISTS messages_in (id TEXT PRIMARY KEY, content TEXT NOT NULL)');
    for (const id of messages) database.prepare('INSERT INTO messages_in VALUES (?, ?)').run(id, `said ${id}`);
  } finally {
    database.close();
  }
  await write(runtime.checkout_realpath, MEMORY, 'The principal prefers mornings.\n');
}

function messages(checkout: string): string[] {
  const database = new Database(path.join(checkout, SESSION, 'inbound.db'), { readonly: true });
  try {
    return (database.prepare('SELECT id FROM messages_in ORDER BY id').all() as Array<{ id: string }>).map(
      (row) => row.id,
    );
  } finally {
    database.close();
  }
}

/** A migration script's effect on the database it resolves from its working directory. */
type Migrate = (database: string) => void;

function applying(...names: readonly string[]): Migrate {
  return (file) => {
    const database = new Database(file);
    try {
      for (const name of names) {
        database
          .prepare('INSERT INTO schema_version SELECT COALESCE(MAX(version), 0) + 1, ?, ? FROM schema_version')
          .run(name, '2026-09-28T12:00:00.000Z');
      }
    } finally {
      database.close();
    }
  };
}

/** Where an update is killed: the boundary call it never returns from. */
type HangPoint = 'build' | 'migrate' | 'stop' | 'stamp' | 'retag' | 'second-tag' | 'verify' | 'rebuild';

/** What every faked boundary holds, and what reached it. */
interface World {
  running: boolean;
  freeBytes: number;
  /** Docker's images: each tag and the image ID it names; `ids` holds every image, tagged or not. */
  readonly tags: Map<string, string>;
  readonly ids: Set<string>;
  readonly commands: SanitizedCommand[];
  readonly serviceCalls: string[];
  readonly preflights: ReleasePreflightInput[];
  readonly onecli: string[];
  readonly rebuilds: Array<{ readonly args: readonly string[]; readonly timeoutMs: number | undefined }>;
  readonly fetched: string[];
  /** The service's stops and starts, and Docker's tag moves, in order. */
  readonly events: string[];
  /** How long each health check was allowed. */
  readonly healthWaits: Array<number | undefined>;
  migrate: Migrate;
  buildFails?: boolean;
  /** What `ps` lists, and what `lsof` finds open under a checkout's data/. */
  processes: string;
  openFiles: string;
  /** The listener ID the running host answers with. */
  listener: string;
  /** Runs when the host starts, from the live checkout, as the host would. */
  onStart?: (checkout: string) => void;
  /** Runs once the release's tripwire is stamped: the last of the carry. */
  onStamp?: () => void;
  rebuildFails?: boolean;
  /** The step an update never returns from, as if killed there; `reached` resolves once it is under way. */
  hangAt?: HangPoint;
  /** Kill the swap at its rename number `renameKill`. */
  renameKill?: number;
  reached?: () => void;
}

let images = 0;

function imageId(): string {
  images += 1;
  return `sha256:${createHash('sha256').update(`image ${images}`).digest('hex')}`;
}

function world(runtime: InstanceRuntimeConfig, migrate: Migrate = applying()): World {
  const tags = new Map([
    [`${imageBase(runtime)}:latest`, imageId()],
    [`${imageBase(runtime)}:ag-research`, imageId()],
    [DEPLOYED_GATEWAY, imageId()],
  ]);
  return {
    running: true,
    freeBytes: 1e15,
    tags,
    ids: new Set(tags.values()),
    commands: [],
    serviceCalls: [],
    preflights: [],
    onecli: [],
    rebuilds: [],
    fetched: [],
    events: [],
    healthWaits: [],
    migrate,
    processes: '',
    openFiles: '',
    listener: '11111111-1111-4111-8111-111111111111',
  };
}

const never = (): Promise<never> => new Promise(() => undefined);

async function hang(state: World, point: HangPoint): Promise<void> {
  if (state.hangAt !== point) return;
  state.reached?.();
  await never();
}

/** Tag an image as Docker does: the tag's former image stays, untagged unless another tag names it. */
function tag(state: World, reference: string, name: string): void {
  const id = state.tags.get(reference) ?? (state.ids.has(reference) ? reference : undefined);
  if (!id) throw new GwsEaError('command_failed', `No such image: ${reference}`, { details: { exitCode: 1 } });
  state.tags.set(name, id);
}

/** Tagged and untagged image IDs of one repository. */
function repositoryImages(state: World, repository: string): { tagged: Set<string>; untagged: string[] } {
  const tagged = new Set([...state.tags].filter(([name]) => name.startsWith(`${repository}:`)).map(([, id]) => id));
  const named = new Set(state.tags.values());
  return { tagged, untagged: [...state.ids].filter((id) => !named.has(id)) };
}

/** Git for real; Docker, `ps`, `lsof`, and the release's own scripts as `state` says. */
function runner(state: World): SanitizedCommandRunner {
  return async (spec) => {
    state.commands.push(spec);
    const [first, second] = spec.args;
    const joined = spec.args.join(' ');
    if (spec.command === 'git') return runSanitizedCommand(spec);
    if (spec.command === 'pnpm' && joined === 'run migrate') {
      state.migrate(path.join(spec.cwd, 'data', 'v2.db'));
      await hang(state, 'migrate');
      return { stdout: '', stderr: '' };
    }
    if (spec.command === 'pnpm' && joined.startsWith('exec tsx scripts/upgrade-state.ts set ')) {
      await hang(state, 'stamp');
      const commit = git(spec.cwd, 'rev-parse', 'HEAD');
      await mkdir(path.join(spec.cwd, 'data'), { recursive: true });
      await writeFile(path.join(spec.cwd, 'data', 'upgrade-state.json'), JSON.stringify({ commit, via: spec.args[5] }));
      state.onStamp?.();
      return { stdout: '', stderr: '' };
    }
    if (spec.command === 'bash' && first?.endsWith(path.join('container', 'build.sh')) && second === 'next') {
      if (state.buildFails) {
        throw new GwsEaError('command_failed', 'bash exited with code 1', {
          details: { exitCode: 1, stderrTail: 'ERROR: failed to solve: process did not complete successfully' },
        });
      }
      const id = imageId();
      state.ids.add(id);
      state.tags.set(`${getInstallScopedNames(spec.env?.NANOCLAW_INSTALL_ID ?? '').containerImageBase}:next`, id);
      await hang(state, 'build');
      return { stdout: '', stderr: '' };
    }
    if (spec.command === 'ps') return { stdout: state.processes, stderr: '' };
    if (spec.command === 'lsof') {
      if (state.openFiles) return { stdout: state.openFiles, stderr: '' };
      throw new GwsEaError('command_failed', 'lsof exited with code 1', { details: { exitCode: 1, stderrTail: '' } });
    }
    if (spec.command === 'docker') {
      const last = spec.args.at(-1)!;
      if (first === 'ps') return { stdout: '', stderr: '' };
      if (first === 'image' && second === 'inspect' && joined.includes('{{.Size}}')) {
        return { stdout: `${IMAGE_BYTES}\n`, stderr: '' };
      }
      if (first === 'image' && second === 'inspect') {
        if (!state.ids.has(last)) {
          throw new GwsEaError('command_failed', 'docker exited with code 1', {
            details: { exitCode: 1, stderrTail: `Error: No such image: ${last}` },
          });
        }
        const names = [...state.tags].filter(([, id]) => id === last).map(([name]) => name);
        return { stdout: `${JSON.stringify(names)}\n`, stderr: '' };
      }
      if (first === 'image' && second === 'ls') {
        const id = state.tags.get(last);
        return { stdout: id ? `${joined.includes('--no-trunc') ? id : id.slice(7, 19)}\n` : '', stderr: '' };
      }
      if (first === 'tag') {
        await hang(state, 'retag');
        if (state.events.at(-1) === 'tag') await hang(state, 'second-tag');
        state.events.push('tag');
        tag(state, spec.args[1]!, spec.args[2]!);
        return { stdout: '', stderr: '' };
      }
      if (first === 'image' && second === 'rm') {
        const id = state.tags.get(last);
        if (id) {
          state.tags.delete(last);
          if (![...state.tags.values()].includes(id)) state.ids.delete(id);
        } else {
          if ([...state.tags.values()].includes(last)) throw new Error(`a tagged image was removed: ${last}`);
          state.ids.delete(last);
        }
        return { stdout: '', stderr: '' };
      }
      if (first === 'build') {
        const id = imageId();
        state.ids.add(id);
        state.tags.set(spec.args[spec.args.indexOf('--tag') + 1]!, id);
        return { stdout: '', stderr: '' };
      }
    }
    throw new Error(`unexpected command: ${spec.command} ${joined}`);
  };
}

/** NanoClaw's service helpers: the assistant's service runs while `state.running` says so. */
function services(state: World): NanoclawServiceHelpers {
  const unused = (): never => {
    throw new Error('the helpers run their commands through the fakes below');
  };
  return {
    createCommandRunner: () => ({ run: unused, tryRun: unused }),
    detectService: (_root, env) => {
      state.serviceCalls.push(`detect ${env.installSlug}`);
      return { mode: 'launchd', active: state.running, name: `com.nanoclaw-v2-${env.installSlug}` };
    },
    stopService: async (_handle, env) => {
      state.serviceCalls.push(`stop ${env.installSlug}`);
      state.events.push(state.running ? 'stop running' : 'stop');
      await hang(state, 'stop');
      state.running = false;
    },
    startService: (_handle, root, env) => {
      state.serviceCalls.push(`start ${env.installSlug}`);
      state.events.push('start');
      state.running = true;
      state.onStart?.(root);
    },
    drainContainers: async (_root, env) => {
      state.serviceCalls.push(`drain ${env.installSlug}`);
    },
    verifyServiceHealth: async (_handle, _root, env, timeoutMs) => {
      state.serviceCalls.push(`health ${env.installSlug}`);
      state.healthWaits.push(timeoutMs);
      return state.running;
    },
  };
}

/** The host's status over its socket, and its listener: the running host answers for its own checkout. */
function hostStatus(state: World, runtime: InstanceRuntimeConfig): HostStatusHelpers {
  const status = (root: string) => ({
    pid: 4242,
    instance_id: `host-${state.serviceCalls.length}`,
    project_root: root,
    webhook: { id: state.listener, port: runtime.allocated_ports.nanoclaw_webhook, paths: ['/webhook/gchat'] },
    channels: [{ instance: 'gchat', type: 'gchat', connected: true }],
  });
  return {
    queryHost: async (root) => {
      if (!state.running) throw new Error('connect ENOENT data/ncl.sock');
      return status(root);
    },
    waitForHost: async (root) => {
      await hang(state, 'verify');
      if (!state.running) throw new Error('Host did not respond. Check logs/nanoclaw.error.log.');
      return status(root);
    },
  };
}

function dependencies(state: World, release: Release, runtime: InstanceRuntimeConfig): UpdateDependencies {
  return {
    serviceHelpers: services(state),
    providerSetup: PROVIDER_SETUP,
    upsertEnvVars,
    hostStatus: hostStatus(state, runtime),
    toolRoot: release.tool,
    runCommand: runner(state),
    runReleasePreflight: async (input) => {
      state.preflights.push(input);
      return {
        provider: input.provider,
        providerCapabilityDigest: input.providerCapabilityDigest,
        providerCredential: input.providerCredential,
        packageManager: 'pnpm@10.34.5',
        onecli: COHORT,
      };
    },
    freeBytes: async () => state.freeBytes,
    service: { platform: 'darwin', uid: 501, ambientEnv: {}, sleep: async () => undefined },
    fetch: async (input, init) => {
      const url = String(input);
      state.fetched.push(`${init?.method ?? 'GET'} ${url}`);
      if (!state.running) throw new TypeError('fetch failed');
      return new Response(null, { status: 401, headers: { 'x-nanoclaw-webhook-id': state.listener } });
    },
    onecli: {
      apply: async (layout) => {
        state.onecli.push(`apply ${layout.project}`);
      },
      verify: async (layout) => {
        state.onecli.push(`verify ${layout.project}`);
      },
      observe: async (layout) => {
        state.onecli.push(`observe ${layout.project}`);
        return { status: 'present' };
      },
    },
    ncl: async (config, args, options) => {
      state.rebuilds.push({ args, timeoutMs: options?.timeoutMs });
      await hang(state, 'rebuild');
      if (state.rebuildFails) {
        throw new GwsEaError('ncl_failed', `ncl ${args.join(' ')} failed: apt-get could not find package made-up`);
      }
      // NanoClaw's buildAgentGroupImage moves the group's tag to an image built on the new base.
      const id = imageId();
      state.ids.add(id);
      state.tags.set(`${imageBase(config)}:${args[args.indexOf('--id') + 1]}`, id);
      return { restarted: 0, rebuilt: true };
    },
    ...(state.renameKill === undefined
      ? {}
      : {
          rename: (() => {
            let calls = 0;
            return async (from: string, to: string) => {
              calls += 1;
              if (calls >= state.renameKill!) {
                state.reached?.();
                await never();
              }
              const { rename } = await import('node:fs/promises');
              await rename(from, to);
            };
          })(),
        }),
  };
}

/** Stage an update of `runtime`'s assistant under its instance lock, as the command does. */
async function stage(host: Machine, runtime: InstanceRuntimeConfig, deps: UpdateDependencies): Promise<StagedUpdate> {
  const intent = await resolveUpdateIntent(host.paths, { instanceId: runtime.instance_id }, deps);
  const operation = await acquireInstanceOperation(host.paths, runtime.instance_id, {
    command: 'update',
    target: intent.target,
  });
  if (!operation) throw new Error('The test instance operation was busy');
  try {
    return await prepareUpdate(operation, intent, deps);
  } finally {
    operation.release();
  }
}

/**
 * Start staging and abandon it at `state.hangAt`, as if the process were
 * killed there: nothing after that point runs, cleanup included, and the
 * instance lock goes with the process.
 */
async function killDuringStaging(host: Machine, runtime: InstanceRuntimeConfig, state: World, release: Release) {
  const deps = dependencies(state, release, runtime);
  const intent = await resolveUpdateIntent(host.paths, { instanceId: runtime.instance_id }, deps);
  const operation = await acquireInstanceOperation(host.paths, runtime.instance_id, {
    command: 'update',
    target: intent.target,
  });
  if (!operation) throw new Error('The test instance operation was busy');
  const reached = new Promise<void>((resolve) => (state.reached = resolve));
  const abandoned = prepareUpdate(operation, intent, deps);
  await Promise.race([reached, abandoned]);
  operation.release();
}

/**
 * Confirm an update and run its cutover until `state.hangAt` (or the swap's
 * rename `state.renameKill`), then abandon it there, as if the process were
 * killed: nothing after that point runs, and the instance lock goes with it.
 */
async function killDuringCutover(host: Machine, runtime: InstanceRuntimeConfig, state: World, release: Release) {
  const deps = dependencies(state, release, runtime);
  const intent = await resolveUpdateIntent(host.paths, { instanceId: runtime.instance_id }, deps);
  const operation = await acquireInstanceOperation(host.paths, runtime.instance_id, {
    command: 'update',
    target: intent.target,
  });
  if (!operation) throw new Error('The test instance operation was busy');
  const reached = new Promise<'killed'>((resolve) => (state.reached = () => resolve('killed')));
  const run = async (): Promise<'finished'> => {
    const staged = await prepareUpdate(operation, intent, deps);
    await confirmStagedUpdate(operation, staged, deps, async () => true);
    await continueUpdate(operation, deps);
    return 'finished';
  };
  expect(await Promise.race([reached, run()])).toBe('killed');
  operation.release();
}

/** Every entry under `root` but those under `except`: type, mode, modification time, and content hash. */
async function snapshot(root: string, except: readonly string[] = []): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  const walk = async (target: string): Promise<void> => {
    if (except.includes(target)) return;
    const info = await lstat(target);
    const key = path.relative(root, target) || '.';
    if (info.isSymbolicLink()) entries.set(key, `link ${await readlink(target)}`);
    else if (info.isFile()) {
      const digest = createHash('sha256')
        .update(await readFile(target))
        .digest('hex');
      entries.set(key, `file ${info.mode} ${info.mtimeMs} ${digest}`);
    } else {
      entries.set(key, `dir ${info.mode}`);
      for (const name of await readdir(target)) await walk(path.join(target, name));
    }
  };
  await walk(root);
  return entries;
}

function release(host: Machine, commit: string): ReleaseCoordinates {
  return { source_remote: host.remote, release_track: 'dogfood', deployed_commit: commit };
}

/** What the assistant's live release is: its registry entry, checkout, receipt, and service. */
async function liveState(host: Machine, runtime: InstanceRuntimeConfig) {
  return {
    registered: releaseOf(await getInstanceReservation(host.paths, runtime.instance_id)),
    head: git(runtime.checkout_realpath, 'rev-parse', 'HEAD'),
    status: git(runtime.checkout_realpath, 'status', '--porcelain'),
    receipt: await readFile(host.paths.releasePreflightFile(runtime.instance_id), 'utf8'),
    migrations: readCentralMigrations(runtime.checkout_realpath),
  };
}

/** Each case clones, fetches, and stages real Git repositories, which a loaded machine slows. */
const GIT_HEAVY = { timeout: 60_000 } as const;

describe('staging an update while the assistant serves', GIT_HEAVY, () => {
  it("stages the tool's release beside the running assistant and previews what the update changes", async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime, applying(ADDED_MIGRATION));
    const before = await liveState(host, runtime);

    const staged = await stage(host, runtime, dependencies(state, next, runtime));

    const id = runtime.instance_id;
    expect(staged.preview).toEqual({
      instanceId: id,
      from: release(host, host.first),
      to: release(host, next.commit),
      migrations: [ADDED_MIGRATION],
      gateway: { current: DEPLOYED_GATEWAY, release: RELEASE_GATEWAY },
      groupImages: [{ id: 'ag-research', name: 'research' }],
      agentRunnerLockChanged: false,
      sessionSchemaChanged: false,
    });
    // It served throughout: the service was only looked at.
    expect(state.running).toBe(true);
    expect(state.serviceCalls).toEqual([`detect ${runtime.install_id}`]);
    expect(await liveState(host, runtime)).toEqual(before);

    // The release is staged in next/, preflighted there, with its receipt beside it.
    const checkout = host.paths.releaseCheckoutRoot(id, 'next');
    expect(staged.checkoutRoot).toBe(checkout);
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(next.commit);
    expect(state.preflights).toEqual([
      {
        checkoutRoot: checkout,
        provider: 'claude',
        providerCapabilityDigest: PROVIDER_SETUP.capabilityDigest,
        providerCredential: CREDENTIAL,
        onecliCliPath: ONECLI_CLI,
      },
    ]);
    expect(JSON.parse(await readFile(host.paths.releasePreflightFile(id, 'next'), 'utf8'))).toMatchObject({
      instance_id: id,
      deployed_commit: next.commit,
      provider: 'claude',
    });
    // The agent image was built from the staged checkout as :next, with the instance's own .env and identity.
    expect(await readFile(path.join(checkout, '.env'), 'utf8')).toBe(
      await readFile(path.join(runtime.checkout_realpath, '.env'), 'utf8'),
    );
    const build = state.commands.find((command) => command.command === 'bash')!;
    expect(build).toMatchObject({ args: [path.join(checkout, 'container', 'build.sh'), 'next'], cwd: checkout });
    expect(build.env).toMatchObject({
      NANOCLAW_INSTALL_ID: runtime.install_id,
      DOCKER_HOST: DOCKER,
      HOME: runtime.home_directory,
    });
    expect(new Set(state.tags.keys())).toEqual(
      new Set([
        `${imageBase(runtime)}:latest`,
        `${imageBase(runtime)}:ag-research`,
        `${imageBase(runtime)}:next`,
        DEPLOYED_GATEWAY,
        RELEASE_GATEWAY,
      ]),
    );
    // Nothing is recorded until the operator confirms.
    expect(await readOperationRecord(host.paths, id)).toBeUndefined();
    expect(staged.manifest).toEqual({ central_migrations: [...LIVE_MIGRATIONS], session_tables: {} });

    const preview = updatePreviewLines(staged.preview).join('\n');
    expect(preview).toContain(`dogfood ${host.first.slice(0, 12)}`);
    expect(preview).toContain(`dogfood ${next.commit.slice(0, 12)}`);
    expect(preview).toContain(ADDED_MIGRATION);
    expect(preview).toContain(`${DEPLOYED_GATEWAY} → ${RELEASE_GATEWAY}`);
    expect(preview).toContain('research (ag-research)');
    expect(preview).toMatch(/failure after the swap may restore the pre-update snapshot/u);
  });

  it.each([
    [
      'only the session-schema sources',
      { 'src/mailbox/sqlite/session-db.ts': '// session columns 2\n' },
      { sessionSchemaChanged: true, agentRunnerLockChanged: false },
    ],
    [
      'only the agent-runner lockfile',
      { [LOCKFILE]: 'lock 2\n' },
      { sessionSchemaChanged: false, agentRunnerLockChanged: true },
    ],
  ] as const)('previews a release that changes %s for what it is', async (_label, files, expected) => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host, files);
    const state = world(runtime);

    const staged = await stage(host, runtime, dependencies(state, next, runtime));

    expect(staged.preview).toMatchObject({ ...expected, migrations: [] });
    const preview = updatePreviewLines(staged.preview).join('\n');
    const snapshotWarning = /failure after the swap may restore the pre-update snapshot/u;
    const staleWarning = /research .*previous agent-runner dependencies/u;
    if (expected.sessionSchemaChanged) expect(preview).toMatch(snapshotWarning);
    else expect(preview).not.toMatch(snapshotWarning);
    if (expected.agentRunnerLockChanged) expect(preview).toMatch(staleWarning);
    else expect(preview).not.toMatch(staleWarning);
  });

  it('removes the staging and changes nothing live when the agent image build fails', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    state.buildFails = true;
    const before = await liveState(host, runtime);
    const tags = new Map(state.tags);

    await expect(stage(host, runtime, dependencies(state, next, runtime))).rejects.toMatchObject({
      code: 'command_failed',
    });

    expect(await exists(host.paths.releaseRoot(runtime.instance_id, 'next'))).toBe(false);
    expect(state.tags).toEqual(tags);
    expect(await liveState(host, runtime)).toEqual(before);
    expect(state.running).toBe(true);
    expect(await readOperationRecord(host.paths, runtime.instance_id)).toBeUndefined();
  });

  it('refuses a release whose migrations fail on a copy of the database, before building anything, and names them', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime, (file) => {
      applying(ADDED_MIGRATION)(file);
      throw new GwsEaError('command_failed', 'pnpm exited with code 1', {
        details: { exitCode: 1, stderrTail: `Error: migration ${FAILING_MIGRATION} left FK violations` },
      });
    });
    const before = await liveState(host, runtime);

    const refusal = stage(host, runtime, dependencies(state, next, runtime));

    await expect(refusal).rejects.toMatchObject({
      code: 'migration_dry_run_failed',
      message: expect.stringContaining(ADDED_MIGRATION),
      details: { stderrTail: expect.stringContaining(FAILING_MIGRATION), applied: [ADDED_MIGRATION] },
    });
    expect(state.commands.some((command) => command.command === 'bash')).toBe(false);
    expect(await exists(host.paths.releaseRoot(runtime.instance_id, 'next'))).toBe(false);
    expect(await liveState(host, runtime)).toEqual(before);
  });

  it('refuses a deployment checkout with tracked edits, naming them, and stages nothing', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    await write(runtime.checkout_realpath, 'release.txt', 'patched in place\n');
    const state = world(runtime);

    await expect(stage(host, runtime, dependencies(state, next, runtime))).rejects.toMatchObject({
      code: 'deployment_checkout_modified',
      message: expect.stringContaining('release.txt'),
    });

    expect(await exists(host.paths.releaseRoot(runtime.instance_id, 'next'))).toBe(false);
    expect(state.preflights).toEqual([]);
  });

  it('refuses before staging when the disk cannot hold the staged release, a copy of its state, and a new image', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    state.freeBytes = IMAGE_BYTES;

    const refusal = stage(host, runtime, dependencies(state, next, runtime));

    await expect(refusal).rejects.toMatchObject({ code: 'insufficient_disk' });
    await expect(refusal).rejects.toSatisfy(
      (error: GwsEaError) => typeof error.details?.needed === 'number' && error.details.needed > IMAGE_BYTES,
    );
    expect(await exists(host.paths.releaseRoot(runtime.instance_id, 'next'))).toBe(false);
    expect(state.preflights).toEqual([]);
  });

  it('refuses a stopped assistant, naming gws-ea start, and stages nothing', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    state.running = false;

    await expect(stage(host, runtime, dependencies(state, next, runtime))).rejects.toMatchObject({
      code: 'host_not_running',
      message: expect.stringContaining(`gws-ea start --id ${runtime.instance_id}`),
    });

    expect(await exists(host.paths.releaseRoot(runtime.instance_id, 'next'))).toBe(false);
  });

  it.each(['build', 'migrate'] as const)(
    'leaves staging killed during the %s behind for status to report, and the next update removes it and stages cleanly',
    async (step) => {
      const host = await machine();
      const runtime = await assistant(host);
      const next = await nextRelease(host);
      const killed = world(runtime, applying(ADDED_MIGRATION));
      killed.hangAt = step;

      await killDuringStaging(host, runtime, killed, next);

      const reservation = await getInstanceReservation(host.paths, runtime.instance_id);
      expect(await inspectOperation(host.paths, reservation)).toEqual({ state: 'none', abandonedStaging: true });
      const leftover = path.join(host.paths.releaseRoot(runtime.instance_id, 'next'), 'left-by-the-killed-run');
      await writeFile(leftover, '');

      const state = world(runtime, applying(ADDED_MIGRATION));
      for (const [name, id] of killed.tags) {
        state.tags.set(name, id);
        state.ids.add(id);
      }
      const staged = await stage(host, runtime, dependencies(state, next, runtime));

      // The :next image a killed build left is removed with next/, before anything is fetched again.
      const nextImage = `${imageBase(runtime)}:next`;
      const docker = (args: string) =>
        state.commands.findIndex((command) => command.command === 'docker' && command.args.join(' ') === args);
      const fetch = state.commands.findIndex((command) => command.command === 'git' && command.args[0] === 'fetch');
      expect(killed.tags.has(nextImage)).toBe(step === 'build');
      expect(docker(`image ls --quiet ${nextImage}`)).toBeGreaterThanOrEqual(0);
      expect(docker(`image ls --quiet ${nextImage}`)).toBeLessThan(fetch);
      if (step === 'build') expect(docker(`image rm ${nextImage}`)).toBeLessThan(fetch);
      expect(docker(`image rm ${nextImage}`) >= 0).toBe(step === 'build');
      expect(await exists(leftover)).toBe(false);
      expect(staged.preview.migrations).toEqual([ADDED_MIGRATION]);
      expect(git(staged.checkoutRoot, 'rev-parse', 'HEAD')).toBe(next.commit);
      expect(await inspectOperation(host.paths, reservation)).toEqual({ state: 'none', abandonedStaging: true });
    },
  );

  it('refuses an assistant whose create has not finished, naming resume', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    // A journal missing its last step: create never finished.
    const journal = JSON.parse(await readFile(host.paths.journalFile(runtime.instance_id), 'utf8')) as {
      steps: Record<string, unknown>;
    };
    delete journal.steps[PROVISION_STEPS.at(-1)!];
    await writeFile(host.paths.journalFile(runtime.instance_id), JSON.stringify(journal), { mode: 0o600 });

    await expect(stage(host, runtime, dependencies(world(runtime), next, runtime))).rejects.toMatchObject({
      code: 'instance_not_created',
      message: expect.stringContaining(`gws-ea resume --id ${runtime.instance_id}`),
    });
  });
});

describe("the dry run of a release's migrations", () => {
  /** A live checkout with the host's closed database, and a staged checkout beside it. */
  async function checkouts() {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gws-ea-dry-run-')));
    roots.push(root);
    const live = path.join(root, 'nanoclaw');
    const staged = path.join(root, 'next', 'nanoclaw');
    await mkdir(path.join(live, 'data'), { recursive: true });
    await mkdir(path.join(staged, 'data'), { recursive: true, mode: 0o700 });
    const database = new Database(path.join(live, 'data', 'v2.db'));
    try {
      database.pragma('journal_mode = WAL');
      database.exec(
        'CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied TEXT NOT NULL)',
      );
      LIVE_MIGRATIONS.forEach((name, index) =>
        database
          .prepare('INSERT INTO schema_version VALUES (?, ?, ?)')
          .run(index + 1, name, '2026-09-01T00:00:00.000Z'),
      );
    } finally {
      database.close();
    }
    return { root, live, staged };
  }

  /** The release's migration script, standing in: it records where it ran and what the database held, then migrates it. */
  function migrationScript(seen: Array<{ cwd: string; migrations: readonly string[] }>): SanitizedCommandRunner {
    return async (spec) => {
      if (spec.command !== 'pnpm' || spec.args.join(' ') !== 'run migrate') throw new Error('unexpected command');
      const database = path.join(spec.cwd, 'data', 'v2.db');
      seen.push({ cwd: spec.cwd, migrations: readCentralMigrations(spec.cwd) });
      applying(ADDED_MIGRATION)(database);
      return { stdout: '', stderr: '' };
    };
  }

  it('runs on a copy in the staged data alone, writing nothing else and leaving the live migrations as they were', async () => {
    const { root, live, staged } = await checkouts();
    const before = await snapshot(root, [path.join(staged, 'data')]);
    const seen: Array<{ cwd: string; migrations: readonly string[] }> = [];

    await expect(
      dryRunReleaseMigrations(
        { liveCheckout: live, liveMigrations: LIVE_MIGRATIONS, stagedCheckout: staged },
        migrationScript(seen),
        {},
      ),
    ).resolves.toEqual([ADDED_MIGRATION]);

    // The script ran from the staged checkout, on a copy holding everything the live database records.
    expect(seen).toEqual([{ cwd: staged, migrations: [...LIVE_MIGRATIONS] }]);
    expect(readCentralMigrations(staged)).toEqual([...LIVE_MIGRATIONS, ADDED_MIGRATION]);
    expect(readCentralMigrations(live)).toEqual([...LIVE_MIGRATIONS]);
    expect(await snapshot(root, [path.join(staged, 'data')])).toEqual(before);
    expect((await lstat(path.join(staged, 'data', 'v2.db'))).mode & 0o777).toBe(0o600);
  });

  it.each([
    ["the staged checkout's data is a link to the live data", 'data'],
    ['the staged checkout is a link to the live checkout', 'checkout'],
    ['the staged checkout is a link to a directory elsewhere', 'elsewhere'],
  ] as const)('refuses before running or writing anything when %s', async (_label, linked) => {
    const { root, live, staged } = await checkouts();
    const elsewhere = path.join(root, 'elsewhere');
    await mkdir(elsewhere);
    if (linked === 'data') {
      await rm(path.join(staged, 'data'), { recursive: true });
      await symlink(path.join(live, 'data'), path.join(staged, 'data'));
    } else {
      await rm(staged, { recursive: true });
      await symlink(linked === 'checkout' ? live : elsewhere, staged);
    }
    const resolved = path.join(linked === 'elsewhere' ? elsewhere : live, 'data', 'v2.db');
    const before = await snapshot(root);
    const seen: Array<{ cwd: string; migrations: readonly string[] }> = [];

    await expect(
      dryRunReleaseMigrations(
        { liveCheckout: live, liveMigrations: LIVE_MIGRATIONS, stagedCheckout: staged },
        migrationScript(seen),
        {},
      ),
    ).rejects.toMatchObject({
      code: 'unsafe_dry_run',
      message: expect.stringContaining(
        `would run against ${resolved}, outside the staged checkout's ${path.join(staged, 'data')}`,
      ),
    });

    expect(seen).toEqual([]);
    expect(await snapshot(root)).toEqual(before);
  });

  it('refuses before running when the staged checkout already holds a database where the copy goes', async () => {
    const { live, staged } = await checkouts();
    await writeFile(path.join(staged, 'data', 'v2.db'), 'a database the release shipped\n');
    const seen: Array<{ cwd: string; migrations: readonly string[] }> = [];

    await expect(
      dryRunReleaseMigrations(
        { liveCheckout: live, liveMigrations: LIVE_MIGRATIONS, stagedCheckout: staged },
        migrationScript(seen),
        {},
      ),
    ).rejects.toMatchObject({ code: 'unsafe_dry_run', message: expect.stringContaining('already holds a database') });

    expect(seen).toEqual([]);
    expect(await readFile(path.join(staged, 'data', 'v2.db'), 'utf8')).toBe('a database the release shipped\n');
  });

  it('refuses when the live migrations changed while the dry run ran', async () => {
    const { live, staged } = await checkouts();
    const runLive: SanitizedCommandRunner = async () => {
      applying(ADDED_MIGRATION)(path.join(live, 'data', 'v2.db'));
      return { stdout: '', stderr: '' };
    };

    await expect(
      dryRunReleaseMigrations(
        { liveCheckout: live, liveMigrations: LIVE_MIGRATIONS, stagedCheckout: staged },
        runLive,
        {},
      ),
    ).rejects.toMatchObject({ code: 'live_schema_changed' });
  });
});

/** Leave an update to `to` open, as a cutover interrupted after its stop would. */
async function openUpdate(host: Machine, runtime: InstanceRuntimeConfig, to: ReleaseCoordinates): Promise<void> {
  const operation = await acquireInstanceOperation(host.paths, runtime.instance_id, { command: 'update', target: to });
  if (!operation) throw new Error('The test instance operation was busy');
  try {
    await beginOperation(operation, { kind: 'update', from: release(host, host.first), to });
    await advanceOperation(operation, 'stopped', { stop: { at: '2026-09-28T10:00:00.000Z', graceful: true } });
  } finally {
    operation.release();
  }
}

function cli(
  host: Machine,
  state: World,
  next: Release,
  runtime: InstanceRuntimeConfig,
  overrides: Partial<CliRuntime> = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const {
    serviceHelpers,
    providerSetup,
    upsertEnvVars: upsert,
    hostStatus: host_,
    reporter: _reporter,
    ...seams
  } = dependencies(state, next, runtime);
  const run = (args: readonly string[]) =>
    runCli(args, {
      paths: host.paths,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      serviceHelpers,
      toolProviderSetup: async () => providerSetup,
      upsertEnvVars: upsert,
      hostStatus: host_,
      update: seams,
      ...overrides,
    });
  return { run, out, err };
}

/** `status` for the assistant, observed through the same fakes: it must answer in any state. */
function status(host: Machine, state: World, next: Release, runtime: InstanceRuntimeConfig) {
  const unserved = async (): Promise<never> => {
    throw new GwsEaError('ncl_failed', 'the host does not answer in this test');
  };
  const deps = dependencies(state, next, runtime);
  return observeAssistantStatus(
    {
      paths: host.paths,
      serviceHelpers: deps.serviceHelpers,
      hostStatus: deps.hostStatus,
      toolRoot: next.tool,
      platform: 'darwin',
      uid: 501,
      observers: {
        runCommand: runner(state),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ncl: unserved,
        onecliAdmin: unserved,
        onecli: async () => ({ status: 'present' }),
      },
    },
    runtime.instance_id,
  );
}

function receiptCommit(file: string): Promise<string> {
  return readFile(file, 'utf8').then((text) => (JSON.parse(text) as { deployed_commit: string }).deployed_commit);
}

function runtimeCommit(checkout: string): Promise<string> {
  return receiptCommit(path.join(checkout, 'data', 'gws-ea', 'runtime.json'));
}

/**
 * The assistant once an update from the machine's first release to `to` is
 * recorded and finished: every record names `to`, the previous release is
 * kept whole, `:latest` is the image the update built and `:previous` the
 * one it ran, and nothing of the update is left open.
 */
async function expectUpdated(host: Machine, runtime: InstanceRuntimeConfig, to: Release, state: World, ran: string) {
  const id = runtime.instance_id;
  const live = runtime.checkout_realpath;
  const previous = host.paths.releaseCheckoutRoot(id, 'previous');
  expect(releaseOf(await getInstanceReservation(host.paths, id))).toEqual(release(host, to.commit));
  expect(git(live, 'rev-parse', 'HEAD')).toBe(to.commit);
  expect(git(live, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  expect(await receiptCommit(instanceMarkerFile(live))).toBe(to.commit);
  expect(await runtimeCommit(live)).toBe(to.commit);
  expect(await receiptCommit(host.paths.releasePreflightFile(id))).toBe(to.commit);
  // The tripwire was stamped by the release's own script, in its checkout, for its own commit.
  expect(JSON.parse(await readFile(path.join(live, 'data', 'upgrade-state.json'), 'utf8'))).toEqual({
    commit: to.commit,
    via: 'gws-ea',
  });
  expect(git(previous, 'rev-parse', 'HEAD')).toBe(host.first);
  expect(await receiptCommit(instanceMarkerFile(previous))).toBe(host.first);
  expect(await runtimeCommit(previous)).toBe(host.first);
  expect(await receiptCommit(host.paths.releasePreflightFile(id, 'previous'))).toBe(host.first);
  expect(await readOperationRecord(host.paths, id)).toBeUndefined();
  expect(await exists(host.paths.releaseRoot(id, 'next'))).toBe(false);
  const base = imageBase(runtime);
  expect(state.tags.get(`${base}:previous`)).toBe(ran);
  expect(state.tags.get(`${base}:latest`)).not.toBe(ran);
  expect(state.tags.has(`${base}:next`)).toBe(false);
  expect(repositoryImages(state, base).untagged).toEqual([]);
}

/** Where each kill leaves the update's record. */
const KILLS: ReadonlyArray<readonly [string, (state: World) => void, OperationPhase]> = [
  ['while stopping the host', (state) => (state.hangAt = 'stop'), 'staged'],
  ['after the stop, while carrying its state', (state) => (state.hangAt = 'stamp'), 'stopped'],
  ["at the swap's first rename", (state) => (state.renameKill = 1), 'swapping'],
  ['once the kept files moved into previous/', (state) => (state.renameKill = 2), 'swapping'],
  ['between the two checkout renames', (state) => (state.renameKill = 3), 'swapping'],
  ["before the new release's receipt is promoted", (state) => (state.renameKill = 4), 'swapping'],
  ['after the swap, while retagging images', (state) => (state.hangAt = 'retag'), 'swapped'],
  ['between the two image tags', (state) => (state.hangAt = 'second-tag'), 'swapped'],
  ['after the start, while verifying', (state) => (state.hangAt = 'verify'), 'started'],
  ['once recorded, while rebuilding group images', (state) => (state.hangAt = 'rebuild'), 'recorded'],
];

describe('an update killed during its cutover', GIT_HEAVY, () => {
  it.each(KILLS)(
    'killed %s, is reported by status, refuses conflicting commands, and is finished by update',
    async (_label, kill, phase) => {
      const host = await machine();
      const runtime = await assistant(host);
      await converse(runtime, 'm1', 'm2');
      const next = await nextRelease(host);
      const state = world(runtime);
      const ran = state.tags.get(`${imageBase(runtime)}:latest`)!;
      kill(state);

      await killDuringCutover(host, runtime, state, next);

      const id = runtime.instance_id;
      expect((await readOperationRecord(host.paths, id))?.phase).toBe(phase);
      const observed = await status(host, state, next, runtime);
      // Whichever release is live, its own receipt and Compose file say what OneCLI must run (KTD6, KTD17).
      if (phase !== 'swapping') expect(observed.probes.onecli).toEqual({ status: 'ok', reason: null });
      expect(observed.operation).toMatchObject(
        phase === 'recorded'
          ? {
              state: 'recorded',
              follow_ups: expect.arrayContaining([{ kind: 'rebuild_group_image', agent_group_id: 'ag-research' }]),
            }
          : {
              state: 'open',
              phase,
              continue_with: `gws-ea update --id ${id}`,
              revert_with: `gws-ea rollback --id ${id}`,
            },
      );

      delete state.hangAt;
      delete state.renameKill;
      const { run, err, out } = cli(host, state, next, runtime);
      if (phase === 'recorded') {
        // The release is recorded, so the gate is released: the assistant runs as usual.
        expect(await run(['start', '--id', id])).toBe(0);
      } else {
        expect(await run(['start', '--id', id])).toBe(1);
        expect(err.join('\n')).toContain(`Continue it with gws-ea update --id ${id}`);
        expect(err.join('\n')).toContain(`revert it with gws-ea rollback --id ${id}`);
      }

      expect(await run(['update', '--id', id, '--yes'])).toBe(0);

      // It went on from its record: nothing was staged twice.
      expect(state.preflights).toHaveLength(1);
      await expectUpdated(host, runtime, next, state, ran);
      expect(messages(runtime.checkout_realpath)).toEqual(['m1', 'm2']);
      expect(await readFile(path.join(runtime.checkout_realpath, MEMORY), 'utf8')).toContain('mornings');
      expect(state.running).toBe(true);
      const target = `dogfood ${next.commit.slice(0, 12)}`;
      expect(out).toContain(
        phase === 'recorded'
          ? `Assistant ${id} runs ${target}; its update is finished.`
          : `Assistant ${id} was updated to ${target}.`,
      );
    },
  );

  it.each(['verified', 'committed to the registry'] as const)(
    'killed once %s, is recorded and finished by update without verifying again',
    async (point) => {
      const host = await machine();
      const runtime = await assistant(host);
      const next = await nextRelease(host);
      const state = world(runtime);
      const ran = state.tags.get(`${imageBase(runtime)}:latest`)!;
      state.hangAt = 'verify';
      await killDuringCutover(host, runtime, state, next);
      // The process got past verification and recorded it, then (for the second case) moved the registry too.
      const id = runtime.instance_id;
      const operation = await acquireInstanceOperation(host.paths, id, {
        command: 'update',
        target: release(host, next.commit),
      });
      if (!operation) throw new Error('The test instance operation was busy');
      try {
        await advanceOperation(operation, 'verified');
      } finally {
        operation.release();
      }
      if (point === 'committed to the registry') {
        await swapInstanceRelease(host.paths, id, release(host, host.first), release(host, next.commit));
      }
      delete state.hangAt;
      const checks = state.healthWaits.length;

      expect(await cli(host, state, next, runtime).run(['update', '--id', id, '--yes'])).toBe(0);

      expect(state.healthWaits).toHaveLength(checks);
      await expectUpdated(host, runtime, next, state, ran);
    },
  );

  it('re-stops a host the OS started at stopped, and carries the state it wrote since', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    await converse(runtime, 'm1');
    const next = await nextRelease(host);
    const state = world(runtime);
    const ran = state.tags.get(`${imageBase(runtime)}:latest`)!;
    state.hangAt = 'stamp';
    await killDuringCutover(host, runtime, state, next);
    expect((await readOperationRecord(host.paths, runtime.instance_id))?.phase).toBe('stopped');

    // The OS starts the old host again (RunAtLoad at login), and it serves another message.
    state.running = true;
    await converse(runtime, 'm2');
    delete state.hangAt;
    const stops = state.serviceCalls.filter((call) => call.startsWith('stop')).length;
    const { run } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);

    expect(state.serviceCalls.filter((call) => call.startsWith('stop')).length).toBe(stops + 1);
    await expectUpdated(host, runtime, next, state, ran);
    expect(messages(runtime.checkout_realpath)).toEqual(['m1', 'm2']);
    // The release kept for rollback is the state as the old host last left it.
    expect(messages(host.paths.releaseCheckoutRoot(runtime.instance_id, 'previous'))).toEqual(['m1', 'm2']);
  });

  it('stops a host the OS started at swapped before it moves any image, then starts the release again', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    const ran = state.tags.get(`${imageBase(runtime)}:latest`)!;
    state.hangAt = 'retag';
    await killDuringCutover(host, runtime, state, next);
    expect((await readOperationRecord(host.paths, runtime.instance_id))?.phase).toBe('swapped');

    // The OS starts the host, now from the new release's checkout, still on the old agent image.
    state.running = true;
    delete state.hangAt;
    state.events.length = 0;

    expect(await cli(host, state, next, runtime).run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);

    expect(state.events).toEqual(['stop running', 'tag', 'tag', 'start']);
    await expectUpdated(host, runtime, next, state, ran);
  });
});

describe('the cutover refuses to go on', GIT_HEAVY, () => {
  it("when the live database's migrations changed since staging, before recording the stop", async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime, applying(ADDED_MIGRATION));
    state.hangAt = 'stop';
    await killDuringCutover(host, runtime, state, next);
    // Something migrated the live database while the update waited to stop it.
    applying(FAILING_MIGRATION)(path.join(runtime.checkout_realpath, 'data', 'v2.db'));
    delete state.hangAt;
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain(FAILING_MIGRATION);
    expect(err.join('\n')).toContain(`gws-ea rollback --id ${runtime.instance_id}`);
    expect((await readOperationRecord(host.paths, runtime.instance_id))?.phase).toBe('staged');
    expect(await exists(path.join(host.paths.releaseCheckoutRoot(runtime.instance_id, 'next'), SESSION))).toBe(false);
  });

  it('when anything still holds its data open, before copying or moving anything', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    await converse(runtime, 'm1');
    const next = await nextRelease(host);
    const state = world(runtime);
    const live = runtime.checkout_realpath;
    const before = await snapshot(live);
    // A leftover opener, idle: an operator's sqlite3 shell on a session database.
    state.openFiles = `p4242\ncsqlite3\nf5\nn${path.join(live, SESSION, 'inbound.db')}\n`;
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(1);

    const summary = err.join('\n');
    expect(summary).toContain(`sqlite3 (PID 4242) holds ${path.join(live, SESSION, 'inbound.db')}`);
    expect(summary).toContain(`gws-ea rollback --id ${runtime.instance_id}`);
    expect((await readOperationRecord(host.paths, runtime.instance_id))?.phase).toBe('staged');
    // Nothing was copied, settled, or moved.
    expect(await snapshot(live)).toEqual(before);
    const staged = host.paths.releaseCheckoutRoot(runtime.instance_id, 'next');
    expect(await exists(path.join(staged, SESSION))).toBe(false);
    expect(await exists(path.join(host.paths.releaseRoot(runtime.instance_id, 'next'), 'carrying'))).toBe(false);
    expect(await exists(host.paths.releaseRoot(runtime.instance_id, 'previous'))).toBe(false);
    expect(releaseOf(await getInstanceReservation(host.paths, runtime.instance_id))).toEqual(release(host, host.first));
  });

  it('when something opens its data after the carry, just before the first rename, moving nothing', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    await converse(runtime, 'm1');
    const next = await nextRelease(host);
    const state = world(runtime);
    const ran = state.tags.get(`${imageBase(runtime)}:latest`)!;
    const live = runtime.checkout_realpath;
    state.onStamp = () => {
      state.openFiles = `p5150\ncnode\nf9\nn${path.join(live, 'data', 'v2.db')}\n`;
    };
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain(`node (PID 5150) holds ${path.join(live, 'data', 'v2.db')}`);
    const id = runtime.instance_id;
    expect((await readOperationRecord(host.paths, id))?.phase).toBe('swapping');
    expect(git(live, 'rev-parse', 'HEAD')).toBe(host.first);
    expect(git(host.paths.releaseCheckoutRoot(id, 'next'), 'rev-parse', 'HEAD')).toBe(next.commit);
    expect(await exists(host.paths.releaseRoot(id, 'previous'))).toBe(false);

    // Once it lets go, the update goes on from its record.
    state.openFiles = '';
    delete state.onStamp;
    expect(await run(['update', '--id', id, '--yes'])).toBe(0);
    await expectUpdated(host, runtime, next, state, ran);
    expect(messages(live)).toEqual(['m1']);
  });

  it('when the host answers while the live checkout is not at the target, recording nothing', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    // Something moved the live checkout off the release before the host came up; the host still answers.
    state.onStart = (checkout) => {
      git(
        checkout,
        '-c',
        'user.name=T',
        '-c',
        'user.email=t@example.test',
        'commit',
        '--quiet',
        '--allow-empty',
        '-m',
        'x',
      );
    };
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain(`gws-ea rollback --id ${runtime.instance_id}`);
    expect((await readOperationRecord(host.paths, runtime.instance_id))?.phase).toBe('started');
    expect(releaseOf(await getInstanceReservation(host.paths, runtime.instance_id))).toEqual(release(host, host.first));
  });
});

describe('gws-ea update', GIT_HEAVY, () => {
  it("switches the assistant to the tool's release, keeping every conversation, memory, and setting", async () => {
    const host = await machine();
    const runtime = await assistant(host);
    await converse(runtime, 'm1');
    const live = runtime.checkout_realpath;
    await write(live, 'data/circuit-breaker.json', '{"crashes":4}');
    const next = await nextRelease(host);
    const state = world(runtime, applying(ADDED_MIGRATION));
    const base = imageBase(runtime);
    const ran = state.tags.get(`${base}:latest`)!;
    const research = state.tags.get(`${base}:ag-research`)!;
    const before = await snapshot(live, [path.join(live, 'data', 'v2.db-shm'), path.join(live, 'data', 'v2.db-wal')]);
    const { run, out } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);

    const id = runtime.instance_id;
    await expectUpdated(host, runtime, next, state, ran);
    const printed = out.join('\n');
    expect(printed).toContain(ADDED_MIGRATION);
    expect(out.at(-1)).toContain(`dogfood ${host.first.slice(0, 12)}`);
    expect(printed).toContain(`Assistant ${id} was updated to dogfood ${next.commit.slice(0, 12)}.`);
    // Conversations, memory, and settings came across; the old release's own records and crash count did not.
    expect(messages(live)).toEqual(['m1']);
    expect(await readFile(path.join(live, MEMORY), 'utf8')).toContain('mornings');
    expect(await readFile(path.join(live, '.env'), 'utf8')).toContain('INSTALL_CJK_FONTS=true');
    expect(await exists(path.join(live, 'data', 'circuit-breaker.json'))).toBe(false);
    // The previous release is the snapshot the stop left, untouched by the update.
    const previous = host.paths.releaseCheckoutRoot(id, 'previous');
    expect(
      await snapshot(previous, [path.join(previous, 'data', 'v2.db-shm'), path.join(previous, 'data', 'v2.db-wal')]),
    ).toEqual(before);
    // It keeps the files that release ran with: its Compose file and gws-ea's .env keys.
    const kept = path.join(host.paths.releaseRoot(id, 'previous'));
    expect(await readFile(path.join(kept, 'onecli-compose.yaml'), 'utf8')).toContain(DEPLOYED_GATEWAY);
    expect(JSON.parse(await readFile(path.join(kept, 'host-environment.json'), 'utf8'))).toMatchObject({
      WEBHOOK_PORT: String(runtime.allocated_ports.nanoclaw_webhook),
    });
    // The service definition is the release's own, written while the host was stopped.
    const definition = path.join(host.root, 'Library', 'LaunchAgents', `com.nanoclaw-v2-${runtime.install_id}.plist`);
    expect(await readFile(definition, 'utf8')).toContain(path.join(live, 'dist', 'gws-ea', 'process.js'));
    // The release changed the gateway: it was recreated, then checked with the isolation probe.
    expect(state.onecli).toEqual([`apply ${runtime.onecli_project}`, `verify ${runtime.onecli_project}`]);
    // Its listener answers for the new host, and the route reaches it.
    expect(state.fetched).toEqual(
      expect.arrayContaining([
        `POST http://127.0.0.1:${runtime.allocated_ports.nanoclaw_webhook}/webhook/gchat`,
        `POST ${runtime.endpoint_url}`,
      ]),
    );
    // The per-group image was rebuilt on the new base, with the host's own build bound, and its old image deleted.
    expect(state.rebuilds).toEqual([
      { args: ['groups', 'restart', '--id', 'ag-research', '--rebuild'], timeoutMs: expect.any(Number) },
    ]);
    expect(state.rebuilds[0]!.timeoutMs).toBeGreaterThanOrEqual(15 * 60_000);
    expect(state.ids.has(research)).toBe(false);
    expect(state.healthWaits).toEqual([60_000]);
  });

  it("allows a killed host's claim lease when the stop was not graceful", async () => {
    const host = await machine();
    const runtime = await assistant(host);
    // The host was killed: its lease row was never marked stopped, and has not expired.
    const database = new Database(path.join(runtime.checkout_realpath, 'data', 'v2.db'));
    try {
      database.exec(`CREATE TABLE host_instances (
        instance_id TEXT PRIMARY KEY, install_id TEXT, hostname TEXT, pid INTEGER,
        started_at TEXT NOT NULL, lease_expires_at TEXT NOT NULL, stopped_at TEXT)`);
      database
        .prepare('INSERT INTO host_instances VALUES (?, ?, NULL, 1, ?, ?, NULL)')
        .run('killed-host', runtime.install_id, '2026-09-28T09:00:00.000Z', '2999-01-01T00:00:00.000Z');
    } finally {
      database.close();
    }
    const next = await nextRelease(host);
    const state = world(runtime);
    const { run } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);

    expect(state.healthWaits.at(-1)).toBe(60_000 + 90_000);
  });

  it('keeps a failed image rebuild as a follow-up that leaves the release in place, and retries it next time', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    const ran = state.tags.get(`${imageBase(runtime)}:latest`)!;
    state.rebuildFails = true;
    const { run, err, out } = cli(host, state, next, runtime);
    const id = runtime.instance_id;

    expect(await run(['update', '--id', id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain('ag-research');
    expect(err.join('\n')).toContain(`gws-ea update --id ${id}`);
    expect(releaseOf(await getInstanceReservation(host.paths, id))).toEqual(release(host, next.commit));
    expect(await readOperationRecord(host.paths, id)).toMatchObject({
      phase: 'recorded',
      follow_ups: expect.arrayContaining([{ kind: 'rebuild_group_image', agent_group_id: 'ag-research' }]),
    });
    expect((await status(host, state, next, runtime)).operation).toMatchObject({ state: 'recorded' });
    // The gate is released: the assistant starts and its ncl is admitted.
    expect(await run(['start', '--id', id])).toBe(0);
    const ncl = await acquireInstanceOperation(host.paths, id, { command: 'ncl' });
    expect(ncl).not.toBeNull();
    ncl?.release();

    state.rebuildFails = false;
    expect(await run(['update', '--id', id, '--yes'])).toBe(0);

    expect(out.at(-1)).toBe(`Assistant ${id} runs dogfood ${next.commit.slice(0, 12)}; its update is finished.`);
    await expectUpdated(host, runtime, next, state, ran);
  });

  it('after two updates keeps one previous release and leaves no untagged agent image', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const first = await nextRelease(host);
    const state = world(runtime);
    expect(await cli(host, state, first, runtime).run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);
    const second = await nextRelease(host);
    const base = imageBase(runtime);
    const ran = state.tags.get(`${base}:latest`)!;

    expect(await cli(host, state, second, runtime).run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);

    const id = runtime.instance_id;
    expect(git(runtime.checkout_realpath, 'rev-parse', 'HEAD')).toBe(second.commit);
    expect(git(host.paths.releaseCheckoutRoot(id, 'previous'), 'rev-parse', 'HEAD')).toBe(first.commit);
    expect(await exists(host.paths.releaseRoot(id, 'superseded'))).toBe(false);
    expect(state.tags.get(`${base}:previous`)).toBe(ran);
    expect(repositoryImages(state, base).untagged).toEqual([]);
    expect([...state.tags.keys()].filter((name) => name.startsWith(`${base}:`)).sort()).toEqual(
      [`${base}:ag-research`, `${base}:latest`, `${base}:previous`].sort(),
    );
  });

  it("updates one assistant without touching another's checkout, state, service, images, OneCLI, or connector", async () => {
    const host = await machine();
    const a = await assistant(host, 37_001);
    const b = await assistant(host, 37_101);
    const next = await nextRelease(host);
    const state = world(a);
    const bLatest = imageId();
    state.tags.set(`${imageBase(b)}:latest`, bLatest);
    state.ids.add(bLatest);
    const bRegistered = await getInstanceReservation(host.paths, b.instance_id);
    const bFiles = await snapshot(host.paths.instanceRoot(b.instance_id));

    expect(await cli(host, state, next, a).run(['update', '--id', a.instance_id, '--yes'])).toBe(0);

    const identifiers = [
      b.instance_id,
      b.install_id,
      b.checkout_realpath,
      b.onecli_project,
      imageBase(b),
      String(b.allocated_ports.nanoclaw_webhook),
      b.endpoint_url,
    ];
    const reached = [
      ...state.commands.map((command) => JSON.stringify(command)),
      ...state.serviceCalls,
      ...state.onecli,
      ...state.fetched,
      ...state.rebuilds.map((call) => call.args.join(' ')),
    ].join('\n');
    for (const identifier of identifiers) expect(reached).not.toContain(identifier);
    expect(reached).not.toContain('cloudflared');
    expect(await getInstanceReservation(host.paths, b.instance_id)).toEqual(bRegistered);
    expect(await snapshot(host.paths.instanceRoot(b.instance_id))).toEqual(bFiles);
    expect(state.tags.get(`${imageBase(b)}:latest`)).toBe(bLatest);
  });

  it('asks on a terminal with the preview, and a decline leaves no record and removes the staging', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    const asked: unknown[] = [];
    const { run, out } = cli(host, state, next, runtime, {
      confirmUpdate: async (preview) => {
        asked.push(preview);
        return false;
      },
    });

    expect(await run(['update', '--id', runtime.instance_id])).toBe(0);

    expect(asked).toEqual([expect.objectContaining({ to: release(host, next.commit) })]);
    expect(out).toContain('Update cancelled. Nothing was changed.');
    expect(await readOperationRecord(host.paths, runtime.instance_id)).toBeUndefined();
    expect(await exists(host.paths.releaseRoot(runtime.instance_id, 'next'))).toBe(false);
    expect(state.tags.has(`${imageBase(runtime)}:next`)).toBe(false);
    expect(state.running).toBe(true);
  });

  it('fails with input_required without a terminal or --yes, before anything is read or run', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id])).toBe(1);

    expect(err.join('\n')).toContain('pass --yes');
    expect(state.commands).toEqual([]);
    expect(state.serviceCalls).toEqual([]);
    expect(await exists(host.paths.releaseRoot(runtime.instance_id, 'next'))).toBe(false);
  });

  it('refuses a stopped assistant naming gws-ea start, without offering to retry the update', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    state.running = false;
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(1);

    const summary = err.join('\n');
    expect(summary).toContain(`gws-ea start --id ${runtime.instance_id}`);
    expect(summary).not.toContain('Retry with');
  });

  it('refuses to start another update while one to a different release is unfinished, naming what continues it', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    await openUpdate(host, runtime, release(host, 'e'.repeat(40)));
    const state = world(runtime);
    const { run, err } = cli(host, state, next, runtime);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(1);

    const summary = err.join('\n');
    expect(summary).toContain('is unfinished (stopped)');
    expect(summary).toContain(`gws-ea rollback --id ${runtime.instance_id}`);
    expect(state.preflights).toEqual([]);
    expect(await exists(host.paths.releaseRoot(runtime.instance_id, 'next'))).toBe(false);
  });
});
