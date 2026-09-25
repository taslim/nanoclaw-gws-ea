import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOnecliRuntimeLayout } from './onecli-compose.js';
import { CONTROL_PLANE_ROOT, resolveControlPlanePaths } from './paths.js';
import type { SanitizedCommand } from './process.js';
import { allocateInstanceId } from './registry.js';
import {
  buildInstanceCliCommand,
  buildInstanceHostEnvironment,
  createInstanceRuntimeConfig,
  createInstanceServiceLayout,
  googleChatProjectNumberFile,
  launchInstanceHost,
  loadInstanceRuntimeConfig,
  persistInstanceRuntime,
  readRecordedHomeDirectory,
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
  });
  const home = path.join(root, 'home');
  await mkdir(home, { mode: 0o700 });
  return {
    config: createInstanceRuntimeConfig(reservation, onecli, {
      nodePath: process.execPath,
      homeDirectory: home,
      selectedProvider: 'claude',
      dockerEndpoint: 'unix:///var/run/docker.sock',
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
    expect(environmentFile).not.toContain('runtime-secret-canary');
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
    expect(JSON.parse(manifest)).toMatchObject({ docker_endpoint: 'unix:///var/run/docker.sock' });
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

  it('reads the home directory removal needs from a runtime an earlier launcher wrote', async () => {
    const { config } = await fixture();
    await persistInstanceRuntime(config, upsertEnvVars);
    const file = path.join(config.checkout_realpath, 'data', 'gws-ea', 'runtime.json');
    const earlier = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    delete earlier.docker_endpoint;
    await writeFile(file, JSON.stringify({ ...earlier, install_id: config.install_id }), { mode: 0o600 });

    await expect(loadInstanceRuntimeConfig(file)).rejects.toMatchObject({ code: 'invalid_runtime_config' });
    await expect(readRecordedHomeDirectory(file)).resolves.toBe(config.home_directory);
    await expect(readRecordedHomeDirectory(`${file}.missing`)).resolves.toBeUndefined();
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
    });

    expect(environment).toMatchObject({
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

  it('renders and restarts only the exact service without touching a global ncl target', async () => {
    const { config, home } = await fixture();
    await persistInstanceRuntime(config, upsertEnvVars);
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const runner = vi.fn(async (command: { command: string; args: readonly string[] }) => {
      calls.push(command);
      return { stdout: '', stderr: '' };
    });
    const layout = await reconcileInstanceService(config, {
      platform: 'macos',
      homeDirectory: home,
      runCommand: runner,
    });
    const definition = await readFile(layout.serviceDefinitionPath, 'utf8');

    expect(definition).toContain(path.join(config.checkout_realpath, 'dist', 'gws-ea', 'process.js'));
    expect(definition).toContain(layout.runtimeConfigFile);
    expect(definition).not.toContain('chat-secret-canary');
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      ['launchctl', 'unload', layout.serviceDefinitionPath],
      ['launchctl', 'load', layout.serviceDefinitionPath],
      ['launchctl', 'kickstart', '-k', `gui/${process.getuid?.() ?? 0}/${layout.serviceIdentity}`],
      ['launchctl', 'print', `gui/${process.getuid?.() ?? 0}/${layout.serviceIdentity}`],
    ]);
    expect(calls.flatMap((call) => call.args).join(' ')).not.toContain('.local/bin/ncl');

    const cli = buildInstanceCliCommand(config, ['groups', 'list'], { PATH: '/safe/bin', HOME: '/attacker' });
    expect(cli.command).toBe(path.join(config.checkout_realpath, 'bin', 'ncl'));
    expect(cli.cwd).toBe(config.checkout_realpath);
    expect(cli.env?.HOME).toBe(config.home_directory);
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
    const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
    const runner = vi.fn(async (command: { command: string; args: readonly string[]; cwd: string }) => {
      calls.push(command);
      return { stdout: '', stderr: '' };
    });
    await reconcileInstanceRuntime(config, {
      upsertEnvVars,
      platform: 'macos',
      homeDirectory: home,
      runCommand: runner,
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
  });
});
