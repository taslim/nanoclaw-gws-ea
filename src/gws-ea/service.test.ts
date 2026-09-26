import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOnecliRuntimeLayout } from './onecli-compose.js';
import { CONTROL_PLANE_ROOT, resolveControlPlanePaths } from './paths.js';
import type { SanitizedCommand } from './process.js';
import { GwsEaError } from './types.js';
import { allocateInstanceId } from './registry.js';
import {
  buildInstanceCliCommand,
  buildInstanceHostEnvironment,
  createInstanceRuntimeConfig,
  createInstanceServiceLayout,
  googleChatProjectNumberFile,
  instanceServicePid,
  launchInstanceHost,
  loadInstanceRuntimeConfig,
  persistInstanceRuntime,
  reconcileInstanceRuntime,
  reconcileInstanceService,
  runInstanceOnecliAdminCommand,
  type InstanceRuntimeConfig,
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

async function fixture(): Promise<{ config: InstanceRuntimeConfig; home: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-service-'));
  roots.push(root);
  const paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'config'),
    stateRoot: path.join(root, 'state'),
  });
  const instanceId = allocateInstanceId();
  const checkout = paths.checkoutRoot(instanceId);
  await mkdir(path.join(checkout, 'dist', 'gws-ea'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(checkout, 'bin'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(checkout, 'dist', 'index.js'), 'host');
  await writeFile(path.join(checkout, 'dist', 'gws-ea', 'process.js'), 'launcher');
  await writeFile(path.join(checkout, 'bin', 'ncl'), '#!/bin/sh\n', { mode: 0o700 });
  await writeFile(path.join(checkout, 'package.json'), '{"version":"2.3.0"}\n');
  const onecliCli = path.join(root, 'onecli');
  await writeFile(onecliCli, '#!/bin/sh\n', { mode: 0o700 });
  const reservation: InstanceReservation = {
    instance_id: instanceId,
    checkout_realpath: checkout,
    release_track: 'dogfood',
    source_remote: 'https://example.test/nanoclaw.git',
    deployed_commit: 'a'.repeat(40),
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
    cliExecutable: onecliCli,
    dockerEndpoint: DOCKER_ENDPOINT,
  });
  const home = path.join(root, 'home');
  await mkdir(home, { mode: 0o700 });
  return {
    config: createInstanceRuntimeConfig(reservation, onecli, {
      nodePath: process.execPath,
      homeDirectory: home,
      selectedProvider: 'claude',
      dockerEndpoint: DOCKER_ENDPOINT,
    }),
    home,
  };
}

describe('GWS-EA instance runtime', () => {
  it('persists only independent values and the Docker endpoint, and derives every instance target', async () => {
    const { config, home } = await fixture();
    await persistInstanceRuntime(config, upsertEnvVars);
    const layout = createInstanceServiceLayout(config, { platform: 'macos', homeDirectory: home });
    const environmentFile = await readFile(layout.environmentFile, 'utf8');
    const manifest = await readFile(layout.runtimeConfigFile, 'utf8');

    expect(config.install_id).toBe(config.instance_id.replaceAll('-', ''));
    expect(layout.serviceIdentity).toBe(`com.nanoclaw-v2-${config.install_id}`);
    expect(layout.imageTag).toBe(`nanoclaw-agent-v2-${config.install_id}:latest`);
    expect(layout.installLabel).toBe(`nanoclaw-install=${config.install_id}`);
    expect(layout.cliSocket).toBe(path.join(config.checkout_realpath, 'data', 'ncl.sock'));
    expect(layout.standardOutputPath).toBe(path.join(config.checkout_realpath, 'logs', 'nanoclaw.log'));
    const secretsDirectory = path.join(path.dirname(config.checkout_realpath), 'secrets');
    expect(config.secret_files).toEqual({
      gchat_credentials: path.join(secretsDirectory, 'gchat-service-account.json'),
      onecli_runtime_api_key: path.join(secretsDirectory, 'onecli-runtime-api-key'),
      onecli_admin_api_key: path.join(secretsDirectory, 'onecli-admin-api-key'),
    });
    expect(secretsDirectory.startsWith(`${config.checkout_realpath}${path.sep}`)).toBe(false);
    expect(environmentFile).toContain(`WEBHOOK_PORT=${config.allocated_ports.nanoclaw_webhook}`);
    expect(environmentFile).toContain('WEBHOOK_HOST=127.0.0.1');
    expect(environmentFile).toContain(`NANOCLAW_EGRESS_NETWORK=${config.agent_egress_network}`);
    expect(Object.keys(JSON.parse(manifest) as object).sort()).toEqual([
      'allocated_ports',
      'checkout_realpath',
      'deployed_commit',
      'docker_endpoint',
      'endpoint_url',
      'home_directory',
      'instance_id',
      'node_path',
      'onecli_cli_path',
      'onecli_project',
      'schema_version',
      'selected_provider',
    ]);
    expect(JSON.parse(manifest)).toMatchObject({ docker_endpoint: DOCKER_ENDPOINT });
    expect((await stat(layout.environmentFile)).mode & 0o777).toBe(0o600);
  });

  it('loads a runtime file with unknown fields, recomputes derived values, and leaves the file as written', async () => {
    const { config } = await fixture();
    await persistInstanceRuntime(config, upsertEnvVars);
    const file = path.join(config.checkout_realpath, 'data', 'gws-ea', 'runtime.json');
    const written = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const extended = `${JSON.stringify({ ...written, added_by_a_newer_launcher: { any: 'shape' }, install_id: 'stale' }, null, 2)}\n`;
    await writeFile(file, extended, { mode: 0o600 });

    const loaded = await loadInstanceRuntimeConfig(file);
    expect(loaded.install_id).toBe(config.instance_id.replaceAll('-', ''));
    expect(loaded.onecli_gateway_container).toBe(config.onecli_gateway_container);
    await persistInstanceRuntime(loaded, upsertEnvVars);
    expect(await readFile(file, 'utf8')).toBe(extended);
  });

  it('refuses a runtime file whose persisted values disagree', async () => {
    const { config } = await fixture();
    await persistInstanceRuntime(config, upsertEnvVars);

    await expect(
      persistInstanceRuntime({ ...config, docker_endpoint: 'unix:///run/other/docker.sock' }, upsertEnvVars),
    ).rejects.toMatchObject({ code: 'runtime_conflict' });
  });

  it('keeps a .env key another writer added when resume persists the runtime again', async () => {
    const { config } = await fixture();
    await persistInstanceRuntime(config, upsertEnvVars);
    const environmentFile = path.join(config.checkout_realpath, '.env');
    const stale = (await readFile(environmentFile, 'utf8')).replace('WEBHOOK_HOST=127.0.0.1', 'WEBHOOK_HOST=0.0.0.0');
    await writeFile(environmentFile, `${stale}# added by /add-telegram\nTELEGRAM_BOT_TOKEN=skill-value\n`);

    await persistInstanceRuntime(config, upsertEnvVars);

    const lines = (await readFile(environmentFile, 'utf8')).split('\n');
    expect(lines).toContain('TELEGRAM_BOT_TOKEN=skill-value');
    expect(lines).toContain('# added by /add-telegram');
    expect(lines.filter((line) => line.startsWith('WEBHOOK_HOST='))).toEqual(['WEBHOOK_HOST=127.0.0.1']);
    expect(lines).toContain(`NANOCLAW_INSTALL_ID=${config.install_id}`);
  });

  it('loads only host credentials into a fresh environment and rejects ambient redirects', async () => {
    const { config } = await fixture();
    await persistInstanceRuntime(config, upsertEnvVars);
    await writeOwnerOnlyFileExclusive(
      config.secret_files.gchat_credentials,
      '{"client_email":"bot@example.test","private_key":"chat-secret-canary"}',
    );
    await writeOwnerOnlyFileExclusive(config.secret_files.onecli_runtime_api_key, 'runtime-secret-canary');
    await writeOwnerOnlyFileExclusive(googleChatProjectNumberFile(config), '441811502258\n');
    await writeOwnerOnlyFileExclusive(config.secret_files.onecli_admin_api_key, 'admin-secret-canary');

    const environment = await buildInstanceHostEnvironment(config, {
      PATH: '/safe/bin',
      NANOCLAW_INSTALL_ID: 'victim',
      WEBHOOK_PORT: '9',
      WEBHOOK_HOST: '0.0.0.0',
      ONECLI_URL: 'https://attacker.invalid',
      ONECLI_API_KEY: 'ambient-secret',
      GCHAT_CREDENTIALS: 'ambient-chat-secret',
      GCHAT_WORKSPACE_ADDON_SERVICE_ACCOUNT_EMAIL: 'service-999999999999@gcp-sa-gsuiteaddons.iam.gserviceaccount.com',
      NODE_OPTIONS: '--import=/tmp/attacker.js',
      DOCKER_HOST: 'tcp://attacker.invalid:2376',
    });

    expect(environment).toMatchObject({
      DOCKER_HOST: DOCKER_ENDPOINT,
      NANOCLAW_INSTALL_ID: config.install_id,
      WEBHOOK_PORT: String(config.allocated_ports.nanoclaw_webhook),
      WEBHOOK_HOST: '127.0.0.1',
      NANOCLAW_EGRESS_NETWORK: config.agent_egress_network,
      ONECLI_URL: config.onecli_app_url,
      ONECLI_API_KEY: 'runtime-secret-canary',
      GCHAT_CREDENTIALS: expect.stringContaining('chat-secret-canary'),
      GCHAT_WORKSPACE_ADDON_SERVICE_ACCOUNT_EMAIL: 'service-441811502258@gcp-sa-gsuiteaddons.iam.gserviceaccount.com',
    });
    expect(environment).not.toHaveProperty('NODE_OPTIONS');
    expect(Object.values(environment)).not.toContain('admin-secret-canary');
  });

  it('runs OneCLI administration through the pinned binary and admin-only credential file', async () => {
    const { config } = await fixture();
    await persistInstanceRuntime(config, upsertEnvVars);
    await writeOwnerOnlyFileExclusive(config.secret_files.onecli_admin_api_key, 'admin-secret-canary');
    const calls: SanitizedCommand[] = [];
    const runner = vi.fn(async (command: SanitizedCommand) => {
      calls.push(command);
      return { stdout: '{"data":[]}', stderr: '' };
    });

    const result = await runInstanceOnecliAdminCommand(config, ['agents', 'list'], {
      runCommand: runner,
      ambientEnv: {
        PATH: '/attacker/bin',
        ONECLI_API_HOST: 'https://attacker.invalid',
        ONECLI_API_KEY: 'ambient-secret',
        GCHAT_CREDENTIALS: 'ambient-chat-secret',
      },
    });

    expect(result.stdout).toBe('{"data":[]}');
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        command: config.onecli_cli_path,
        args: ['agents', 'list'],
        env: expect.objectContaining({
          ONECLI_API_HOST: config.onecli_app_url,
          ONECLI_API_KEY: 'admin-secret-canary',
        }),
      }),
    );
    const command = calls[0];
    expect(command?.env).not.toHaveProperty('GCHAT_CREDENTIALS');
  });

  it('reloads a changed launchd definition with bootout then one bootstrap, and reports the pid', async () => {
    const { config, home } = await fixture();
    await persistInstanceRuntime(config, upsertEnvVars);
    const layout = createInstanceServiceLayout(config, { platform: 'macos', homeDirectory: home });
    await mkdir(path.dirname(layout.serviceDefinitionPath), { recursive: true });
    await writeFile(layout.serviceDefinitionPath, '<plist>an earlier launcher’s definition</plist>');
    const calls: SanitizedCommand[] = [];
    const runner = vi.fn(async (command: SanitizedCommand) => {
      calls.push(command);
      if (command.args[0] === 'bootout') {
        throw new GwsEaError('command_failed', 'Command failed (exit code 3): launchctl bootout', {
          details: { exitCode: 3, stderrTail: 'Boot-out failed: 3: No such process' },
        });
      }
      return { stdout: command.args[0] === 'print' ? '\tstate = running\n\tpid = 4242\n' : '', stderr: '' };
    });

    const started = await reconcileInstanceService(config, {
      platform: 'macos',
      homeDirectory: home,
      runCommand: runner,
      uid: 501,
    });
    const definition = await readFile(layout.serviceDefinitionPath, 'utf8');

    const domain = `gui/501/${layout.serviceIdentity}`;
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      ['launchctl', 'bootout', domain],
      ['launchctl', 'bootstrap', 'gui/501', layout.serviceDefinitionPath],
      // Demand-starts a job launchd left pended; without `-k` it never restarts a running one.
      ['launchctl', 'kickstart', domain],
      ['launchctl', 'print', domain],
    ]);
    expect(started).toEqual({ layout, pid: 4242 });
    expect(definition).not.toContain('an earlier launcher');
    expect(definition).toContain(path.join(config.checkout_realpath, 'dist', 'gws-ea', 'process.js'));
    expect(definition).toContain(layout.runtimeConfigFile);

    const cli = buildInstanceCliCommand(config, ['groups', 'list'], { PATH: '/safe/bin', HOME: '/attacker' });
    expect(cli.command).toBe(path.join(config.checkout_realpath, 'bin', 'ncl'));
    expect(cli.cwd).toBe(config.checkout_realpath);
    expect(cli.env?.HOME).toBe(config.home_directory);
  });

  it('fails the start when launchd refuses the definition for any reason but a job that was not loaded', async () => {
    const { config, home } = await fixture();
    await persistInstanceRuntime(config, upsertEnvVars);
    const refused = new GwsEaError('command_failed', 'Command failed (exit code 5): launchctl bootstrap', {
      details: { exitCode: 5, stderrTail: 'Bootstrap failed: 5: Input/output error' },
    });
    const runner = vi.fn(async (command: SanitizedCommand) => {
      if (command.args[0] === 'bootstrap') throw refused;
      return { stdout: '', stderr: '' };
    });

    await expect(
      reconcileInstanceService(config, { platform: 'macos', homeDirectory: home, runCommand: runner, uid: 501 }),
    ).rejects.toBe(refused);
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
    });

    const unit = started.layout.serviceIdentity;
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      ['loginctl', 'show-user', '1000', '--property', 'Linger', '--value'],
      ['loginctl', 'enable-linger'],
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', unit],
      ['systemctl', '--user', 'restart', unit],
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
    });

    expect(calls.filter(([program]) => program === 'loginctl')).toEqual([
      ['loginctl', 'show-user', '1000', '--property', 'Linger', '--value'],
    ]);
  });

  it('carries the recorded Docker endpoint in the service definition and the image build', async () => {
    const { config, home } = await fixture();
    const calls: SanitizedCommand[] = [];
    const runner = vi.fn(async (command: SanitizedCommand) => {
      calls.push(command);
      return { stdout: '', stderr: '' };
    });

    for (const platform of ['macos', 'linux'] as const) {
      const { layout } = await reconcileInstanceRuntime(config, {
        upsertEnvVars,
        platform,
        homeDirectory: home,
        runningAsRoot: false,
        runCommand: runner,
        uid: 1000,
      });
      const definition = await readFile(layout.serviceDefinitionPath, 'utf8');
      expect(definition).toContain(DOCKER_ENDPOINT);
      expect(definition).toMatch(platform === 'macos' ? /<key>DOCKER_HOST<\/key>/u : /Environment=DOCKER_HOST=/u);
    }
    const build = calls.find((call) => call.args.includes('container'))!;
    expect(build.env?.DOCKER_HOST).toBe(DOCKER_ENDPOINT);
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
    const { config } = await fixture();
    await persistInstanceRuntime(config, upsertEnvVars);
    await expect(buildInstanceHostEnvironment(config)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an invalid Google Chat project number before host start', async () => {
    const { config } = await fixture();
    await persistInstanceRuntime(config, upsertEnvVars);
    await writeOwnerOnlyFileExclusive(config.secret_files.gchat_credentials, 'chat-credential');
    await writeOwnerOnlyFileExclusive(config.secret_files.onecli_runtime_api_key, 'runtime-key');
    await writeOwnerOnlyFileExclusive(googleChatProjectNumberFile(config), '0\n');

    await expect(buildInstanceHostEnvironment(config)).rejects.toMatchObject({ code: 'invalid_runtime_config' });
  });

  it('replaces the launcher with the exact checkout host and constructed environment', async () => {
    const { config } = await fixture();
    await persistInstanceRuntime(config, upsertEnvVars);
    await writeOwnerOnlyFileExclusive(
      config.secret_files.gchat_credentials,
      '{"client_email":"bot@example.test","private_key":"chat-secret-canary"}',
    );
    await writeOwnerOnlyFileExclusive(config.secret_files.onecli_runtime_api_key, 'runtime-secret-canary');
    await writeOwnerOnlyFileExclusive(googleChatProjectNumberFile(config), '441811502258\n');
    const calls: Array<{ file: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const marker = new Error('execve called');
    const execve = ((file: string, args: readonly string[], env: NodeJS.ProcessEnv): never => {
      calls.push({ file, args, env });
      throw marker;
    }) as NonNullable<NodeJS.Process['execve']>;
    const originalCwd = process.cwd();
    try {
      await expect(
        launchInstanceHost(
          path.join(config.checkout_realpath, 'data', 'gws-ea', 'runtime.json'),
          {
            PATH: '/service/bin',
            NODE_OPTIONS: '--import=/tmp/attacker.js',
            ONECLI_API_KEY: 'ambient-secret',
          },
          execve,
        ),
      ).rejects.toBe(marker);
    } finally {
      process.chdir(originalCwd);
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      file: config.node_path,
      args: [config.node_path, path.join(config.checkout_realpath, 'dist', 'index.js')],
    });
    expect(calls[0]?.env.ONECLI_API_KEY).toBe('runtime-secret-canary');
    expect(calls[0]?.env).not.toHaveProperty('NODE_OPTIONS');
  });

  it('prepares only the exact checkout image and service without invoking generic service setup', async () => {
    const { config, home } = await fixture();
    const calls: SanitizedCommand[] = [];
    const runner = vi.fn(async (command: SanitizedCommand) => {
      calls.push(command);
      return { stdout: '', stderr: '' };
    });
    // pnpm lives outside the service's minimal PATH, as a pnpm standalone install puts it.
    const operatorPath = '/Users/operator/Library/pnpm/bin:/usr/bin:/bin';
    await reconcileInstanceRuntime(config, {
      upsertEnvVars,
      platform: 'macos',
      homeDirectory: home,
      runCommand: runner,
      uid: 501,
      ambientEnv: { PATH: operatorPath, HOME: '/Users/elsewhere' },
    });

    expect(calls[0]).toMatchObject({
      command: 'pnpm',
      args: ['exec', 'tsx', 'scripts/upgrade-state.ts', 'set', '2.3.0', 'gws-ea'],
      cwd: config.checkout_realpath,
    });
    expect(calls[1]).toMatchObject({
      command: 'pnpm',
      args: ['exec', 'tsx', 'setup/index.ts', '--step', 'container'],
      cwd: config.checkout_realpath,
    });
    expect(calls.flatMap((call) => call.args)).not.toContain('service');
    expect(calls.flatMap((call) => call.args).join(' ')).not.toContain('.local/bin/ncl');
    // The build finds the operator's tools, against this instance's home, Docker endpoint, and install ID.
    for (const call of calls.slice(0, 2)) {
      expect(call.env).toMatchObject({
        PATH: operatorPath,
        HOME: config.home_directory,
        DOCKER_HOST: config.docker_endpoint,
        NANOCLAW_INSTALL_ID: config.install_id,
      });
    }
  });
});
