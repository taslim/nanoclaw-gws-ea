import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { browserPaths } from '../modules/gws-ea-browser/paths.js';
import { BROWSER_POLICY_VERSIONS, readBrowserPolicy } from '../modules/gws-ea-browser/policy.js';
import {
  assertBrowserPolicyReadable,
  browserCapabilityLines,
  disableBrowserCapability,
  enableBrowserCapability,
  inspectBrowserCapability,
  releaseBrowserPolicyVersions,
} from './browser-capability.js';
import { runCli } from './cli.js';
import { deriveGcpClaims } from './gcp-identity.js';
import { reserveInstance } from './journal.js';
import { resolveControlPlanePaths } from './paths.js';
import { runSanitizedCommandOutcome, type SanitizedCommand } from './process.js';
import { expectResultContract } from './testing/result-contract.js';
import { persistTestRuntime } from './testing/runtime-fixture.js';
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
  const runtime = await persistTestRuntime(paths, reservation);
  const browser = browserPaths(path.join(runtime.instance_root, 'browser', 'policy.json'));
  return { root, paths, instanceId, runtime, browser };
}

const hostDown = async (): Promise<never> => {
  throw new GwsEaError('command_failed', 'Command failed (exit code 2)');
};

const chrome = async (command: SanitizedCommand) => {
  if (command.args.join(' ') !== '--version') throw new Error('Unexpected process');
  return { stdout: 'Google Chrome 141.0.0.0\n', stderr: '', exitCode: 0 };
};

describe('assistant browser capability', () => {
  it('enables an owner-only policy idempotently', async () => {
    const f = await fixture();
    const first = await enableBrowserCapability(f.paths, f.instanceId);
    expect(first).toMatchObject({ enabled: true, changed: true });
    expect(await readBrowserPolicy(f.browser.policyFile)).toMatchObject({ enabled: true });
    expect((await stat(f.browser.root)).mode & 0o777).toBe(0o700);
    expect((await stat(f.browser.policyFile)).mode & 0o777).toBe(0o600);
    expect(await enableBrowserCapability(f.paths, f.instanceId)).toMatchObject({ changed: false });
  });

  it('persists disabled intent with its effect recorded and is idempotent', async () => {
    const f = await fixture();
    await enableBrowserCapability(f.paths, f.instanceId);
    const seen: unknown[] = [];
    const result = await disableBrowserCapability(f.paths, f.instanceId, {
      recordEffect: async (changed) => {
        if (changed) seen.push(await readBrowserPolicy(f.browser.policyFile));
      },
    });
    expect(result).toMatchObject({ enabled: false, changed: true });
    expect(seen).toEqual([expect.objectContaining({ enabled: false })]);
    expect(await disableBrowserCapability(f.paths, f.instanceId)).toMatchObject({ changed: false });
  });

  it('reports Chrome missing and unobservable host isolation without writing anything', async () => {
    const f = await fixture();
    await enableBrowserCapability(f.paths, f.instanceId);
    const before = await readFile(f.browser.policyFile, 'utf8');
    const result = await inspectBrowserCapability(f.paths, f.instanceId, {
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
    expect(await readFile(f.browser.policyFile, 'utf8')).toBe(before);
  });

  it.each([
    { proxyReachable: false, debuggerReachable: false },
    { proxyReachable: true, debuggerReachable: false },
    { proxyReachable: false, debuggerReachable: true },
  ])('probes both host listeners on the assistant network: %j', async ({ proxyReachable, debuggerReachable }) => {
    const f = await fixture();
    await enableBrowserCapability(f.paths, f.instanceId);
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
      const result = await inspectBrowserCapability(f.paths, f.instanceId, {
        check: true,
        ncl: async (_runtime, args) => {
          expect(args).toEqual(['gws-ea-browser-health']);
          return {
            schemaVersion: 1,
            enabled: true,
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
      expect(browserCapabilityLines(result)).toEqual(
        expect.arrayContaining([
          `  Proxy isolation: ${proxyReachable ? 'failed' : 'passed'}`,
          `  Debugger isolation: ${debuggerReachable ? 'failed' : 'passed'}`,
        ]),
      );
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
    await enableBrowserCapability(f.paths, f.instanceId);
    const calls: string[][] = [];
    const result = await inspectBrowserCapability(f.paths, f.instanceId, {
      check: true,
      ncl: async (_runtime, args) => {
        calls.push([...args]);
        return {
          schemaVersion: 1,
          enabled: true,
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
    await enableBrowserCapability(f.paths, f.instanceId);
    const result = await inspectBrowserCapability(f.paths, f.instanceId, {
      check: true,
      ncl: async () => ({
        schemaVersion: 1,
        enabled: true,
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
      await enableBrowserCapability(f.paths, f.instanceId);
      let reads = 0;
      const result = await inspectBrowserCapability(f.paths, f.instanceId, {
        check: true,
        ncl: async () => ({
          schemaVersion: 1,
          enabled: true,
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
    await enableBrowserCapability(f.paths, f.instanceId);
    const result = await inspectBrowserCapability(f.paths, f.instanceId, {
      check: true,
      ncl: async () => ({
        schemaVersion: 1,
        enabled: true,
        proxy: { state: 'listening', port: 41444 },
        chrome: { state: 'stopped' },
      }),
      runCommand: async (command) =>
        command.command === 'docker' ? { stdout: '', stderr: 'image missing', exitCode: 125 } : chrome(command),
    });
    expect(result.isolation.status).toBe('unknown');
    expect(result.ready).toBe(false);
  });

  it('publishes complete native result schemas for successful lifecycle and failed checks', async () => {
    const f = await fixture();
    for (const command of ['enable', 'show', 'check', 'disable'] as const) {
      const stdout: string[] = [];
      const exit = await runCli(['capabilities', command, 'browser', '--id', f.instanceId, '--json'], {
        paths: f.paths,
        stdout: (line) => stdout.push(line),
        stderr: () => undefined,
        browserInspection: { runCommand: chrome, ncl: hostDown },
      });
      // With the host down, an enable waits for it to set the web alias up, the browser left enabled.
      expect(exit).toBe(command === 'check' ? 1 : command === 'enable' ? 10 : 0);
      const result: unknown = JSON.parse(stdout.join('\n'));
      expectResultContract(`capabilities ${command} browser`, result);
      expect(result).toMatchObject({
        changed: command === 'enable' || command === 'disable',
        command: `capabilities ${command} browser`,
        ...(command === 'enable'
          ? {
              outcome: 'paused',
              data: {
                pause: {
                  phase: 'provision_alias',
                  code: 'alias_host_unavailable',
                  details: [
                    `Start the assistant with gws-ea start --id ${f.instanceId}, then continue`,
                    'ncl: Command failed (exit code 2)',
                  ],
                },
              },
            }
          : {}),
        ...(command === 'show' ? { data: { activation: 'enabled' } } : {}),
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

describe('the browser access setting', () => {
  /** The running host as `ncl` reaches it: what it reads, its profile, its agent groups and its verified web alias. */
  function host(options: { readonly versions?: readonly number[]; readonly down?: boolean } = {}) {
    const ncl = async (_runtime: unknown, args: readonly string[]): Promise<unknown> => {
      if (options.down) throw new Error('host down');
      if (args.join(' ') === 'gws-ea-alias get')
        return { alias: 'onuj@example.test', candidate: null, probe_sent: false };
      if (args[0] === 'gws-ea-browser-health')
        return {
          schemaVersion: 1,
          ...(options.versions ? { policyVersions: options.versions } : {}),
          enabled: true,
          proxy: { state: 'stopped' },
        };
      if (args[0] === 'gws-ea-profile-get')
        return { browser_agent_group_id: 'ag-browser', external_email_agent_group_id: 'ag-external' };
      if (args[0] === 'groups' && ['ag-main', 'ag-research', 'ag-browser', 'ag-external'].includes(args[3]))
        return { id: args[3] };
      throw new GwsEaError('ncl_failed', `ncl ${args.join(' ')} failed: group not found: ${args[3]}`);
    };
    return { ncl };
  }
  const listing = (...agentGroupIds: string[]) => ({ kind: 'agent_groups' as const, agentGroupIds });

  it('writes a version-2 list once the running host reads one and has each group', async () => {
    const f = await fixture();
    const { ncl } = host({ versions: [1, 2] });
    const result = await enableBrowserCapability(f.paths, f.instanceId, { ncl }, listing('ag-main', 'ag-research'));
    expect(result).toMatchObject({
      enabled: true,
      changed: true,
      access: { version: 2, agent_group_ids: ['ag-main', 'ag-research'] },
    });
    expect(await readBrowserPolicy(f.browser.policyFile)).toMatchObject({
      status: 'enabled',
      access: { version: 2, agentGroupIds: ['ag-main', 'ag-research'] },
    });
    expect((await stat(f.browser.policyFile)).mode & 0o777).toBe(0o600);
    expect(
      await enableBrowserCapability(f.paths, f.instanceId, { ncl }, listing('ag-main', 'ag-research', 'ag-main')),
    ).toMatchObject({ changed: false });
  });

  it.each([
    ['does not read a list', { versions: [1] }, 'browser_access_unsupported'],
    ['reports no versions at all', {}, 'browser_access_unsupported'],
    ['is not running', { down: true }, 'browser_access_unverified'],
  ])('refuses version 2, writing nothing, when the host %s', async (_case, options, code) => {
    const f = await fixture();
    await enableBrowserCapability(f.paths, f.instanceId);
    const before = await readFile(f.browser.policyFile, 'utf8');
    await expect(
      enableBrowserCapability(f.paths, f.instanceId, { ncl: host(options).ncl }, listing('ag-research')),
    ).rejects.toMatchObject({ code });
    expect(await readFile(f.browser.policyFile, 'utf8')).toBe(before);
  });

  it.each([
    ['the external-email group', 'ag-external', 'is external-email, which can never use the browser'],
    ['the browser itself', 'ag-browser', 'is browser, which can never use the browser'],
    ['a group the assistant does not have', 'ag-unknown', 'has no agent group ag-unknown'],
  ])('refuses a list naming %s', async (_case, id, message) => {
    const f = await fixture();
    await expect(
      enableBrowserCapability(f.paths, f.instanceId, { ncl: host({ versions: [1, 2] }).ncl }, listing('ag-main', id)),
    ).rejects.toMatchObject({ code: 'invalid_arguments', message: expect.stringContaining(message) });
    expect(await readBrowserPolicy(f.browser.policyFile)).toMatchObject({ status: 'disabled', access: { version: 1 } });
  });

  it('keeps the list through disable and a plain enable, and returns to main alone only when asked', async () => {
    const f = await fixture();
    const { ncl } = host({ versions: [1, 2] });
    await enableBrowserCapability(f.paths, f.instanceId, { ncl }, listing('ag-research'));
    const list = { version: 2, agent_group_ids: ['ag-research'] };
    expect(await disableBrowserCapability(f.paths, f.instanceId)).toMatchObject({ enabled: false, access: list });
    expect(await readBrowserPolicy(f.browser.policyFile)).toMatchObject({
      status: 'disabled',
      access: { version: 2, agentGroupIds: ['ag-research'] },
    });
    expect(await enableBrowserCapability(f.paths, f.instanceId)).toMatchObject({ changed: true, access: list });
    expect(await inspectBrowserCapability(f.paths, f.instanceId)).toMatchObject({ access: list });
    expect(await enableBrowserCapability(f.paths, f.instanceId, {}, { kind: 'main' })).toMatchObject({
      changed: true,
      access: { version: 1 },
    });
    expect(JSON.parse(await readFile(f.browser.policyFile, 'utf8'))).toEqual({ schemaVersion: 1, enabled: true });
  });

  it('refuses a rollback below version 2 while a list is in place, until main alone has the browser again', async () => {
    const f = await fixture();
    const older = path.join(f.root, 'older-release');
    const newer = path.join(f.root, 'newer-release');
    await mkdir(path.join(newer, 'src', 'gws-ea'), { recursive: true });
    await writeFile(
      path.join(newer, 'src', 'gws-ea', 'browser-compatibility.json'),
      JSON.stringify({ schemaVersion: 1, policyVersions: [1, 2] }),
    );
    expect(await releaseBrowserPolicyVersions(older)).toEqual([1]);
    expect(await releaseBrowserPolicyVersions(newer)).toEqual([1, 2]);
    await assertBrowserPolicyReadable(f.runtime, older, 'dogfood older');
    await enableBrowserCapability(f.paths, f.instanceId, { ncl: host({ versions: [1, 2] }).ncl }, listing('ag-main'));
    await disableBrowserCapability(f.paths, f.instanceId);
    await expect(assertBrowserPolicyReadable(f.runtime, older, 'dogfood older')).rejects.toMatchObject({
      code: 'rollback_unavailable',
      message: expect.stringContaining('which dogfood older cannot read'),
    });
    await assertBrowserPolicyReadable(f.runtime, newer, 'dogfood newer');
    await enableBrowserCapability(f.paths, f.instanceId, {}, { kind: 'main' });
    await assertBrowserPolicyReadable(f.runtime, older, 'dogfood older');
  });

  it('ships a release marker naming exactly the versions its host reads', async () => {
    expect(await releaseBrowserPolicyVersions(process.cwd())).toEqual([...BROWSER_POLICY_VERSIONS]);
  });

  it('grants through the command line with the published result, telling the operator what a grant shares', async () => {
    const f = await fixture();
    const stdout: string[] = [];
    const exit = await runCli(
      ['capabilities', 'enable', 'browser', '--id', f.instanceId, '--agent-group', 'ag-research', '--json'],
      {
        paths: f.paths,
        stdout: (line) => stdout.push(line),
        stderr: () => undefined,
        // The assistant's web alias is already verified, so the grant completes without a pause.
        browserInspection: { ncl: host({ versions: [1, 2] }).ncl },
      },
    );
    expect(exit).toBe(0);
    const result: unknown = JSON.parse(stdout.join('\n'));
    expectResultContract('capabilities enable browser', result);
    expect(result).toMatchObject({ data: { access: { version: 2, agent_group_ids: ['ag-research'] } } });
    const lines: string[] = [];
    expect(
      await runCli(['capabilities', 'show', 'browser', '--id', f.instanceId], {
        paths: f.paths,
        stdout: (line) => lines.push(line),
        stderr: () => undefined,
      }),
    ).toBe(0);
    expect(lines).toContain(
      "  Access: agent groups ag-research; each shares the signed-in browser profile and the vault's logins",
    );
    const errors: string[] = [];
    expect(
      await runCli(
        ['capabilities', 'enable', 'browser', '--id', f.instanceId, '--agent-group', 'ag-research', '--main-only'],
        { paths: f.paths, stdout: () => undefined, stderr: (line) => errors.push(line) },
      ),
    ).not.toBe(0);
    expect(errors.join('\n')).toContain('Use --agent-group or --main-only, not both.');
  });
});
