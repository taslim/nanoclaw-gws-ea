import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CLOUDFLARED_IMAGE,
  CLOUDFLARE_CONNECTOR_OWNER_LABEL,
  CLOUDFLARE_CONNECTOR_ROLE_LABEL,
  buildCloudflareComposeInvocation,
  cloudflareOriginUrl,
  createCloudflareConnectorLayout,
  inspectCloudflareConnector,
  prepareCloudflareConnector,
  reconcileCloudflareConnector,
  renderCloudflareConnectorCompose,
  stopCloudflareConnector,
  validateCloudflareConnectorState,
  validateObservedCloudflareConnector,
  type CloudflareConnectorLayout,
  type ObservedCloudflareConnector,
} from './cloudflare-connector.js';
import type { SanitizedCommand } from './process.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object');
  return value as Record<string, unknown>;
}

async function layout(platform: 'macos' | 'linux'): Promise<CloudflareConnectorLayout> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-cloudflared-'));
  roots.push(root);
  return createCloudflareConnectorLayout({
    cloudflareRoot: path.join(root, 'ingress', 'cloudflare'),
    platform,
    ownerUid: 501,
    ownerGid: 20,
  });
}

function observed(
  layout: CloudflareConnectorLayout,
  overrides: Partial<ObservedCloudflareConnector> = {},
): ObservedCloudflareConnector {
  return {
    id: 'container-id',
    service: 'connector',
    project: layout.project,
    owner: 'shared-cloudflare-ingress',
    role: 'connector',
    image: CLOUDFLARED_IMAGE,
    user: layout.runtimeUser,
    command: ['tunnel', '--no-autoupdate', 'run', '--token-file', '/run/secrets/tunnel_token'],
    environment: [
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      'SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt',
    ],
    running: true,
    restarting: false,
    restartPolicy: 'unless-stopped',
    readOnlyRootFilesystem: true,
    privileged: false,
    capabilitiesDropped: ['ALL'],
    securityOptions: ['no-new-privileges:true'],
    networkMode: layout.platform === 'linux' ? 'host' : 'bridge',
    extraHosts: layout.platform === 'macos' ? ['host.docker.internal:host-gateway'] : [],
    mounts: [
      {
        type: 'bind',
        source: layout.tokenFile,
        destination: '/run/secrets/tunnel_token',
        readOnly: true,
      },
    ],
    tmpfs: ['/tmp'],
    publishedPorts: {},
    ...overrides,
  };
}

function inspectJson(layout: CloudflareConnectorLayout): string {
  const value = observed(layout);
  return JSON.stringify([
    {
      Id: value.id,
      Config: {
        Image: value.image,
        User: value.user,
        Cmd: value.command,
        Env: value.environment,
        Labels: {
          'com.docker.compose.project': value.project,
          'com.docker.compose.service': value.service,
          [CLOUDFLARE_CONNECTOR_OWNER_LABEL]: value.owner,
          [CLOUDFLARE_CONNECTOR_ROLE_LABEL]: value.role,
        },
      },
      State: { Running: value.running, Restarting: value.restarting },
      HostConfig: {
        RestartPolicy: { Name: value.restartPolicy },
        ReadonlyRootfs: value.readOnlyRootFilesystem,
        Privileged: value.privileged,
        CapDrop: value.capabilitiesDropped,
        SecurityOpt: value.securityOptions,
        NetworkMode: value.networkMode,
        ExtraHosts: value.extraHosts,
        Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=16m,mode=1777' },
        PortBindings: value.publishedPorts,
      },
      Mounts: value.mounts.map((mount) => ({
        Type: mount.type,
        Source: mount.source,
        Destination: mount.destination,
        RW: !mount.readOnly,
      })),
    },
  ]);
}

describe('shared Cloudflare connector', () => {
  it('uses the immutable multi-architecture cloudflared pin', () => {
    expect(CLOUDFLARED_IMAGE).toBe(
      'cloudflare/cloudflared:2026.9.1@sha256:b269e8abd07a5bf6f3f4be65d5050b2174eca89c56a0241a8ff32a16aec454e4',
    );
  });

  it.each(['macos', 'linux'] as const)(
    'renders the exact hardened %s connector without secret material',
    async (platform) => {
      const connector = await layout(platform);
      const source = renderCloudflareConnectorCompose(connector);
      const compose = record(parseYaml(source));
      const service = record(record(compose.services).connector);
      const secrets = record(compose.secrets);
      const canary = 'connector-token-canary';

      expect(service.image).toBe(CLOUDFLARED_IMAGE);
      expect(service.command).toEqual([
        'tunnel',
        '--no-autoupdate',
        'run',
        '--token-file',
        '/run/secrets/tunnel_token',
      ]);
      expect(service.user).toBe('501:20');
      expect(service).toMatchObject({
        restart: 'unless-stopped',
        read_only: true,
        cap_drop: ['ALL'],
        security_opt: ['no-new-privileges:true'],
        tmpfs: ['/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777'],
        labels: {
          [CLOUDFLARE_CONNECTOR_OWNER_LABEL]: 'shared-cloudflare-ingress',
          [CLOUDFLARE_CONNECTOR_ROLE_LABEL]: 'connector',
        },
      });
      expect(record(secrets.tunnel_token).file).toBe(connector.tokenFile);
      expect(service.network_mode).toBe(platform === 'linux' ? 'host' : 'bridge');
      expect(service.extra_hosts ?? []).toEqual(platform === 'macos' ? ['host.docker.internal:host-gateway'] : []);
      expect(source).not.toContain(canary);
      expect(source).not.toContain('/var/run/docker.sock');
      expect(source).not.toContain('/nanoclaw');
      expect(service).not.toHaveProperty('ports');
      expect(service).not.toHaveProperty('environment');
    },
  );

  it('renders explicit platform origins without claiming Linux port isolation', () => {
    expect(cloudflareOriginUrl('macos', 31_001)).toBe('http://host.docker.internal:31001');
    expect(cloudflareOriginUrl('linux', 31_001)).toBe('http://127.0.0.1:31001');
    expect(() => cloudflareOriginUrl('macos', 0)).toThrow(/port/u);
  });

  it('persists only the connector token as an owner-only file outside assistant checkouts', async () => {
    const connector = await layout('macos');
    const canary = 'connector-token-canary';
    await prepareCloudflareConnector(connector, canary);

    expect(await readFile(connector.tokenFile, 'utf8')).toBe(canary);
    expect((await stat(connector.tokenFile)).mode & 0o777).toBe(0o600);
    expect((await stat(connector.rootDirectory)).mode & 0o777).toBe(0o700);
    expect(await readFile(connector.composeFile, 'utf8')).not.toContain(canary);
    expect(await readFile(connector.envFile, 'utf8')).not.toContain(canary);
    expect(connector.rootDirectory).not.toContain(`${path.sep}instances${path.sep}`);
    await expect(validateCloudflareConnectorState(connector)).resolves.toBeUndefined();

    await prepareCloudflareConnector(connector, canary);
    await expect(prepareCloudflareConnector(connector, 'different-token')).rejects.toMatchObject({
      code: 'connector_token_conflict',
    });
    await rm(connector.tokenFile);
    await expect(validateCloudflareConnectorState(connector)).rejects.toMatchObject({
      code: 'cloudflare_connector_state_missing',
    });
  });

  it.each([false, true])('inspects before its private directory exists (connector present: %s)', async (present) => {
    const connector = await layout('macos');
    const runner = vi.fn(async (command: SanitizedCommand) => {
      expect((await stat(command.cwd)).isDirectory()).toBe(true);
      if (command.args[1] === 'ls') return { stdout: present ? 'container-id\n' : '', stderr: '' };
      return { stdout: inspectJson(connector), stderr: '' };
    });

    await expect(inspectCloudflareConnector(connector, runner)).resolves.toEqual(
      present ? observed(connector) : undefined,
    );
    expect(runner).toHaveBeenCalledTimes(present ? 2 : 1);
    await expect(stat(connector.rootDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts only the exact owned connector specification', async () => {
    const connector = await layout('macos');
    expect(() => validateObservedCloudflareConnector(connector, observed(connector))).not.toThrow();
    for (const unsafe of [
      observed(connector, { image: 'cloudflare/cloudflared:latest' }),
      observed(connector, { command: ['tunnel', 'run', 'secret-on-argv'] }),
      observed(connector, { environment: ['TUNNEL_TOKEN=connector-token-canary'] }),
      observed(connector, {
        mounts: [
          ...observed(connector).mounts,
          { type: 'bind', source: '/var/run/docker.sock', destination: '/var/run/docker.sock', readOnly: false },
        ],
      }),
      observed(connector, { networkMode: 'host' }),
      observed(connector, { owner: 'foreign' }),
      observed(connector, { user: '65532:65532' }),
      observed(connector, { readOnlyRootFilesystem: false }),
      observed(connector, { privileged: true }),
      observed(connector, { restarting: true }),
    ]) {
      expect(() => validateObservedCloudflareConnector(connector, unsafe)).toThrow();
    }
  });

  it('adopts and restarts only an exact connector without exposing its token to Docker argv or environment', async () => {
    const connector = await layout('linux');
    const canary = 'connector-token-canary';
    const calls: SanitizedCommand[] = [];
    const runner = vi.fn(async (command: SanitizedCommand) => {
      calls.push(command);
      if (command.args[0] === 'container' && command.args[1] === 'ls') return { stdout: 'container-id\n', stderr: '' };
      if (command.args[0] === 'container' && command.args[1] === 'inspect') {
        return { stdout: inspectJson(connector), stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const stabilityDelay = vi.fn(async () => undefined);
    await reconcileCloudflareConnector(connector, canary, {
      runCommand: runner,
      ambientEnv: { PATH: '/safe/bin' },
      stabilityDelay,
    });
    await reconcileCloudflareConnector(connector, canary, {
      runCommand: runner,
      ambientEnv: { PATH: '/safe/bin' },
      stabilityDelay,
    });

    const upCalls = calls.filter((call) => call.args.includes('up'));
    expect(upCalls).toHaveLength(2);
    expect(stabilityDelay).toHaveBeenCalledTimes(2);
    expect(calls.map((call) => JSON.stringify(call))).not.toContainEqual(expect.stringContaining(canary));
    expect(await readFile(connector.tokenFile, 'utf8')).toBe(canary);
    expect(buildCloudflareComposeInvocation(connector, ['up']).args).not.toContain(canary);
  });

  it('rejects a connector that enters a restart loop immediately after startup', async () => {
    const connector = await layout('macos');
    let lists = 0;
    let inspections = 0;
    const runner = vi.fn(async (command: SanitizedCommand) => {
      if (command.args[0] === 'container' && command.args[1] === 'ls') {
        lists += 1;
        return { stdout: lists === 1 ? '' : 'container-id\n', stderr: '' };
      }
      if (command.args[0] === 'container' && command.args[1] === 'inspect') {
        inspections += 1;
        const runtime = JSON.parse(inspectJson(connector)) as Array<Record<string, unknown>>;
        if (inspections === 2) record(runtime[0]?.State).Restarting = true;
        return { stdout: JSON.stringify(runtime), stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(
      reconcileCloudflareConnector(connector, 'connector-token', {
        runCommand: runner,
        stabilityDelay: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'unhealthy_connector' });
  });

  it('refuses a wrong existing spec before compose can replace it and stops only an owned connector', async () => {
    const connector = await layout('macos');
    const wrong = JSON.parse(inspectJson(connector)) as Array<Record<string, unknown>>;
    record(wrong[0]?.Config).Image = 'cloudflare/cloudflared:latest';
    let inspection = JSON.stringify(wrong);
    let stopped = false;
    const calls: SanitizedCommand[] = [];
    const runner = vi.fn(async (command: SanitizedCommand) => {
      calls.push(command);
      if (command.args[0] === 'container' && command.args[1] === 'ls') {
        return { stdout: stopped ? '' : 'container-id\n', stderr: '' };
      }
      if (command.args[0] === 'container' && command.args[1] === 'inspect') return { stdout: inspection, stderr: '' };
      if (command.args.includes('down')) stopped = true;
      return { stdout: '', stderr: '' };
    });

    await expect(reconcileCloudflareConnector(connector, 'token', { runCommand: runner })).rejects.toMatchObject({
      code: 'unsafe_connector_image',
    });
    expect(calls.some((call) => call.args.includes('up'))).toBe(false);
    await expect(readFile(connector.tokenFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    calls.length = 0;
    inspection = inspectJson(connector);
    await stopCloudflareConnector(connector, { runCommand: runner });
    expect(calls.some((call) => call.args.includes('down'))).toBe(true);
  });
});
