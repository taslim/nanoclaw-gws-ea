import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CONTROL_PLANE_ROOT } from './paths.js';
import { TOOL_ENVIRONMENT_KEYS, runSanitizedCommand } from './process.js';
import {
  assertUpdateKeepsSetup,
  runReleasePreflight,
  type DeployedSetup,
  type ReleaseSetup,
  type SetupCommand,
} from './release-preflight.js';

/** gws-ea's pins, which a release carries at the same path as this launcher. */
const PINS_FILE = 'src/gws-ea/versions.json';
const LAUNCHER_PIN_FILE = JSON.parse(await readFile(path.join(CONTROL_PLANE_ROOT, PINS_FILE), 'utf8')) as Record<
  string,
  string
>;

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function write(root: string, relativePath: string, contents: string): Promise<void> {
  const file = path.join(root, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

function commit(root: string, message: string): void {
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', message);
}

async function writePins(root: string, changes: Record<string, string>): Promise<void> {
  await write(root, PINS_FILE, `${JSON.stringify({ ...LAUNCHER_PIN_FILE, ...changes }, null, 2)}\n`);
}

async function releaseFixture(): Promise<string> {
  const instanceRoot = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-preflight-'));
  roots.push(instanceRoot);
  const root = path.join(instanceRoot, 'nanoclaw');
  await mkdir(root);
  git(root, 'init', '-b', 'main');
  await write(root, '.gitignore', 'node_modules/\ndist/\ndata/\n');
  await write(
    root,
    'package.json',
    JSON.stringify(
      {
        name: 'nanoclaw-release-fixture',
        version: '1.0.0',
        packageManager: 'pnpm@10.34.5',
        scripts: { build: 'tsc' },
        dependencies: { '@onecli-sh/sdk': '2.2.1' },
        devDependencies: { typescript: '^5.7.0' },
      },
      null,
      2,
    ) + '\n',
  );
  await write(root, PINS_FILE, await readFile(path.join(CONTROL_PLANE_ROOT, PINS_FILE), 'utf8'));
  await write(root, 'bin/ncl', '#!/usr/bin/env bash\nexit 0\n');
  await chmod(path.join(root, 'bin/ncl'), 0o755);
  await write(root, 'src/channels/gchat.ts', "export const gchat = 'registered';\n");
  commit(root, 'complete release');
  git(root, 'checkout', '--detach');
  return realpath(root);
}

function preflightInput(root: string) {
  return {
    checkoutRoot: root,
    provider: 'claude',
    providerCredential: { name: 'Anthropic', type: 'anthropic', hostPattern: 'api.anthropic.com' },
  } as const;
}

function recorder(commands: SetupCommand[]): (command: SetupCommand) => Promise<void> {
  return async (command) => {
    commands.push(command);
    if (command.args[0] === 'run' && command.args[1] === 'build') {
      await write(command.cwd, 'dist/gws-ea/process.js', 'export {};\n');
      await write(command.cwd, 'dist/index.js', 'export {};\n');
    }
  };
}

function expectCommonEnvironment(environment: Readonly<Record<string, string>>, checkoutRoot: string): void {
  expect(environment.HOME).toBe(path.join(path.dirname(checkoutRoot), '.release-home'));
  for (const key of Object.keys(environment)) {
    expect([...TOOL_ENVIRONMENT_KEYS, 'HOME']).toContain(key);
  }
}

describe('release preflight', () => {
  it("reads the release's cohort, installs frozen dependencies, and builds without applying skills", async () => {
    const root = await releaseFixture();
    const commands: SetupCommand[] = [];

    const result = await runReleasePreflight(preflightInput(root), {
      runSetupCommand: recorder(commands),
    });

    expect(result).toEqual({
      provider: 'claude',
      providerCredential: { name: 'Anthropic', type: 'anthropic', hostPattern: 'api.anthropic.com' },
      packageManager: 'pnpm@10.34.5',
      onecli: { gateway: '1.42.0', sdk: '2.2.1' },
    });
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({ command: 'pnpm', args: ['install', '--frozen-lockfile'], cwd: root });
    expect(commands[1]).toMatchObject({ command: 'pnpm', args: ['run', 'build'], cwd: root });
    for (const command of commands) expectCommonEnvironment(command.env, root);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('runs every Git and pnpm child with an instance-owned allowlisted environment', async () => {
    const root = await releaseFixture();
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/tmp/hostile-gitconfig');
    vi.stubEnv('GIT_WORK_TREE', '/tmp/hostile-work-tree');
    vi.stubEnv('NPM_CONFIG_USERCONFIG', '/tmp/hostile-npmrc');
    vi.stubEnv('PNPM_HOME', '/tmp/hostile-pnpm');
    vi.stubEnv('ONECLI_HOME', '/tmp/hostile-onecli');
    vi.stubEnv('ANTHROPIC_API_KEY', 'must-not-propagate');
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/tmp/hostile-google-key');
    const gitEnvironments: Array<Readonly<Record<string, string>> | undefined> = [];
    const setupCommands: SetupCommand[] = [];

    await runReleasePreflight(preflightInput(root), {
      runCommand: async (spec) => {
        gitEnvironments.push(spec.env);
        return runSanitizedCommand(spec);
      },
      runSetupCommand: recorder(setupCommands),
    });

    expect(gitEnvironments.length).toBeGreaterThan(0);
    for (const environment of gitEnvironments) {
      expect(environment?.HOME).toBe(path.join(path.dirname(root), '.release-home'));
      expect(environment?.GIT_CONFIG_NOSYSTEM).toBe('1');
      expect(environment?.GIT_TERMINAL_PROMPT).toBe('0');
      for (const key of Object.keys(environment ?? {})) {
        expect([...TOOL_ENVIRONMENT_KEYS, 'HOME', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT']).toContain(key);
      }
    }
    for (const command of setupCommands) expectCommonEnvironment(command.env, root);
  });

  it('rejects a build that does not emit the service runtime artifacts', async () => {
    const root = await releaseFixture();
    const commands: SetupCommand[] = [];

    await expect(
      runReleasePreflight(preflightInput(root), {
        runSetupCommand: async (command) => {
          commands.push(command);
        },
      }),
    ).rejects.toThrow(/dist\/gws-ea\/process\.js/u);
    expect(commands).toHaveLength(2);
  });

  it.each([
    ['cloudflare/cloudflared:latest'],
    ['cloudflare/cloudflared:2026.9.1'],
    ['cloudflare/cloudflared@sha256:' + 'a'.repeat(64)],
  ])('rejects a mutable or incomplete cloudflared pin: %s', async (image) => {
    const root = await releaseFixture();
    await writePins(root, { cloudflared: image });
    commit(root, 'invalid cloudflared pin');

    await expect(runReleasePreflight(preflightInput(root))).rejects.toMatchObject({
      code: 'invalid_release_pin',
    });
  });

  it.each([
    [PINS_FILE, JSON.stringify({ ...LAUNCHER_PIN_FILE, 'onecli-gateway': '^1.42.0' })],
    [
      'package.json',
      JSON.stringify({
        name: 'fixture',
        packageManager: 'pnpm@10.34.5',
        scripts: { build: 'tsc' },
        dependencies: { '@onecli-sh/sdk': '^2.2.1' },
        devDependencies: { typescript: '^5.7.0' },
      }),
    ],
  ])('rejects a non-exact OneCLI pin in %s', async (relativePath, contents) => {
    const root = await releaseFixture();
    await write(root, relativePath, `${contents}\n`);
    commit(root, `float ${relativePath}`);
    const commands: SetupCommand[] = [];

    await expect(
      runReleasePreflight(preflightInput(root), { runSetupCommand: recorder(commands) }),
    ).rejects.toMatchObject({ code: 'invalid_release_pin' });
    expect(commands).toEqual([]);
  });

  it('fails immediately with the tracked diff when frozen install changes source', async () => {
    const root = await releaseFixture();
    const commands: SetupCommand[] = [];

    await expect(
      runReleasePreflight(preflightInput(root), {
        runSetupCommand: async (command) => {
          commands.push(command);
          if (command.args[0] === 'install') await write(root, 'package.json', '{"drift":true}\n');
        },
      }),
    ).rejects.toThrow(/package\.json/);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ command: 'pnpm', args: ['install', '--frozen-lockfile'], cwd: root });
  });

  it.each([
    ['changes a tracked file', 'src/channels/gchat.ts'],
    ['leaves an untracked file', 'src/channels/generated.ts'],
  ])('refuses a dirty tree after the build when it %s, naming the file', async (_change, file) => {
    const root = await releaseFixture();
    const commands: SetupCommand[] = [];
    const build = recorder(commands);

    await expect(
      runReleasePreflight(preflightInput(root), {
        runSetupCommand: async (command) => {
          await build(command);
          if (command.args[0] === 'run') await write(root, file, "export const gchat = 'drifted';\n");
        },
      }),
    ).rejects.toMatchObject({ code: 'checkout_drift', message: expect.stringContaining(file) });
    expect(commands).toHaveLength(2);
  });
});

describe('update compatibility', () => {
  const credential = { name: 'Anthropic', type: 'anthropic', hostPattern: 'api.anthropic.com' } as const;
  const deployed: DeployedSetup = {
    onecli: { gateway: '1.42.0', sdk: '2.2.1' },
    postgresImage: 'postgres:18-alpine',
    provider: 'claude',
    providerCredential: credential,
  };
  const same: ReleaseSetup = {
    onecli: deployed.onecli,
    postgresImage: deployed.postgresImage,
    providerCredential: credential,
  };

  it("accepts a release that keeps the assistant's OneCLI, Postgres, and provider setup", () => {
    expect(() => assertUpdateKeepsSetup(deployed, { ...same, providerCredential: { ...credential } })).not.toThrow();
  });

  it.each([
    ['OneCLI gateway', { onecli: { ...deployed.onecli, gateway: '1.43.0' } }, 'onecli_version_changed', '1.43.0'],
    ['OneCLI SDK', { onecli: { ...deployed.onecli, sdk: '2.3.1' } }, 'onecli_version_changed', '2.3.1'],
    ['Postgres image', { postgresImage: 'postgres:19-alpine' }, 'postgres_version_changed', 'postgres:19-alpine'],
    [
      'provider credential',
      { providerCredential: { ...credential, hostPattern: 'api.example.test' } },
      'provider_setup_changed',
      'claude',
    ],
    ['provider', { providerCredential: undefined }, 'provider_not_composed', 'claude'],
  ] as const)(
    "refuses a release that changes the assistant's %s, naming it and the release to update from",
    (name, change, code, named) => {
      expect(() => assertUpdateKeepsSetup(deployed, { ...same, ...change })).toThrow(
        expect.objectContaining({
          code,
          message: expect.stringMatching(new RegExp(`${name}.*${named.replaceAll('.', '\\.')}.*GWS-EA release`, 'u')),
        }),
      );
    },
  );
});
