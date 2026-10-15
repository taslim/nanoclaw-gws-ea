import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { browserPaths } from '../modules/gws-ea-browser/paths.js';
import { readBrowserPolicy } from '../modules/gws-ea-browser/policy.js';
import { BrowserVault } from '../modules/gws-ea-browser/onepassword.js';
import { enableBrowserCapability, disableBrowserCapability, inspectBrowserCapability } from './browser-capability.js';
import { runCli } from './cli.js';
import { deriveGcpClaims } from './gcp-identity.js';
import { reserveInstance } from './journal.js';
import { createOnecliRuntimeLayout } from './onecli-compose.js';
import { resolveControlPlanePaths } from './paths.js';
import { runSanitizedCommandOutcome, type SanitizedCommand } from './process.js';
import { createInstanceRuntimeConfig, persistInstanceRuntime } from './service.js';
import { expectResultContract } from './testing/result-contract.js';
import { GwsEaError } from './types.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'browser-capability-')));
  roots.push(root);
  const paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'config'),
    stateRoot: path.join(root, 'state'),
  });
  const instanceId = randomUUID();
  const reservation = await reserveInstance(paths, {
    instance_id: instanceId,
    release_track: 'dogfood',
    source_remote: 'https://example.test/repo.git',
    deployed_commit: 'a'.repeat(40),
    allocated_ports: { onecli_app: 31002, onecli_gateway: 31003 },
    exclusive_resource_claims: {
      ...deriveGcpClaims(instanceId),
      gcp_account: 'operator@example.test',
      workspace_email: 'assistant@example.test',
      onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
    },
  });
  const onecli = createOnecliRuntimeLayout({
    instanceId,
    instanceRoot: paths.instanceRoot(instanceId),
    project: reservation.exclusive_resource_claims.onecli_project,
    appPort: 31002,
    gatewayPort: 31003,
    dockerEndpoint: 'unix:///var/run/docker.sock',
  });
  const runtime = createInstanceRuntimeConfig(paths, reservation, onecli, {
    nodePath: process.execPath,
    homeDirectory: root,
    selectedProvider: 'claude',
    dockerEndpoint: 'unix:///var/run/docker.sock',
  });
  await persistInstanceRuntime(runtime, () => undefined);
  const browser = browserPaths(path.join(runtime.instance_root, 'browser', 'policy.json'));
  return { root, paths, instanceId, runtime, browser };
}

const chrome = async (command: SanitizedCommand) => {
  if (command.args.join(' ') !== '--version') throw new Error('Unexpected process');
  return { stdout: 'Google Chrome 141.0.0.0\n', stderr: '', exitCode: 0 };
};

describe('assistant browser capability', () => {
  it('enables email sign-in without a token, is idempotent, and leaves vault filling unavailable', async () => {
    const f = await fixture();
    const promptToken = vi.fn(async () => 'must-not-be-requested');
    const first = await enableBrowserCapability(f.paths, f.instanceId, {}, { promptToken });
    expect(first).toMatchObject({ enabled: true, credential_mode: 'email', changed: true });
    expect(await readBrowserPolicy(f.browser.policyFile)).toMatchObject({ enabled: true, credentialMode: 'email' });
    expect((await stat(f.browser.root)).mode & 0o777).toBe(0o700);
    expect((await stat(f.browser.policyFile)).mode & 0o777).toBe(0o600);
    await expect(stat(f.browser.tokenFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await enableBrowserCapability(f.paths, f.instanceId, {}, { promptToken })).toMatchObject({ changed: false });
    expect(promptToken).not.toHaveBeenCalled();
    await expect(new BrowserVault(f.browser.policyFile).itemsForOrigin('https://example.com')).rejects.toMatchObject({
      reason: 'vault_unavailable',
    });
    const shown = await inspectBrowserCapability(f.paths, f.instanceId);
    expect(shown.vault).toMatchObject({ status: 'not_configured' });
  });

  it('stores stdin tokens owner-only before publishing enabled policy, without returning the token', async () => {
    const f = await fixture();
    const effects: unknown[] = [];
    const token = 'op-service-account-secret-test';
    const result = await enableBrowserCapability(
      f.paths,
      f.instanceId,
      { credentialMode: '1password', tokenStdin: true },
      {
        stdin: Readable.from([token, '\n']),
        recordEffect: async (changed) => {
          if (changed)
            effects.push({
              token: await readFile(f.browser.tokenFile, 'utf8'),
              policy: await readBrowserPolicy(f.browser.policyFile),
            });
        },
      },
    );
    expect(effects[0]).toMatchObject({ token, policy: { enabled: false } });
    expect((await stat(path.dirname(f.browser.tokenFile))).mode & 0o777).toBe(0o700);
    expect((await stat(f.browser.tokenFile)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(await enableBrowserCapability(f.paths, f.instanceId)).toMatchObject({
      credential_mode: '1password',
      changed: false,
    });
  });

  it('uses the hidden prompt only for selected 1Password and pauses without an input source', async () => {
    const f = await fixture();
    await expect(enableBrowserCapability(f.paths, f.instanceId, { credentialMode: '1password' })).rejects.toMatchObject(
      { code: 'browser_token_required' },
    );
    await expect(stat(f.browser.policyFile)).rejects.toMatchObject({ code: 'ENOENT' });
    const promptToken = vi.fn(async () => 'hidden-service-token');
    await enableBrowserCapability(f.paths, f.instanceId, { credentialMode: '1password' }, { promptToken });
    expect(promptToken).toHaveBeenCalledOnce();
  });

  it('disables policy before deleting the token and returns provider revocation guidance', async () => {
    const f = await fixture();
    await enableBrowserCapability(
      f.paths,
      f.instanceId,
      { credentialMode: '1password' },
      { promptToken: async () => 'hidden-service-token' },
    );
    const seen: unknown[] = [];
    const result = await disableBrowserCapability(f.paths, f.instanceId, {
      recordEffect: async (changed) => {
        if (changed)
          seen.push({
            policy: await readBrowserPolicy(f.browser.policyFile),
            token: await readFile(f.browser.tokenFile, 'utf8').catch(() => null),
          });
      },
    });
    expect(seen[0]).toMatchObject({ policy: { enabled: false }, token: 'hidden-service-token' });
    await expect(stat(f.browser.tokenFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.provider_revocation_required).toBe(true);
    expect(await disableBrowserCapability(f.paths, f.instanceId)).toMatchObject({ changed: false });
  });

  it('drops the optional token when switching to email and returns revocation guidance', async () => {
    const f = await fixture();
    await enableBrowserCapability(
      f.paths,
      f.instanceId,
      { credentialMode: '1password' },
      { promptToken: async () => 'switching-mode-service-token' },
    );
    const result = await enableBrowserCapability(f.paths, f.instanceId, { credentialMode: 'email' });
    expect(result).toMatchObject({ enabled: true, credential_mode: 'email', provider_revocation_required: true });
    await expect(stat(f.browser.tokenFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports Chrome missing and host-down isolation as not_run without writing anything', async () => {
    const f = await fixture();
    await enableBrowserCapability(f.paths, f.instanceId);
    const before = await readFile(f.browser.policyFile, 'utf8');
    const result = await inspectBrowserCapability(f.paths, f.instanceId, {
      check: true,
      runCommand: async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      ncl: async () => {
        throw new Error('host down');
      },
    });
    expect(result.chrome.status).toBe('unavailable');
    expect(result.isolation.status).toBe('not_run');
    expect(result.ready).toBe(false);
    expect(await readFile(f.browser.policyFile, 'utf8')).toBe(before);
  });

  it('distinguishes an optional absent vault from a configured missing or inaccessible token', async () => {
    const f = await fixture();
    await enableBrowserCapability(
      f.paths,
      f.instanceId,
      { credentialMode: '1password' },
      { promptToken: async () => 'hidden-service-token' },
    );
    await chmod(f.browser.tokenFile, 0o644);
    expect((await inspectBrowserCapability(f.paths, f.instanceId)).vault.status).toBe('unavailable');
    await rm(f.browser.tokenFile);
    expect((await inspectBrowserCapability(f.paths, f.instanceId)).vault.status).toBe('unavailable');
  });

  it.each([false, true])('probes the actual host gateway on the assistant network; reachable=%s', async (reachable) => {
    const f = await fixture();
    await enableBrowserCapability(f.paths, f.instanceId);
    const commands: SanitizedCommand[] = [];
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('No TCP listener');
    const port = address.port;
    if (!reachable)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    try {
      const result = await inspectBrowserCapability(f.paths, f.instanceId, {
        check: true,
        ncl: async (_runtime, args) => {
          expect(args).toEqual(['gws-ea-browser-health']);
          return { schemaVersion: 1, enabled: true, proxy: { state: 'listening', port } };
        },
        runCommand: async (command) => {
          commands.push(command);
          if (command.command !== 'docker') return chrome(command);
          const script = command.args.at(-1);
          if (!script) throw new Error('No container probe script');
          // Execute the emitted TCP probe; supply the container-only host mapping locally.
          const mapping =
            "require('node:dns').lookup=(_host,options,callback)=>callback(null,options.all?[{address:'127.0.0.1',family:4}]:'127.0.0.1',4);";
          return runSanitizedCommandOutcome({
            command: process.execPath,
            args: ['--eval', mapping + script],
            cwd: f.root,
            timeoutMs: 10_000,
          });
        },
      });
      expect(result.isolation.status).toBe(reachable ? 'failed' : 'passed');
      expect(result.vault.status).toBe('not_configured');
      expect(result.ready).toBe(!reachable);
      const probe = commands.find((command) => command.command === 'docker');
      expect(probe?.args).toEqual(
        expect.arrayContaining([
          '--pull=never',
          '--network',
          f.runtime.agent_egress_network,
          '--add-host=gws-ea-browser-host:host-gateway',
        ]),
      );
      expect(probe?.env?.DOCKER_HOST).toBe(f.runtime.docker_endpoint);
      expect(probe?.args.join(' ')).toContain(String(port));
      expect(probe?.args.join(' ')).not.toContain('host.docker.internal');
    } finally {
      if (server.listening)
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it.each(['disabled', 'unavailable'] as const)(
    'does not report a host with %s browser runtime as ready',
    async (state) => {
      const f = await fixture();
      await enableBrowserCapability(f.paths, f.instanceId);
      const result = await inspectBrowserCapability(f.paths, f.instanceId, {
        check: true,
        ncl: async () => ({
          schemaVersion: 1,
          enabled: state !== 'disabled',
          proxy: { state: 'listening', port: 41444 },
          chrome: { state: state === 'unavailable' ? 'unavailable' : 'stopped' },
        }),
        runCommand: async (command) =>
          command.command === 'docker' ? { stdout: '{"reachable":false}', stderr: '', exitCode: 0 } : chrome(command),
      });
      expect(result.ready).toBe(false);
      if (state === 'disabled') expect(result.isolation.status).toBe('not_run');
      else
        expect(result.chrome).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('running host') });
    },
  );

  it('never reports a failed probe launch as passed', async () => {
    const f = await fixture();
    await enableBrowserCapability(f.paths, f.instanceId);
    const result = await inspectBrowserCapability(f.paths, f.instanceId, {
      check: true,
      ncl: async () => ({ schemaVersion: 1, enabled: true, proxy: { state: 'listening', port: 41444 } }),
      runCommand: async (command) =>
        command.command === 'docker' ? { stdout: '', stderr: 'image missing', exitCode: 125 } : chrome(command),
    });
    expect(result.isolation.status).toBe('unknown');
    expect(result.ready).toBe(false);
  });

  it('returns the native JSON outcome and never prompts in JSON mode', async () => {
    const f = await fixture();
    const stdout: string[] = [];
    const promptBrowserToken = vi.fn(async () => 'never-read-this-token');
    expect(
      await runCli(
        ['capabilities', 'enable', 'browser', '--id', f.instanceId, '--credential-mode', '1password', '--json'],
        { paths: f.paths, stdout: (line) => stdout.push(line), stderr: () => undefined, promptBrowserToken },
      ),
    ).toBe(10);
    expect(JSON.parse(stdout.join('\n'))).toMatchObject({
      command: 'capabilities enable browser',
      outcome: 'paused',
      changed: false,
      error: { code: 'browser_token_required' },
    });
    expect(promptBrowserToken).not.toHaveBeenCalled();
    expectResultContract('capabilities enable browser', JSON.parse(stdout.join('\n')));
  });

  it('rejects token-stdin on a terminal without waiting for keyboard input', async () => {
    const f = await fixture();
    const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    try {
      await expect(
        enableBrowserCapability(f.paths, f.instanceId, { credentialMode: '1password', tokenStdin: true }),
      ).rejects.toMatchObject({ code: 'invalid_arguments' });
    } finally {
      if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
    }
  });

  it('handles hidden-prompt cancellation as an unchanged decline', async () => {
    const f = await fixture();
    const stdout: string[] = [];
    expect(
      await runCli(['capabilities', 'enable', 'browser', '--id', f.instanceId, '--credential-mode', '1password'], {
        paths: f.paths,
        stdout: (line) => stdout.push(line),
        stderr: () => undefined,
        promptBrowserToken: async () => {
          throw new GwsEaError('cancelled', 'Browser enablement cancelled.');
        },
      }),
    ).toBe(0);
    await expect(stat(f.browser.policyFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('publishes complete native result schemas for successful lifecycle and failed checks', async () => {
    const f = await fixture();
    for (const command of ['enable', 'show', 'check', 'disable'] as const) {
      const stdout: string[] = [];
      const exit = await runCli(['capabilities', command, 'browser', '--id', f.instanceId, '--json'], {
        paths: f.paths,
        stdout: (line) => stdout.push(line),
        stderr: () => undefined,
        browserInspection: {
          runCommand: chrome,
          ncl: async () => {
            throw new Error('host down');
          },
        },
      });
      expect(exit).toBe(command === 'check' ? 1 : 0);
      const result: unknown = JSON.parse(stdout.join('\n'));
      expectResultContract(`capabilities ${command} browser`, result);
      expect(result).toMatchObject({
        changed: command === 'enable' || command === 'disable',
        command: `capabilities ${command} browser`,
      });
    }
    const stdout: string[] = [];
    expect(
      await runCli(['capabilities', 'list', '--json'], {
        paths: f.paths,
        stdout: (line) => stdout.push(line),
        stderr: () => undefined,
      }),
    ).toBe(0);
    expectResultContract('capabilities list', JSON.parse(stdout.join('\n')));
  });
});
