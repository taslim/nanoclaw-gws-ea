/**
 * The world update and rollback tests share: a machine with a release
 * repository, and assistants built as create leaves them on the release
 * layout (a registry reservation and completed journal; `state/` with its
 * marker, runtime record, `.env`, and a central database the host left
 * closed; the release staged as every release is, its OneCLI Compose file and
 * service definition installed from what was kept with it, and the live link
 * pointed at it). Every boundary a switch crosses is faked: the service
 * manager (launchd: a job loaded or not, its host running only while the
 * program its definition names exists), Docker and the OneCLI project, `ps`,
 * `lsof`, the release's install, build, migration, and tripwire scripts, the
 * host's status and listener, and `ncl`. Git, tar, SQLite, and the files are
 * real. Each test file removes the machines it made with
 * `removeTemporaryRoots`.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { expect } from 'vitest';

import { AGENT_IMAGE_KEY_LABEL } from '../agent-image.js';
import { releaseImageKey, releaseImageTag } from '../agent-image-release.js';
import { runCli, type CliRuntime } from '../cli.js';
import { acquireInstanceOperation, recordStepCompleted, reserveInstance } from '../journal.js';
import { readKeptRelease } from '../kept-release.js';
import { createOnecliRuntimeLayout, renderOnecliCompose, type OnecliRuntimeLayout } from '../onecli-compose.js';
import { resolveWrapperGatewayImage, wrapperImageTag } from '../onecli-gateway-image.js';
import { CONTROL_PLANE_ROOT, resolveControlPlanePaths, type ControlPlanePaths } from '../paths.js';
import type { Observation } from '../phases.js';
import { LAUNCHER_PINS, ONECLI_SDK_VERSION } from '../pins.js';
import { runSanitizedCommand, type SanitizedCommand, type SanitizedCommandRunner } from '../process.js';
import { getInstanceReservation, writeInstanceMarker } from '../registry.js';
import { createState, pointCurrent, releaseName } from '../release-layout.js';
import type { SetupCommand } from '../release-preflight.js';
import { applyReleaseEnvironment, stageRelease } from '../release-stage.js';
import type { ToolProviderSetup } from '../release-target.js';
import {
  createInstanceRuntimeConfig,
  instanceServiceDefinitionFile,
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
export const CREDENTIAL = {
  name: 'Anthropic',
  type: 'anthropic',
  hostPattern: 'api.anthropic.com',
  headerName: 'x-api-key',
};
const PINS = { gateway: LAUNCHER_PINS.onecliGateway };
/** A release whose agent image differs from the first one's: its build context changed. */
export const NEW_IMAGE = { 'container/Dockerfile': 'FROM scratch\nRUN true\n' } as const;
/** A gateway an earlier release built, which an assistant may still run. */
export const DEPLOYED_GATEWAY = wrapperImageTag('0'.repeat(16));
/** The gateway every release this machine stages names. */
export const RELEASE_GATEWAY = (await resolveWrapperGatewayImage(PINS)).image;
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
/** The file a release ships main's shared skill list in, as the fake `ncl` reads it from the live release. */
export const MAIN_SKILLS = 'main-skills.json';
export const PROVIDER_SETUP: ToolProviderSetup = {
  credentialMetadata: (provider) => (provider === 'claude' ? CREDENTIAL : undefined),
};
export const SESSION = path.join('data', 'v2-sessions', 'ag-main', 'session-1');
export const MEMORY = path.join('groups', 'main', 'CLAUDE.local.md');
/** Main's template in a release, and main's folder. */
const MAIN_TEMPLATE_DIR = path.join('templates', 'gws-ea', 'main');
export const MAIN_FOLDER = path.join('groups', 'main');

/** Main's template as a release ships it at `version`. */
export function mainTemplate(version: string): Record<string, string> {
  return {
    [path.join(MAIN_TEMPLATE_DIR, 'plugin.json')]: `${JSON.stringify({ name: 'gws-ea-main', version: '1.0.0' })}\n`,
    [path.join(MAIN_TEMPLATE_DIR, 'instructions.md')]: `# Main executive assistant\n\nInstructions ${version}.\n`,
  };
}

/**
 * What a release needs for staging to find it whole: its package manifest
 * and gws-ea's pins (the receipt's cohort), the `ncl` launcher, the agent
 * image's build context and the script it sources, the session-schema
 * sources and agent-runner lockfile an update compares, main's template and
 * shared skill list, and an ignore file that leaves its build output and its
 * links to the assistant's state untracked, as NanoClaw's own does.
 */
function releaseFiles(): Readonly<Record<string, string>> {
  return {
    '.gitignore': 'node_modules\ndist\n.env\ndata\ngroups\nstore\nlogs\n',
    'package.json': `${JSON.stringify({
      name: 'nanoclaw',
      version: '2.3.0',
      packageManager: 'pnpm@10.0.0',
      dependencies: { '@onecli-sh/sdk': ONECLI_SDK_VERSION },
    })}\n`,
    'src/gws-ea/versions.json': readFileSync(path.join(CONTROL_PLANE_ROOT, 'src', 'gws-ea', 'versions.json'), 'utf8'),
    'container/Dockerfile': 'FROM scratch\n',
    // Never run: the tests' runner stands in for NanoClaw's image build.
    'container/build.sh': '#!/bin/bash\nexit 99\n',
    [LOCKFILE]: 'lock 1\n',
    'setup/lib/install-slug.sh': '# names the image repository\n',
    [MAIN_SKILLS]: `${JSON.stringify(['agent-browser'])}\n`,
    ...Object.fromEntries(SESSION_SCHEMA_SOURCES.map((source) => [source, `// ${source} 1\n`])),
    ...mainTemplate('1'),
  };
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
  for (const [file, contents] of Object.entries(releaseFiles())) await write(work, file, contents);
  await write(work, 'release.txt', 'first\n');
  execFileSync('chmod', ['0755', path.join(work, 'container', 'build.sh')]);
  await write(work, 'bin/ncl', '#!/bin/sh\n');
  execFileSync('chmod', ['0755', path.join(work, 'bin', 'ncl')]);
  const first = commitAll(work, 'first release');
  const remote = path.join(root, 'remote.git');
  git(root, 'clone', '--quiet', '--bare', work, remote);
  git(remote, 'config', 'uploadpack.allowFilter', 'true');
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', '--quiet', 'origin', `HEAD:refs/heads/${TRACK_BRANCH}`);
  return { root, paths, remote, work, first };
}

export interface Release {
  readonly commit: string;
  /** A clone at the release: the gws-ea the operator updates with. */
  readonly tool: string;
}

let releases = 0;

/** Push the next release, changing `files`, to the track's branch of the release repository. */
export async function nextRelease(host: Machine, files: Readonly<Record<string, string>> = {}): Promise<Release> {
  releases += 1;
  await write(host.work, 'release.txt', `release ${releases}\n`);
  for (const [file, contents] of Object.entries(files)) await write(host.work, file, contents);
  const commit = commitAll(host.work, `release ${releases}`);
  git(host.work, 'push', '--quiet', host.remote, `HEAD:refs/heads/${TRACK_BRANCH}`);
  const tool = path.join(host.root, `tool-${commit.slice(0, 8)}`);
  git(host.root, 'clone', '--quiet', host.remote, tool);
  git(tool, 'checkout', '--quiet', '--detach', commit);
  return { commit, tool };
}

export function imageBase(runtime: Pick<InstanceRuntimeConfig, 'install_id'>): string {
  return getInstallScopedNames(runtime.install_id).containerImageBase;
}

/** The tag of `commit`'s release in the assistant's repository. */
export function releaseTag(runtime: Pick<InstanceRuntimeConfig, 'install_id'>, commit: string): string {
  return releaseImageTag(imageBase(runtime), releaseName(commit));
}

/** The content key of `release`'s agent image, built with the fixture's `INSTALL_CJK_FONTS=true`. */
export function releaseAgentImageKey(release: Release, flags: { readonly installCjkFonts?: boolean } = {}): string {
  return releaseImageKey({
    contextTree: git(release.tool, 'rev-parse', `${release.commit}:container`),
    installCjkFonts: flags.installCjkFonts ?? true,
  });
}

/** The physical layout of the assistant's instance. */
export function layoutOf(host: Machine, runtime: InstanceRuntimeConfig) {
  return host.paths.instanceLayout(runtime.instance_id);
}

/**
 * The central database a host left closed (WAL, no side files): the live
 * migrations, the profile naming main, main's shared skills, no sessions yet,
 * and three agent groups, one of them running a per-group image NanoClaw
 * built on the base, and one an image of its own.
 */
export function centralDatabase(runtime: InstanceRuntimeConfig): void {
  const database = new Database(path.join(runtime.state_root, 'data', 'v2.db'));
  try {
    database.pragma('journal_mode = WAL');
    database.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied TEXT NOT NULL);
      CREATE TABLE agent_groups (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE, agent_provider TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE container_configs (
        agent_group_id TEXT PRIMARY KEY, image_tag TEXT, mcp_servers TEXT NOT NULL DEFAULT '{}', skills TEXT
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

/** Fake staging boundaries: Git and tar for real, the release's install and build written as they would leave it. */
const stagingSeams = {
  runCommand: async (command: SanitizedCommand) => {
    if (command.command === 'git' || command.command === 'tar') return runSanitizedCommand(command);
    return { stdout: '', stderr: '' };
  },
  runSetupCommand: setupCommand,
};

/** The release's frozen install and build, as they leave the release: its dependencies and its build output. */
async function setupCommand(command: SetupCommand): Promise<void> {
  if (command.args[0] === 'install') {
    await write(command.cwd, 'node_modules/.modules.yaml', 'installed\n');
    return;
  }
  await write(command.cwd, 'dist/index.js', 'host\n');
  await write(command.cwd, 'dist/gws-ea/process.js', 'launcher\n');
}

/** How a test wants an assistant made: what an older release than this tool kept with its own. */
export interface AssistantOptions {
  readonly port?: number;
  /** The gateway its release's Compose file names, as an older tool rendered it. */
  readonly gateway?: string;
  /** Its release's service definition, as an older tool rendered it. */
  readonly serviceDefinition?: string;
}

/** Each assistant's first release and its image's content key, which `world` tags its image for. */
const createdAt = new Map<string, { readonly commit: string; readonly key: string }>();

/** The service manager options the fixture's assistants run under: launchd, as this user. */
export const SERVICE = { platform: 'darwin' as const, uid: 501, ambientEnv: {}, sleep: async () => undefined };

/** The assistant's service definition, in the fixture machine's home. */
export function serviceDefinitionFile(runtime: InstanceRuntimeConfig): string {
  return instanceServiceDefinitionFile(runtime, { platform: 'macos', homeDirectory: runtime.home_directory });
}

/**
 * An assistant create finished at the machine's first release: its state, its
 * release staged and kept, gws-ea's `.env` keys applied, its OneCLI Compose
 * file and service definition installed from what was kept, and the live link
 * pointing at the release; its central database as the host left it.
 */
export async function assistant(host: Machine, options: AssistantOptions = {}): Promise<InstanceRuntimeConfig> {
  const { paths } = host;
  const port = options.port ?? 37_001;
  const instanceId = randomUUID();
  const reserved = await reserveInstance(paths, {
    instance_id: instanceId,
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
  const layout = paths.instanceLayout(instanceId);
  await writeInstanceMarker(paths, instanceId);
  await createState(layout);
  const onecli = createOnecliRuntimeLayout({
    instanceId,
    instanceRoot: paths.instanceRoot(instanceId),
    project: reserved.exclusive_resource_claims.onecli_project,
    appPort: reserved.allocated_ports.onecli_app,
    gatewayPort: reserved.allocated_ports.onecli_gateway,
    dockerEndpoint: DOCKER,
  });
  const runtime = createInstanceRuntimeConfig(paths, reserved, onecli, {
    nodePath: process.execPath,
    homeDirectory: host.root,
    selectedProvider: 'claude',
    dockerEndpoint: DOCKER,
  });
  await writeFile(path.join(layout.state, '.env'), 'INSTALL_CJK_FONTS=true\n', { mode: 0o600 });
  await persistInstanceRuntime(runtime, upsertEnvVars);
  const service = { platform: 'macos' as const, homeDirectory: host.root, runningAsRoot: false };
  await stageRelease(
    {
      paths,
      view: reserved,
      runtime,
      onecli,
      service,
      provider: { provider: 'claude', providerCredential: CREDENTIAL },
    },
    stagingSeams,
  );
  const name = releaseName(host.first);
  const keptFiles = path.join(layout.kept(name));
  if (options.gateway) {
    await writeFile(path.join(keptFiles, 'onecli-compose.yaml'), renderOnecliCompose(onecli, PINS, options.gateway), {
      mode: 0o600,
    });
  }
  if (options.serviceDefinition) {
    await writeFile(path.join(keptFiles, 'service-definition'), options.serviceDefinition, { mode: 0o600 });
  }
  const kept = await readKeptRelease(keptFiles);
  await applyReleaseEnvironment(runtime, name, upsertEnvVars);
  await mkdir(onecli.rootDirectory, { recursive: true, mode: 0o700 });
  await writeFile(onecli.composeFile, kept.compose, { mode: 0o600 });
  await mkdir(path.dirname(serviceDefinitionFile(runtime)), { recursive: true });
  await writeFile(serviceDefinitionFile(runtime), kept.serviceDefinition, { mode: 0o600 });
  centralDatabase(runtime);
  await stampMain(layout.release(name), runtime.state_root);
  await pointCurrent(layout, name);
  createdAt.set(instanceId, {
    commit: host.first,
    key: releaseImageKey({
      contextTree: git(host.work, 'rev-parse', `${host.first}:container`),
      installCjkFonts: true,
    }),
  });
  return runtime;
}

/** Stamp main from a release's own template into the state, as create's `ncl groups create --template` does. */
export async function stampMain(release: string, state: string): Promise<void> {
  await cp(path.join(release, MAIN_TEMPLATE_DIR), path.join(state, MAIN_FOLDER), { recursive: true });
}

/** What the assistant's conversations and memory hold: a session message row and a memory file. */
export async function converse(runtime: InstanceRuntimeConfig, ...messages: readonly string[]): Promise<void> {
  const session = path.join(runtime.state_root, SESSION);
  await mkdir(session, { recursive: true, mode: 0o700 });
  const database = new Database(path.join(session, 'inbound.db'));
  try {
    database.pragma('journal_mode = DELETE');
    database.exec('CREATE TABLE IF NOT EXISTS messages_in (id TEXT PRIMARY KEY, content TEXT NOT NULL)');
    for (const id of messages) database.prepare('INSERT INTO messages_in VALUES (?, ?)').run(id, `said ${id}`);
  } finally {
    database.close();
  }
  await write(runtime.state_root, MEMORY, 'The principal prefers mornings.\n');
}

/** The messages the session under `stateRoot` received. */
export function messages(stateRoot: string): string[] {
  const database = new Database(path.join(stateRoot, SESSION, 'inbound.db'), { readonly: true });
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
 * Where a run is killed: the boundary call it never returns from. `stamp` is
 * the release's tripwire script, the first step of a switch, `verify` the
 * wait for the started host, and `rebuild` an agent group's image rebuild.
 */
export type HangPoint = 'build' | 'migrate' | 'stop' | 'stamp' | 'verify' | 'rebuild';

/** What every faked boundary holds, and what reached it. */
export interface World {
  /** The launchd job is loaded. */
  loaded: boolean;
  /** Its host runs: only while the job is loaded and the program its definition names exists. */
  running: boolean;
  /** The service definition the loaded job read when it was bootstrapped. */
  loadedDefinition?: string;
  freeBytes: number;
  /** Docker's images: each tag and the image ID it names; `ids` holds every image, tagged or not. */
  readonly tags: Map<string, string>;
  readonly ids: Set<string>;
  /** The agent image key each image's label carries, by image ID. */
  readonly labels: Map<string, string>;
  readonly commands: SanitizedCommand[];
  /** Every install and build of a release staging ran. */
  readonly setups: SetupCommand[];
  /** The service's stops and starts, and staging's installs, builds, and image builds, in order. */
  readonly events: string[];
  /** Every call the service helpers took, with the install it named. */
  readonly serviceCalls: string[];
  /** The OneCLI Compose file each project last came up from. */
  readonly gateways: Map<string, string>;
  /** Isolation probes run, by the gateway image each probed. */
  readonly probes: string[];
  /** The isolation probe fails while the gateway runs this image. */
  failingGateway?: string;
  /** The serving runtime's re-verification before the fence fails. */
  reverifyFails?: boolean;
  readonly reverified: string[];
  readonly rebuilds: Array<{ readonly args: readonly string[]; readonly timeoutMs: number | undefined }>;
  /** Main's shared skills reconciled, each time: the list the live release ships. */
  readonly skills: string[][];
  readonly fetched: string[];
  /** How long each health check was allowed. */
  readonly healthWaits: Array<number | undefined>;
  migrate: Migrate;
  buildFails?: boolean;
  /** Every layer of a per-group image is cached, so its rebuild gives the image its tag already names. */
  cachedRebuild?: boolean;
  /** What `ps` lists, and what `lsof` finds open under the instance's state. */
  processes: string;
  openFiles: string;
  /** The containers `docker ps --all` lists, by the install label it filters on. */
  readonly containers: Map<string, readonly string[]>;
  /** The listener ID the running host answers with. */
  listener: string;
  /** The callback route answers 502, as a tunnel with nothing behind it does. */
  routeDown?: boolean;
  /** What observing OneCLI finds instead of it present. */
  onecliObservation?: Observation;
  /** Runs when the host starts, from the live release, as the host would. */
  onStart?: (checkout: string) => void;
  /** The service manager refuses to start the host. */
  startFails?: boolean;
  /** Runs as the release's tripwire is stamped, the first step of a switch. */
  onStamp?: () => void;
  rebuildFails?: boolean;
  /** The step a run never returns from, as if killed there; `reached` resolves once it is under way. */
  hangAt?: HangPoint;
  reached?: () => void;
}

let images = 0;
/** When each image was created: in the order the fixture made them, a second apart. */
const created = new Map<string, string>();

export function imageId(): string {
  images += 1;
  const id = `sha256:${createHash('sha256').update(`image ${images}`).digest('hex')}`;
  created.set(id, new Date(Date.UTC(2026, 8, 1) + images * 1_000).toISOString());
  return id;
}

/** The fixture's Docker and services for `runtime`'s assistant: its release image, a per-group image, and the gateways. */
export function world(runtime: Pick<InstanceRuntimeConfig, 'install_id' | 'instance_id'>, migrate = applying()): World {
  const created = createdAt.get(runtime.instance_id);
  const own = imageId();
  const tags = new Map([
    ...(created ? [[releaseTag(runtime, created.commit), own] as const] : []),
    [`${imageBase(runtime)}:ag-research`, imageId()],
    [DEPLOYED_GATEWAY, imageId()],
    [RELEASE_GATEWAY, imageId()],
  ]);
  return {
    loaded: true,
    running: true,
    freeBytes: 1e15,
    tags,
    ids: new Set(tags.values()),
    labels: new Map(created ? [[own, created.key]] : []),
    commands: [],
    setups: [],
    events: [],
    serviceCalls: [],
    gateways: new Map(),
    probes: [],
    reverified: [],
    rebuilds: [],
    skills: [],
    fetched: [],
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

function dockerFailure(stderrTail: string): GwsEaError {
  return new GwsEaError('command_failed', 'docker exited with code 1', { details: { exitCode: 1, stderrTail } });
}

/** Tag an image as Docker does: the tag's former image stays, untagged unless another tag names it. */
export function tag(state: World, reference: string, name: string): void {
  const id = state.tags.get(reference) ?? (state.ids.has(reference) ? reference : undefined);
  if (!id) throw dockerFailure(`Error response from daemon: No such image: ${reference}`);
  state.tags.set(name, id);
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
    if (![...state.tags.values()].includes(named)) {
      state.ids.delete(named);
      state.labels.delete(named);
    }
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
  state.labels.delete(reference);
}

/** Tagged and untagged image IDs: what a repository's tags name, and what no tag names at all. */
export function repositoryImages(state: World, repository: string): { tagged: Set<string>; untagged: string[] } {
  const tagged = new Set([...state.tags].filter(([name]) => name.startsWith(`${repository}:`)).map(([, id]) => id));
  const named = new Set(state.tags.values());
  return { tagged, untagged: [...state.ids].filter((id) => !named.has(id)) };
}

/** The value of each `flag` in `args`. */
function flagValues(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, index) => (args[index - 1] === flag ? [arg] : []));
}

/** `docker image ls --filter`, as Docker answers it for `label=<key>=<value>` and `dangling=false`. */
function listFiltered(state: World, args: readonly string[]): string {
  const tagged = new Set(state.tags.values());
  const matches = (id: string): boolean =>
    flagValues(args, '--filter').every((filter) => {
      if (filter === 'dangling=false') return tagged.has(id);
      const [name, value] = filter.replace(/^label=/u, '').split(/=(.*)/su);
      return name === AGENT_IMAGE_KEY_LABEL && state.labels.get(id) === value;
    });
  return [...state.ids]
    .filter(matches)
    .map((id) => `${id}\n`)
    .join('');
}

/** `docker image inspect <id>` as Docker prints it: the fields an agent image lookup reads. */
function inspected(state: World, id: string): string {
  if (!state.ids.has(id)) throw dockerFailure(`Error: No such image: ${id}`);
  const label = state.labels.get(id);
  return `${JSON.stringify([
    {
      Id: id,
      RepoTags: [...state.tags].filter(([, named]) => named === id).map(([name]) => name),
      Created: created.get(id) ?? '2026-09-01T00:00:00.000Z',
      Config: { Labels: label === undefined ? null : { [AGENT_IMAGE_KEY_LABEL]: label } },
    },
  ])}\n`;
}

/** A OneCLI project's containers: the gateway's ID changes whenever Compose recreated it from another file. */
function projectContainers(state: World, project: string): string {
  const running = state.gateways.get(project) ?? 'created';
  const gateway = createHash('sha256').update(running).digest('hex').slice(0, 12);
  return `postgres-${project}\napp-${project}\n${gateway}\n`;
}

/** Docker as the instance and its OneCLI project use it. */
async function docker(state: World, spec: SanitizedCommand): Promise<{ stdout: string; stderr: string }> {
  const [first, second] = spec.args;
  const joined = spec.args.join(' ');
  const last = spec.args.at(-1)!;
  if (first === 'compose') {
    const project = flagValues(spec.args, '--project-name')[0]!;
    if (spec.args.includes('up')) {
      state.gateways.set(project, await readFile(flagValues(spec.args, '--file')[0]!, 'utf8'));
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected compose command: ${joined}`);
  }
  if (first === 'container' && second === 'ls') {
    const project = flagValues(spec.args, '--filter')[0]!.replace('label=com.docker.compose.project=', '');
    return { stdout: projectContainers(state, project), stderr: '' };
  }
  if (first === 'run') {
    const project = [...state.gateways].find(([name]) =>
      (flagValues(spec.args, '--network')[0] ?? '').startsWith(name),
    );
    const running = project?.[1] ?? '';
    state.probes.push(
      running.includes(RELEASE_GATEWAY)
        ? RELEASE_GATEWAY
        : running.includes(DEPLOYED_GATEWAY)
          ? DEPLOYED_GATEWAY
          : 'unknown',
    );
    if (state.failingGateway && running.includes(state.failingGateway)) {
      throw new GwsEaError('command_failed', 'docker exited with code 1', {
        details: { exitCode: 1, stderrTail: 'link-local/metadata reachable through gateway' },
      });
    }
    return { stdout: '', stderr: '' };
  }
  if (first === 'ps') {
    const label = spec.args[spec.args.indexOf('--filter') + 1]?.replace(/^label=/u, '') ?? '';
    return { stdout: (state.containers.get(label) ?? []).map((id) => `${id}\n`).join(''), stderr: '' };
  }
  if (first === 'image' && second === 'inspect' && joined.includes('{{.Size}}')) {
    if (!state.tags.has(last)) throw dockerFailure(`Error: No such image: ${last}`);
    return { stdout: `${IMAGE_BYTES}\n`, stderr: '' };
  }
  if (first === 'image' && second === 'inspect') return { stdout: inspected(state, last), stderr: '' };
  if (first === 'image' && second === 'ls' && spec.args.includes('--filter')) {
    return { stdout: listFiltered(state, spec.args), stderr: '' };
  }
  if (first === 'image' && second === 'ls') {
    const id = state.tags.get(last);
    return { stdout: id ? `${joined.includes('--no-trunc') ? id : id.slice(7, 19)}\n` : '', stderr: '' };
  }
  if (first === 'tag') {
    tag(state, spec.args[1]!, spec.args[2]!);
    return { stdout: '', stderr: '' };
  }
  if (first === 'image' && second === 'rm') {
    removeImage(state, last);
    return { stdout: '', stderr: '' };
  }
  if (first === 'build' && last === '-') {
    // A metadata-only build from stdin: the image it names `FROM`, with one label more.
    const from = /^FROM (\S+)\n$/u.exec(spec.input ?? '')?.[1];
    const base = from ? (state.tags.get(from) ?? (state.ids.has(from) ? from : undefined)) : undefined;
    if (!base) throw dockerFailure(`ERROR: failed to solve: ${from ?? 'no FROM'}: not found`);
    const [label, value] = (flagValues(spec.args, '--label')[0] ?? '').split(/=(.*)/su);
    if (label !== AGENT_IMAGE_KEY_LABEL || !value) throw new Error(`unexpected label build: ${joined}`);
    const id = imageId();
    state.ids.add(id);
    state.labels.set(id, value);
    state.tags.set(flagValues(spec.args, '--tag')[0]!, id);
    return { stdout: '', stderr: '' };
  }
  if (first === 'build') {
    const id = imageId();
    state.ids.add(id);
    state.tags.set(flagValues(spec.args, '--tag')[0]!, id);
    return { stdout: '', stderr: '' };
  }
  throw new Error(`unexpected docker command: ${joined}`);
}

/** Git and tar for real; Docker, `ps`, `lsof`, and the release's own scripts as `state` says. */
export function runner(state: World): SanitizedCommandRunner {
  return async (spec) => {
    state.commands.push(spec);
    const [first, second] = spec.args;
    const joined = spec.args.join(' ');
    if (spec.command === 'git' || spec.command === 'tar') return runSanitizedCommand(spec);
    if (spec.command === 'pnpm' && joined === 'run migrate') {
      state.migrate(path.join(spec.cwd, 'data', 'v2.db'));
      await hang(state, 'migrate');
      return { stdout: '', stderr: '' };
    }
    if (spec.command === 'pnpm' && joined.startsWith('exec tsx scripts/upgrade-state.ts set ')) {
      await hang(state, 'stamp');
      state.onStamp?.();
      // The release's own script, run from its folder, writes through the release's `data` link.
      const commit = git(spec.cwd, 'rev-parse', 'HEAD');
      await writeFile(path.join(spec.cwd, 'data', 'upgrade-state.json'), JSON.stringify({ commit, via: spec.args[5] }));
      return { stdout: '', stderr: '' };
    }
    if (spec.command === 'bash' && first?.endsWith(path.join('container', 'build.sh')) && second) {
      await hang(state, 'build');
      if (state.buildFails) {
        throw new GwsEaError('command_failed', 'bash exited with code 1', {
          details: { exitCode: 1, stderrTail: 'ERROR: failed to solve: process did not complete successfully' },
        });
      }
      const base = getInstallScopedNames(spec.env?.NANOCLAW_INSTALL_ID ?? '').containerImageBase;
      const id = imageId();
      state.ids.add(id);
      state.tags.set(`${base}:${second}`, id);
      state.events.push('build');
      return { stdout: '', stderr: '' };
    }
    if (spec.command === 'ps') return { stdout: state.processes, stderr: '' };
    if (spec.command === 'sh' && spec.args[2] === 'lsof') return { stdout: state.openFiles, stderr: '' };
    if (spec.command === 'systemctl') return { stdout: '', stderr: '' };
    if (spec.command === 'docker') return docker(state, spec);
    throw new Error(`unexpected command: ${spec.command} ${joined}`);
  };
}

/**
 * NanoClaw's service helpers, as launchd runs an assistant: a job is loaded
 * (bootstrapped) or not, a stop boots it out, and a loaded job runs the host
 * only while the program its definition names, through the live link,
 * exists; launchd retries it, so a host comes up once the link is there.
 */
export function services(state: World): NanoclawServiceHelpers {
  const unused = (): never => {
    throw new Error('the helpers run their commands through the fakes below');
  };
  const program = (root: string): boolean => existsSync(path.join(root, 'dist', 'gws-ea', 'process.js'));
  return {
    createCommandRunner: () => ({ run: unused, tryRun: unused }),
    detectService: (_root, env) => {
      state.serviceCalls.push(`detect ${env.installSlug}`);
      return {
        mode: 'launchd',
        active: state.loaded,
        name: `com.nanoclaw-v2-${env.installSlug}`,
        definition: path.join(env.home, 'Library', 'LaunchAgents', `com.nanoclaw-v2-${env.installSlug}.plist`),
      };
    },
    stopService: async (handle, env) => {
      if (!handle.active) return;
      state.serviceCalls.push(`stop ${env.installSlug}`);
      state.events.push(state.running ? 'stop running' : 'stop');
      await hang(state, 'stop');
      state.loaded = false;
      state.running = false;
    },
    startService: (handle, root, env) => {
      if (!handle.active) return;
      state.serviceCalls.push(`start ${env.installSlug}`);
      if (state.startFails) throw new Error('Bootstrap failed: 5: Input/output error');
      state.events.push('start');
      state.loaded = true;
      state.loadedDefinition = readFileSync(handle.definition!, 'utf8');
      state.running = program(root);
      if (state.running) state.onStart?.(root);
    },
    drainContainers: async (_root, env) => {
      state.serviceCalls.push(`drain ${env.installSlug}`);
    },
    verifyServiceHealth: async (_handle, root, env, timeoutMs) => {
      state.serviceCalls.push(`health ${env.installSlug}`);
      state.healthWaits.push(timeoutMs);
      // launchd retries a loaded job whose program was missing, and starts it once the live link is back.
      if (state.loaded && !state.running && program(root)) state.running = true;
      return state.running;
    },
  };
}

/**
 * A reboot or login: launchd loads the job from its definition (`RunAtLoad`)
 * and runs the host only if the program the definition names exists.
 */
export function reboot(state: World, runtime: InstanceRuntimeConfig): void {
  state.loaded = true;
  state.loadedDefinition = readFileSync(serviceDefinitionFile(runtime), 'utf8');
  state.running = existsSync(path.join(runtime.checkout_root, 'dist', 'gws-ea', 'process.js'));
}

/** The host's status over its socket, and its listener: the running host answers for its own release. */
export function hostStatus(state: World, runtime: InstanceRuntimeConfig): HostStatusHelpers {
  const status = (root: string) => ({
    pid: 4242,
    instance_id: `host-${state.events.length}`,
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

/**
 * The assistant's own `ncl`, through its running host: an agent group's image
 * rebuilt on the live release's image, the profile, and main's shared skills
 * set to the list the live release ships.
 */
function ncl(state: World): NonNullable<UpdateDependencies['ncl']> {
  return async (config, args, options) => {
    if (!state.running) throw new GwsEaError('ncl_failed', 'ncl could not reach the host: connect ENOENT');
    if (args[0] === 'gws-ea-profile' && args[1] === 'get') return { main_agent_group_id: 'ag-main' };
    if (args[0] === 'gws-ea-main' && args[1] === 'reconcile') {
      const id = args[args.indexOf('--agent-group-id') + 1]!;
      const skills = JSON.parse(await readFile(path.join(config.checkout_root, MAIN_SKILLS), 'utf8')) as string[];
      const database = new Database(path.join(config.state_root, 'data', 'v2.db'));
      try {
        database
          .prepare('UPDATE container_configs SET skills = ? WHERE agent_group_id = ?')
          .run(JSON.stringify(skills), id);
      } finally {
        database.close();
      }
      state.skills.push(skills);
      return { agent_group_id: id, skills };
    }
    state.rebuilds.push({ args, timeoutMs: options?.timeoutMs });
    await hang(state, 'rebuild');
    if (state.rebuildFails) {
      throw new GwsEaError('ncl_failed', `ncl ${args.join(' ')} failed: apt-get could not find package made-up`);
    }
    // NanoClaw's buildAgentGroupImage moves the group's tag to an image built on the live release's image.
    const group = `${imageBase(config)}:${args[args.indexOf('--id') + 1]}`;
    const id = (state.cachedRebuild ? state.tags.get(group) : undefined) ?? imageId();
    state.ids.add(id);
    state.tags.set(group, id);
    return { restarted: 0, rebuilt: true };
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
    runSetupCommand: async (command) => {
      state.setups.push(command);
      state.events.push(`setup ${command.args[0] === 'install' ? 'install' : 'build'}`);
      await setupCommand(command);
    },
    freeBytes: async () => state.freeBytes,
    service: SERVICE,
    ambientEnv: {},
    fetch: async (input, init) => {
      const url = String(input);
      state.fetched.push(`${init?.method ?? 'GET'} ${url}`);
      if (!state.running) throw new TypeError('fetch failed');
      const local = new URL(url).hostname === '127.0.0.1';
      if (!local && state.routeDown) return new Response(null, { status: 502 });
      return new Response(null, { status: 401, headers: { 'x-nanoclaw-webhook-id': state.listener } });
    },
    onecli: {
      reverify: async (layout: OnecliRuntimeLayout) => {
        state.reverified.push(layout.project);
        if (state.reverifyFails) throw new GwsEaError('unhealthy_onecli', 'The OneCLI runtime is not serving.');
      },
      observe: async () => state.onecliObservation ?? { status: 'present' },
    },
    ncl: ncl(state),
  };
}

/**
 * Confirm an update and run it until `state.hangAt`, or until `kill` stops it,
 * then abandon it there, as if the process were killed: nothing after that
 * point runs, and the instance lock goes with it.
 */
export async function killDuringUpdate(host: Machine, runtime: InstanceRuntimeConfig, state: World, release: Release) {
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
    await confirmStagedUpdate(operation, staged, async () => true);
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

/** What the assistant's live release is: its registry entry, live link, and the live release's HEAD and tree. */
export async function liveState(host: Machine, runtime: InstanceRuntimeConfig) {
  return {
    registered: releaseOf(await getInstanceReservation(host.paths, runtime.instance_id)),
    live: await readlink(runtime.checkout_root),
    head: git(runtime.checkout_root, 'rev-parse', 'HEAD'),
    status: git(runtime.checkout_root, 'status', '--porcelain'),
    migrations: readCentralMigrations(runtime.state_root),
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
        onecliAgents: unserved,
        onecli: async () => ({ status: 'present' }),
      },
    },
    runtime.instance_id,
  );
}
