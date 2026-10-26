import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectBrowserIsolation } from './browser-isolation.js';
import { deriveGcpClaims } from './gcp-identity.js';
import { reserveInstance } from './journal.js';
import { resolveControlPlanePaths } from './paths.js';
import { persistTestRuntime } from './testing/runtime-fixture.js';
import { runSanitizedCommandOutcome, type SanitizedCommand } from './process.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'browser-isolation-')));
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
  const runtime = await persistTestRuntime(paths, reservation);
  return { root, paths, instanceId, runtime };
}
const chrome = async (_command: SanitizedCommand) => ({ stdout: 'Google Chrome 141.0.0.0\n', stderr: '', exitCode: 0 });
describe('browser network-isolation observation', () => {
  it('reports Chrome missing and unobservable host isolation without writing anything', async () => {
    const f = await fixture();
    const result = await inspectBrowserIsolation(f.paths, f.instanceId, {
      check: true,
      runCommand: async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      ncl: async () => {
        throw new Error('host down: ws://127.0.0.1:41444/devtools/browser/private-fixture-id');
      },
    });
    expect(result.chrome.status).toBe('unavailable');
    expect(result.isolation.status).toBe('unknown');
    expect(result.ready).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private-fixture-id');
  });

  it.each([
    { proxyReachable: false, debuggerReachable: false },
    { proxyReachable: true, debuggerReachable: false },
    { proxyReachable: false, debuggerReachable: true },
  ])('probes both host listeners on the assistant network: %j', async ({ proxyReachable, debuggerReachable }) => {
    const f = await fixture();
    const commands: SanitizedCommand[] = [];
    const listeners = await Promise.all(
      [proxyReachable, debuggerReachable].map(async (reachable) => {
        const server = createServer((socket) => socket.end());
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (address === null || typeof address === 'string') throw new Error('No TCP listener');
        if (!reachable)
          await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        return { server, port: address.port };
      }),
    );
    const [proxy, debuggerListener] = listeners;
    try {
      const result = await inspectBrowserIsolation(f.paths, f.instanceId, {
        check: true,
        ncl: async (_runtime, args) => {
          expect(args).toEqual(['gws-ea-browser-health']);
          return {
            schemaVersion: 1,
            available: true,
            proxy: { state: 'listening', port: proxy!.port },
            chrome: { state: 'running', pid: 12345, debuggerPort: debuggerListener!.port },
          };
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
      expect(result.isolation).toMatchObject({
        status: proxyReachable || debuggerReachable ? 'failed' : 'passed',
        proxy: { status: proxyReachable ? 'failed' : 'passed' },
        debugger: { status: debuggerReachable ? 'failed' : 'passed' },
      });
      expect(result.ready).toBe(!proxyReachable && !debuggerReachable);
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
      for (const listener of listeners) expect(probe?.args.join(' ')).toContain(String(listener.port));
      expect(probe?.args.join(' ')).not.toContain('host.docker.internal');
    } finally {
      for (const { server } of listeners)
        if (server.listening)
          await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it('keeps idle Chrome stopped and reports debugger proof as not_run', async () => {
    const f = await fixture();
    const calls: string[][] = [];
    const result = await inspectBrowserIsolation(f.paths, f.instanceId, {
      check: true,
      ncl: async (_runtime, args) => {
        calls.push([...args]);
        return {
          schemaVersion: 1,
          available: true,
          proxy: { state: 'listening', port: 41444 },
          chrome: { state: 'stopped' },
        };
      },
      runCommand: async (command) =>
        command.command === 'docker' ? { stdout: '{"proxy":false}', stderr: '', exitCode: 0 } : chrome(command),
    });
    expect(result).toMatchObject({
      ready: true,
      isolation: { status: 'passed', proxy: { status: 'passed' }, debugger: { status: 'not_run' } },
    });
    expect(calls).toEqual([['gws-ea-browser-health'], ['gws-ea-browser-health']]);
  });

  it.each([
    undefined,
    { state: 'starting' },
    { state: 'running', pid: 12345 },
    { state: 'running', pid: 12345, debuggerPort: 0 },
  ])('does not infer debugger isolation from incomplete running state: %j', async (hostChrome) => {
    const f = await fixture();
    const result = await inspectBrowserIsolation(f.paths, f.instanceId, {
      check: true,
      ncl: async () => ({
        schemaVersion: 1,
        available: true,
        proxy: { state: 'listening', port: 41444 },
        chrome: hostChrome,
      }),
      runCommand: async (command) =>
        command.command === 'docker' ? { stdout: '{"proxy":false}', stderr: '', exitCode: 0 } : chrome(command),
    });
    expect(result).toMatchObject({ ready: false, isolation: { status: 'unknown', debugger: { status: 'unknown' } } });
  });

  it.each([
    { beforeChrome: { state: 'stopped' }, proxy: { state: 'listening', port: 41445 }, chrome: { state: 'stopped' } },
    {
      beforeChrome: { state: 'stopped' },
      proxy: { state: 'listening', port: 41444 },
      chrome: { state: 'running', pid: 12345, debuggerPort: 41445 },
    },
    {
      beforeChrome: { state: 'running', pid: 12345, debuggerPort: 41445 },
      proxy: { state: 'listening', port: 41444 },
      chrome: { state: 'running', pid: 12346, debuggerPort: 41445 },
    },
  ])(
    'invalidates a probe if its target set changes before the second health read: %j',
    async ({ beforeChrome, ...after }) => {
      const f = await fixture();
      let reads = 0;
      const result = await inspectBrowserIsolation(f.paths, f.instanceId, {
        check: true,
        ncl: async () => ({
          schemaVersion: 1,
          available: true,
          ...(reads++ === 0 ? { proxy: { state: 'listening', port: 41444 }, chrome: beforeChrome } : after),
        }),
        runCommand: async (command) =>
          command.command === 'docker'
            ? { stdout: '{"proxy":false,"debugger":false}', stderr: '', exitCode: 0 }
            : chrome(command),
      });
      expect(reads).toBe(2);
      expect(result).toMatchObject({ ready: false, isolation: { status: 'unknown' } });
    },
  );

  it.each(['disabled', 'unavailable'] as const)(
    'does not report a host with %s browser runtime as ready',
    async (state) => {
      const f = await fixture();
      const result = await inspectBrowserIsolation(f.paths, f.instanceId, {
        check: true,
        ncl: async () => ({
          schemaVersion: 1,
          available: state !== 'disabled',
          proxy: { state: 'listening', port: 41444 },
          chrome: { state: state === 'unavailable' ? 'unavailable' : 'stopped' },
        }),
        runCommand: async (command) =>
          command.command === 'docker' ? { stdout: '{"proxy":false}', stderr: '', exitCode: 0 } : chrome(command),
      });
      expect(result.ready).toBe(false);
      if (state === 'disabled') expect(result.isolation.status).toBe('not_run');
      else
        expect(result.chrome).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('running host') });
    },
  );

  it('never reports a failed probe launch as passed', async () => {
    const f = await fixture();
    const result = await inspectBrowserIsolation(f.paths, f.instanceId, {
      check: true,
      ncl: async () => ({
        schemaVersion: 1,
        available: true,
        proxy: { state: 'listening', port: 41444 },
        chrome: { state: 'stopped' },
      }),
      runCommand: async (command) =>
        command.command === 'docker' ? { stdout: '', stderr: 'image missing', exitCode: 125 } : chrome(command),
    });
    expect(result.isolation.status).toBe('unknown');
    expect(result.ready).toBe(false);
  });
});
