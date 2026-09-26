import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { processLockOwner } from '../community-portal/process-lock.js';
import {
  CLOUDFLARE_CONNECTOR_OWNER_LABEL,
  CLOUDFLARE_CONNECTOR_ROLE_LABEL,
  CLOUDFLARE_CONNECTOR_TOKEN_LABEL,
  createCloudflareConnectorLayout,
  hasConnectorToken,
  inspectCloudflareConnector,
  observeCloudflareConnector,
  renderCloudflareConnectorCompose,
  repairCloudflareConnector,
  stopCloudflareConnector,
  storeConnectorToken,
  type CloudflareConnectorLayout,
} from './cloudflare-connector.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { PRESENT } from './phases.js';
import { CLOUDFLARED_IMAGE } from './pins.js';
import type { SanitizedCommand } from './process.js';
import { GwsEaError } from './types.js';

const TOKEN = 'connector-token-canary';
const DIGEST = createHash('sha256').update(TOKEN).digest('hex');
const IMAGE_ENVIRONMENT = [
  'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  'SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt',
];
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

type Json = Record<string, unknown>;

async function fixture(platform: 'macos' | 'linux' = 'linux'): Promise<{
  paths: ControlPlanePaths;
  layout: CloudflareConnectorLayout;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-cloudflared-'));
  roots.push(root);
  const paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'config'),
    stateRoot: path.join(root, 'state'),
  });
  await mkdir(paths.stateRoot);
  return {
    paths,
    layout: createCloudflareConnectorLayout({
      cloudflareRoot: paths.cloudflareRoot,
      platform,
      ownerUid: 501,
      ownerGid: 20,
    }),
  };
}

/** `docker container inspect` output for the connector Compose creates from the rendered file. */
function inspection(layout: CloudflareConnectorLayout, change: (container: Json) => void = () => undefined): Json {
  const container: Json = {
    Id: 'c0ffee',
    Name: '/gws-ea-cloudflare-connector-1',
    RestartCount: 0,
    Config: {
      Image: CLOUDFLARED_IMAGE,
      User: layout.runtimeUser,
      Cmd: ['tunnel', '--no-autoupdate', 'run', '--token-file', '/run/secrets/tunnel_token'],
      Env: [...IMAGE_ENVIRONMENT],
      Labels: {
        'com.docker.compose.project': layout.project,
        'com.docker.compose.service': 'connector',
        'com.docker.compose.version': '2.39.1',
        [CLOUDFLARE_CONNECTOR_OWNER_LABEL]: 'shared-cloudflare-ingress',
        [CLOUDFLARE_CONNECTOR_ROLE_LABEL]: 'connector',
        [CLOUDFLARE_CONNECTOR_TOKEN_LABEL]: DIGEST,
      },
    },
    State: { Status: 'running', Running: true, Paused: false, Restarting: false, ExitCode: 0 },
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      ReadonlyRootfs: true,
      Privileged: false,
      CapAdd: null,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      NetworkMode: layout.platform === 'linux' ? 'host' : 'bridge',
      ExtraHosts: layout.platform === 'macos' ? ['host.docker.internal:host-gateway'] : null,
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=16m,mode=1777' },
      PortBindings: {},
    },
    Mounts: [
      {
        Type: 'bind',
        Source: layout.tokenFile,
        Destination: '/run/secrets/tunnel_token',
        Mode: '',
        RW: false,
        Propagation: 'rprivate',
      },
    ],
  };
  change(container);
  return container;
}

/** A Docker CLI that answers from one container, or none, and records whether each pull and up held the machine lock. */
function docker(initial: Json | undefined, paths?: ControlPlanePaths) {
  let container = initial;
  const calls: SanitizedCommand[] = [];
  const locking: Array<readonly ['pull' | 'up', boolean]> = [];
  const lockHeld = () => paths !== undefined && processLockOwner(paths.registryLock)?.pid === process.pid;
  const run = vi.fn(async (command: SanitizedCommand) => {
    // Like the real runner, refuse a working directory that does not exist.
    if (!(await stat(command.cwd).catch(() => undefined))?.isDirectory()) {
      throw new Error(`Working directory ${command.cwd} is unavailable`);
    }
    calls.push(command);
    const [first, second] = command.args;
    if (first === 'container' && second === 'ls') return { stdout: container ? 'c0ffee\n' : '', stderr: '' };
    if (first === 'container' && second === 'inspect') return { stdout: JSON.stringify([container]), stderr: '' };
    if (first === 'image' && second === 'inspect') return { stdout: JSON.stringify(IMAGE_ENVIRONMENT), stderr: '' };
    if (first === 'pull') locking.push(['pull', lockHeld()]);
    if (command.args.includes('up')) {
      locking.push(['up', lockHeld()]);
      container = { ...(container ?? {}), ...upResult };
    }
    if (command.args.includes('down')) container = undefined;
    return { stdout: '', stderr: '' };
  });
  let upResult: Json = {};
  return {
    run,
    calls,
    locking,
    set afterUp(value: Json) {
      upResult = value;
    },
    get container() {
      return container;
    },
  };
}

describe('shared Cloudflare connector', () => {
  it.each(['macos', 'linux'] as const)(
    'renders the hardened %s connector with a token digest, not the token',
    async (platform) => {
      const { layout } = await fixture(platform);
      const source = renderCloudflareConnectorCompose(layout, DIGEST);
      const compose = parseYaml(source) as Json;
      const service = (compose.services as Json).connector as Json;

      expect(service).toMatchObject({
        image: CLOUDFLARED_IMAGE,
        command: ['tunnel', '--no-autoupdate', 'run', '--token-file', '/run/secrets/tunnel_token'],
        user: '501:20',
        restart: 'unless-stopped',
        read_only: true,
        cap_drop: ['ALL'],
        security_opt: ['no-new-privileges:true'],
        tmpfs: ['/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777'],
        network_mode: platform === 'linux' ? 'host' : 'bridge',
        labels: {
          [CLOUDFLARE_CONNECTOR_OWNER_LABEL]: 'shared-cloudflare-ingress',
          [CLOUDFLARE_CONNECTOR_ROLE_LABEL]: 'connector',
          [CLOUDFLARE_CONNECTOR_TOKEN_LABEL]: DIGEST,
        },
      });
      expect(((compose.secrets as Json).tunnel_token as Json).file).toBe(layout.tokenFile);
      expect(service.extra_hosts ?? []).toEqual(platform === 'macos' ? ['host.docker.internal:host-gateway'] : []);
      expect(service).not.toHaveProperty('ports');
      expect(service).not.toHaveProperty('environment');
      expect(source).not.toContain(TOKEN);
      expect(source).not.toContain('/var/run/docker.sock');
    },
  );

  it('stores the connector token owner-only outside assistant checkouts, replacing a rotated one', async () => {
    const { layout } = await fixture();
    await expect(hasConnectorToken(layout)).resolves.toBe(false);

    await storeConnectorToken(layout, TOKEN);
    expect(await readFile(layout.tokenFile, 'utf8')).toBe(TOKEN);
    expect((await stat(layout.tokenFile)).mode & 0o777).toBe(0o600);
    expect((await stat(layout.rootDirectory)).mode & 0o777).toBe(0o700);
    expect(layout.rootDirectory).not.toContain(`${path.sep}instances${path.sep}`);
    await expect(hasConnectorToken(layout)).resolves.toBe(true);

    await storeConnectorToken(layout, 'rotated-connector-token');
    expect(await readFile(layout.tokenFile, 'utf8')).toBe('rotated-connector-token');
    await expect(storeConnectorToken(layout, ' padded ')).rejects.toMatchObject({ code: 'invalid_connector_token' });
  });

  it.each([false, true])('inspects before its private directory exists (connector present: %s)', async (present) => {
    const { layout } = await fixture();
    const cli = docker(present ? inspection(layout) : undefined);

    const observed = await inspectCloudflareConnector(layout, cli.run);
    expect(observed === undefined).toBe(!present);
    expect(cli.run).toHaveBeenCalledTimes(present ? 2 : 1);
    await expect(stat(layout.rootDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  describe('observation', () => {
    async function observe(change?: (container: Json) => void, present = true) {
      const { layout } = await fixture();
      await storeConnectorToken(layout, TOKEN);
      const cli = docker(present ? inspection(layout, change) : undefined);
      return observeCloudflareConnector(layout, { runCommand: cli.run });
    }

    it('finds the exact running connector present', async () => {
      await expect(observe()).resolves.toEqual(PRESENT);
    });

    it('finds a missing or stopped connector absent, so it is repaired', async () => {
      await expect(observe(undefined, false)).resolves.toEqual({
        status: 'absent',
        reason: 'it has not been created',
      });
      await expect(
        observe((container) => {
          container.State = { Status: 'exited', Running: false, Restarting: false, ExitCode: 0 };
        }),
      ).resolves.toEqual({ status: 'absent', reason: 'it is exited' });
    });

    it('cannot tell yet while the connector is restarting', async () => {
      await expect(
        observe((container) => {
          container.State = { Status: 'restarting', Running: true, Restarting: true, ExitCode: 1 };
          container.RestartCount = 4;
        }),
      ).resolves.toEqual({
        status: 'unknown',
        reason: 'The Cloudflare connector is restarting',
        evidence: 'state restarting, exit code 1, 4 restarts',
      });
    });

    it.each([
      {
        label: 'a cloudflared pin bump',
        change: (container: Json) => {
          (container.Config as Json).Image = `cloudflare/cloudflared:2026.8.0@sha256:${'1'.repeat(64)}`;
        },
        // The validated pin's only regular-expression metacharacter is the dot.
        reason: new RegExp(
          `runs cloudflare/cloudflared:2026\\.8\\.0@.*, not the pinned ${CLOUDFLARED_IMAGE.replaceAll('.', '\\.')}$`,
          'u',
        ),
      },
      {
        label: 'environment drift',
        change: (container: Json) => {
          (container.Config as Json).Env = [...IMAGE_ENVIRONMENT, `TUNNEL_TOKEN=${TOKEN}`];
        },
        reason: /environment its image does not set: TUNNEL_TOKEN$/u,
      },
      {
        label: 'a rotated connector token',
        change: (container: Json) => {
          ((container.Config as Json).Labels as Json)[CLOUDFLARE_CONNECTOR_TOKEN_LABEL] = 'f'.repeat(64);
        },
        reason: /was started with a different connector token/u,
      },
      {
        label: 'token-file mount drift',
        change: (container: Json) => {
          (container.Mounts as Json[])[0]!.Source = '/tmp/elsewhere';
        },
        reason: /does not mount exactly its token file/u,
      },
      {
        label: 'security drift',
        change: (container: Json) => {
          (container.HostConfig as Json).Privileged = true;
        },
        reason: /security settings differ/u,
      },
    ])('finds $label absent, so the owned connector is recreated', async ({ change, reason }) => {
      const observed = await observe(change);
      expect(observed).toMatchObject({ status: 'absent', reason: expect.stringMatching(reason) });
      expect(JSON.stringify(observed)).not.toContain(TOKEN);
    });

    it.each([
      {
        label: 'a foreign owner label',
        change: (container: Json) => {
          ((container.Config as Json).Labels as Json)[CLOUDFLARE_CONNECTOR_OWNER_LABEL] = 'someone-else';
        },
      },
      {
        label: 'another Compose service',
        change: (container: Json) => {
          ((container.Config as Json).Labels as Json)['com.docker.compose.service'] = 'sidecar';
        },
      },
    ])('refuses a connector with $label instead of recreating it', async ({ change }) => {
      await expect(observe(change)).rejects.toMatchObject({ code: 'unsafe_connector_owner' });
    });
  });

  describe('repair', () => {
    it('pulls a missing image outside the lock, then recreates the connector under the machine lock', async () => {
      const { paths, layout } = await fixture();
      await storeConnectorToken(layout, TOKEN);
      const cli = docker(undefined, paths);
      cli.afterUp = inspection(layout);

      await repairCloudflareConnector(paths, layout, { runCommand: cli.run, ambientEnv: { PATH: '/usr/bin' } });

      const commands = cli.calls.map((call) => call.args.filter((arg) => !arg.startsWith('/')));
      expect(commands.filter((args) => args[0] === 'pull')).toEqual([['pull', CLOUDFLARED_IMAGE]]);
      expect(commands.find((args) => args.includes('up'))).toEqual(
        expect.arrayContaining(['up', '--detach', '--force-recreate', '--remove-orphans']),
      );
      expect(cli.locking).toEqual([
        ['pull', false],
        ['up', true],
      ]);
      expect(await readFile(layout.composeFile, 'utf8')).toBe(renderCloudflareConnectorCompose(layout, DIGEST));
      expect(JSON.stringify(cli.calls)).not.toContain(TOKEN);
    });

    it('recreates a stopped connector without pulling', async () => {
      const { paths, layout } = await fixture();
      await storeConnectorToken(layout, TOKEN);
      const cli = docker(
        inspection(layout, (container) => {
          container.State = { Status: 'exited', Running: false, Restarting: false, ExitCode: 137 };
        }),
        paths,
      );
      cli.afterUp = inspection(layout);

      await repairCloudflareConnector(paths, layout, { runCommand: cli.run });

      expect(cli.locking).toEqual([['up', true]]);
    });

    it('leaves a connector another run already repaired', async () => {
      const { paths, layout } = await fixture();
      await storeConnectorToken(layout, TOKEN);
      const cli = docker(inspection(layout), paths);

      await repairCloudflareConnector(paths, layout, { runCommand: cli.run });

      expect(cli.calls.some((call) => call.args.includes('up'))).toBe(false);
    });

    it('needs the stored connector token and never asks for another', async () => {
      const { paths, layout } = await fixture();
      const cli = docker(undefined, paths);

      await expect(repairCloudflareConnector(paths, layout, { runCommand: cli.run })).rejects.toMatchObject({
        code: 'cloudflare_connector_token_missing',
      });
      expect(cli.calls).toEqual([]);
    });

    it('refuses to recreate a connector it does not own', async () => {
      const { paths, layout } = await fixture();
      await storeConnectorToken(layout, TOKEN);
      const cli = docker(
        inspection(layout, (container) => {
          ((container.Config as Json).Labels as Json)[CLOUDFLARE_CONNECTOR_OWNER_LABEL] = 'someone-else';
        }),
        paths,
      );

      await expect(repairCloudflareConnector(paths, layout, { runCommand: cli.run })).rejects.toBeInstanceOf(
        GwsEaError,
      );
      expect(cli.calls.some((call) => call.args.includes('up'))).toBe(false);
    });
  });

  it('stops an owned connector even when it has drifted, and never a foreign one', async () => {
    const { layout } = await fixture();
    await storeConnectorToken(layout, TOKEN);
    await writeFile(layout.composeFile, renderCloudflareConnectorCompose(layout, DIGEST), { mode: 0o600 });
    const drifted = docker(
      inspection(layout, (container) => {
        (container.Config as Json).Image = 'cloudflare/cloudflared:latest';
      }),
    );

    await stopCloudflareConnector(layout, { runCommand: drifted.run });
    expect(drifted.calls.some((call) => call.args.includes('down'))).toBe(true);

    const foreign = docker(
      inspection(layout, (container) => {
        ((container.Config as Json).Labels as Json)[CLOUDFLARE_CONNECTOR_OWNER_LABEL] = 'someone-else';
      }),
    );
    await expect(stopCloudflareConnector(layout, { runCommand: foreign.run })).rejects.toMatchObject({
      code: 'unsafe_connector_owner',
    });
    expect(foreign.calls.some((call) => call.args.includes('down'))).toBe(false);
  });
});
