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
  browserAliasNextActions,
  disableBrowserCapability,
  enableBrowserCapability,
  enableBrowserWithAlias,
  inspectBrowserCapability,
  releaseBrowserPolicyVersions,
} from './browser-capability.js';
import { runCli } from './cli.js';
import { deriveGcpClaims } from './gcp-identity.js';
import { reserveInstance } from './journal.js';
import { getInstanceReservation } from './registry.js';
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

const hostDown = async (): Promise<never> => {
  throw new GwsEaError('command_failed', 'Command failed (exit code 2)');
};

/** The assistant's host as the alias step reaches it: the profile, and the alias commands in memory. */
function aliasHost(verifies: () => boolean) {
  const calls: string[] = [];
  let alias: string | null = null;
  let candidate: string | null = null;
  let probeSent = false;
  const setup = () => ({ alias, candidate, probe_sent: probeSent });
  const ncl = async (_runtime: unknown, args: readonly string[]): Promise<unknown> => {
    calls.push(args.join(' '));
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    switch (args.slice(0, 2).join(' ')) {
      case 'gws-ea-profile get':
        return {
          assistant_display_name: 'Juno Hale',
          assistant_workspace_email: 'assistant@example.test',
          principal_emails: ['morgan@example.test'],
        };
      case 'gws-ea-alias get':
        return setup();
      case 'gws-ea-alias propose':
        candidate = args.includes('--none') ? null : value('--address');
        probeSent = false;
        return setup();
      case 'gws-ea-alias probe':
        if (args.includes('--send')) probeSent = true;
        if (!verifies()) return { outcome: 'not_yet', alias: null };
        alias = candidate;
        candidate = null;
        return { outcome: 'verified', alias };
      default:
        throw new Error(`unexpected ncl ${args.join(' ')}`);
    }
  };
  return { ncl, calls };
}

/** A host whose web alias is already verified: the alias step has nothing to wait for. */
async function verifiedAliasHost(runtime: unknown, args: readonly string[]): Promise<unknown> {
  if (args.slice(0, 2).join(' ') === 'gws-ea-alias get')
    return { alias: 'onuj@example.test', candidate: null, probe_sent: false };
  return aliasHost(() => true).ncl(runtime, args);
}

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

  it("asks for the assistant's web alias once enabled, and finishes when its probe arrives", async () => {
    const f = await fixture();
    let delivered = false;
    const host = aliasHost(() => delivered);
    const effects: unknown[] = [];

    const enabled = await enableBrowserWithAlias(f.paths, f.instanceId, {
      alias: { ncl: host.ncl },
      recordEffect: (changed) => void effects.push(changed),
    });

    expect(enabled).toMatchObject({
      enabled: true,
      changed: true,
      pause: {
        phase: 'provision_alias',
        code: 'alias_required',
        message:
          'Add elahonuj@example.test as an alias of assistant@example.test in the Google Admin console, then confirm it.',
        resumeFlag: '--alias-added',
      },
    });
    expect(effects).toContain(true);
    expect((await getInstanceReservation(f.paths, f.instanceId)).exclusive_resource_claims.alias_email).toBe(
      'elahonuj@example.test',
    );
    expect(browserAliasNextActions(f.instanceId, enabled.pause!)).toEqual([
      expect.objectContaining({ kind: 'external', url: 'https://admin.google.com/ac/users' }),
      {
        kind: 'command',
        argv: ['gws-ea', 'capabilities', 'enable', 'browser', '--id', f.instanceId, '--alias-added'],
      },
    ]);

    delivered = true;
    const verified = await enableBrowserWithAlias(f.paths, f.instanceId, {
      alias: { ncl: host.ncl, decision: { kind: 'added' }, sleep: async () => undefined },
    });
    expect(verified).toMatchObject({ enabled: true, changed: false });
    expect(verified.pause).toBeUndefined();
    expect(host.calls.filter((call) => call.includes('--send'))).toHaveLength(1);
  });

  it('pauses for a running host when the assistant is stopped, with the browser enabled', async () => {
    const f = await fixture();

    const enabled = await enableBrowserWithAlias(f.paths, f.instanceId, { alias: { ncl: hostDown } });

    expect(enabled).toMatchObject({ enabled: true, pause: { code: 'alias_host_unavailable' } });
    expect(enabled.pause?.details?.[0]).toBe(
      `Start the assistant with gws-ea start --id ${f.instanceId}, then continue`,
    );
    expect(await readBrowserPolicy(f.browser.policyFile)).toMatchObject({ enabled: true });
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
        browserAlias: { ncl: hostDown },
      });
      // With the host down, an enable waits for it to set the web alias up.
      expect(exit).toBe(command === 'check' ? 1 : command === 'enable' ? 10 : 0);
      const result: unknown = JSON.parse(stdout.join('\n'));
      expectResultContract(`capabilities ${command} browser`, result);
      expect(result).toMatchObject({
        changed: command === 'enable' || command === 'disable',
        command: `capabilities ${command} browser`,
        ...(command === 'enable'
          ? { outcome: 'paused', data: { pause: { phase: 'provision_alias', code: 'alias_host_unavailable' } } }
          : {}),
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
  /** The running host as `ncl` reaches it: what it reads, its profile and its agent groups. */
  function host(options: { readonly versions?: readonly number[]; readonly down?: boolean } = {}) {
    const asked: string[][] = [];
    const ncl = async (_runtime: unknown, args: readonly string[]): Promise<unknown> => {
      asked.push([...args]);
      if (options.down) throw new Error('host down');
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
    return { ncl, asked };
  }
  const listing = (...agentGroupIds: string[]) => ({ kind: 'agent_groups' as const, agentGroupIds });

  it('writes a version-2 list once the running host reads one and has each group', async () => {
    const f = await fixture();
    const { ncl, asked } = host({ versions: [1, 2] });
    const result = await enableBrowserCapability(f.paths, f.instanceId, { ncl }, listing('ag-main', 'ag-research'));
    expect(result).toMatchObject({
      enabled: true,
      changed: true,
      access: { version: 2, agent_group_ids: ['ag-main', 'ag-research'] },
    });
    expect(asked).toEqual([
      ['gws-ea-browser-health'],
      ['gws-ea-profile-get'],
      ['groups', 'get', '--id', 'ag-main'],
      ['groups', 'get', '--id', 'ag-research'],
    ]);
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
        browserInspection: { ncl: host({ versions: [1, 2] }).ncl },
        // The assistant's web alias is already verified, so the grant completes without a pause.
        browserAlias: { ncl: verifiedAliasHost },
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
