import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOnecliRuntimeLayout } from './onecli-compose.js';
import { resolveControlPlanePaths } from './paths.js';
import type { SanitizedCommand } from './process.js';
import { allocateInstanceId } from './registry.js';
import {
  buildInstanceCliCommand,
  buildInstanceHostEnvironment,
  createInstanceRuntimeConfig,
  createInstanceServiceLayout,
  launchInstanceHost,
  persistInstanceRuntime,
  reconcileInstanceRuntime,
  reconcileInstanceService,
  runInstanceOnecliAdminCommand,
  type InstanceRuntimeConfig,
} from './service.js';
import { writeOwnerOnlyFileExclusive } from './secrets.js';
import type { InstanceReservation } from './types.js';

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
    }),
    home,
  };
}

describe('GWS-EA instance runtime', () => {
  it('persists only non-secret exact coordinates and derives every instance target', async () => {
    const { config, home } = await fixture();
    await persistInstanceRuntime(config);
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
    expect(manifest).toContain(config.secret_files.onecli_runtime_api_key);
    expect((await stat(layout.environmentFile)).mode & 0o777).toBe(0o600);
  });

  it('loads only host credentials into a fresh environment and rejects ambient redirects', async () => {
    const { config } = await fixture();
    await persistInstanceRuntime(config);
    await writeOwnerOnlyFileExclusive(
      config.secret_files.gchat_credentials,
      '{"client_email":"bot@example.test","private_key":"chat-secret-canary"}',
    );
    await writeOwnerOnlyFileExclusive(config.secret_files.onecli_runtime_api_key, 'runtime-secret-canary');
    await writeOwnerOnlyFileExclusive(config.secret_files.onecli_admin_api_key, 'admin-secret-canary');

    const environment = await buildInstanceHostEnvironment(config, {
      PATH: '/safe/bin',
      NANOCLAW_INSTALL_ID: 'victim',
      WEBHOOK_PORT: '9',
      WEBHOOK_HOST: '0.0.0.0',
      ONECLI_URL: 'https://attacker.invalid',
      ONECLI_API_KEY: 'ambient-secret',
      GCHAT_CREDENTIALS: 'ambient-chat-secret',
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
    });
    expect(environment).not.toHaveProperty('NODE_OPTIONS');
    expect(Object.values(environment)).not.toContain('admin-secret-canary');
  });

  it('runs OneCLI administration through the pinned binary and admin-only credential file', async () => {
    const { config } = await fixture();
    await persistInstanceRuntime(config);
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
    await persistInstanceRuntime(config);
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
    await persistInstanceRuntime(config);
    await expect(buildInstanceHostEnvironment(config)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('replaces the launcher with the exact checkout host and constructed environment', async () => {
    const { config } = await fixture();
    await persistInstanceRuntime(config);
    await writeOwnerOnlyFileExclusive(
      config.secret_files.gchat_credentials,
      '{"client_email":"bot@example.test","private_key":"chat-secret-canary"}',
    );
    await writeOwnerOnlyFileExclusive(config.secret_files.onecli_runtime_api_key, 'runtime-secret-canary');
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
