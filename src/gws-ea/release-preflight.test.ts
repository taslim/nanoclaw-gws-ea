import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runArgumentCommand, type CommandRunner } from './checkout.js';
import { runReleasePreflight, type SetupCommand } from './release-preflight.js';
import { providerProvisioningCapabilityDigest } from '../provider-provisioning-capability.js';

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
  await write(
    root,
    'pnpm-lock.yaml',
    [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      "      '@onecli-sh/sdk':",
      '        specifier: 2.2.1',
      '        version: 2.2.1',
      '    devDependencies:',
      '      typescript:',
      '        specifier: ^5.7.0',
      '        version: 5.9.3',
      '',
    ].join('\n'),
  );
  await write(
    root,
    'versions.json',
    JSON.stringify({ 'onecli-gateway': '1.42.0', 'onecli-cli': '2.2.5' }, null, 2) + '\n',
  );
  await write(
    root,
    'templates/gws-ea/main/plugin.json',
    JSON.stringify(
      {
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        name: 'gws-ea-main',
        version: '1.0.0',
        description: 'fixture',
        extensions: { 'ai.nanoco.nanoclaw': { agentName: 'main' } },
      },
      null,
      2,
    ) + '\n',
  );
  await write(root, 'bin/ncl', '#!/usr/bin/env bash\nexit 0\n');
  await write(root, 'bin/gws-ea', '#!/usr/bin/env bash\nexit 0\n');
  await chmod(path.join(root, 'bin/ncl'), 0o755);
  await chmod(path.join(root, 'bin/gws-ea'), 0o755);
  await write(root, 'setup/gws-ea.ts', 'export {};\n');
  await write(root, 'setup/gws-ea-input.ts', 'export {};\n');
  await write(root, 'setup/lib/bright-select.ts', 'export {};\n');
  await write(root, 'setup/lib/captured-token.ts', 'export {};\n');
  await write(root, 'setup/lib/inherit-script.ts', 'export {};\n');
  await write(root, '.claude/skills/add-onecli/scripts/install-claude.sh', '#!/bin/sh\n');
  await write(root, '.claude/skills/add-onecli/scripts/register-claude-token.sh', '#!/bin/sh\n');
  await write(root, 'src/provider-credential.ts', 'export {};\n');
  await write(root, 'src/channels/gchat.ts', "export const gchat = 'registered';\n");
  await write(root, 'src/channels/index.ts', "import './cli.js';\nimport './gchat.js';\n");
  await write(root, 'src/gateway-providers/index.ts', "import './installed.js';\n");
  await write(root, 'src/gateway-providers/installed.ts', "import './onecli.js';\n");
  await write(root, 'src/gateway-providers/onecli.ts', 'export {};\n');
  await write(root, 'src/gateway-providers/onecli-files.ts', 'export {};\n');
  await write(root, 'container/skills/onecli-gateway/SKILL.md', '# OneCLI gateway\n');
  await write(root, 'container/skills/onecli-gateway/instructions.md', '# OneCLI instructions\n');
  await write(root, 'src/gws-ea/process.ts', 'export {};\n');
  await write(root, 'scripts/init-first-agent.ts', 'export {};\n');
  await write(root, 'src/modules/gws-ea-profile/index.ts', 'export {};\n');
  await write(root, 'src/modules/gws-ea-profile/migration.ts', 'export {};\n');
  await write(root, 'src/modules/index.ts', "import './gws-ea-profile/index.js';\n");
  await write(root, 'src/provider-contracts/claude.ts', "export const provider = 'claude';\n");
  await write(root, 'src/provider-contracts/index.ts', "import './claude.js';\n");
  await write(root, 'setup/providers/claude.ts', "export const provider = 'claude';\n");
  await write(root, 'setup/providers/index.ts', "import './claude.js';\n");
  await write(root, 'setup/providers/registry.ts', 'export {};\n');
  await write(root, 'container/agent-runner/src/providers/claude.ts', "export const provider = 'claude';\n");
  await write(root, 'container/agent-runner/src/providers/index.ts', "import './claude.js';\n");
  await write(root, 'container/agent-runner/src/provider-contracts/claude.ts', "export const provider = 'claude';\n");
  await write(root, 'container/agent-runner/src/provider-contracts/index.ts', "import './claude.js';\n");
  await write(root, 'container/agent-runner/src/providers/claude.conformance.test.ts', 'export {};\n');
  commit(root, 'complete release');
  git(root, 'checkout', '--detach');
  return realpath(root);
}

async function preflightInput(root: string) {
  return {
    checkoutRoot: root,
    provider: 'claude',
    providerCapabilityDigest: await providerProvisioningCapabilityDigest(root),
    providerCredential: { name: 'Anthropic', type: 'anthropic', hostPattern: 'api.anthropic.com' },
    onecliCliPath: '/fixture/bin/onecli',
  } as const;
}

const fixtureCommandRunner: CommandRunner = async (spec) =>
  spec.command === '/fixture/bin/onecli'
    ? { stdout: JSON.stringify({ version: '2.2.5', server_version: 'unknown' }), stderr: '' }
    : runArgumentCommand(spec);

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
    expect(['HOME', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE']).toContain(key);
  }
}

describe('release preflight', () => {
  it('validates a composed release, installs frozen dependencies, and builds without applying skills', async () => {
    const root = await releaseFixture();
    const commands: SetupCommand[] = [];

    const result = await runReleasePreflight(await preflightInput(root), {
      runCommand: fixtureCommandRunner,
      runSetupCommand: recorder(commands),
    });

    expect(result).toEqual({
      provider: 'claude',
      providerCapabilityDigest: await providerProvisioningCapabilityDigest(root),
      providerCredential: { name: 'Anthropic', type: 'anthropic', hostPattern: 'api.anthropic.com' },
      packageManager: 'pnpm@10.34.5',
      onecli: { gateway: '1.42.0', cli: '2.2.5', sdk: '2.2.1' },
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
    const gitEnvironments: Array<Readonly<Record<string, string>>> = [];
    let onecliEnvironment: Readonly<Record<string, string>> | undefined;
    const setupCommands: SetupCommand[] = [];

    await runReleasePreflight(await preflightInput(root), {
      runCommand: async (spec) => {
        if (spec.command === '/fixture/bin/onecli') {
          onecliEnvironment = spec.env;
          return { stdout: JSON.stringify({ version: '2.2.5', server_version: 'unknown' }), stderr: '' };
        }
        gitEnvironments.push(spec.env);
        return runArgumentCommand(spec);
      },
      runSetupCommand: recorder(setupCommands),
    });

    expect(gitEnvironments.length).toBeGreaterThan(0);
    for (const environment of gitEnvironments) {
      expect(environment.HOME).toBe(path.join(path.dirname(root), '.release-home'));
      expect(environment.GIT_CONFIG_NOSYSTEM).toBe('1');
      expect(environment.GIT_TERMINAL_PROMPT).toBe('0');
      for (const key of Object.keys(environment)) {
        expect(['HOME', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT']).toContain(
          key,
        );
      }
    }
    expectCommonEnvironment(onecliEnvironment!, root);
    for (const command of setupCommands) expectCommonEnvironment(command.env, root);
  });

  it.each([
    ['template', 'templates/gws-ea/main/plugin.json', 'incomplete_release'],
    ['Google Chat adapter', 'src/channels/gchat.ts', 'incomplete_release'],
    ['GWS-EA interactive launcher', 'setup/gws-ea-input.ts', 'incomplete_release'],
    ['GWS-EA service launcher', 'src/gws-ea/process.ts', 'incomplete_release'],
    ['GWS-EA profile migration', 'src/modules/gws-ea-profile/migration.ts', 'incomplete_release'],
    ['OneCLI gateway adapter', 'src/gateway-providers/onecli.ts', 'gateway_not_composed'],
    ['OneCLI agent instructions', 'container/skills/onecli-gateway/SKILL.md', 'gateway_not_composed'],
    ['provider host contract', 'src/provider-contracts/claude.ts', 'provider_not_composed'],
    ['provider runtime', 'container/agent-runner/src/providers/claude.ts', 'provider_not_composed'],
  ])('rejects a release missing its committed %s before setup commands', async (_label, missingPath, code) => {
    const root = await releaseFixture();
    await rm(path.join(root, missingPath));
    commit(root, `remove ${missingPath}`);
    const commands: SetupCommand[] = [];

    await expect(
      runReleasePreflight(await preflightInput(root), {
        runCommand: fixtureCommandRunner,
        runSetupCommand: recorder(commands),
      }),
    ).rejects.toMatchObject({ code });
    expect(commands).toEqual([]);
  });

  it('rejects a committed release without OneCLI gateway registration', async () => {
    const root = await releaseFixture();
    await write(root, 'src/gateway-providers/installed.ts', 'export {};\n');
    commit(root, 'remove OneCLI gateway registration');
    const commands: SetupCommand[] = [];

    await expect(
      runReleasePreflight(await preflightInput(root), {
        runCommand: fixtureCommandRunner,
        runSetupCommand: recorder(commands),
      }),
    ).rejects.toMatchObject({ code: 'gateway_not_composed' });
    expect(commands).toEqual([]);
  });

  it('rejects a build that does not emit the service runtime artifacts', async () => {
    const root = await releaseFixture();
    const commands: SetupCommand[] = [];

    await expect(
      runReleasePreflight(await preflightInput(root), {
        runCommand: fixtureCommandRunner,
        runSetupCommand: async (command) => {
          commands.push(command);
        },
      }),
    ).rejects.toThrow(/dist\/gws-ea\/process\.js/u);
    expect(commands).toHaveLength(2);
  });

  it('rejects a selected provider that is not composed into the release', async () => {
    const root = await releaseFixture();
    const commands: SetupCommand[] = [];

    await expect(
      runReleasePreflight(
        { ...(await preflightInput(root)), provider: 'opencode' },
        { runSetupCommand: recorder(commands) },
      ),
    ).rejects.toMatchObject({ code: 'provider_not_composed' });
    expect(commands).toEqual([]);
  });

  it('rejects a launcher/target provider setup mismatch before setup commands', async () => {
    const root = await releaseFixture();
    const commands: SetupCommand[] = [];

    await expect(
      runReleasePreflight(
        { ...(await preflightInput(root)), providerCapabilityDigest: 'f'.repeat(64) },
        { runSetupCommand: recorder(commands) },
      ),
    ).rejects.toMatchObject({ code: 'provider_capability_mismatch' });
    expect(commands).toEqual([]);
  });

  it('rejects target OneCLI pins that the launcher cannot execute before setup commands', async () => {
    const root = await releaseFixture();
    await write(
      root,
      'versions.json',
      JSON.stringify({ 'onecli-gateway': '1.43.0', 'onecli-cli': '2.2.5' }, null, 2) + '\n',
    );
    commit(root, 'new OneCLI gateway cohort');
    const commands: SetupCommand[] = [];

    await expect(
      runReleasePreflight(await preflightInput(root), { runSetupCommand: recorder(commands) }),
    ).rejects.toMatchObject({ code: 'onecli_release_mismatch' });
    expect(commands).toEqual([]);
  });

  it('rejects an installed OneCLI CLI outside the selected cohort before setup commands', async () => {
    const root = await releaseFixture();
    const commands: SetupCommand[] = [];

    await expect(
      runReleasePreflight(await preflightInput(root), {
        runCommand: async (spec) =>
          spec.command === '/fixture/bin/onecli'
            ? { stdout: JSON.stringify({ version: '2.2.4', server_version: 'unknown' }), stderr: '' }
            : runArgumentCommand(spec),
        runSetupCommand: recorder(commands),
      }),
    ).rejects.toMatchObject({ code: 'incompatible_onecli' });
    expect(commands).toEqual([]);
  });

  it('rejects an inconsistent pnpm lockfile before setup commands', async () => {
    const root = await releaseFixture();
    await write(
      root,
      'pnpm-lock.yaml',
      [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .:',
        '    dependencies:',
        "      '@onecli-sh/sdk':",
        '        specifier: 2.2.0',
        '        version: 2.2.0',
        '    devDependencies:',
        '      typescript:',
        '        specifier: ^5.7.0',
        '        version: 5.9.3',
        '',
      ].join('\n'),
    );
    commit(root, 'inconsistent lockfile');
    const commands: SetupCommand[] = [];

    await expect(
      runReleasePreflight(await preflightInput(root), { runSetupCommand: recorder(commands) }),
    ).rejects.toMatchObject({ code: 'inconsistent_lockfile' });
    expect(commands).toEqual([]);
  });

  it.each([
    ['versions.json', JSON.stringify({ 'onecli-gateway': '^1.42.0', 'onecli-cli': '2.2.5' })],
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
      runReleasePreflight(await preflightInput(root), { runSetupCommand: recorder(commands) }),
    ).rejects.toMatchObject({ code: 'invalid_release_pin' });
    expect(commands).toEqual([]);
  });

  it('fails immediately with the tracked diff when frozen install changes source', async () => {
    const root = await releaseFixture();
    const commands: SetupCommand[] = [];

    await expect(
      runReleasePreflight(await preflightInput(root), {
        runCommand: fixtureCommandRunner,
        runSetupCommand: async (command) => {
          commands.push(command);
          if (command.args[0] === 'install') await write(root, 'package.json', '{"drift":true}\n');
        },
      }),
    ).rejects.toThrow(/package\.json/);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ command: 'pnpm', args: ['install', '--frozen-lockfile'], cwd: root });
  });

  it('fails with the tracked diff when the build changes source', async () => {
    const root = await releaseFixture();
    const commands: SetupCommand[] = [];

    await expect(
      runReleasePreflight(await preflightInput(root), {
        runCommand: fixtureCommandRunner,
        runSetupCommand: async (command) => {
          commands.push(command);
          if (command.args[0] === 'run') {
            await write(root, 'src/channels/gchat.ts', "export const gchat = 'drifted';\n");
          }
        },
      }),
    ).rejects.toThrow(/src\/channels\/gchat\.ts/);
    expect(commands).toHaveLength(2);
  });
});
