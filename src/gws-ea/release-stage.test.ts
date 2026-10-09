/**
 * Staging a release and applying its kept files. Staging writes nothing into
 * the assistant's state, not even creating it, keeps a complete release as it
 * is, and stages one left incomplete again; a hook sees the release before it
 * has links. Applying a release's kept files writes only gws-ea's `.env` keys,
 * reports whether the service definition changed, and brings the gateway to
 * the kept Compose file, probing it when Compose recreated it, before the
 * service definition changes.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { keepRelease } from './kept-release.js';
import { createOnecliRuntimeLayout, renderOnecliCompose, type OnecliRuntimeLayout } from './onecli-compose.js';
import { resolveWrapperGatewayImage, wrapperImageTag } from './onecli-gateway-image.js';
import { CONTROL_PLANE_ROOT, resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { ONECLI_GATEWAY_VERSION, ONECLI_SDK_VERSION } from './pins.js';
import type { SanitizedCommand } from './process.js';
import { reserveInstance } from './journal.js';
import { createState, releaseName } from './release-layout.js';
import { applyReleaseFiles, stageRelease, type ReleaseStageRequest } from './release-stage.js';
import {
  createInstanceRuntimeConfig,
  instanceHostConfiguration,
  instanceServiceDefinitionFile,
  renderInstanceServiceDefinition,
  type InstanceRuntimeConfig,
  type UpsertEnvVars,
} from './service.js';
import { releaseRepository, stagingWorld } from './testing/release-fixture.js';
import { GwsEaError, type InstanceReservation } from './types.js';

/** Upstream's `.env` writer, which the driver injects; loaded by path because `src/` cannot import `setup/`. */
const { upsertEnvVars } = (await import(path.join(CONTROL_PLANE_ROOT, 'setup', 'set-env.ts'))) as {
  readonly upsertEnvVars: UpsertEnvVars;
};

const DOCKER = 'unix:///var/run/docker.sock';
const PINS = { gateway: ONECLI_GATEWAY_VERSION };

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

interface Assistant {
  readonly paths: ControlPlanePaths;
  readonly reservation: InstanceReservation;
  readonly runtime: InstanceRuntimeConfig;
  readonly onecli: OnecliRuntimeLayout;
  readonly home: string;
}

/** A reserved assistant whose release is the commit `commit` of the repository at `remote`. */
async function assistant(root: string, remote = 'https://example.test/nanoclaw.git', commit = 'a'.repeat(40)) {
  const paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'config'),
    stateRoot: path.join(root, 'state'),
  });
  const reservation = await reserveInstance(paths, {
    instance_id: '22222222-2222-4222-8222-222222222222',
    release_track: 'rebuild-v2',
    source_remote: remote,
    deployed_commit: commit,
    allocated_ports: { nanoclaw_webhook: 34_001, onecli_app: 34_002, onecli_gateway: 34_003 },
    exclusive_resource_claims: {
      ingress: { mode: 'existing', endpoint_url: 'https://assistant.example.test/webhook/gchat' },
      gcp_project_id: 'assistant-project',
      gcp_account: 'operator@example.test',
      gchat_service_account: 'gws-ea-chat@assistant-project.iam.gserviceaccount.com',
      workspace_email: 'juno@example.test',
      onecli_project: 'gws-ea-22222222',
    },
  });
  const onecli = createOnecliRuntimeLayout({
    instanceId: reservation.instance_id,
    instanceRoot: paths.instanceRoot(reservation.instance_id),
    project: reservation.exclusive_resource_claims.onecli_project,
    appPort: reservation.allocated_ports.onecli_app,
    gatewayPort: reservation.allocated_ports.onecli_gateway,
    dockerEndpoint: DOCKER,
  });
  const home = path.join(root, 'home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const runtime = createInstanceRuntimeConfig(paths, reservation, onecli, {
    nodePath: process.execPath,
    homeDirectory: home,
    selectedProvider: 'claude',
    dockerEndpoint: DOCKER,
  });
  return { paths, reservation, runtime, onecli, home } satisfies Assistant;
}

const CREDENTIAL = {
  name: 'Claude provider',
  type: 'api_key',
  hostPattern: 'api.anthropic.com',
  headerName: 'x-api-key',
};

function stageRequest(target: Assistant, overrides: Partial<ReleaseStageRequest> = {}): ReleaseStageRequest {
  return {
    paths: target.paths,
    view: target.reservation,
    runtime: target.runtime,
    state: target.paths.instanceLayout(target.reservation.instance_id).state,
    onecli: target.onecli,
    service: { platform: 'macos', homeDirectory: target.home, runningAsRoot: false },
    provider: { provider: 'claude', providerCredential: CREDENTIAL },
    ...overrides,
  };
}

/** Every path under `root`, relative to it, with what each is. */
async function tree(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .map((entry) => {
      const relative = path.relative(root, path.join(entry.parentPath, entry.name));
      return `${relative}${entry.isDirectory() ? '/' : entry.isSymbolicLink() ? ' ->' : ''}`;
    })
    .sort();
}

describe('staging a release', () => {
  it('writes nothing into the assistant’s state, not even creating it, and keeps a complete release as it is', async () => {
    const root = await temporaryRoot('gws-ea-stage-');
    const repository = await releaseRepository(root);
    const target = await assistant(root, repository.remote, repository.commit);
    const layout = target.paths.instanceLayout(target.reservation.instance_id);
    const release = releaseName(repository.commit);
    const { world, seams } = stagingWorld();

    await stageRelease(stageRequest(target), seams);

    await expect(lstat(layout.state)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(layout.current)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await tree(layout.kept(release))).toEqual([
      'host-environment.json',
      'onecli-compose.yaml',
      'release-preflight.json',
      'service-definition',
    ]);
    const kept = await tree(layout.kept(release));
    const ran = { git: world.git.length, faked: world.faked.length, setup: world.setup.length };

    await stageRelease(stageRequest(target), seams);

    expect({ git: world.git.length, faked: world.faked.length, setup: world.setup.length }).toEqual(ran);
    expect(await tree(layout.kept(release))).toEqual(kept);
  });

  it('runs its hook on the release before the release has links, and links it after', async () => {
    const root = await temporaryRoot('gws-ea-stage-');
    const repository = await releaseRepository(root);
    const target = await assistant(root, repository.remote, repository.commit);
    const layout = target.paths.instanceLayout(target.reservation.instance_id);
    await createState(layout);
    await writeFile(path.join(layout.state, '.env'), 'INSTALL_CJK_FONTS=true\n');
    const before = await tree(layout.state);
    const seen: string[] = [];

    await stageRelease(
      stageRequest(target, {
        beforeLink: async (release) => {
          // A dry run's scratch `data/` is the release's own while it has no links, and goes with it.
          seen.push(...(await readdir(release)).filter((entry) => ['.env', 'data', 'logs'].includes(entry)));
          await mkdir(path.join(release, 'data'));
          await writeFile(path.join(release, 'data', 'v2.db'), 'scratch');
          await rm(path.join(release, 'data'), { recursive: true });
        },
      }),
      stagingWorld().seams,
    );

    expect(seen).toEqual([]);
    expect((await lstat(path.join(layout.release(releaseName(repository.commit)), 'data'))).isSymbolicLink()).toBe(
      true,
    );
    expect(await tree(layout.state)).toEqual(before);
    expect(await readFile(path.join(layout.state, '.env'), 'utf8')).toBe('INSTALL_CJK_FONTS=true\n');
  });

  it("builds the release's image with the flags of the state the assistant serves from", async () => {
    const root = await temporaryRoot('gws-ea-stage-');
    const repository = await releaseRepository(root);
    const target = await assistant(root, repository.remote, repository.commit);
    // The one-time conversion stages before the state moves: the flags are still in the old checkout.
    const serving = path.join(root, 'old-checkout');
    await mkdir(serving, { recursive: true });
    await writeFile(path.join(serving, '.env'), 'INSTALL_CJK_FONTS=true\n');
    const { world, seams } = stagingWorld();

    await stageRelease(stageRequest(target, { state: serving }), seams);

    const build = world.faked.find((command) => command.args.some((arg) => arg.endsWith('container/build.sh')));
    expect(build?.env?.INSTALL_CJK_FONTS).toBe('true');
  });

  it('stages again a release whose receipt was never written, its kept files and checkout with it', async () => {
    const root = await temporaryRoot('gws-ea-stage-');
    const repository = await releaseRepository(root);
    const target = await assistant(root, repository.remote, repository.commit);
    const layout = target.paths.instanceLayout(target.reservation.instance_id);
    const release = releaseName(repository.commit);
    const { world, seams } = stagingWorld();
    await stageRelease(stageRequest(target), seams);
    // A run killed while keeping the release's files: everything but the receipt is there.
    await rm(layout.receipt(release));
    await writeFile(path.join(layout.release(release), 'left-by-the-killed-run'), '');

    await stageRelease(stageRequest(target), seams);

    expect(world.git.filter((subcommand) => subcommand === 'init')).toHaveLength(2);
    await expect(lstat(path.join(layout.release(release), 'left-by-the-killed-run'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(JSON.parse(await readFile(layout.receipt(release), 'utf8'))).toMatchObject({
      instance_id: target.reservation.instance_id,
      deployed_commit: repository.commit,
    });
  });
});

/**
 * The instance's OneCLI project as Docker reports it: Compose recreates the
 * gateway, with a new container ID, only when the Compose file it comes up
 * from differs from the one it last came up from, and the isolation probe can
 * be made to fail.
 */
function onecliWorld(onecli: OnecliRuntimeLayout, running: string) {
  const world = { running, calls: [] as SanitizedCommand[], probes: 0, failProbe: undefined as Error | undefined };
  const gatewayId = (): string => createHash('sha256').update(world.running).digest('hex').slice(0, 12);
  const runner = async (command: SanitizedCommand) => {
    world.calls.push(command);
    const joined = command.args.join(' ');
    if (joined.startsWith('image ls --quiet ')) return { stdout: 'sha256:present\n', stderr: '' };
    if (joined.startsWith('container ls --all')) {
      return { stdout: `postgres-1\napp-1\n${gatewayId()}\n`, stderr: '' };
    }
    if (command.args[0] === 'compose' && command.args.includes('up')) {
      world.running = await readFile(onecli.composeFile, 'utf8');
      return { stdout: '', stderr: '' };
    }
    if (command.args[0] === 'run') {
      world.probes += 1;
      if (world.failProbe) throw world.failProbe;
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected docker ${joined}`);
  };
  return { world, runner };
}

/**
 * An assistant with a release kept as staging keeps it, running the OneCLI
 * Compose file an earlier release rendered, which names the gateway it built.
 */
async function keptAssistant() {
  const root = await temporaryRoot('gws-ea-apply-');
  const target = await assistant(root);
  const layout = target.paths.instanceLayout(target.reservation.instance_id);
  const service = { platform: 'macos' as const, homeDirectory: target.home, runningAsRoot: false };
  const { image } = await resolveWrapperGatewayImage(PINS);
  const kept = {
    compose: renderOnecliCompose(target.onecli, PINS, image),
    serviceDefinition: renderInstanceServiceDefinition(target.runtime, service),
    hostEnvironment: instanceHostConfiguration(target.runtime),
  };
  await keepRelease(layout.kept(releaseName(target.reservation.deployed_commit)), kept, {
    instanceId: target.reservation.instance_id,
    commit: target.reservation.deployed_commit,
    preflight: {
      provider: 'claude',
      providerCredential: CREDENTIAL,
      packageManager: 'pnpm@10.0.0',
      onecli: { gateway: ONECLI_GATEWAY_VERSION, sdk: ONECLI_SDK_VERSION },
    },
  });
  await createState(layout);
  await mkdir(target.onecli.rootDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    target.onecli.composeFile,
    renderOnecliCompose(target.onecli, PINS, wrapperImageTag('0'.repeat(16))),
    { mode: 0o600 },
  );
  const docker = onecliWorld(target.onecli, await readFile(target.onecli.composeFile, 'utf8'));
  const apply = () =>
    applyReleaseFiles(
      { runtime: target.runtime, onecli: target.onecli, commit: target.reservation.deployed_commit },
      { upsertEnvVars, ...service },
      { dockerCommandRunner: docker.runner },
    );
  return {
    target,
    layout,
    kept,
    docker: docker.world,
    apply,
    definition: instanceServiceDefinitionFile(target.runtime, service),
  };
}

describe("applying a release's kept files", () => {
  it("writes only gws-ea's keys into the state's .env, keeping another writer's", async () => {
    const subject = await keptAssistant();
    const environment = path.join(subject.layout.state, '.env');
    await writeFile(environment, 'INSTALL_CJK_FONTS=true\nWEBHOOK_PORT=1\n');

    await subject.apply();

    const written = await readFile(environment, 'utf8');
    expect(written).toContain('INSTALL_CJK_FONTS=true\n');
    expect(written).not.toContain('WEBHOOK_PORT=1\n');
    for (const [key, value] of Object.entries(subject.kept.hostEnvironment)) {
      expect(written).toContain(`${key}=${value}\n`);
    }
  });

  it('reports a service definition it installed as changed, and one already in place as not', async () => {
    const subject = await keptAssistant();
    await mkdir(path.dirname(subject.definition), { recursive: true });
    await writeFile(subject.definition, 'the definition an earlier release rendered\n', { mode: 0o600 });

    await expect(subject.apply()).resolves.toEqual({ definitionChanged: true });
    expect(await readFile(subject.definition, 'utf8')).toBe(subject.kept.serviceDefinition);
    expect((await stat(subject.definition)).mode & 0o777).toBe(0o600);
    await expect(subject.apply()).resolves.toEqual({ definitionChanged: false });
  });

  it('puts back a differing Compose file and probes the gateway Compose recreated, and recreates nothing when they match', async () => {
    const subject = await keptAssistant();

    await subject.apply();

    expect(await readFile(subject.target.onecli.composeFile, 'utf8')).toBe(subject.kept.compose);
    expect(subject.docker.running).toBe(subject.kept.compose);
    expect(subject.docker.probes).toBe(1);

    // Run again, as a switch resumed after its apply does: Compose recreates nothing, so nothing new is probed.
    await subject.apply();
    expect(subject.docker.probes).toBe(1);
  });

  it('brings the gateway up when the kept Compose file was written but the run was cut short before it came up', async () => {
    const subject = await keptAssistant();
    await writeFile(subject.target.onecli.composeFile, subject.kept.compose, { mode: 0o600 });

    await subject.apply();

    expect(subject.docker.running).toBe(subject.kept.compose);
    expect(subject.docker.probes).toBe(1);
  });

  it('refuses the release when its recreated gateway fails the probe, before its service definition changes', async () => {
    const subject = await keptAssistant();
    subject.docker.failProbe = new GwsEaError('command_failed', 'link-local/metadata reachable through gateway');

    await expect(subject.apply()).rejects.toBe(subject.docker.failProbe);
    await expect(lstat(subject.definition)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
