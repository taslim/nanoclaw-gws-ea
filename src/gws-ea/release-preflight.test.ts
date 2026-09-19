import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runReleasePreflight, type SetupCommand } from './release-preflight.js';

const roots: string[] = [];

afterEach(async () => {
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-preflight-'));
  roots.push(root);
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
  await write(root, 'src/channels/gchat.ts', "export const gchat = 'registered';\n");
  await write(root, 'src/channels/index.ts', "import './cli.js';\nimport './gchat.js';\n");
  await write(root, 'src/provider-contracts/claude.ts', "export const provider = 'claude';\n");
  await write(root, 'src/provider-contracts/index.ts', "import './claude.js';\n");
  await write(root, 'setup/providers/claude.ts', "export const provider = 'claude';\n");
  await write(root, 'setup/providers/index.ts', "import './claude.js';\n");
  await write(root, 'container/agent-runner/src/providers/claude.ts', "export const provider = 'claude';\n");
  await write(root, 'container/agent-runner/src/providers/index.ts', "import './claude.js';\n");
  await write(root, 'container/agent-runner/src/provider-contracts/claude.ts', "export const provider = 'claude';\n");
  await write(root, 'container/agent-runner/src/provider-contracts/index.ts', "import './claude.js';\n");
  await write(root, 'container/agent-runner/src/providers/claude.conformance.test.ts', 'export {};\n');
  commit(root, 'complete release');
  git(root, 'checkout', '--detach');
  return realpath(root);
}

function recorder(commands: SetupCommand[]): (command: SetupCommand) => Promise<void> {
  return async (command) => {
    commands.push(command);
  };
}

describe('release preflight', () => {
  it('validates a composed release, installs frozen dependencies, and builds without applying skills', async () => {
    const root = await releaseFixture();
    const commands: SetupCommand[] = [];

    const result = await runReleasePreflight(
      { checkoutRoot: root, provider: 'claude' },
      { runSetupCommand: recorder(commands) },
    );

    expect(result).toEqual({
      provider: 'claude',
      packageManager: 'pnpm@10.34.5',
      onecli: { gateway: '1.42.0', cli: '2.2.5', sdk: '2.2.1' },
    });
    expect(commands).toEqual([
      { command: 'pnpm', args: ['install', '--frozen-lockfile'], cwd: root },
      { command: 'pnpm', args: ['run', 'build'], cwd: root },
    ]);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it.each([
    ['template', 'templates/gws-ea/main/plugin.json', 'incomplete_release'],
    ['Google Chat adapter', 'src/channels/gchat.ts', 'incomplete_release'],
    ['provider host contract', 'src/provider-contracts/claude.ts', 'provider_not_composed'],
    ['provider runtime', 'container/agent-runner/src/providers/claude.ts', 'provider_not_composed'],
  ])('rejects a release missing its committed %s before setup commands', async (_label, missingPath, code) => {
    const root = await releaseFixture();
    await rm(path.join(root, missingPath));
    commit(root, `remove ${missingPath}`);
    const commands: SetupCommand[] = [];

    await expect(
      runReleasePreflight({ checkoutRoot: root, provider: 'claude' }, { runSetupCommand: recorder(commands) }),
    ).rejects.toMatchObject({ code });
    expect(commands).toEqual([]);
  });

  it('rejects a selected provider that is not composed into the release', async () => {
    const root = await releaseFixture();
    const commands: SetupCommand[] = [];

    await expect(
      runReleasePreflight({ checkoutRoot: root, provider: 'opencode' }, { runSetupCommand: recorder(commands) }),
    ).rejects.toMatchObject({ code: 'provider_not_composed' });
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
      runReleasePreflight({ checkoutRoot: root, provider: 'claude' }, { runSetupCommand: recorder(commands) }),
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
      runReleasePreflight({ checkoutRoot: root, provider: 'claude' }, { runSetupCommand: recorder(commands) }),
    ).rejects.toMatchObject({ code: 'invalid_release_pin' });
    expect(commands).toEqual([]);
  });

  it('fails immediately with the tracked diff when frozen install changes source', async () => {
    const root = await releaseFixture();
    const commands: SetupCommand[] = [];

    await expect(
      runReleasePreflight(
        { checkoutRoot: root, provider: 'claude' },
        {
          runSetupCommand: async (command) => {
            commands.push(command);
            if (command.args[0] === 'install') await write(root, 'package.json', '{"drift":true}\n');
          },
        },
      ),
    ).rejects.toThrow(/package\.json/);
    expect(commands).toEqual([{ command: 'pnpm', args: ['install', '--frozen-lockfile'], cwd: root }]);
  });

  it('fails with the tracked diff when the build changes source', async () => {
    const root = await releaseFixture();
    const commands: SetupCommand[] = [];

    await expect(
      runReleasePreflight(
        { checkoutRoot: root, provider: 'claude' },
        {
          runSetupCommand: async (command) => {
            commands.push(command);
            if (command.args[0] === 'run') {
              await write(root, 'src/channels/gchat.ts', "export const gchat = 'drifted';\n");
            }
          },
        },
      ),
    ).rejects.toThrow(/src\/channels\/gchat\.ts/);
    expect(commands).toHaveLength(2);
  });
});
