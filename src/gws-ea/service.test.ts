import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOnecliRuntimeLayout } from './onecli-compose.js';
import { CONTROL_PLANE_ROOT, resolveControlPlanePaths } from './paths.js';
import type { SanitizedCommand } from './process.js';
import { GwsEaError } from './types.js';

import {
  buildInstanceCliCommand,
  createInstanceRuntimeConfig,
  googleChatProjectNumberFile,
  instanceServicePid,
  launchInstanceHost,
  loadInstanceRuntimeConfig,
  instanceServiceDefinitionFile,
  persistInstanceRuntime,
  reconcileInstanceRuntime,
  reconcileInstanceService,
  instanceOnecliAdmin,
  reloadInstanceService,
  renderInstanceServiceDefinition,
  restoreInstanceServiceDefinition,
  type InstanceRuntimeConfig,
  type InstanceServiceLayout,
  type UpsertEnvVars,
} from './service.js';
import { writeOwnerOnlyFileExclusive } from './secrets.js';
import type { InstanceReservation } from './types.js';

/** Upstream's `.env` writer, which the driver injects; loaded by path because `src/` cannot import `setup/`. */
const { upsertEnvVars } = (await import(path.join(CONTROL_PLANE_ROOT, 'setup', 'set-env.ts'))) as {
  readonly upsertEnvVars: UpsertEnvVars;
};

const roots: string[] = [];
/** The Docker endpoint create recorded; deliberately not the default socket. */
const DOCKER_ENDPOINT = 'unix:///Users/operator/.colima/default/docker.sock';
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** The commit of the release the fixture's assistant runs, and its folder's name. */
const COMMIT = 'a'.repeat(40);
const RELEASE = 'aaaaaaaa';

/** A release folder holding what the service and the launcher run. */
async function releaseFolder(release: string): Promise<void> {
  await mkdir(path.join(release, 'dist', 'gws-ea'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(release, 'bin'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(release, 'dist', 'index.js'), 'host');
  await writeFile(path.join(release, 'dist', 'gws-ea', 'process.js'), 'launcher');
  await writeFile(path.join(release, 'bin', 'ncl'), '#!/bin/sh\n', { mode: 0o700 });
  await writeFile(path.join(release, 'package.json'), '{"version":"2.3.0"}\n');
}

/** An assistant whose live link names its one release, `aaaaaaaa`. */
async function fixture(): Promise<{ config: InstanceRuntimeConfig; home: string; release: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-service-'));
  roots.push(root);
  const paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'config'),
    stateRoot: path.join(root, 'state'),
  });
  const instanceId = randomUUID();
  const release = paths.instanceLayout(instanceId).release(RELEASE);
  await releaseFolder(release);
  await symlink(RELEASE, paths.checkoutRoot(instanceId));
  const reservation: InstanceReservation = {
    instance_id: instanceId,
    release_track: 'dogfood',
    source_remote: 'https://example.test/nanoclaw.git',
    deployed_commit: COMMIT,
    allocated_ports: { nanoclaw_webhook: 31_001, onecli_app: 31_002, onecli_gateway: 31_003 },
    exclusive_resource_claims: {
      ingress: { mode: 'existing', endpoint_url: 'https://assistant.example.test/webhook/gchat' },
      gcp_project_id: 'assistant-project',
      gcp_account: 'operator@example.test',
      gchat_service_account: 'gws-ea-chat@assistant-project.iam.gserviceaccount.com',
      workspace_email: 'assistant@example.test',
      onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
    },
  };
  const onecli = createOnecliRuntimeLayout({
    instanceId,
    instanceRoot: paths.instanceRoot(instanceId),
    project: reservation.exclusive_resource_claims.onecli_project,
    appPort: reservation.allocated_ports.onecli_app,
    gatewayPort: reservation.allocated_ports.onecli_gateway,
    dockerEndpoint: DOCKER_ENDPOINT,
  });
  const home = path.join(root, 'home');
  await mkdir(home, { mode: 0o700 });
  return {
    config: createInstanceRuntimeConfig(paths, reservation, onecli, {
      nodePath: process.execPath,
      homeDirectory: home,
      selectedProvider: 'claude',
      dockerEndpoint: DOCKER_ENDPOINT,
    }),
    home,
    release: await realpath(release),
  };
}

describe('GWS-EA instance runtime', () => {
  it("persists only independent values and the Docker endpoint, in the assistant's physical state, and derives every instance target", async () => {
    const { config, release } = await fixture();
    await persistInstanceRuntime(config, upsertEnvVars);
    const environmentPath = path.join(config.instance_root, 'state', '.env');
    const environmentFile = await readFile(environmentPath, 'utf8');
    const runtimeFile = path.join(config.instance_root, 'state', 'data', 'gws-ea', 'runtime.json');
    const manifest = await readFile(runtimeFile, 'utf8');

    expect(config.install_id).toBe(config.instance_id.replaceAll('-', ''));
    expect(path.basename(config.instance_root)).toBe(config.instance_id.slice(0, 8));
    expect(config.checkout_root).toBe(path.join(config.instance_root, 'nanoclaw'));
    expect(config.state_root).toBe(path.join(config.instance_root, 'state'));
    const secretsDirectory = path.join(config.instance_root, 'secrets');
    expect(config.secret_files).toEqual({
      gchat_credentials: path.join(secretsDirectory, 'gchat-service-account.json'),
      onecli_runtime_api_key: path.join(secretsDirectory, 'onecli-runtime-api-key'),
      onecli_admin_api_key: path.join(secretsDirectory, 'onecli-admin-api-key'),
    });
    // Nothing is written through the live link into the release.
    for (const entry of ['.env', 'data', 'logs']) {
      await expect(lstat(path.join(release, entry))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect((await lstat(path.join(config.instance_root, 'logs'))).isDirectory()).toBe(true);
    expect(environmentFile).toContain(`WEBHOOK_PORT=${config.allocated_ports.nanoclaw_webhook}`);
    expect(environmentFile).toContain('WEBHOOK_HOST=127.0.0.1');
    expect(environmentFile).toContain(`NANOCLAW_EGRESS_NETWORK=${config.agent_egress_network}`);
    expect(Object.keys(JSON.parse(manifest) as object).sort()).toEqual([
      'allocated_ports',
      'docker_endpoint',
      'endpoint_url',
      'home_directory',
      'instance_id',
      'instance_root',
      'node_path',
      'onecli_project',
      'schema_version',
      'selected_provider',
    ]);
    expect(JSON.parse(manifest)).toMatchObject({
      schema_version: 2,
      docker_endpoint: DOCKER_ENDPOINT,
      instance_root: config.instance_root,
    });
    // With no release live, the record still reads.
    await rm(config.checkout_root);
    await expect(loadInstanceRuntimeConfig(runtimeFile)).resolves.toEqual(config);
    expect((await stat(environmentPath)).mode & 0o777).toBe(0o600);
  });

  it('loads a runtime file with unknown fields, recomputes derived values, and leaves the file as written', async () => {
    const { config } = await fixture();
    await persistInstanceRuntime(config, upsertEnvVars);
    const file = path.join(config.state_root, 'data', 'gws-ea', 'runtime.json');
    const written = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const extended = `${JSON.stringify({ ...written, added_by_a_newer_launcher: { any: 'shape' }, install_id: 'stale' }, null, 2)}\n`;
    await writeFile(file, extended, { mode: 0o600 });

    const loaded = await loadInstanceRuntimeConfig(file);
    expect(loaded.install_id).toBe(config.instance_id.replaceAll('-', ''));
    expect(loaded.onecli_gateway_container).toBe(config.onecli_gateway_container);
    await persistInstanceRuntime(loaded, upsertEnvVars);
    expect(await readFile(file, 'utf8')).toBe(extended);
    // A copy anywhere but the assistant's own state is not its record.
    const copy = path.join(config.checkout_root, 'data', 'gws-ea', 'runtime.json');
    await mkdir(path.dirname(copy), { recursive: true, mode: 0o700 });
    await writeFile(copy, extended, { mode: 0o600 });
    await expect(loadInstanceRuntimeConfig(copy)).rejects.toMatchObject({ code: 'runtime_mismatch' });
  });

  it('refuses a runtime file whose persisted values disagree', async () => {
    const { config } = await fixture();
    await persistInstanceRuntime(config, upsertEnvVars);

    await expect(
      persistInstanceRuntime({ ...config, docker_endpoint: 'unix:///run/other/docker.sock' }, upsertEnvVars),
    ).rejects.toMatchObject({ code: 'runtime_conflict' });
  });

  it('adds only the gws-ea .env keys that are missing when resume persists the runtime again', async () => {
    const { config } = await fixture();
    await persistInstanceRuntime(config, upsertEnvVars);
    const environmentFile = path.join(config.state_root, '.env');
    // An earlier release quoted its value; the egress network key was lost; a skill added its own.
    const earlier = (await readFile(environmentFile, 'utf8'))
      .replace('WEBHOOK_HOST=127.0.0.1', 'WEBHOOK_HOST="127.0.0.1"')
      .replace(`NANOCLAW_EGRESS_NETWORK=${config.agent_egress_network}\n`, '');
    await writeFile(environmentFile, `${earlier}# added by /add-telegram\nTELEGRAM_BOT_TOKEN=skill-value\n`);

    await persistInstanceRuntime(config, upsertEnvVars);

    const contents = await readFile(environmentFile, 'utf8');
    expect(contents).toBe(
      `${earlier}# added by /add-telegram\nTELEGRAM_BOT_TOKEN=skill-value\nNANOCLAW_EGRESS_NETWORK=${config.agent_egress_network}\n`,
    );
  });

  it("administers OneCLI at the instance's own app URL with the admin-only credential file", async () => {
    const { config } = await fixture();
    await persistInstanceRuntime(config, upsertEnvVars);
    await writeOwnerOnlyFileExclusive(config.secret_files.onecli_admin_api_key, 'admin-secret-canary\n');
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('[]'));

    await (await instanceOnecliAdmin(config, { fetch })).listAgents();

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`${config.onecli_app_url}/v1/agents`);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer admin-secret-canary');
  });

  it('refuses an empty OneCLI admin credential file before calling OneCLI', async () => {
    const { config } = await fixture();
    await persistInstanceRuntime(config, upsertEnvVars);
    await writeOwnerOnlyFileExclusive(config.secret_files.onecli_admin_api_key, '\n');
    const fetch = vi.fn(async () => new Response('[]'));

    await expect(instanceOnecliAdmin(config, { fetch })).rejects.toMatchObject({ code: 'invalid_secret' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps an existing launchd definition as written, restarts it as every command does, and reports its layout and pid', async () => {
    const { config, home } = await fixture();
    await persistInstanceRuntime(config, upsertEnvVars);
    const live = path.join(config.instance_root, 'nanoclaw');
    const state = path.join(config.instance_root, 'state');
    const logs = path.join(config.instance_root, 'logs');
    const serviceIdentity = `com.nanoclaw-v2-${config.install_id}`;
    const layout: InstanceServiceLayout = {
      manager: 'launchd',
      serviceIdentity,
      serviceDefinitionPath: path.join(home, 'Library', 'LaunchAgents', `${serviceIdentity}.plist`),
      runtimeConfigFile: path.join(state, 'data', 'gws-ea', 'runtime.json'),
      environmentFile: path.join(state, '.env'),
      launcherEntrypoint: path.join(live, 'dist', 'gws-ea', 'process.js'),
      hostEntrypoint: path.join(live, 'dist', 'index.js'),
      cliPath: path.join(live, 'bin', 'ncl'),
      cliSocket: path.join(state, 'data', 'ncl.sock'),
      standardOutputPath: path.join(logs, 'nanoclaw.log'),
      standardErrorPath: path.join(logs, 'nanoclaw.error.log'),
      installLabel: `nanoclaw-install=${config.install_id}`,
    };
    await mkdir(path.dirname(layout.serviceDefinitionPath), { recursive: true });
    const earlier = '<plist>the definition an earlier release rendered</plist>';
    await writeFile(layout.serviceDefinitionPath, earlier);
    const calls: SanitizedCommand[] = [];
    const runner = vi.fn(async (command: SanitizedCommand) => {
      calls.push(command);
      return { stdout: command.args[0] === 'print' ? '\tstate = running\n\tpid = 4242\n' : '', stderr: '' };
    });
    const restarted: string[] = [];

    const started = await reconcileInstanceService(config, {
      platform: 'macos',
      homeDirectory: home,
      runCommand: runner,
      uid: 501,
      restartService: async (runtime) => {
        restarted.push(runtime.instance_id);
      },
    });
    const definition = await readFile(layout.serviceDefinitionPath, 'utf8');

    expect(restarted).toEqual([config.instance_id]);
    // Only the pid is read here; the (re)start is NanoClaw's own, through the helpers every command uses.
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      ['launchctl', 'print', `gui/501/${layout.serviceIdentity}`],
    ]);
    expect(started).toEqual({ layout, pid: 4242 });
    // An existing definition is the release's own: starting the service never re-renders it.
    expect(definition).toBe(earlier);

    const cli = buildInstanceCliCommand(config, ['groups', 'list'], { PATH: '/safe/bin', HOME: '/attacker' });
    expect(cli.command).toBe(path.join(live, 'bin', 'ncl'));
    expect(cli.cwd).toBe(live);
    expect(cli.env?.HOME).toBe(config.home_directory);
  });

  it.each([
    ['derives the user-bus environment from the UID', {}, '/run/user/1000', 'unix:path=/run/user/1000/bus'],
    [
      'keeps the operator’s user-bus environment',
      { XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/custom-bus' },
      '/run/user/1000',
      'unix:path=/run/user/1000/custom-bus',
    ],
  ] as const)('starts a Linux user service with linger enabled and %s', async (_label, ambient, runtimeDir, bus) => {
    const { config, home } = await fixture();
    await persistInstanceRuntime(config, upsertEnvVars);
    const calls: SanitizedCommand[] = [];
    const runner = vi.fn(async (command: SanitizedCommand) => {
      calls.push(command);
      return { stdout: command.args.includes('MainPID') ? '777\n' : '', stderr: '' };
    });

    const started = await reconcileInstanceService(config, {
      platform: 'linux',
      homeDirectory: home,
      runningAsRoot: false,
      runCommand: runner,
      uid: 1000,
      ambientEnv: { PATH: '/usr/bin', ...ambient },
      restartService: async () => {
        calls.push({ command: 'restart', args: [], cwd: '/', env: {} });
      },
    });

    const unit = started.layout.serviceIdentity;
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      ['loginctl', 'show-user', '1000', '--property', 'Linger', '--value'],
      ['loginctl', 'enable-linger'],
      // A new unit is written, so systemd is told before it is enabled and started.
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', unit],
      ['restart'],
      ['systemctl', '--user', 'show', unit, '--property', 'MainPID', '--value'],
    ]);
    for (const call of calls.filter((command) => command.command === 'systemctl')) {
      expect(call.env).toMatchObject({ XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: bus });
    }
    expect(started.pid).toBe(777);
    expect(started.layout.serviceDefinitionPath).toBe(path.join(home, '.config', 'systemd', 'user', `${unit}.service`));
  });

  it('stops with the fix when linger cannot be enabled, before touching the service', async () => {
    const { config, home } = await fixture();
    await persistInstanceRuntime(config, upsertEnvVars);
    const calls: string[] = [];
    const runner = vi.fn(async (command: SanitizedCommand) => {
      calls.push(command.command);
      if (command.command === 'loginctl') {
        throw new GwsEaError('command_failed', 'Command failed (exit code 1): loginctl enable-linger');
      }
      return { stdout: '', stderr: '' };
    });

    await expect(
      reconcileInstanceService(config, {
        platform: 'linux',
        homeDirectory: home,
        runningAsRoot: false,
        runCommand: runner,
        uid: 1000,
        ambientEnv: { USER: 'operator' },
        restartService: async () => calls.push('restart'),
      }),
    ).rejects.toMatchObject({
      code: 'linger_required',
      message: expect.stringContaining('loginctl enable-linger operator'),
    });
    expect(calls).toEqual(['loginctl', 'loginctl']);
  });

  it('leaves lingering alone when it is already enabled', async () => {
    const { config, home } = await fixture();
    await persistInstanceRuntime(config, upsertEnvVars);
    const calls: string[][] = [];
    const runner = vi.fn(async (command: SanitizedCommand) => {
      calls.push([command.command, ...command.args]);
      return { stdout: command.args.includes('Linger') ? 'yes\n' : '', stderr: '' };
    });

    await reconcileInstanceService(config, {
      platform: 'linux',
      homeDirectory: home,
      runningAsRoot: false,
      runCommand: runner,
      uid: 1000,
      ambientEnv: {},
      restartService: async () => undefined,
    });

    expect(calls.filter(([program]) => program === 'loginctl')).toEqual([
      ['loginctl', 'show-user', '1000', '--property', 'Linger', '--value'],
    ]);
  });

  it('renders a new instance’s service definition and every gws-ea .env key, carrying the recorded Docker endpoint', async () => {
    const { config, home } = await fixture();
    const calls: SanitizedCommand[] = [];
    const runner = vi.fn(async (command: SanitizedCommand) => {
      calls.push(command);
      return { stdout: '', stderr: '' };
    });

    for (const platform of ['macos', 'linux'] as const) {
      const { layout } = await reconcileInstanceRuntime(config, COMMIT, {
        upsertEnvVars,
        restartService: async () => undefined,
        platform,
        homeDirectory: home,
        runningAsRoot: false,
        runCommand: runner,
        uid: 1000,
      });
      const definition = await readFile(layout.serviceDefinitionPath, 'utf8');
      expect(definition).toContain(DOCKER_ENDPOINT);
      expect(definition).toMatch(platform === 'macos' ? /<key>DOCKER_HOST<\/key>/u : /Environment=DOCKER_HOST=/u);
      // The service runs the launcher through the live link, and writes its output to the physical logs.
      expect(definition).toContain(path.join(config.instance_root, 'nanoclaw', 'dist', 'gws-ea', 'process.js'));
      expect(definition).toContain(path.join(config.instance_root, 'state', 'data', 'gws-ea', 'runtime.json'));
      expect(definition).toContain(path.join(config.instance_root, 'logs', 'nanoclaw.log'));
      expect(definition).toContain(path.join(config.instance_root, 'logs', 'nanoclaw.error.log'));
    }
    const environment = await readFile(path.join(config.state_root, '.env'), 'utf8');
    expect(environment.trimEnd().split('\n').sort()).toEqual(
      [
        `NANOCLAW_INSTALL_ID=${config.install_id}`,
        'DEFAULT_AGENT_PROVIDER=claude',
        'NANOCLAW_GATEWAY_PROVIDER=onecli',
        `WEBHOOK_PORT=${config.allocated_ports.nanoclaw_webhook}`,
        'WEBHOOK_HOST=127.0.0.1',
        'NANOCLAW_EGRESS_LOCKDOWN=true',
        `NANOCLAW_EGRESS_NETWORK=${config.agent_egress_network}`,
        `ONECLI_GATEWAY_CONTAINER=${config.onecli_gateway_container}`,
        `ONECLI_URL=${config.onecli_app_url}`,
        `GCHAT_ENDPOINT_URL=${config.endpoint_url}`,
      ].sort(),
    );
  });

  it('resumes with an existing service definition and .env byte-identical, however this tool would render them', async () => {
    const { config, home } = await fixture();
    await persistInstanceRuntime(config, upsertEnvVars);
    const environmentFile = path.join(config.state_root, '.env');
    const environment = `# written by an earlier release\n${(await readFile(environmentFile, 'utf8')).replace(/=(.*)$/gmu, '="$1"')}`;
    await writeFile(environmentFile, environment, { mode: 0o600 });
    const definitionFile = path.join(home, 'Library', 'LaunchAgents', `com.nanoclaw-v2-${config.install_id}.plist`);
    const definition = '<plist>the definition an earlier release rendered</plist>\n';
    await mkdir(path.dirname(definitionFile), { recursive: true });
    await writeFile(definitionFile, definition, { mode: 0o600 });
    const calls: string[][] = [];
    const runner = vi.fn(async (command: SanitizedCommand) => {
      calls.push([command.command, ...command.args]);
      return { stdout: '', stderr: '' };
    });
    const upsert = vi.fn(upsertEnvVars);
    let restarts = 0;

    const { layout } = await reconcileInstanceRuntime(config, COMMIT, {
      upsertEnvVars: upsert,
      restartService: async () => {
        restarts += 1;
      },
      platform: 'macos',
      homeDirectory: home,
      runCommand: runner,
      uid: 501,
    });

    expect(layout.serviceDefinitionPath).toBe(definitionFile);
    expect(await readFile(definitionFile, 'utf8')).toBe(definition);
    expect(upsert).not.toHaveBeenCalled();
    expect(await readFile(environmentFile, 'utf8')).toBe(environment);
    // The service still restarts from the definition it has.
    expect(restarts).toBe(1);
    expect(calls.filter(([program]) => program === 'launchctl').map(([, verb]) => verb)).toEqual(['print']);
  });

  it.each([
    ['a running launchd job', 'macos', { stdout: 'gui/501/x = {\n\tstate = running\n\tpid = 4242\n}\n' }, 4242],
    ['a loaded launchd job with no process', 'macos', { stdout: 'gui/501/x = {\n\tstate = waiting\n}\n' }, undefined],
    [
      'a launchd job that is not loaded',
      'macos',
      new GwsEaError('command_failed', 'Could not find service'),
      undefined,
    ],
    ['a running systemd unit', 'linux', { stdout: '777\n' }, 777],
    ['a stopped systemd unit', 'linux', { stdout: '0\n' }, undefined],
  ] as const)('reads the service pid of %s', async (_label, platform, answer, pid) => {
    const { config, home } = await fixture();
    const runner = vi.fn(async (_command: SanitizedCommand) => {
      if (answer instanceof Error) throw answer;
      return { stdout: answer.stdout, stderr: '' };
    });

    await expect(
      instanceServicePid(config, { platform, homeDirectory: home, runningAsRoot: false, runCommand: runner, uid: 501 }),
    ).resolves.toBe(pid);
  });

  it('fails before host start when a required secret is missing or unsafe', async () => {
    const { config, release } = await fixture();
    await persistInstanceRuntime(config, upsertEnvVars);
    const execve = vi.fn((): never => {
      throw new Error('execve called');
    });

    await expect(
      launchInstanceHost(path.join(config.state_root, 'data', 'gws-ea', 'runtime.json'), {}, execve, release),
    ).rejects.toMatchObject({
      code: 'ENOENT',
      path: expect.stringContaining(`${path.dirname(config.secret_files.gchat_credentials)}${path.sep}`),
    });
    expect(execve).not.toHaveBeenCalled();
  });

  it('rejects an invalid Google Chat project number before host start', async () => {
    const { config, release } = await fixture();
    await persistInstanceRuntime(config, upsertEnvVars);
    await writeOwnerOnlyFileExclusive(config.secret_files.gchat_credentials, 'chat-credential');
    await writeOwnerOnlyFileExclusive(config.secret_files.onecli_runtime_api_key, 'runtime-key');
    await writeOwnerOnlyFileExclusive(googleChatProjectNumberFile(config), '0\n');
    const execve = vi.fn((): never => {
      throw new Error('execve called');
    });

    await expect(
      launchInstanceHost(path.join(config.state_root, 'data', 'gws-ea', 'runtime.json'), {}, execve, release),
    ).rejects.toMatchObject({ code: 'invalid_runtime_config', message: expect.stringContaining('project number') });
    expect(execve).not.toHaveBeenCalled();
  });

  it('starts no host from a release the live link does not name, or while no release is live', async () => {
    const { config, release } = await fixture();
    await persistInstanceRuntime(config, upsertEnvVars);
    await writeOwnerOnlyFileExclusive(config.secret_files.gchat_credentials, 'chat-credential');
    await writeOwnerOnlyFileExclusive(config.secret_files.onecli_runtime_api_key, 'runtime-key');
    await writeOwnerOnlyFileExclusive(googleChatProjectNumberFile(config), '441811502258\n');
    const other = path.join(config.instance_root, 'bbbbbbbb');
    await releaseFolder(other);
    const execve = vi.fn((): never => {
      throw new Error('execve called');
    });
    const runtimeFile = path.join(config.state_root, 'data', 'gws-ea', 'runtime.json');

    // A launcher left behind by a release a switch replaced.
    await expect(launchInstanceHost(runtimeFile, {}, execve, other)).rejects.toMatchObject({
      code: 'not_live_release',
      message: expect.stringContaining(`which is ${release}`),
    });
    // The tool's own checkout is no release of this assistant.
    await expect(launchInstanceHost(runtimeFile, {}, execve)).rejects.toMatchObject({ code: 'not_live_release' });
    // A switch has fenced the assistant.
    await rm(config.checkout_root);
    await expect(launchInstanceHost(runtimeFile, {}, execve, release)).rejects.toMatchObject({
      code: 'not_live_release',
      message: expect.stringContaining('which has none'),
    });
    expect(execve).not.toHaveBeenCalled();
  });

  it("replaces the launcher with its live release's host, on that release's image, with only its host credentials, ignoring ambient redirects", async () => {
    const { config, release } = await fixture();
    await persistInstanceRuntime(config, upsertEnvVars);
    await writeOwnerOnlyFileExclusive(
      config.secret_files.gchat_credentials,
      '{"client_email":"bot@example.test","private_key":"chat-secret-canary"}',
    );
    await writeOwnerOnlyFileExclusive(config.secret_files.onecli_runtime_api_key, 'runtime-secret-canary');
    await writeOwnerOnlyFileExclusive(googleChatProjectNumberFile(config), '441811502258\n');
    await writeOwnerOnlyFileExclusive(config.secret_files.onecli_admin_api_key, 'admin-secret-canary');
    const calls: Array<{ file: string; args: readonly string[]; env: NodeJS.ProcessEnv; cwd: string }> = [];
    const marker = new Error('execve called');
    const execve = ((file: string, args: readonly string[], env: NodeJS.ProcessEnv): never => {
      calls.push({ file, args, env, cwd: process.cwd() });
      throw marker;
    }) as NonNullable<NodeJS.Process['execve']>;
    const originalCwd = process.cwd();
    try {
      await expect(
        launchInstanceHost(
          path.join(config.state_root, 'data', 'gws-ea', 'runtime.json'),
          {
            PATH: '/service/bin',
            NANOCLAW_INSTALL_ID: 'victim',
            WEBHOOK_PORT: '9',
            WEBHOOK_HOST: '0.0.0.0',
            ONECLI_URL: 'https://attacker.invalid',
            ONECLI_API_KEY: 'ambient-secret',
            GCHAT_CREDENTIALS: 'ambient-chat-secret',
            GCHAT_WORKSPACE_ADDON_SERVICE_ACCOUNT_EMAIL:
              'service-999999999999@gcp-sa-gsuiteaddons.iam.gserviceaccount.com',
            NODE_OPTIONS: '--import=/tmp/attacker.js',
            DOCKER_HOST: 'tcp://attacker.invalid:2376',
            CONTAINER_IMAGE: 'attacker/image:latest',
          },
          execve,
          release,
        ),
      ).rejects.toBe(marker);
    } finally {
      process.chdir(originalCwd);
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      file: config.node_path,
      args: [config.node_path, path.join(release, 'dist', 'index.js')],
      // The host runs from the physical release, so NanoClaw reaches the state through that release's links.
      cwd: release,
      env: {
        CONTAINER_IMAGE: `nanoclaw-agent-v2-${config.install_id}:r-${RELEASE}`,
        DOCKER_HOST: DOCKER_ENDPOINT,
        NANOCLAW_INSTALL_ID: config.install_id,
        WEBHOOK_PORT: String(config.allocated_ports.nanoclaw_webhook),
        WEBHOOK_HOST: '127.0.0.1',
        NANOCLAW_EGRESS_NETWORK: config.agent_egress_network,
        ONECLI_URL: config.onecli_app_url,
        ONECLI_API_KEY: 'runtime-secret-canary',
        GCHAT_CREDENTIALS: expect.stringContaining('chat-secret-canary'),
        GCHAT_WORKSPACE_ADDON_SERVICE_ACCOUNT_EMAIL: 'service-441811502258@gcp-sa-gsuiteaddons.iam.gserviceaccount.com',
        GWS_EA_GOOGLE_GRANT_FILE: path.join(path.dirname(config.secret_files.gchat_credentials), 'google-grant.json'),
      },
    });
    expect(calls[0]?.env).not.toHaveProperty('NODE_OPTIONS');
    expect(Object.values(calls[0]?.env ?? {})).not.toContain('admin-secret-canary');
  });

  it("stamps the release's tripwire with its own script and starts its service, building no image", async () => {
    const { config, home, release } = await fixture();
    const calls: SanitizedCommand[] = [];
    const runner = vi.fn(async (command: SanitizedCommand) => {
      calls.push(command);
      return { stdout: '', stderr: '' };
    });
    // pnpm lives outside the service's minimal PATH, as a pnpm standalone install puts it.
    const operatorPath = '/Users/operator/Library/pnpm/bin:/usr/bin:/bin';
    let restarts = 0;
    await reconcileInstanceRuntime(config, COMMIT, {
      upsertEnvVars,
      restartService: async () => {
        restarts += 1;
      },
      platform: 'macos',
      homeDirectory: home,
      runCommand: runner,
      uid: 501,
      ambientEnv: { PATH: operatorPath, HOME: '/Users/elsewhere' },
    });

    // The release was staged with its own image (`release-stage.ts`): only its tripwire is stamped, and the
    // service manager asked for the pid of the host it started.
    expect(calls.map((call) => call.command)).toEqual(['pnpm', 'launchctl']);
    expect(calls[0]).toMatchObject({
      command: 'pnpm',
      args: ['exec', 'tsx', 'scripts/upgrade-state.ts', 'set', '2.3.0', 'gws-ea'],
      cwd: release,
      // The script finds the operator's tools, against this instance's home, Docker endpoint, and install ID.
      env: {
        PATH: operatorPath,
        HOME: config.home_directory,
        DOCKER_HOST: config.docker_endpoint,
        NANOCLAW_INSTALL_ID: config.install_id,
      },
    });
    expect(restarts).toBe(1);
  });
});

describe('the service definition a switch installs', () => {
  it('installs a kept definition only when it differs, and has systemd read it before every start', async () => {
    const { config, home } = await fixture();
    const calls: SanitizedCommand[] = [];
    const runCommand = vi.fn(async (command: SanitizedCommand) => {
      calls.push(command);
      return { stdout: '', stderr: '' };
    });
    for (const platform of ['macos', 'linux'] as const) {
      const options = { platform, homeDirectory: home, runningAsRoot: false, runCommand, uid: 1000 };
      const file = instanceServiceDefinitionFile(config, options);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, 'the definition an earlier release rendered\n', { mode: 0o600 });
      const kept = renderInstanceServiceDefinition(config, options);

      expect(await restoreInstanceServiceDefinition(config, kept, options)).toBe(true);
      expect(await readFile(file, 'utf8')).toBe(kept);
      expect(kept).toContain(path.join(config.checkout_root, 'dist', 'gws-ea', 'process.js'));
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(await restoreInstanceServiceDefinition(config, kept, options)).toBe(false);
      await reloadInstanceService(config, options);
    }
    // launchd reads its definition when the job is bootstrapped; systemd is told when it changed and before a start.
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'daemon-reload'],
    ]);
  });
});
