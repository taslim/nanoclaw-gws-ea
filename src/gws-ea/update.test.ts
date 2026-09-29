/**
 * `update` stages the tool's release beside an assistant built as create
 * leaves it: a registry reservation and completed journal, a Git checkout
 * detached at its release with its marker, runtime, and `.env`, the release
 * receipt, the OneCLI Compose file, and a central database the host left
 * closed. Git and SQLite are real; the service manager, Docker, the release's
 * install and build, and its migration script are faked at their boundaries.
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
import { advanceOperation, beginOperation, inspectOperation, readOperationRecord } from './operation.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { LAUNCHER_PINS, ONECLI_SDK_VERSION } from './pins.js';
import { runSanitizedCommand, type SanitizedCommand, type SanitizedCommandRunner } from './process.js';
import { allocateInstanceId, getInstanceReservation } from './registry.js';
import type { ReleasePreflightInput } from './release-preflight.js';
import type { ToolProviderSetup } from './release-target.js';
import { createInstanceRuntimeConfig, persistInstanceRuntime, type InstanceRuntimeConfig } from './service.js';
import type { NanoclawServiceHelpers } from './service-control.js';
import { GwsEaError, PROVISION_STEPS, releaseOf, type ReleaseCoordinates } from './types.js';
import {
  dryRunReleaseMigrations,
  prepareUpdate,
  resolveUpdateIntent,
  updatePreviewLines,
  type StagedUpdate,
  type UpdateDependencies,
} from './update.js';
import { readCentralMigrations } from './verify.js';
import { getInstallScopedNames } from '../install-slug.js';

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
  await write(work, '.gitignore', 'data/\nlogs/\n.env\n');
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

/** Push the next release to the track, changing `files`. */
async function nextRelease(host: Machine, files: Readonly<Record<string, string>> = {}): Promise<Release> {
  await write(host.work, 'release.txt', 'next\n');
  for (const [file, contents] of Object.entries(files)) await write(host.work, file, contents);
  const commit = commitAll(host.work, 'next release');
  git(host.work, 'push', '--quiet', 'origin', `HEAD:refs/heads/${TRACK_BRANCH}`);
  const tool = path.join(host.root, `tool-${commit.slice(0, 8)}`);
  git(host.root, 'clone', '--quiet', host.remote, tool);
  git(tool, 'checkout', '--quiet', '--detach', commit);
  return { commit, tool };
}

function imageBase(runtime: InstanceRuntimeConfig): string {
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

/** What every faked boundary holds, and what reached it. */
interface World {
  running: boolean;
  freeBytes: number;
  readonly images: Set<string>;
  readonly commands: SanitizedCommand[];
  readonly serviceCalls: string[];
  readonly preflights: ReleasePreflightInput[];
  migrate: Migrate;
  buildFails?: boolean;
  /** The step staging never returns from, as if killed there; `reached` resolves once it is under way. */
  hangAt?: 'build' | 'migrate';
  reached?: () => void;
}

function world(runtime: InstanceRuntimeConfig, migrate: Migrate = applying()): World {
  return {
    running: true,
    freeBytes: 1e15,
    images: new Set([`${imageBase(runtime)}:latest`, DEPLOYED_GATEWAY]),
    commands: [],
    serviceCalls: [],
    preflights: [],
    migrate,
  };
}

const never = (): Promise<never> => new Promise(() => undefined);

/** Git for real; the release's migration script, its image build, and Docker as `state` says. */
function runner(state: World): SanitizedCommandRunner {
  return async (spec) => {
    state.commands.push(spec);
    const [first, second] = spec.args;
    if (spec.command === 'git') return runSanitizedCommand(spec);
    if (spec.command === 'pnpm' && spec.args.join(' ') === 'run migrate') {
      state.migrate(path.join(spec.cwd, 'data', 'v2.db'));
      if (state.hangAt === 'migrate') {
        state.reached?.();
        return never();
      }
      return { stdout: '', stderr: '' };
    }
    if (spec.command === 'bash' && first?.endsWith(path.join('container', 'build.sh')) && second === 'next') {
      const next = `${getInstallScopedNames(spec.env?.NANOCLAW_INSTALL_ID ?? '').containerImageBase}:next`;
      if (state.buildFails) {
        throw new GwsEaError('command_failed', 'bash exited with code 1', {
          details: { exitCode: 1, stderrTail: 'ERROR: failed to solve: process did not complete successfully' },
        });
      }
      state.images.add(next);
      if (state.hangAt === 'build') {
        state.reached?.();
        return never();
      }
      return { stdout: '', stderr: '' };
    }
    if (spec.command === 'docker') {
      const image = spec.args.at(-1)!;
      if (first === 'image' && second === 'inspect') return { stdout: `${IMAGE_BYTES}\n`, stderr: '' };
      if (first === 'image' && second === 'ls')
        return { stdout: state.images.has(image) ? 'sha256:1\n' : '', stderr: '' };
      if (first === 'image' && second === 'rm') {
        state.images.delete(image);
        return { stdout: '', stderr: '' };
      }
      if (first === 'build') {
        state.images.add(spec.args[spec.args.indexOf('--tag') + 1]!);
        return { stdout: '', stderr: '' };
      }
    }
    throw new Error(`unexpected command: ${spec.command} ${spec.args.join(' ')}`);
  };
}

function unused(): never {
  throw new Error('staging never changes the service');
}

/** NanoClaw's service helpers: the assistant's service runs while `state.running` says so. */
function services(state: World): NanoclawServiceHelpers {
  return {
    createCommandRunner: () => ({ run: unused, tryRun: unused }),
    detectService: (_root, env) => {
      state.serviceCalls.push(`detect ${env.installSlug}`);
      return { mode: 'launchd', active: state.running, name: `com.nanoclaw-v2-${env.installSlug}` };
    },
    stopService: async () => unused(),
    startService: unused,
    drainContainers: async () => unused(),
    verifyServiceHealth: async () => unused(),
  };
}

function dependencies(state: World, release: Release): UpdateDependencies {
  return {
    serviceHelpers: services(state),
    providerSetup: PROVIDER_SETUP,
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
    service: { platform: 'darwin', uid: 501, ambientEnv: {} },
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
  const deps = dependencies(state, release);
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
const GIT_HEAVY = { timeout: 30_000 } as const;

describe('staging an update while the assistant serves', GIT_HEAVY, () => {
  it("stages the tool's release beside the running assistant and previews what the update changes", async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime, applying(ADDED_MIGRATION));
    const before = await liveState(host, runtime);

    const staged = await stage(host, runtime, dependencies(state, next));

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
    expect(state.images).toEqual(
      new Set([`${imageBase(runtime)}:latest`, `${imageBase(runtime)}:next`, DEPLOYED_GATEWAY, RELEASE_GATEWAY]),
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

    const staged = await stage(host, runtime, dependencies(state, next));

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
    const images = new Set(state.images);

    await expect(stage(host, runtime, dependencies(state, next))).rejects.toMatchObject({ code: 'command_failed' });

    expect(await exists(host.paths.releaseRoot(runtime.instance_id, 'next'))).toBe(false);
    expect(state.images).toEqual(images);
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

    const refusal = stage(host, runtime, dependencies(state, next));

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

    await expect(stage(host, runtime, dependencies(state, next))).rejects.toMatchObject({
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

    const refusal = stage(host, runtime, dependencies(state, next));

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

    await expect(stage(host, runtime, dependencies(state, next))).rejects.toMatchObject({
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
      for (const image of killed.images) state.images.add(image);
      const staged = await stage(host, runtime, dependencies(state, next));

      // The :next image a killed build left is removed with next/, before anything is fetched again.
      const nextImage = `${imageBase(runtime)}:next`;
      const docker = (args: string) =>
        state.commands.findIndex((command) => command.command === 'docker' && command.args.join(' ') === args);
      const fetch = state.commands.findIndex((command) => command.command === 'git' && command.args[0] === 'fetch');
      expect(killed.images.has(nextImage)).toBe(step === 'build');
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

    await expect(stage(host, runtime, dependencies(world(runtime), next))).rejects.toMatchObject({
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

function cli(host: Machine, state: World, next: Release, runtime: Partial<CliRuntime> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const { serviceHelpers, providerSetup, reporter: _reporter, ...seams } = dependencies(state, next);
  const run = (args: readonly string[]) =>
    runCli(args, {
      paths: host.paths,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      serviceHelpers,
      toolProviderSetup: async () => providerSetup,
      update: seams,
      ...runtime,
    });
  return { run, out, err };
}

describe('gws-ea update', GIT_HEAVY, () => {
  it('with --yes, records the staged update at staged, leaving the live release, its receipt, and its service as they were', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime, applying(ADDED_MIGRATION));
    const before = await liveState(host, runtime);
    const { run, out } = cli(host, state, next);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);

    expect(await readOperationRecord(host.paths, runtime.instance_id)).toMatchObject({
      kind: 'update',
      phase: 'staged',
      from: release(host, host.first),
      to: release(host, next.commit),
      manifest: { central_migrations: [...LIVE_MIGRATIONS], session_tables: {} },
      images: [],
      follow_ups: [{ kind: 'rebuild_group_image', agent_group_id: 'ag-research' }],
    });
    expect(await liveState(host, runtime)).toEqual(before);
    expect(state.running).toBe(true);
    const printed = out.join('\n');
    expect(printed).toContain(ADDED_MIGRATION);
    expect(printed).toContain(`update to dogfood ${next.commit.slice(0, 12)} is staged.`);

    // Run again, the update continues from its record: nothing is staged or checked twice.
    const commands = state.commands.length;
    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(0);
    expect(state.preflights).toHaveLength(1);
    expect(state.commands.slice(commands).every((command) => command.command === 'git')).toBe(true);
    expect(out.at(-1)).toBe(
      `Assistant ${runtime.instance_id}'s update to dogfood ${next.commit.slice(0, 12)} is staged.`,
    );
  });

  it('asks on a terminal with the preview, and a decline leaves no record and removes the staging', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    const asked: unknown[] = [];
    const { run, out } = cli(host, state, next, {
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
    expect(state.images.has(`${imageBase(runtime)}:next`)).toBe(false);
  });

  it('fails with input_required without a terminal or --yes, before anything is read or run', async () => {
    const host = await machine();
    const runtime = await assistant(host);
    const next = await nextRelease(host);
    const state = world(runtime);
    const { run, err } = cli(host, state, next);

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
    const { run, err } = cli(host, state, next);

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
    const { run, err } = cli(host, state, next);

    expect(await run(['update', '--id', runtime.instance_id, '--yes'])).toBe(1);

    const summary = err.join('\n');
    expect(summary).toContain('is unfinished (stopped)');
    expect(summary).toContain(`gws-ea rollback --id ${runtime.instance_id}`);
    expect(state.preflights).toEqual([]);
    expect(await exists(host.paths.releaseRoot(runtime.instance_id, 'next'))).toBe(false);
  });
});
