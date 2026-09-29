/**
 * The world update and rollback tests share: a machine with a release
 * repository, assistants built as create leaves them (a registry reservation
 * and completed journal, a Git checkout detached at its release with its
 * marker, runtime, and `.env`, the release receipt, the OneCLI Compose file,
 * main stamped from the release's template, and a central database the host
 * left closed), and every boundary a cutover crosses faked: the service
 * manager, Docker, `ps`, `lsof`, the release's install, build, migration, and
 * tripwire scripts, the host's status and listener, OneCLI, and `ncl`, whose
 * restamp of main's template writes main's files as NanoClaw's does. Git,
 * SQLite, and the files are real. Each test file removes the machines it made
 * with `removeTemporaryRoots`.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { expect } from 'vitest';

import { materializeReleaseCheckout } from '../checkout.js';
import { runCli, type CliRuntime } from '../cli.js';
import { acquireInstanceOperation, recordStepCompleted, reserveInstance } from '../journal.js';
import { createOnecliRuntimeLayout, renderOnecliCompose } from '../onecli-compose.js';
import { resolveWrapperGatewayImage, wrapperImageTag } from '../onecli-gateway-image.js';
import { CONTROL_PLANE_ROOT, instanceRuntimeFile, resolveControlPlanePaths, type ControlPlanePaths } from '../paths.js';
import type { Observation } from '../phases.js';
import { LAUNCHER_PINS, ONECLI_SDK_VERSION } from '../pins.js';
import { runSanitizedCommand, type SanitizedCommand, type SanitizedCommandRunner } from '../process.js';
import { allocateInstanceId, getInstanceReservation } from '../registry.js';
import type { ReleasePreflightInput } from '../release-preflight.js';
import type { ToolProviderSetup } from '../release-target.js';
import {
  createInstanceRuntimeConfig,
  persistInstanceRuntime,
  type HostStatusHelpers,
  type InstanceRuntimeConfig,
  type UpsertEnvVars,
} from '../service.js';
import type { NanoclawServiceHelpers } from '../service-control.js';
import { observeAssistantStatus } from '../status.js';
import { GwsEaError, PROVISION_STEPS, releaseOf, type ReleaseCoordinates } from '../types.js';
import {
  confirmStagedUpdate,
  continueUpdate,
  prepareUpdate,
  resolveUpdateIntent,
  type UpdateDependencies,
} from '../update.js';
import { readCentralMigrations } from '../verify.js';
import { getInstallScopedNames } from '../../install-slug.js';

const roots: string[] = [];

/** A new temporary directory, by its real path, removed by `removeTemporaryRoots`. */
export async function temporaryRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

/** Remove every temporary directory made since the last call; each test file runs it after each test. */
export async function removeTemporaryRoots(): Promise<void> {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
}

/** Upstream's `.env` writer, which the driver injects; loaded by path because `src/` cannot import `setup/`. */
export const { upsertEnvVars } = (await import(path.join(CONTROL_PLANE_ROOT, 'setup', 'set-env.ts'))) as {
  readonly upsertEnvVars: UpsertEnvVars;
};

export const TRACK_BRANCH = 'rebuild-v2';
export const DOCKER = 'unix:///var/run/docker.sock';
export const ONECLI_CLI = '/usr/local/bin/onecli';
export const CREDENTIAL = {
  name: 'Anthropic',
  type: 'anthropic',
  hostPattern: 'api.anthropic.com',
  headerName: 'x-api-key',
};
export const COHORT = { gateway: LAUNCHER_PINS.onecliGateway, cli: LAUNCHER_PINS.onecliCli, sdk: ONECLI_SDK_VERSION };
/** The gateway the assistant's Compose file names: one an earlier release built. */
export const DEPLOYED_GATEWAY = wrapperImageTag('0'.repeat(16));
export const RELEASE_GATEWAY = (await resolveWrapperGatewayImage(COHORT)).image;
export const LIVE_MIGRATIONS = ['initial-v2-schema', 'host-coordination'] as const;
export const ADDED_MIGRATION = 'module:gws-ea-profile:add-notes';
export const FAILING_MIGRATION = 'module:gws-ea-profile:add-reminders';
export const IMAGE_BYTES = 1_500_000_000;
export const LOCKFILE = 'container/agent-runner/bun.lock';
export const SESSION_SCHEMA_SOURCES = [
  'src/mailbox/sqlite/schema.ts',
  'src/mailbox/sqlite/session-db.ts',
  'container/agent-runner/src/mailbox/sqlite/connection.ts',
] as const;
export const PROVIDER_SETUP: ToolProviderSetup = {
  capabilityDigest: 'd'.repeat(64),
  credentialMetadata: (provider) => (provider === 'claude' ? CREDENTIAL : undefined),
};
export const SESSION = path.join('data', 'v2-sessions', 'ag-main', 'session-1');
export const MEMORY = path.join('groups', 'main', 'CLAUDE.local.md');
/** Main's template in a release, main's folder, the plugin stamped into it, and the files that plugin stamps. */
export const MAIN_TEMPLATE_DIR = path.join('templates', 'gws-ea', 'main');
export const MAIN_FOLDER = path.join('groups', 'main');
export const MAIN_BASELINE = path.join(MAIN_FOLDER, 'plugins', 'gws-ea-main');
export const PERSONA = path.join(MAIN_FOLDER, 'instructions.prepend.md');
export const PROCEDURE = path.join(MAIN_FOLDER, 'additional_context', 'operating-procedure.md');
const MAIN_CONTEXT = path.join(MAIN_TEMPLATE_DIR, 'ai.nanoco.nanoclaw', 'context');

/** Main's template as a release ships it at `version`: its manifest, persona, and operating procedure. */
export function mainTemplate(version: string): Record<string, string> {
  return {
    [path.join(MAIN_TEMPLATE_DIR, 'plugin.json')]: `${JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'gws-ea-main',
      version: '1.0.0',
    })}\n`,
    // Trailing blank lines: NanoClaw stamps the persona trimmed.
    [path.join(MAIN_CONTEXT, 'instructions.md')]: `# Main executive assistant\n\nInstructions ${version}.\n\n`,
    [path.join(MAIN_CONTEXT, 'additional_context', 'operating-procedure.md')]: `Operating procedure ${version}.\n`,
  };
}

/** Main's persona as NanoClaw stamps it from `mainTemplate(version)`. */
export function stampedPersona(version: string): string {
  return `# Main executive assistant\n\nInstructions ${version}.\n`;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function commitAll(repository: string, message: string): string {
  git(repository, 'add', '.');
  git(repository, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', message);
  return git(repository, 'rev-parse', 'HEAD');
}

export async function write(root: string, relativePath: string, contents: string): Promise<void> {
  const file = path.join(root, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

export async function exists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
}

export interface Machine {
  readonly root: string;
  readonly paths: ControlPlanePaths;
  /** The release repository, as a hosted one serves it. */
  readonly remote: string;
  /** A working clone that commits each release and pushes it to the track. */
  readonly work: string;
  /** The release every assistant here was created at. */
  readonly first: string;
}

export async function machine(): Promise<Machine> {
  const root = await temporaryRoot('gws-ea-update-');
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
  for (const [file, contents] of Object.entries(mainTemplate('1'))) await write(work, file, contents);
  // Never run: the tests' runner stands in for the release's own image build.
  await write(work, 'container/build.sh', '#!/bin/bash\nexit 99\n');
  const first = commitAll(work, 'first release');
  const remote = path.join(root, 'remote.git');
  git(root, 'clone', '--quiet', '--bare', work, remote);
  git(remote, 'config', 'uploadpack.allowFilter', 'true');
  git(work, 'remote', 'add', 'origin', remote);
  return { root, paths, remote, work, first };
}

export interface Release {
  readonly commit: string;
  /** A clone at the release: the gws-ea the operator updates with. */
  readonly tool: string;
}

let releases = 0;

/** Where a release is pushed: a repository, and the branch there that carries it. */
export interface ReleaseDestination {
  readonly remote: string;
  readonly branch: string;
}

/** Push the next release, changing `files`, to the track's branch of the release repository or to `to`. */
export async function nextRelease(
  host: Machine,
  files: Readonly<Record<string, string>> = {},
  to: ReleaseDestination = { remote: host.remote, branch: TRACK_BRANCH },
): Promise<Release> {
  releases += 1;
  await write(host.work, 'release.txt', `release ${releases}\n`);
  for (const [file, contents] of Object.entries(files)) await write(host.work, file, contents);
  const commit = commitAll(host.work, `release ${releases}`);
  git(host.work, 'push', '--quiet', to.remote, `HEAD:refs/heads/${to.branch}`);
  const tool = path.join(host.root, `tool-${commit.slice(0, 8)}`);
  git(host.root, 'clone', '--quiet', to.remote, tool);
  git(tool, 'checkout', '--quiet', '--detach', commit);
  return { commit, tool };
}

export function imageBase(runtime: Pick<InstanceRuntimeConfig, 'install_id'>): string {
  return getInstallScopedNames(runtime.install_id).containerImageBase;
}

/**
 * The central database a host left closed (WAL, no side files): the live
 * migrations, the profile naming main, no sessions yet, and three agent
 * groups, one of them running a per-group image NanoClaw built on the base,
 * and one an image of its own.
 */
export function centralDatabase(runtime: InstanceRuntimeConfig): void {
  const database = new Database(path.join(runtime.checkout_realpath, 'data', 'v2.db'));
  try {
    database.pragma('journal_mode = WAL');
    database.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied TEXT NOT NULL);
      CREATE TABLE agent_groups (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE, agent_provider TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE container_configs (
        agent_group_id TEXT PRIMARY KEY, image_tag TEXT, mcp_servers TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE gws_ea_profile (singleton INTEGER PRIMARY KEY, main_agent_group_id TEXT);
      INSERT INTO gws_ea_profile VALUES (1, 'ag-main');
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, agent_group_id TEXT, messaging_group_id TEXT, thread_id TEXT, status TEXT, created_at TEXT
      );
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
        .run(id, name, id === 'ag-main' ? 'main' : id, '2026-09-01T00:00:00.000Z');
      database.prepare('INSERT INTO container_configs (agent_group_id, image_tag) VALUES (?, ?)').run(id, image);
    }
  } finally {
    database.close();
  }
}

/** An assistant create finished at the machine's first release, its Compose file naming `gateway`. */
export async function assistant(
  host: Machine,
  port = 37_001,
  gateway: string = DEPLOYED_GATEWAY,
): Promise<InstanceRuntimeConfig> {
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
  await writeFile(onecli.composeFile, renderOnecliCompose(onecli, COHORT, gateway), { mode: 0o600 });
  centralDatabase(runtime);
  await stampMain(runtime.checkout_realpath);
  return runtime;
}

/** Every file under `root`, by path relative to it; none when it is absent. */
async function filesUnder(root: string, prefix = ''): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const found: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) found.push(...(await filesUnder(root, relative)));
    else found.push(relative);
  }
  return found;
}

/** What a plugin stamps into main's folder beside itself, as NanoClaw writes it: its persona, trimmed, and each context file. */
async function stampedContext(plugin: string): Promise<Map<string, string>> {
  const context = path.join(plugin, 'ai.nanoco.nanoclaw', 'context');
  const stamped = new Map<string, string>();
  for (const file of await filesUnder(context)) {
    if (!file.endsWith('.md')) continue;
    const text = await readFile(path.join(context, file), 'utf8');
    if (file === 'instructions.md') stamped.set('instructions.prepend.md', `${text.trimEnd()}\n`);
    else stamped.set(file, text);
  }
  return stamped;
}

/** Stamp main from the checkout's own template, as create's `ncl groups create --template` does. */
export async function stampMain(checkout: string): Promise<void> {
  const template = path.join(checkout, MAIN_TEMPLATE_DIR);
  await cp(template, path.join(checkout, MAIN_BASELINE), { recursive: true });
  for (const [file, contents] of await stampedContext(template)) {
    await write(path.join(checkout, MAIN_FOLDER), file, contents);
  }
}

/**
 * NanoClaw's restamp of main from the live release's template
 * (`src/templates/restamp.ts`), as `ncl groups create --template --id`
 * answers: its plan, or with `--yes` the restamp itself, the plugin replaced
 * whole and then each file. Only the files are modelled: `state.restampPlan`
 * adds what the plan says of main's skills, MCP servers, and tasks.
 */
async function restampMain(state: World, config: InstanceRuntimeConfig, args: readonly string[]): Promise<unknown> {
  state.restamps.push({ instanceId: config.instance_id, args });
  state.onRestamp?.(config.checkout_realpath, args);
  if (state.restampFails) {
    throw new GwsEaError('ncl_failed', `ncl ${args.join(' ')} failed: Cannot read the previously stamped plugin`);
  }
  const apply = args.includes('--yes');
  const checkout = config.checkout_realpath;
  const template = path.join(checkout, MAIN_TEMPLATE_DIR);
  const baseline = path.join(checkout, MAIN_BASELINE);
  const [wanted, stamped] = await Promise.all([stampedContext(template), stampedContext(baseline)]);
  const changes: Array<Record<string, unknown>> = [];
  const writes: Array<() => Promise<void>> = [];
  for (const file of [...new Set([...wanted.keys(), ...stamped.keys()])].sort()) {
    const target = path.join(checkout, MAIN_FOLDER, file);
    const live = await readFile(target, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    const want = wanted.get(file);
    const surface = file === 'instructions.prepend.md' ? 'persona' : 'context';
    if (want === live) {
      if (want !== undefined) changes.push({ surface, name: file, action: 'unchanged' });
      continue;
    }
    changes.push({
      surface,
      name: file,
      action: want === undefined ? 'remove' : live === undefined ? 'create' : 'update',
      ...(live !== undefined && live !== stamped.get(file) ? { customized: true } : {}),
    });
    writes.push(async () => {
      await rm(target, { force: true });
      if (want !== undefined) await write(path.join(checkout, MAIN_FOLDER), file, want);
    });
  }
  changes.push(...(state.restampPlan ?? []));
  if (apply) {
    await rm(baseline, { recursive: true, force: true });
    await cp(template, baseline, { recursive: true });
    await hang(state, 'restamp-partway');
    for (const change of writes) await change();
    await hang(state, 'restamp');
  }
  return {
    group: { id: args[args.indexOf('--id') + 1], name: 'main', folder: 'main' },
    plugin: 'gws-ea-main',
    applied: apply,
    changes,
    report: [],
    note: apply ? 'Restamp applied.' : 'DRY RUN — nothing was changed. Re-run with --yes to apply.',
  };
}

/** Make another of the checkout's agent groups main, as the profile names it. */
export function makeMain(checkout: string, agentGroupId: string): void {
  const database = new Database(path.join(checkout, 'data', 'v2.db'));
  try {
    database.prepare('UPDATE gws_ea_profile SET main_agent_group_id = ? WHERE singleton = 1').run(agentGroupId);
  } finally {
    database.close();
  }
}

/** What the assistant's conversations and memory hold: a session message row and a memory file. */
export async function converse(runtime: InstanceRuntimeConfig, ...messages: readonly string[]): Promise<void> {
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

export function messages(checkout: string): string[] {
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
export type Migrate = (database: string) => void;

export function applying(...names: readonly string[]): Migrate {
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

/**
 * Where an update is killed: the boundary call it never returns from. At
 * `restamp` the host finished restamping main's template; at
 * `restamp-partway` it had replaced only the plugin. At `untag` a rollback's
 * cleanup is removing the `:previous` tag it leaves.
 */
export type HangPoint =
  | 'build'
  | 'migrate'
  | 'stop'
  | 'stamp'
  | 'retag'
  | 'second-tag'
  | 'verify'
  | 'rebuild'
  | 'restamp'
  | 'restamp-partway'
  | 'untag';

/** What every faked boundary holds, and what reached it. */
export interface World {
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
  /** `ncl groups create --template` calls: main's restamp, planned or applied, and whose host it asked. */
  readonly restamps: Array<{ readonly instanceId: string; readonly args: readonly string[] }>;
  /** What NanoClaw's restamp plan says beyond main's files: its skills, MCP servers, and tasks. */
  restampPlan?: Array<Record<string, unknown>>;
  restampFails?: boolean;
  /** Runs as main's restamp is asked for, before NanoClaw answers: whatever the agent does meanwhile. */
  onRestamp?: (checkout: string, args: readonly string[]) => void;
  readonly fetched: string[];
  /** The service's stops and starts, and Docker's tag moves, in order. */
  readonly events: string[];
  /** How long each health check was allowed. */
  readonly healthWaits: Array<number | undefined>;
  migrate: Migrate;
  buildFails?: boolean;
  /** Every layer of the agent image is cached, so the build of `:next` gives the image `:latest` names. */
  cachedBuild?: boolean;
  /** Every layer of a per-group image is cached, so its rebuild gives the image its tag already names. */
  cachedRebuild?: boolean;
  /** What `ps` lists, and what `lsof` finds open under a checkout's data/. */
  processes: string;
  openFiles: string;
  /** The containers `docker ps --all` lists, by the install label it filters on. */
  readonly containers: Map<string, readonly string[]>;
  /** The listener ID the running host answers with. */
  listener: string;
  /** The listener ID the local listener answers with instead, as another host's would. */
  listenerAnswer?: string;
  /** The webhook port the host reports instead of its own. */
  webhookPort?: number;
  /** The callback route answers 502, as a tunnel with nothing behind it does. */
  routeDown?: boolean;
  /** What observing OneCLI finds instead of it present, when its gateway did not change. */
  onecliObservation?: Observation;
  /** OneCLI's health or isolation check fails, when its gateway changed. */
  onecliVerifyFails?: boolean;
  /** Runs when the host starts, from the live checkout, as the host would. */
  onStart?: (checkout: string) => void;
  /** The service manager refuses to start the host. */
  startFails?: boolean;
  /** Runs once the release's tripwire is stamped: the last of the carry. */
  onStamp?: () => void;
  rebuildFails?: boolean;
  /** The step an update never returns from, as if killed there; `reached` resolves once it is under way. */
  hangAt?: HangPoint;
  /** Kill the swap at its rename number `renameKill`. */
  renameKill?: number;
  /** Every rename of a swap fails, as a filesystem gone read-only fails it. */
  renameFails?: boolean;
  reached?: () => void;
}

let images = 0;

export function imageId(): string {
  images += 1;
  return `sha256:${createHash('sha256').update(`image ${images}`).digest('hex')}`;
}

export function world(runtime: InstanceRuntimeConfig, migrate: Migrate = applying()): World {
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
    restamps: [],
    fetched: [],
    events: [],
    healthWaits: [],
    migrate,
    processes: '',
    openFiles: '',
    containers: new Map(),
    listener: '11111111-1111-4111-8111-111111111111',
  };
}

/** The label Docker finds an install's agent containers by. */
export function installLabel(runtime: Pick<InstanceRuntimeConfig, 'install_id'>): string {
  return getInstallScopedNames(runtime.install_id).containerInstallLabel;
}

export const never = (): Promise<never> => new Promise(() => undefined);

export async function hang(state: World, point: HangPoint): Promise<void> {
  if (state.hangAt !== point) return;
  state.reached?.();
  await never();
}

/** Tag an image as Docker does: the tag's former image stays, untagged unless another tag names it. */
export function tag(state: World, reference: string, name: string): void {
  const id = state.tags.get(reference) ?? (state.ids.has(reference) ? reference : undefined);
  if (!id) throw new GwsEaError('command_failed', `No such image: ${reference}`, { details: { exitCode: 1 } });
  state.tags.set(name, id);
}

function dockerFailure(stderrTail: string): GwsEaError {
  return new GwsEaError('command_failed', 'docker exited with code 1', { details: { exitCode: 1, stderrTail } });
}

/**
 * Remove an image as `docker image rm` does without `--force`. A tag is
 * untagged, and its image deleted once no tag names it. An ID deletes its
 * image, untagging the one tag that names it; one several tags name is
 * refused.
 */
function removeImage(state: World, reference: string): void {
  const named = state.tags.get(reference);
  if (named) {
    state.tags.delete(reference);
    if (![...state.tags.values()].includes(named)) state.ids.delete(named);
    return;
  }
  if (!state.ids.has(reference)) throw dockerFailure(`Error response from daemon: No such image: ${reference}`);
  const names = [...state.tags].filter(([, id]) => id === reference).map(([name]) => name);
  if (names.length > 1) {
    throw dockerFailure(
      `Error response from daemon: conflict: unable to delete ${reference.slice(7, 19)} (must be forced) - image is referenced in multiple repositories`,
    );
  }
  for (const name of names) state.tags.delete(name);
  state.ids.delete(reference);
}

/** Tagged and untagged image IDs of one repository. */
export function repositoryImages(state: World, repository: string): { tagged: Set<string>; untagged: string[] } {
  const tagged = new Set([...state.tags].filter(([name]) => name.startsWith(`${repository}:`)).map(([, id]) => id));
  const named = new Set(state.tags.values());
  return { tagged, untagged: [...state.ids].filter((id) => !named.has(id)) };
}

/** Git for real; Docker, `ps`, `lsof`, and the release's own scripts as `state` says. */
export function runner(state: World): SanitizedCommandRunner {
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
      const base = getInstallScopedNames(spec.env?.NANOCLAW_INSTALL_ID ?? '').containerImageBase;
      const cached = state.cachedBuild ? state.tags.get(`${base}:latest`) : undefined;
      const id = cached ?? imageId();
      state.ids.add(id);
      state.tags.set(`${base}:next`, id);
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
      if (first === 'ps') {
        const label = spec.args[spec.args.indexOf('--filter') + 1]?.replace(/^label=/u, '') ?? '';
        return { stdout: (state.containers.get(label) ?? []).map((id) => `${id}\n`).join(''), stderr: '' };
      }
      if (first === 'image' && second === 'inspect' && joined.includes('{{.Size}}')) {
        return { stdout: `${IMAGE_BYTES}\n`, stderr: '' };
      }
      if (first === 'image' && second === 'inspect') {
        if (!state.ids.has(last)) throw dockerFailure(`Error: No such image: ${last}`);
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
        if (last.endsWith(':previous')) await hang(state, 'untag');
        removeImage(state, last);
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
export function services(state: World): NanoclawServiceHelpers {
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
      if (state.startFails) throw new Error('Bootstrap failed: 5: Input/output error');
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
export function hostStatus(state: World, runtime: InstanceRuntimeConfig): HostStatusHelpers {
  const status = (root: string) => ({
    pid: 4242,
    instance_id: `host-${state.serviceCalls.length}`,
    project_root: root,
    webhook: {
      id: state.listener,
      port: state.webhookPort ?? runtime.allocated_ports.nanoclaw_webhook,
      paths: ['/webhook/gchat'],
    },
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

export function dependencies(state: World, release: Release, runtime: InstanceRuntimeConfig): UpdateDependencies {
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
      const local = new URL(url).hostname === '127.0.0.1';
      if (!local && state.routeDown) return new Response(null, { status: 502 });
      const listener = local ? (state.listenerAnswer ?? state.listener) : state.listener;
      return new Response(null, { status: 401, headers: { 'x-nanoclaw-webhook-id': listener } });
    },
    onecli: {
      // As the real ones do, each writes the Compose file of the gateway it recreates.
      apply: async (layout, pins) => {
        state.onecli.push(`apply ${layout.project}`);
        const { image } = await resolveWrapperGatewayImage(pins);
        await writeFile(layout.composeFile, renderOnecliCompose(layout, pins, image), { mode: 0o600 });
      },
      restore: async (layout, _pins, compose) => {
        state.onecli.push(`restore ${layout.project}`);
        await writeFile(layout.composeFile, compose, { mode: 0o600 });
      },
      verify: async (layout) => {
        state.onecli.push(`verify ${layout.project}`);
        if (state.onecliVerifyFails) {
          throw new GwsEaError('onecli_isolation_failed', 'An agent reached the network around the gateway.');
        }
      },
      observe: async (layout) => {
        state.onecli.push(`observe ${layout.project}`);
        return state.onecliObservation ?? { status: 'present' };
      },
    },
    ncl: async (config, args, options) => {
      if (args[0] === 'groups' && args[1] === 'create') return restampMain(state, config, args);
      state.rebuilds.push({ args, timeoutMs: options?.timeoutMs });
      await hang(state, 'rebuild');
      if (state.rebuildFails) {
        throw new GwsEaError('ncl_failed', `ncl ${args.join(' ')} failed: apt-get could not find package made-up`);
      }
      // NanoClaw's buildAgentGroupImage moves the group's tag to an image built on the new base.
      const group = `${imageBase(config)}:${args[args.indexOf('--id') + 1]}`;
      const id = (state.cachedRebuild ? state.tags.get(group) : undefined) ?? imageId();
      state.ids.add(id);
      state.tags.set(group, id);
      return { restarted: 0, rebuilt: true };
    },
    rename: (() => {
      let calls = 0;
      return async (from: string, to: string) => {
        calls += 1;
        if (state.renameKill !== undefined && calls >= state.renameKill) {
          state.reached?.();
          await never();
        }
        if (state.renameFails) {
          throw Object.assign(new Error(`EROFS: read-only file system, rename '${from}' -> '${to}'`), {
            code: 'EROFS',
          });
        }
        const { rename } = await import('node:fs/promises');
        await rename(from, to);
      };
    })(),
  };
}

/**
 * Confirm an update and run its cutover until `state.hangAt` (or the swap's
 * rename `state.renameKill`), then abandon it there, as if the process were
 * killed: nothing after that point runs, and the instance lock goes with it.
 */
export async function killDuringCutover(host: Machine, runtime: InstanceRuntimeConfig, state: World, release: Release) {
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
export async function snapshot(root: string, except: readonly string[] = []): Promise<Map<string, string>> {
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

export function release(host: Machine, commit: string): ReleaseCoordinates {
  return { source_remote: host.remote, release_track: 'dogfood', deployed_commit: commit };
}

/** What the assistant's live release is: its registry entry, checkout, receipt, and service. */
export async function liveState(host: Machine, runtime: InstanceRuntimeConfig) {
  return {
    registered: releaseOf(await getInstanceReservation(host.paths, runtime.instance_id)),
    head: git(runtime.checkout_realpath, 'rev-parse', 'HEAD'),
    status: git(runtime.checkout_realpath, 'status', '--porcelain'),
    receipt: await readFile(host.paths.releasePreflightFile(runtime.instance_id), 'utf8'),
    migrations: readCentralMigrations(runtime.checkout_realpath),
  };
}

export function cli(
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
export function status(host: Machine, state: World, next: Release, runtime: InstanceRuntimeConfig) {
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

export function receiptCommit(file: string): Promise<string> {
  return readFile(file, 'utf8').then((text) => (JSON.parse(text) as { deployed_commit: string }).deployed_commit);
}

export function runtimeCommit(checkout: string): Promise<string> {
  return receiptCommit(instanceRuntimeFile(checkout));
}
