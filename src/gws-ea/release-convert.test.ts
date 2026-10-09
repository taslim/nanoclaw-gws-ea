/**
 * The one-time conversion (KTD12) of an assistant on the layout before
 * releases, built as the gws-ea at 27245c7a left one: under
 * `<state root>/instances/<id>/`, its one checkout at its release with the
 * state inside it (`.env`, `data`, `groups`, `store`, `logs`), the rollback
 * point the swap kept in `previous/`, its receipt, secrets, OneCLI project,
 * journal, and bootstrap record; a registry entry recording its checkout;
 * and a launchd job whose definition runs the old launcher with the runtime
 * record in the checkout. The world update tests share fakes every boundary
 * (`testing/cutover-fixture.ts`); here OneCLI's REST API, Google's token
 * endpoint, and Docker's bind mount through a link answer too. A kill is a
 * run abandoned right after one filesystem change, as if the process died
 * there.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, readlink, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_GOOGLE_SERVICES,
  EXPOSED_GOOGLE_SERVICES,
  GOOGLE_GRANT_FILE_NAME,
  GOOGLE_SIGN_IN_SCOPES,
} from '../modules/gws-ea-google/grant.js';
import { GOOGLE_TOKEN_ENDPOINT } from '../modules/gws-ea-google/tokens.js';
import { releaseImageKey } from './agent-image-release.js';
import { runCli } from './cli.js';
import { acquireInstanceOperation, recordStepCompleted, reserveInstance } from './journal.js';
import { createOnecliRuntimeLayout, renderOnecliCompose } from './onecli-compose.js';
import { readOperationRecord, readRollbackPoint, type OperationPhase } from './operation.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { LAUNCHER_PINS, ONECLI_SDK_VERSION } from './pins.js';
import type { SanitizedCommandRunner } from './process.js';
import { getInstanceReservation } from './registry.js';
import { assertConverted, legacyInstanceRoot } from './release-convert.js';
import { releaseName } from './release-layout.js';
import { instanceHostConfiguration, validateRuntimeConfig, type InstanceRuntimeConfig } from './service.js';
import { renderLaunchdService } from './service-definition.js';
import type { NanoclawServiceHelpers } from './service-control.js';
import {
  centralDatabase,
  converse,
  CREDENTIAL,
  DEPLOYED_GATEWAY,
  DOCKER,
  dependencies,
  exists,
  git,
  imageBase,
  imageId,
  MEMORY,
  messages,
  NEW_IMAGE,
  nextRelease,
  machine,
  release,
  releaseTag,
  removeTemporaryRoots,
  runner,
  SERVICE,
  SESSION,
  serviceDefinitionFile,
  snapshot,
  upsertEnvVars,
  world,
  write,
  type Machine,
  type Release,
  type World,
} from './testing/cutover-fixture.js';
import { GwsEaError, PROVISION_STEPS, releaseOf, type InstanceReservation } from './types.js';
import {
  confirmStagedUpdate,
  continueUpdate,
  prepareUpdate,
  resolveUpdateIntent,
  updatePreviewLines,
  type StagedUpdate,
  type UpdateDependencies,
  type UpdatePreview,
} from './update.js';

/**
 * The filesystem change a run is killed right after (a rename's target and
 * source, or a removal's target), and every rename and removal it made, in
 * order.
 */
const kill = vi.hoisted(() => ({
  after: undefined as ((change: 'rename' | 'rm', target: string, source?: string) => boolean) | undefined,
  reached: undefined as (() => void) | undefined,
  trace: [] as string[],
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const changed = async (change: 'rename' | 'rm', target: string, source?: string): Promise<void> => {
    kill.trace.push(`${change} ${target}`);
    if (!kill.after?.(change, target, source)) return;
    kill.after = undefined;
    kill.reached?.();
    await new Promise(() => undefined);
  };
  return {
    ...actual,
    rename: async (from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) => {
      await actual.rename(from, to);
      await changed('rename', String(to), String(from));
    },
    rm: async (target: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
      await actual.rm(target, options);
      await changed('rm', String(target));
    },
  };
});

afterEach(removeTemporaryRoots);
afterEach(() => {
  kill.after = undefined;
  kill.trace.length = 0;
});

/** Each case clones, fetches, and stages real Git repositories, which a loaded machine slows. */
const GIT_HEAVY = { timeout: 60_000 } as const;

const PINS = { gateway: LAUNCHER_PINS.onecliGateway };
const ONECLI_KEY = `oc_${'k'.repeat(24)}`;
/** Another assistant's agent image, which no conversion ever touches. */
const OTHER_ASSISTANT_IMAGE = 'nanoclaw-agent-v2-0123456789abcdef0123456789abcdef:latest';

/** An assistant on the layout before releases, and what its conversion will record for it. */
interface LegacyAssistant {
  readonly id: string;
  /** `<state root>/instances/<id>`. */
  readonly root: string;
  /** Its one checkout, which holds its state. */
  readonly checkout: string;
  /** Its runtime as the short root records it once converted. */
  readonly runtime: InstanceRuntimeConfig;
  /** Its launchd job's definition. */
  readonly plist: string;
}

/** The old layout's state, where it is before the conversion and where the short root keeps it after. */
const STATE_FILES = [
  ['nanoclaw/data', 'state/data'],
  ['nanoclaw/data/v2.db', 'state/data/v2.db'],
  [`nanoclaw/${SESSION}/inbound.db`, `state/${SESSION}/inbound.db`],
  [`nanoclaw/${MEMORY}`, `state/${MEMORY}`],
  ['nanoclaw/store/messages.db', 'state/store/messages.db'],
  ['nanoclaw/logs/nanoclaw.log', 'logs/nanoclaw.log'],
  ['secrets/onecli-admin-api-key', 'secrets/onecli-admin-api-key'],
  ['onecli/secrets/postgres-password', 'onecli/secrets/postgres-password'],
  ['provision.json', 'provision.json'],
  ['bootstrap.json', 'bootstrap.json'],
] as const;

async function writePrivate(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, contents, { mode: 0o600 });
}

/**
 * An assistant as the gws-ea at 27245c7a left one, created at the machine's
 * first release under step contract `contract`.
 */
async function legacyAssistant(host: Machine, contract: 1 | 2 = 2): Promise<LegacyAssistant> {
  const { paths } = host;
  const port = 38_001;
  const id = randomUUID();
  const project = `gws-ea-${id.replaceAll('-', '')}`;
  const allocated = { nanoclaw_webhook: port, onecli_app: port + 1, onecli_gateway: port + 2 };
  const endpoint = `https://l${port}.example.test/webhook/gchat`;
  await reserveInstance(paths, {
    instance_id: id,
    source_remote: host.remote,
    release_track: 'dogfood',
    deployed_commit: host.first,
    allocated_ports: allocated,
    exclusive_resource_claims: {
      ingress: { mode: 'existing', endpoint_url: endpoint },
      gcp_project_id: `legacy-${port}`,
      gcp_account: 'operator@example.test',
      gchat_service_account: `gws-ea-chat@legacy-${port}.iam.gserviceaccount.com`,
      workspace_email: `l${port}@example.test`,
      onecli_project: project,
    },
  });
  const operation = await acquireInstanceOperation(paths, id);
  if (!operation) throw new Error('The test instance operation was busy');
  try {
    for (const step of PROVISION_STEPS) await recordStepCompleted(operation, step);
  } finally {
    operation.release();
  }
  const root = path.join(paths.stateRoot, 'instances', id);
  const checkout = path.join(root, 'nanoclaw');
  await mkdir(root, { recursive: true, mode: 0o700 });
  // The journal lived at the old root, which nothing at the short root shared.
  const journal = path.join(root, 'provision.json');
  await rename(paths.journalFile(id), journal);
  await rm(paths.instanceRoot(id), { recursive: true, force: true });
  if (contract === 1) {
    const raw = JSON.parse(await readFile(journal, 'utf8')) as { steps: Record<string, unknown> };
    delete raw.steps.connect_google;
    await writePrivate(journal, JSON.stringify({ ...raw, launcher_contract_version: 1 }));
  }
  const registry = JSON.parse(await readFile(paths.registryFile, 'utf8')) as {
    instances: Record<string, Record<string, unknown>>;
  };
  registry.instances[id] = { ...registry.instances[id], checkout_realpath: checkout };
  await writePrivate(paths.registryFile, JSON.stringify(registry));

  // Its checkout at its release, built, with its state inside.
  git(root, 'clone', '--quiet', host.remote, checkout);
  git(checkout, 'checkout', '--quiet', '--detach', host.first);
  await write(checkout, 'dist/index.js', 'host\n');
  await write(checkout, 'dist/gws-ea/process.js', 'launcher\n');
  await write(checkout, 'node_modules/.modules.yaml', 'installed\n');
  const runtime = validateRuntimeConfig({
    schema_version: 2,
    instance_id: id,
    instance_root: paths.instanceRoot(id),
    node_path: process.execPath,
    home_directory: host.root,
    allocated_ports: allocated,
    onecli_project: project,
    selected_provider: 'claude',
    endpoint_url: endpoint,
    docker_endpoint: DOCKER,
  });
  const inCheckout = { ...runtime, state_root: checkout };
  await writePrivate(path.join(checkout, '.env'), 'ASSISTANT_NOTE=kept\n');
  upsertEnvVars({ ...instanceHostConfiguration(runtime) }, checkout);
  await writePrivate(
    path.join(checkout, 'data', 'gws-ea', 'instance.json'),
    JSON.stringify({ schema_version: 1, instance_id: id, deployed_commit: host.first }),
  );
  await writePrivate(
    path.join(checkout, 'data', 'gws-ea', 'runtime.json'),
    JSON.stringify({
      schema_version: 1,
      instance_id: id,
      deployed_commit: host.first,
      checkout_realpath: checkout,
      node_path: process.execPath,
      home_directory: host.root,
      allocated_ports: allocated,
      onecli_project: project,
      onecli_cli_path: path.join(paths.stateRoot, 'tools', 'onecli', '1.0.0', 'onecli'),
      selected_provider: 'claude',
      endpoint_url: endpoint,
      docker_endpoint: DOCKER,
    }),
  );
  centralDatabase(inCheckout);
  await converse(inCheckout, 'm1');
  await writePrivate(path.join(checkout, 'store', 'messages.db'), 'an older store\n');
  await writePrivate(path.join(checkout, 'logs', 'nanoclaw.log'), 'host output\n');

  // Its receipt, as the layout before releases wrote it, and the rollback point its last update kept.
  await writePrivate(
    path.join(root, 'release-preflight.json'),
    JSON.stringify({
      schema_version: 1,
      instance_id: id,
      deployed_commit: host.first,
      provider: 'claude',
      providerCapabilityDigest: `sha256:${'c'.repeat(64)}`,
      providerCredential: CREDENTIAL,
      packageManager: 'pnpm@10.0.0',
      onecli: { gateway: PINS.gateway, cli: '1.0.0', sdk: ONECLI_SDK_VERSION },
    }),
  );
  await writePrivate(path.join(root, 'previous', 'nanoclaw', 'data', 'v2.db'), 'the state the swap kept\n');
  await writePrivate(path.join(root, 'previous', 'release-preflight.json'), '{}\n');

  // Its secrets and its OneCLI project, rendered for the old root.
  for (const [name, value] of [
    ['gchat-service-account.json', '{"type":"service_account"}'],
    ['gchat-project-number', '123456789012'],
    ['onecli-runtime-api-key', ONECLI_KEY],
    ['onecli-admin-api-key', ONECLI_KEY],
  ] as const) {
    await writePrivate(path.join(root, 'secrets', name), value);
  }
  const old = createOnecliRuntimeLayout({
    instanceId: id,
    instanceRoot: root,
    project,
    appPort: allocated.onecli_app,
    gatewayPort: allocated.onecli_gateway,
    dockerEndpoint: DOCKER,
  });
  await writePrivate(old.composeFile, renderOnecliCompose(old, PINS, DEPLOYED_GATEWAY));
  await writePrivate(old.envFile, '# Intentionally empty: runtime coordinates are passed explicitly.\n');
  for (const file of [old.postgresPasswordFile, old.encryptionKeyFile, old.gatewayInternalSecretFile]) {
    await writePrivate(file, randomUUID());
  }
  await mkdir(path.join(old.rootDirectory, 'cli-home'), { mode: 0o700 });
  await writePrivate(path.join(root, 'bootstrap.json'), '{}\n');
  for (const directory of [root, path.join(root, 'secrets'), old.rootDirectory, old.secretsDirectory]) {
    await chmod(directory, 0o700);
  }

  // Its launchd job, whose definition runs the old launcher from the checkout with the runtime record in it.
  const plist = serviceDefinitionFile(runtime);
  await writePrivate(
    plist,
    renderLaunchdService({
      label: `com.nanoclaw-v2-${runtime.install_id}`,
      programArguments: [
        process.execPath,
        path.join(checkout, 'dist', 'gws-ea', 'process.js'),
        'launch-host',
        path.join(checkout, 'data', 'gws-ea', 'runtime.json'),
      ],
      workingDirectory: checkout,
      environment: { HOME: host.root, PATH: '/usr/local/bin:/usr/bin:/bin', DOCKER_HOST: DOCKER },
      standardOutputPath: path.join(checkout, 'logs', 'nanoclaw.log'),
      standardErrorPath: path.join(checkout, 'logs', 'nanoclaw.error.log'),
    }),
  );
  return { id, root, checkout, runtime, plist };
}

/** The fixture's Docker with the old layout's own image tags, a hold among them, and another assistant's image. */
function legacyWorld(host: Machine, legacy: LegacyAssistant): World {
  const state = world(legacy.runtime);
  const base = imageBase(legacy.runtime);
  const live = imageId();
  const previous = imageId();
  const other = imageId();
  for (const [tag, id] of [
    [`${base}:latest`, live],
    [`${base}:previous`, previous],
    [`${base}:next`, live],
    [`${base}:held-${'0'.repeat(12)}`, previous],
    [OTHER_ASSISTANT_IMAGE, other],
  ] as const) {
    state.tags.set(tag, id);
    state.ids.add(id);
  }
  state.labels.set(
    live,
    releaseImageKey({ contextTree: git(host.work, 'rev-parse', `${host.first}:container`), installCjkFonts: false }),
  );
  return state;
}

/**
 * What the conversion's own boundaries hold: OneCLI's vault, Docker's bind
 * mount, the recreated project's probe, and NanoClaw's drain.
 */
interface Conversion {
  /** OneCLI answers its REST API. */
  reachable: boolean;
  /** The secrets OneCLI's vault holds. */
  secrets: Array<{ readonly id: string; readonly name: string; readonly hostPattern: string }>;
  /** Docker does not resolve a bind mount through a link. */
  linkUnresolved?: boolean;
  /** The recreated OneCLI project fails its isolation probe. */
  probeFails?: boolean;
  /** The drain after a stop: NanoClaw's times out, as when an agent container will not stop, or the run is killed there. */
  drain?: 'times-out' | 'killed';
  /** The Compose file each recreated project was proven from. */
  readonly recreated: string[];
}

function conversion(): Conversion {
  return { reachable: true, secrets: [], recreated: [] };
}

function flagValue(args: readonly string[], flag: string): string {
  return args[args.indexOf(flag) + 1] ?? '';
}

/** The fixture's runner, with Docker reading a bind mount's source through its links and listing a repository's tags. */
function conversionRunner(state: World, world: Conversion): SanitizedCommandRunner {
  const base = runner(state);
  return async (spec) => {
    const [first, second] = spec.args;
    if (spec.command === 'ps') kill.trace.push('ps');
    if (spec.command === 'docker' && first === 'run' && spec.args.includes('--entrypoint')) {
      state.commands.push(spec);
      const [source] = flagValue(spec.args, '--volume').split(':');
      return { stdout: world.linkUnresolved ? '' : readFileSync(path.join(source!, 'marker'), 'utf8'), stderr: '' };
    }
    if (spec.command === 'docker' && first === 'image' && second === 'ls' && spec.args.includes('--format')) {
      state.commands.push(spec);
      const repository = spec.args.at(-1)!;
      const tags = [...state.tags.keys()].filter((tag) => tag.startsWith(`${repository}:`));
      return { stdout: tags.map((tag) => `${tag.slice(repository.length + 1)}\n`).join(''), stderr: '' };
    }
    return base(spec);
  };
}

/** OneCLI's REST API on the assistant's own port and Google's token endpoint; anything else as the fixture answers. */
function conversionFetch(fallback: typeof globalThis.fetch, legacy: LegacyAssistant, world: Conversion) {
  const app = `http://127.0.0.1:${legacy.runtime.allocated_ports.onecli_app}/`;
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === GOOGLE_TOKEN_ENDPOINT) {
      const scope = new URLSearchParams(String(init?.body)).get('scope') ?? '';
      return json({ access_token: 'ya29.converted', expires_in: 3599, scope });
    }
    if (!url.startsWith(app)) return fallback(input, init);
    if (!world.reachable) throw new TypeError('fetch failed');
    const route = new URL(url).pathname;
    if (route === '/v1/user/api-key') return json({ apiKey: ONECLI_KEY });
    if (new Headers(init?.headers).get('authorization') !== `Bearer ${ONECLI_KEY}`) return json({}, 401);
    if (route === '/v1/secrets') return json(world.secrets);
    if (route === '/v1/agents') return json([{ id: 'agent-1', identifier: 'ag-main', name: 'Main' }]);
    return json({}, 404);
  };
}

/** NanoClaw's own drain failure: a plain error naming the containers still listed at its timeout. */
const DRAIN_TIMED_OUT = 'Timed out waiting for NanoClaw containers to stop: 3f2a9c1b7d4e';

/** The service helpers, each stop and drain traced among the filesystem changes, the drain as `world` says. */
function traced(helpers: NanoclawServiceHelpers, world: Conversion): NanoclawServiceHelpers {
  return {
    ...helpers,
    stopService: async (handle, env) => {
      if (handle.active) kill.trace.push('stop');
      await helpers.stopService(handle, env);
    },
    drainContainers: async (root, env, timeoutMs) => {
      kill.trace.push('drain');
      if (world.drain === 'times-out') throw new Error(DRAIN_TIMED_OUT);
      if (world.drain === 'killed') {
        kill.reached?.();
        await new Promise(() => undefined);
      }
      await helpers.drainContainers(root, env, timeoutMs);
    },
  };
}

function conversionDependencies(
  state: World,
  next: Release,
  legacy: LegacyAssistant,
  world: Conversion,
): UpdateDependencies {
  const deps = dependencies(state, next, legacy.runtime);
  return {
    ...deps,
    serviceHelpers: traced(deps.serviceHelpers, world),
    runCommand: conversionRunner(state, world),
    fetch: conversionFetch(deps.fetch!, legacy, world),
    verifyRecreatedOnecli: async (layout) => {
      world.recreated.push(readFileSync(layout.composeFile, 'utf8'));
      if (world.probeFails) {
        throw new GwsEaError('onecli_isolation_failed', 'An agent reached the metadata service through the gateway.');
      }
    },
  };
}

/** `gws-ea` as the operator runs it, through the conversion's fakes. */
function cli(host: Machine, state: World, next: Release, legacy: LegacyAssistant, world: Conversion) {
  const out: string[] = [];
  const err: string[] = [];
  const {
    serviceHelpers,
    providerSetup,
    upsertEnvVars: upsert,
    hostStatus,
    reporter: _reporter,
    ...seams
  } = conversionDependencies(state, next, legacy, world);
  const run = (args: readonly string[]) =>
    runCli(args, {
      paths: host.paths,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      serviceHelpers,
      toolProviderSetup: async () => providerSetup,
      upsertEnvVars: upsert,
      hostStatus,
      update: seams,
    });
  return { run, out, err };
}

/** Check and stage the conversion under the instance lock, as `update --id` does before it asks. */
async function stage(host: Machine, legacy: LegacyAssistant, deps: UpdateDependencies): Promise<StagedUpdate> {
  const intent = await resolveUpdateIntent(host.paths, { instanceId: legacy.id }, deps);
  const operation = await acquireInstanceOperation(host.paths, legacy.id, { command: 'update', target: intent.target });
  if (!operation) throw new Error('The test instance operation was busy');
  try {
    return await prepareUpdate(operation, intent, deps);
  } finally {
    operation.release();
  }
}

/**
 * Convert, abandoning the run as if killed once `after` holds for a change
 * (or at the fixture's `hangAt`): nothing after it runs, and the locks it
 * held go with it.
 */
async function killConversion(
  host: Machine,
  legacy: LegacyAssistant,
  state: World,
  next: Release,
  world: Conversion,
  after?: (change: 'rename' | 'rm', target: string, source?: string) => boolean,
) {
  const deps = conversionDependencies(state, next, legacy, world);
  const intent = await resolveUpdateIntent(host.paths, { instanceId: legacy.id }, deps);
  const operation = await acquireInstanceOperation(host.paths, legacy.id, { command: 'update', target: intent.target });
  if (!operation) throw new Error('The test instance operation was busy');
  const reached = new Promise<'killed'>((resolve) => {
    kill.reached = () => resolve('killed');
    state.reached = () => resolve('killed');
  });
  kill.after = after;
  const run = async (): Promise<'finished'> => {
    const staged = await prepareUpdate(operation, intent, deps);
    await confirmStagedUpdate(operation, staged, async () => true);
    await continueUpdate(operation, deps);
    return 'finished';
  };
  expect(await Promise.race([reached, run()])).toBe('killed');
  operation.release();
  // A killed process's machine lock is reclaimed, its owner gone.
  await rm(host.paths.registryLock, { force: true });
  delete state.hangAt;
}

/** Each state file's inode, keyed by where the short root keeps it. */
async function stateInodes(legacy: LegacyAssistant): Promise<Map<string, number>> {
  const inodes = new Map<string, number>();
  for (const [from, to] of STATE_FILES) inodes.set(to, (await stat(path.join(legacy.root, from))).ino);
  return inodes;
}

/**
 * The assistant once converted and updated to `to`: the registry derives its
 * root, its state was moved there by rename, it runs `to` through the live
 * link and its service definition, and nothing of the conversion or the old
 * layout is left: no record, no old root, no old image tag. Another
 * assistant's image is untouched.
 */
async function expectConverted(
  host: Machine,
  legacy: LegacyAssistant,
  to: Release,
  state: World,
  inodes: ReadonlyMap<string, number>,
) {
  const { paths } = host;
  const layout = paths.instanceLayout(legacy.id);
  const reservation = await getInstanceReservation(paths, legacy.id);
  expect(reservation.checkout_realpath).toBeUndefined();
  expect(releaseOf(reservation)).toEqual(release(host, to.commit));
  expect(await readlink(layout.current)).toBe(releaseName(to.commit));
  expect(git(layout.current, 'rev-parse', 'HEAD')).toBe(to.commit);
  expect(git(layout.current, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  for (const [where, inode] of inodes) expect((await stat(path.join(layout.root, where))).ino).toBe(inode);
  expect(messages(layout.state)).toEqual(['m1']);
  expect(await readFile(path.join(layout.state, '.env'), 'utf8')).toContain('ASSISTANT_NOTE=kept');
  expect(JSON.parse(await readFile(paths.runtimeFile(legacy.id), 'utf8'))).toEqual({
    schema_version: 2,
    instance_id: legacy.id,
    instance_root: layout.root,
    node_path: legacy.runtime.node_path,
    home_directory: legacy.runtime.home_directory,
    allocated_ports: legacy.runtime.allocated_ports,
    onecli_project: legacy.runtime.onecli_project,
    selected_provider: 'claude',
    endpoint_url: legacy.runtime.endpoint_url,
    docker_endpoint: DOCKER,
  });
  expect(await readFile(legacy.plist, 'utf8')).toContain(path.join(layout.current, 'dist', 'gws-ea', 'process.js'));
  expect(await exists(path.join(layout.root, 'conversion.json'))).toBe(false);
  expect(await readOperationRecord(paths, legacy.id)).toBeUndefined();
  expect(await readRollbackPoint(paths, legacy.id)).toBeUndefined();
  expect(await exists(legacy.root)).toBe(false);
  const base = imageBase(legacy.runtime);
  expect([...state.tags.keys()].filter((tag) => tag.startsWith(`${base}:`)).sort()).toEqual(
    [`${base}:ag-research`, releaseTag(legacy.runtime, to.commit)].sort(),
  );
  expect(state.tags.has(OTHER_ASSISTANT_IMAGE)).toBe(true);
  expect(state.running).toBe(true);
}

/** `name` renamed into place, the change a kill at that move comes right after. */
function renamedTo(target: string) {
  return (change: 'rename' | 'rm', at: string): boolean => change === 'rename' && at === target;
}

/** The conversion record written at `step`. */
function conversionAt(paths: ControlPlanePaths, id: string, step: string) {
  const file = path.join(paths.instanceRoot(id), 'conversion.json');
  return (change: 'rename' | 'rm', at: string): boolean =>
    change === 'rename' && at === file && (JSON.parse(readFileSync(file, 'utf8')) as { step: string }).step === step;
}

/** The update record written at `phase`. */
function recordedAt(paths: ControlPlanePaths, id: string, phase: OperationPhase) {
  const file = paths.operationFile(id);
  return (change: 'rename' | 'rm', at: string): boolean =>
    change === 'rename' && at === file && (JSON.parse(readFileSync(file, 'utf8')) as { phase: string }).phase === phase;
}

/** The registry written with the assistant's entry as `holds` says. */
function registryAt(paths: ControlPlanePaths, id: string, holds: (entry: InstanceReservation) => boolean) {
  return (change: 'rename' | 'rm', at: string): boolean =>
    change === 'rename' &&
    at === paths.registryFile &&
    holds((JSON.parse(readFileSync(at, 'utf8')) as { instances: Record<string, InstanceReservation> }).instances[id]!);
}

/**
 * Every change the conversion records or makes, in order, each a kill point:
 * the record of the stop, every rename, every rewrite, the recreated OneCLI
 * project, the update's phases from there, the removal of the old layout,
 * and the commit.
 */
const KILL_POINTS: ReadonlyArray<
  readonly [
    string,
    (host: Machine, legacy: LegacyAssistant, next: Release) => (change: 'rename' | 'rm', at: string) => boolean,
  ]
> = [
  ['recording the stop', (host, legacy) => conversionAt(host.paths, legacy.id, 'stopped')],
  ...(['data', '.env', 'groups', 'store'] as const).map(
    (name) =>
      [
        `moving ${name}`,
        (host: Machine, legacy: LegacyAssistant) =>
          renamedTo(path.join(host.paths.instanceLayout(legacy.id).state, name)),
      ] as const,
  ),
  ['moving its logs', (host, legacy) => renamedTo(host.paths.instanceLayout(legacy.id).logs)],
  ['moving its secrets', (host, legacy) => renamedTo(path.join(host.paths.instanceRoot(legacy.id), 'secrets'))],
  ['moving its OneCLI project', (host, legacy) => renamedTo(path.join(host.paths.instanceRoot(legacy.id), 'onecli'))],
  ['moving its journal', (host, legacy) => renamedTo(host.paths.journalFile(legacy.id))],
  ['moving its bootstrap record', (host, legacy) => renamedTo(host.paths.bootstrapFile(legacy.id))],
  [
    'moving its receipt',
    (host, legacy) => renamedTo(host.paths.instanceLayout(legacy.id).receipt(releaseName(host.first))),
  ],
  ['recording the move', (host, legacy) => conversionAt(host.paths, legacy.id, 'moved')],
  ['rewriting its runtime record', (host, legacy) => renamedTo(host.paths.runtimeFile(legacy.id))],
  [
    'rewriting its registry entry',
    (host, legacy) => registryAt(host.paths, legacy.id, (entry) => entry.checkout_realpath === undefined),
  ],
  ['rewriting its service definition', (_host, legacy) => renamedTo(legacy.plist)],
  ['recording the rewrite', (host, legacy) => conversionAt(host.paths, legacy.id, 'rewritten')],
  [
    'writing its OneCLI Compose file',
    (host, legacy) => renamedTo(path.join(host.paths.instanceRoot(legacy.id), 'onecli', 'compose.yaml')),
  ],
  ['recording the update at snapshotted', (host, legacy) => recordedAt(host.paths, legacy.id, 'snapshotted')],
  ['recording the conversion done', (host, legacy) => conversionAt(host.paths, legacy.id, 'recreated')],
  ['recording the switch', (host, legacy) => recordedAt(host.paths, legacy.id, 'switched')],
  ['recording the release verified', (host, legacy) => recordedAt(host.paths, legacy.id, 'verified')],
  [
    'removing the conversion record',
    (host, legacy) => (change, at) =>
      change === 'rm' && at === path.join(host.paths.instanceRoot(legacy.id), 'conversion.json'),
  ],
  [
    'removing the old rollback point',
    (_host, legacy) => (change, at) => change === 'rm' && at === path.join(legacy.root, 'previous'),
  ],
  ['removing the old checkout', (_host, legacy) => (change, at) => change === 'rm' && at === legacy.checkout],
  ['removing the old root', (_host, legacy) => (change, at) => change === 'rm' && at === legacy.root],
  [
    'committing the release',
    (host, legacy, next) => registryAt(host.paths, legacy.id, (entry) => entry.deployed_commit === next.commit),
  ],
];

describe('the legacy-root locator', () => {
  const paths = resolveControlPlanePaths({ configRoot: '/machine/config/gws-ea', stateRoot: '/machine/state/gws-ea' });

  function reservation(legacyCheckout?: string): InstanceReservation {
    const instanceId = randomUUID();
    return {
      instance_id: instanceId,
      release_track: 'dogfood',
      source_remote: 'https://example.test/nanoclaw.git',
      deployed_commit: 'a'.repeat(40),
      allocated_ports: { nanoclaw_webhook: 36_001, onecli_app: 36_002, onecli_gateway: 36_003 },
      exclusive_resource_claims: {
        ingress: { mode: 'existing', endpoint_url: 'https://convert.example.test/webhook/gchat' },
        gcp_project_id: 'convert-project',
        gcp_account: 'operator@example.test',
        gchat_service_account: 'gws-ea-chat@convert-project.iam.gserviceaccount.com',
        workspace_email: 'convert@example.test',
        onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
      },
      ...(legacyCheckout === undefined ? {} : { checkout_realpath: legacyCheckout }),
    };
  }

  it('finds instances/<id> only for an entry that still records its checkout', () => {
    const unconverted = reservation('/machine/state/gws-ea/instances/old/nanoclaw');
    const converted = reservation();

    expect(legacyInstanceRoot(paths, unconverted)).toBe(
      path.join(paths.stateRoot, 'instances', unconverted.instance_id),
    );
    expect(legacyInstanceRoot(paths, converted)).toBeUndefined();
    expect(paths.instanceRoot(converted.instance_id)).toBe(
      path.join(paths.stateRoot, converted.instance_id.slice(0, 8)),
    );
  });

  it('refuses an unconverted assistant with the update that converts it, and passes a converted one', () => {
    const unconverted = reservation('/machine/state/gws-ea/instances/old/nanoclaw');
    const id = unconverted.instance_id;

    expect(() => assertConverted(paths, unconverted)).toThrow(
      expect.objectContaining({
        code: 'legacy_layout',
        message: `Assistant ${id} is on the legacy layout: run gws-ea update --id ${id} to convert it.`,
      }),
    );
    expect(() => assertConverted(paths, reservation())).not.toThrow();
  });
});

describe('converting an assistant on the layout before releases', GIT_HEAVY, () => {
  it("moves its state by renames alone to its short root, switches it to the tool's release, and removes what the old layout left", async () => {
    const host = await machine();
    const legacy = await legacyAssistant(host);
    const next = await nextRelease(host);
    const state = legacyWorld(host, legacy);
    const inodes = await stateInodes(legacy);
    const converting = conversion();
    const { run, out } = cli(host, state, next, legacy, converting);

    expect(await run(['update', '--id', legacy.id, '--yes'])).toBe(0);

    await expectConverted(host, legacy, next, state, inodes);
    // The release was staged while the old one served, and only then was the old host stopped.
    expect(state.events.slice(0, 3)).toEqual(['setup install', 'setup build', 'stop running']);
    const lines = out.join('\n');
    expect(lines).toContain(
      `Layout: its state moves by rename from ${legacy.root} to ${host.paths.instanceRoot(legacy.id)}, one way.`,
    );
    expect(lines).toContain('Rollback: none.');
    expect(lines).toContain('It has no previous release to roll back to.');
    // Its journal moved as it was, and reads as this launcher reads it.
    expect(JSON.parse(await readFile(host.paths.journalFile(legacy.id), 'utf8'))).toMatchObject({
      launcher_contract_version: 2,
    });
  });

  it('recreates its OneCLI project from the Compose file rendered for the short root, its volumes kept and the Cloudflare connector untouched', async () => {
    const host = await machine();
    const legacy = await legacyAssistant(host);
    const next = await nextRelease(host);
    const state = legacyWorld(host, legacy);
    const converting = conversion();

    expect(await cli(host, state, next, legacy, converting).run(['update', '--id', legacy.id, '--yes'])).toBe(0);

    const root = host.paths.instanceRoot(legacy.id);
    const compose = await readFile(path.join(root, 'onecli', 'compose.yaml'), 'utf8');
    expect(compose).toContain(path.join(root, 'onecli', 'secrets', 'postgres-password'));
    expect(compose).not.toContain(legacy.root);
    // Recreated whole from that file, then proven with the isolation probe; nothing removed a volume.
    const ups = state.commands.filter((command) => command.args[0] === 'compose' && command.args.includes('up'));
    expect(ups[0]!.args).toEqual(
      expect.arrayContaining(['--force-recreate', path.join(root, 'onecli', 'compose.yaml')]),
    );
    expect(ups[0]!.args).not.toEqual(expect.arrayContaining(['--renew-anon-volumes']));
    expect(converting.recreated).toEqual([compose]);
    const docker = state.commands.filter((command) => command.command === 'docker').map((command) => command.args);
    expect(docker.filter((args) => args[0] === 'volume' || (args[0] === 'compose' && args.includes('down')))).toEqual(
      [],
    );
    expect(docker.filter((args) => args.join(' ').includes('gws-ea-cloudflare'))).toEqual([]);
    // The probe through a relative link in the short root left nothing behind.
    expect(await exists(path.join(root, '.conversion-probe'))).toBe(false);
  });

  it.each(KILL_POINTS)('killed right after %s, update --id converges to the same end', async (_label, point) => {
    const host = await machine();
    const legacy = await legacyAssistant(host);
    const next = await nextRelease(host);
    const state = legacyWorld(host, legacy);
    const inodes = await stateInodes(legacy);
    const converting = conversion();

    await killConversion(host, legacy, state, next, converting, point(host, legacy, next));

    expect(await cli(host, state, next, legacy, converting).run(['update', '--id', legacy.id, '--yes'])).toBe(0);
    await expectConverted(host, legacy, next, state, inodes);
  });

  it('cannot start a host on half-moved state after a reboot once its first rename is made', async () => {
    const host = await machine();
    const legacy = await legacyAssistant(host);
    const next = await nextRelease(host);
    const state = legacyWorld(host, legacy);
    const inodes = await stateInodes(legacy);
    const converting = conversion();
    const inside = `${legacy.root}${path.sep}`;
    // Whichever move out of the old root comes first.
    await killConversion(
      host,
      legacy,
      state,
      next,
      converting,
      (change, at, from) => change === 'rename' && from?.startsWith(inside) === true && !at.startsWith(inside),
    );

    reboot(state, legacy.plist);

    // launchd loads the old definition, whose launcher finds no runtime record where it names one.
    expect(state.loaded).toBe(true);
    expect(state.running).toBe(false);
    expect(await readFile(legacy.plist, 'utf8')).toContain(
      path.join(legacy.checkout, 'data', 'gws-ea', 'runtime.json'),
    );
    expect(await cli(host, state, next, legacy, converting).run(['update', '--id', legacy.id, '--yes'])).toBe(0);
    await expectConverted(host, legacy, next, state, inodes);
  });

  it.each([
    ['during its stop', undefined],
    ['right after recording the stop', 'stopped'],
  ] as const)(
    'rebooted %s, before its first rename: the rerun stops, drains, and proves it quiet again before moving anything',
    async (_label, recorded) => {
      const host = await machine();
      const legacy = await legacyAssistant(host);
      const next = await nextRelease(host);
      const state = legacyWorld(host, legacy);
      const inodes = await stateInodes(legacy);
      const converting = conversion();
      if (recorded === undefined) state.hangAt = 'stop';
      await killConversion(
        host,
        legacy,
        state,
        next,
        converting,
        recorded === undefined ? undefined : conversionAt(host.paths, legacy.id, recorded),
      );
      expect(await exists(path.join(legacy.checkout, 'data'))).toBe(true);

      reboot(state, legacy.plist);
      expect(state.running).toBe(true);
      kill.trace.length = 0;

      expect(await cli(host, state, next, legacy, converting).run(['update', '--id', legacy.id, '--yes'])).toBe(0);

      const firstMove = kill.trace.indexOf(`rename ${path.join(host.paths.instanceLayout(legacy.id).state, 'data')}`);
      expect(firstMove).toBeGreaterThan(-1);
      expect(kill.trace.slice(0, firstMove)).toEqual(expect.arrayContaining(['stop', 'drain', 'ps']));
      expect(kill.trace.indexOf('stop')).toBeLessThan(kill.trace.indexOf('ps'));
      await expectConverted(host, legacy, next, state, inodes);
    },
  );

  it('refuses an update to another release while its conversion is cut short, naming the gws-ea that continues it', async () => {
    const host = await machine();
    const legacy = await legacyAssistant(host);
    const next = await nextRelease(host);
    const state = legacyWorld(host, legacy);
    const inodes = await stateInodes(legacy);
    const converting = conversion();
    await killConversion(host, legacy, state, next, converting, conversionAt(host.paths, legacy.id, 'moved'));
    const newer = await nextRelease(host);
    const { run, err } = cli(host, state, newer, legacy, converting);

    expect(await run(['update', '--id', legacy.id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain(
      `Continue it with gws-ea update --id ${legacy.id} from the gws-ea at ${next.commit.slice(0, 12)}`,
    );
    expect(await exists(host.paths.instanceLayout(legacy.id).release(releaseName(newer.commit)))).toBe(false);
    expect(await cli(host, state, next, legacy, converting).run(['update', '--id', legacy.id, '--yes'])).toBe(0);
    await expectConverted(host, legacy, next, state, inodes);
  });

  it('stops at a failed isolation probe of the recreated OneCLI project, and update --id completes the conversion', async () => {
    const host = await machine();
    const legacy = await legacyAssistant(host);
    const next = await nextRelease(host);
    const state = legacyWorld(host, legacy);
    const inodes = await stateInodes(legacy);
    const converting = { ...conversion(), probeFails: true };
    const { run, err } = cli(host, state, next, legacy, converting);

    expect(await run(['update', '--id', legacy.id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain(`continue it with gws-ea update --id ${legacy.id}`);
    const recorded = JSON.parse(
      await readFile(path.join(host.paths.instanceRoot(legacy.id), 'conversion.json'), 'utf8'),
    ) as { step: string };
    expect(recorded.step).toBe('rewritten');
    expect((await readOperationRecord(host.paths, legacy.id))?.phase).toBe('staged');
    converting.probeFails = false;

    expect(await run(['update', '--id', legacy.id, '--yes'])).toBe(0);

    await expectConverted(host, legacy, next, state, inodes);
    expect(converting.recreated).toHaveLength(2);
  });

  it('closes with no rollback target when the new release fails verification, and a newer release fixes it forward', async () => {
    const host = await machine();
    const legacy = await legacyAssistant(host);
    const next = await nextRelease(host);
    const state = legacyWorld(host, legacy);
    const inodes = await stateInodes(legacy);
    const converting = conversion();
    state.routeDown = true;
    const { run, err } = cli(host, state, next, legacy, converting);

    expect(await run(['update', '--id', legacy.id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain(
      `Fix it forward: update it to a newer release with gws-ea update --id ${legacy.id}`,
    );
    expect(await readOperationRecord(host.paths, legacy.id)).toMatchObject({
      closed: 'failed',
      no_rollback_target: true,
    });
    expect((await getInstanceReservation(host.paths, legacy.id)).checkout_realpath).toBeUndefined();
    const newer = await nextRelease(host, NEW_IMAGE);
    delete state.routeDown;

    expect(await cli(host, state, newer, legacy, converting).run(['update', '--id', legacy.id, '--yes'])).toBe(0);

    await expectConverted(host, legacy, newer, state, inodes);
  });

  it('removes the old checkout and root only once no state root is left in the checkout', async () => {
    const host = await machine();
    const legacy = await legacyAssistant(host);
    const next = await nextRelease(host);
    const state = legacyWorld(host, legacy);
    const converting = conversion();
    // Something writes state into the old checkout again once the new release runs.
    state.onStart = () => mkdirSync(path.join(legacy.checkout, 'data'), { recursive: true });
    const { run, err } = cli(host, state, next, legacy, converting);

    expect(await run(['update', '--id', legacy.id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain(`${legacy.checkout} still holds data`);
    expect(releaseOf(await getInstanceReservation(host.paths, legacy.id))).toEqual(release(host, next.commit));
    expect(await exists(path.join(legacy.root, 'previous'))).toBe(false);
    expect(await exists(path.join(legacy.checkout, 'dist'))).toBe(true);
    expect(state.tags.has(`${imageBase(legacy.runtime)}:latest`)).toBe(true);
    delete state.onStart;
    await rm(path.join(legacy.checkout, 'data'), { recursive: true });
    const newer = await nextRelease(host);

    expect(await cli(host, state, newer, legacy, converting).run(['update', '--id', legacy.id, '--yes'])).toBe(0);

    expect(await exists(legacy.root)).toBe(false);
    expect(state.tags.has(`${imageBase(legacy.runtime)}:latest`)).toBe(false);
    expect(state.tags.has(OTHER_ASSISTANT_IMAGE)).toBe(true);
  });
});

describe('a conversion refused before anything moves', GIT_HEAVY, () => {
  it('refuses an update or rollback an earlier gws-ea left open, staging nothing', async () => {
    const host = await machine();
    const legacy = await legacyAssistant(host);
    await writePrivate(path.join(legacy.root, 'operation.json'), '{"schema_version":1}\n');
    const next = await nextRelease(host);
    const state = legacyWorld(host, legacy);
    const before = await snapshot(legacy.root);
    const { run, err } = cli(host, state, next, legacy, conversion());

    expect(await run(['update', '--id', legacy.id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain('Finish it with that gws-ea');
    await expectNothingMoved(host, legacy, state, before);
    expect(await readdir(host.paths.instanceRoot(legacy.id))).toEqual([]);
  });

  it('refuses an assistant set up under step contract 1 until it is connected to Google, then rewrites its journal while it serves', async () => {
    const host = await machine();
    const legacy = await legacyAssistant(host, 1);
    const next = await nextRelease(host);
    const state = legacyWorld(host, legacy);
    const converting = conversion();
    const journal = path.join(legacy.root, 'provision.json');
    const before = await snapshot(legacy.root);
    const { run, err } = cli(host, state, next, legacy, converting);

    expect(await run(['update', '--id', legacy.id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain('is not connected yet: the assistant has not signed in to Google yet');
    await expectNothingMoved(host, legacy, state, before);
    expect(JSON.parse(await readFile(journal, 'utf8'))).toMatchObject({ launcher_contract_version: 1 });

    await writePrivate(
      path.join(legacy.root, 'secrets', GOOGLE_GRANT_FILE_NAME),
      JSON.stringify({
        schema_version: 1,
        account: `l${legacy.runtime.allocated_ports.nanoclaw_webhook}@example.test`,
        client_id: '123-abc.apps.googleusercontent.com',
        client_secret: 'GOCSPX-desktop-secret',
        refresh_token: '1//refresh-token',
        scopes: GOOGLE_SIGN_IN_SCOPES.map((scope) =>
          scope === 'email' ? 'https://www.googleapis.com/auth/userinfo.email' : scope,
        ),
        granted_at: '2026-09-30T12:00:00.000Z',
      }),
    );
    converting.secrets = EXPOSED_GOOGLE_SERVICES.map((service) => ({
      id: `sec-${service}`,
      name: AGENT_GOOGLE_SERVICES[service].secretName,
      hostPattern: AGENT_GOOGLE_SERVICES[service].hostPattern,
    }));

    const staged = await stage(host, legacy, conversionDependencies(state, next, legacy, converting));

    expect(staged.preview.conversion).toEqual({ from: legacy.root, to: host.paths.instanceRoot(legacy.id) });
    const rewritten = JSON.parse(await readFile(journal, 'utf8')) as {
      launcher_contract_version: number;
      steps: Record<string, { completed_at?: string }>;
    };
    expect(rewritten.launcher_contract_version).toBe(2);
    expect(rewritten.steps.connect_google?.completed_at).toBeDefined();
    // It served throughout: nothing stopped it, and its state is where it was.
    expect(state.running).toBe(true);
    expect(state.events).not.toContain('stop running');
    expect(await exists(path.join(legacy.checkout, 'data', 'v2.db'))).toBe(true);

    expect(await run(['update', '--id', legacy.id, '--yes'])).toBe(0);
    expect((await getInstanceReservation(host.paths, legacy.id)).checkout_realpath).toBeUndefined();
  });

  it("refuses when this gws-ea's OneCLI administration cannot reach the running gateway, the old release serving", async () => {
    const host = await machine();
    const legacy = await legacyAssistant(host);
    const next = await nextRelease(host);
    const state = legacyWorld(host, legacy);
    const before = await snapshot(legacy.root);
    const { run, err } = cli(host, state, next, legacy, { ...conversion(), reachable: false });

    expect(await run(['update', '--id', legacy.id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain('administers OneCLI over its REST API');
    await expectNothingMoved(host, legacy, state, before);
  });

  it('refuses a short root that already holds something, staging nothing', async () => {
    const host = await machine();
    const legacy = await legacyAssistant(host);
    await writePrivate(path.join(host.paths.instanceRoot(legacy.id), 'state', 'data', 'v2.db'), 'someone else\n');
    const next = await nextRelease(host);
    const state = legacyWorld(host, legacy);
    const before = await snapshot(legacy.root);
    const { run, err } = cli(host, state, next, legacy, conversion());

    expect(await run(['update', '--id', legacy.id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain('which already holds state');
    await expectNothingMoved(host, legacy, state, before);
    expect(await exists(host.paths.instanceLayout(legacy.id).release(releaseName(next.commit)))).toBe(false);
  });

  it('refuses a tool whose release does not move it forward', async () => {
    const host = await machine();
    const legacy = await legacyAssistant(host);
    const state = legacyWorld(host, legacy);
    const before = await snapshot(legacy.root);
    // The machine's working clone is at the release the assistant runs.
    const { run, err } = cli(host, state, { commit: host.first, tool: host.work }, legacy, conversion());

    expect(await run(['update', '--id', legacy.id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain('does not move forward from');
    await expectNothingMoved(host, legacy, state, before);
  });

  it('refuses an assistant no launchd job runs, staging nothing', async () => {
    const host = await machine();
    const legacy = await legacyAssistant(host);
    const next = await nextRelease(host);
    const state = legacyWorld(host, legacy);
    const before = await snapshot(legacy.root);
    const deps = conversionDependencies(state, next, legacy, conversion());

    await expect(stage(host, legacy, { ...deps, service: { ...SERVICE, platform: 'linux' } })).rejects.toMatchObject({
      code: 'conversion_unsupported',
    });
    await expectNothingMoved(host, legacy, state, before);
    expect(await readdir(host.paths.instanceRoot(legacy.id))).toEqual([]);
  });

  it('serves the old release again when something still holds its state open at the stop, moving nothing', async () => {
    const host = await machine();
    const legacy = await legacyAssistant(host);
    const next = await nextRelease(host);
    const state = legacyWorld(host, legacy);
    const inodes = await stateInodes(legacy);
    const before = await snapshot(legacy.root);
    state.openFiles = `p4242\ncsqlite3\nn${path.join(legacy.checkout, 'data', 'v2.db')}\n`;
    const converting = conversion();
    const { run, err } = cli(host, state, next, legacy, converting);

    expect(await run(['update', '--id', legacy.id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain('Nothing was moved, and its old release serves again');
    expect(state.events).toContain('start');
    await expectNothingMoved(host, legacy, state, before);
    state.openFiles = '';

    expect(await run(['update', '--id', legacy.id, '--yes'])).toBe(0);
    await expectConverted(host, legacy, next, state, inodes);
  });

  it("serves the old release again when NanoClaw's drain fails after the stop, saying why, moving nothing", async () => {
    const host = await machine();
    const legacy = await legacyAssistant(host);
    const next = await nextRelease(host);
    const state = legacyWorld(host, legacy);
    const inodes = await stateInodes(legacy);
    const before = await snapshot(legacy.root);
    const converting: Conversion = { ...conversion(), drain: 'times-out' };
    const { run, err } = cli(host, state, next, legacy, converting);

    expect(await run(['update', '--id', legacy.id, '--yes'])).toBe(1);

    expect(err.join('\n')).toContain(
      `NanoClaw did not stop the assistant's agent containers: ${DRAIN_TIMED_OUT}. Nothing was moved, and its old release serves again.`,
    );
    expect(state.events).toContain('start');
    await expectNothingMoved(host, legacy, state, before);
    delete converting.drain;

    expect(await run(['update', '--id', legacy.id, '--yes'])).toBe(0);
    await expectConverted(host, legacy, next, state, inodes);
  });

  it.each([
    ['past its stop, before recording it', 'drain'],
    ['right after recording the stop', 'record'],
  ] as const)(
    'killed %s, then refused on the rerun before its first rename: the old release serves again, nothing moved',
    async (_label, point) => {
      const host = await machine();
      const legacy = await legacyAssistant(host);
      const next = await nextRelease(host);
      const state = legacyWorld(host, legacy);
      const inodes = await stateInodes(legacy);
      const before = await snapshot(legacy.root);
      const converting: Conversion = { ...conversion(), ...(point === 'drain' ? { drain: 'killed' as const } : {}) };
      await killConversion(
        host,
        legacy,
        state,
        next,
        converting,
        point === 'record' ? conversionAt(host.paths, legacy.id, 'stopped') : undefined,
      );
      // The run that stopped the old host is gone, and nothing has started it since.
      expect(state.running).toBe(false);
      delete converting.drain;
      state.openFiles = `p4242\ncsqlite3\nn${path.join(legacy.checkout, 'data', 'v2.db')}\n`;
      const { run, err } = cli(host, state, next, legacy, converting);

      expect(await run(['update', '--id', legacy.id, '--yes'])).toBe(1);

      expect(err.join('\n')).toContain('Nothing was moved, and its old release serves again');
      await expectNothingMoved(host, legacy, state, before);
      state.openFiles = '';

      expect(await run(['update', '--id', legacy.id, '--yes'])).toBe(0);
      await expectConverted(host, legacy, next, state, inodes);
    },
  );
});

describe('the conversion preview', () => {
  it('names the move and that nothing is kept to roll back to, in place of the snapshot warning', () => {
    const from = release({ remote: 'https://example.test/nanoclaw.git' } as Machine, 'a'.repeat(40));
    const preview: UpdatePreview = {
      instanceId: '11111111-1111-4111-8111-111111111111',
      from,
      to: { ...from, deployed_commit: 'b'.repeat(40) },
      migrations: ['module:gws-ea-profile:add-notes'],
      gateway: { current: DEPLOYED_GATEWAY, release: DEPLOYED_GATEWAY },
      groupImages: [],
      agentRunnerLockChanged: false,
      sessionSchemaChanged: false,
      conversion: { from: '/machine/state/instances/1111', to: '/machine/state/11111111' },
    };

    const lines = updatePreviewLines(preview);

    expect(lines).toContain(
      'Layout: its state moves by rename from /machine/state/instances/1111 to /machine/state/11111111, one way.',
    );
    expect(lines.join('\n')).toContain('Rollback: none.');
    expect(lines.join('\n')).not.toContain('pre-update snapshot');
  });
});

/**
 * A reboot or login: launchd loads the job from the definition installed now
 * and runs its program, which starts a host only when its launcher exists and
 * the runtime record the definition names it is there: the old launcher loads
 * that record before anything else, and the new one runs only through the
 * live link.
 */
function reboot(state: World, plist: string): void {
  const definition = readFileSync(plist, 'utf8');
  const strings = [...definition.matchAll(/<string>([^<]*)<\/string>/gu)].map((match) => match[1]!);
  const at = strings.indexOf('launch-host');
  state.loaded = true;
  state.loadedDefinition = definition;
  state.running = existsSync(strings[at - 1]!) && existsSync(strings[at + 1]!);
}

/** The old layout exactly as it was, still registered as such and running, with no update recorded. */
async function expectNothingMoved(
  host: Machine,
  legacy: LegacyAssistant,
  state: World,
  before: ReadonlyMap<string, string>,
): Promise<void> {
  expect(await snapshot(legacy.root)).toEqual(before);
  expect((await getInstanceReservation(host.paths, legacy.id)).checkout_realpath).toBe(legacy.checkout);
  expect(await readOperationRecord(host.paths, legacy.id)).toBeUndefined();
  expect(await exists(path.join(host.paths.instanceRoot(legacy.id), 'conversion.json'))).toBe(false);
  expect(state.running).toBe(true);
}
