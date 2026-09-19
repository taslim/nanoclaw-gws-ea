import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildAllowlistedEnvironment, resolveTrustedExecutable, runSanitizedCommand } from './process.js';

describe('GWS-EA process boundary', () => {
  let trustedNodeRoot: string;
  let trustedNode: string;

  beforeAll(async () => {
    trustedNodeRoot = await mkdtemp(path.join(process.cwd(), '.gws-ea-test-node-'));
    trustedNode = path.join(trustedNodeRoot, 'node');
    await copyFile(process.execPath, trustedNode);
    await chmod(trustedNode, 0o755);
  });

  afterAll(async () => {
    await rm(trustedNodeRoot, { recursive: true, force: true });
  });

  it('copies only inert operating-system values and explicit overrides', () => {
    const environment = buildAllowlistedEnvironment(
      {
        PATH: '/safe/bin',
        LANG: 'en_US.UTF-8',
        HOME: '/attacker',
        NODE_OPTIONS: '--import=/tmp/attacker.js',
        NANOCLAW_INSTALL_ID: 'victim',
        ONECLI_API_KEY: 'ambient-secret',
        GCHAT_CREDENTIALS: 'ambient-chat-secret',
      },
      { HOME: '/expected/home', NANOCLAW_INSTALL_ID: 'expected' },
    );

    expect(environment).toEqual({
      PATH: '/safe/bin',
      LANG: 'en_US.UTF-8',
      HOME: '/expected/home',
      NANOCLAW_INSTALL_ID: 'expected',
    });
  });

  it('executes an argument array without a shell or ambient environment', async () => {
    const result = await runSanitizedCommand({
      command: trustedNode,
      args: [
        '--input-type=module',
        '--eval',
        'process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), secret: process.env.AMBIENT_SECRET ?? null }))',
        '$(touch /tmp/gws-ea-must-not-exist)',
      ],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });

    expect(JSON.parse(result.stdout)).toEqual({
      argv: ['$(touch /tmp/gws-ea-must-not-exist)'],
      secret: null,
    });
  });

  it('does not inherit unspecified parent variables when a caller omits env', async () => {
    const canaryKey = 'GWS_EA_AMBIENT_SECRET_CANARY';
    process.env[canaryKey] = 'must-not-cross';
    try {
      const result = await runSanitizedCommand({
        command: trustedNode,
        args: ['--eval', `process.stdout.write(String(process.env.${canaryKey}))`],
        cwd: process.cwd(),
      });
      expect(result.stdout).toBe('undefined');
    } finally {
      delete process.env[canaryKey];
    }
  });

  it('ignores an executable planted in a publicly writable PATH ancestor', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-hostile-path-'));
    const directory = path.join(root, 'public-bin');
    const executableName = path.basename(trustedNode);
    try {
      await mkdir(directory, { mode: 0o777 });
      await chmod(directory, 0o777);
      await writeFile(path.join(directory, executableName), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
      const resolved = await resolveTrustedExecutable(
        executableName,
        `${directory}${path.delimiter}${path.dirname(trustedNode)}`,
      );
      const child = await runSanitizedCommand({
        command: executableName,
        args: ['--eval', 'process.stdout.write(process.env.PATH ?? "")'],
        cwd: process.cwd(),
        env: { PATH: `${directory}${path.delimiter}${path.dirname(trustedNode)}` },
      });

      expect(resolved).toBe(await realpath(trustedNode));
      expect(child.stdout.split(path.delimiter)).not.toContain(await realpath(directory));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an absolute executable beneath a publicly writable ancestor', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-untrusted-executable-'));
    const directory = path.join(root, 'public-bin');
    const executable = path.join(directory, 'tool');
    try {
      await mkdir(directory, { mode: 0o777 });
      await chmod(directory, 0o777);
      await writeFile(executable, '#!/bin/sh\nexit 0\n');
      await chmod(executable, 0o755);

      await expect(resolveTrustedExecutable(executable)).rejects.toMatchObject({ code: 'untrusted_executable' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts executables owned by root or the current user', async () => {
    await expect(resolveTrustedExecutable('/bin/sh')).resolves.toMatch(/^\//u);
    await expect(resolveTrustedExecutable(trustedNode)).resolves.toMatch(/^\//u);
  });

  it('trusts only the running Node executable through managed installation ancestors', async () => {
    if (typeof process.getuid !== 'function') return;
    const root = await mkdtemp(path.join(process.cwd(), '.gws-ea-managed-node-'));
    const runningNode = path.join(root, 'managed-node');
    const otherExecutable = path.join(root, 'other-tool');
    const originalExecPath = process.execPath;
    const uid = process.getuid();
    const getuid = vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    try {
      await chmod(root, 0o777);
      await writeFile(runningNode, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await writeFile(otherExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      process.execPath = runningNode;

      await chmod(runningNode, 0o775);
      await expect(resolveTrustedExecutable(runningNode)).rejects.toMatchObject({ code: 'untrusted_executable' });
      await chmod(runningNode, 0o755);
      await expect(resolveTrustedExecutable(path.basename(runningNode), root)).resolves.toBe(
        await realpath(runningNode),
      );
      await expect(resolveTrustedExecutable(otherExecutable)).rejects.toMatchObject({ code: 'untrusted_executable' });
    } finally {
      process.execPath = originalExecPath;
      getuid.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
