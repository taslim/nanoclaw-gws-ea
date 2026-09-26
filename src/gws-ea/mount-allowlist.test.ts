import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { nanoclawMountAllowlistFile, protectFromAgentMounts, type ProtectedRoots } from './mount-allowlist.js';
import { resolveControlPlanePaths } from './paths.js';

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A home directory with gws-ea's roots at their XDG defaults and NanoClaw's allowlist location. */
async function home(): Promise<{ readonly home: string; readonly roots: ProtectedRoots; readonly file: string }> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gws-ea-mounts-')));
  roots.push(directory);
  const paths = resolveControlPlanePaths({
    configRoot: path.join(directory, '.config', 'gws-ea'),
    stateRoot: path.join(directory, '.local', 'share', 'gws-ea'),
  });
  const file = nanoclawMountAllowlistFile(directory);
  await mkdir(path.dirname(file), { recursive: true });
  return { home: directory, roots: paths, file };
}

async function writeAllowlist(file: string, allowlist: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(allowlist, null, 2)}\n`);
}

async function readAllowlist(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
}

describe('shared NanoClaw mount allowlist', () => {
  it('protects the allowlist file NanoClaw reads', async () => {
    vi.stubEnv('HOME', '/Users/operator');
    vi.resetModules();
    const { MOUNT_ALLOWLIST_PATH } = await import('../config.js');

    expect(nanoclawMountAllowlistFile('/Users/operator')).toBe(MOUNT_ALLOWLIST_PATH);
  });

  it("adds gws-ea's roots to blockedPatterns without dropping the operator's entries, and never twice", async () => {
    const { home: homeDirectory, roots: protectedRoots, file } = await home();
    const operatorRoot = { path: '~/Projects', allowReadWrite: true, description: 'code' };
    await writeAllowlist(file, {
      allowedRoots: [operatorRoot],
      blockedPatterns: ['password-store'],
      nonMainReadOnly: true,
    });

    await protectFromAgentMounts(protectedRoots, { homeDirectory });
    const first = await readFile(file, 'utf8');
    await protectFromAgentMounts(protectedRoots, { homeDirectory });

    expect(await readFile(file, 'utf8')).toBe(first);
    expect(JSON.parse(first)).toEqual({
      allowedRoots: [operatorRoot],
      blockedPatterns: ['password-store', protectedRoots.configRoot, protectedRoots.stateRoot, protectedRoots.logsRoot],
      nonMainReadOnly: true,
    });
  });

  it.each([
    ['~', 'configRoot'],
    ['~/.local', 'stateRoot'],
    ['~/.local/share/gws-ea', 'stateRoot'],
    ['~/.config', 'configRoot'],
  ] as const)('stops, naming the entry, when allowedRoots has %s', async (entry, exposed) => {
    const { home: homeDirectory, roots: protectedRoots, file } = await home();
    await writeAllowlist(file, { allowedRoots: [{ path: '~/Projects' }, { path: entry }], blockedPatterns: [] });

    await expect(protectFromAgentMounts(protectedRoots, { homeDirectory })).rejects.toMatchObject({
      code: 'mount_allowlist_exposes_gws_ea',
      message: expect.stringContaining(`"${entry}"`),
      details: { file, entry, root: protectedRoots[exposed] },
    });
    // The roots are blocked even though the run stops.
    expect((await readAllowlist(file)).blockedPatterns).toContain(protectedRoots.stateRoot);
  });

  it('stops for an absolute entry that reaches gws-ea state through a symlink', async () => {
    const { home: homeDirectory, roots: protectedRoots, file } = await home();
    const link = path.join(homeDirectory, 'shared');
    await mkdir(path.join(homeDirectory, '.local', 'share'), { recursive: true });
    await symlink(path.join(homeDirectory, '.local', 'share'), link);
    await writeAllowlist(file, { allowedRoots: [{ path: link }], blockedPatterns: [] });

    await expect(protectFromAgentMounts(protectedRoots, { homeDirectory })).rejects.toMatchObject({
      code: 'mount_allowlist_exposes_gws_ea',
      details: { entry: link, root: protectedRoots.stateRoot },
    });
  });

  it('stops for a relative entry, which each host resolves against its own checkout', async () => {
    const { home: homeDirectory, roots: protectedRoots, file } = await home();
    await writeAllowlist(file, { allowedRoots: [{ path: '../..' }], blockedPatterns: [] });

    await expect(protectFromAgentMounts(protectedRoots, { homeDirectory })).rejects.toMatchObject({
      code: 'mount_allowlist_exposes_gws_ea',
      details: { entry: '../..' },
    });
  });

  it('leaves a missing allowlist absent: NanoClaw then mounts nothing extra', async () => {
    const { home: homeDirectory, roots: protectedRoots, file } = await home();

    await protectFromAgentMounts(protectedRoots, { homeDirectory });

    await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['{not json', '[]', '{"allowedRoots":[]}'])('names an allowlist NanoClaw cannot read: %s', async (source) => {
    const { home: homeDirectory, roots: protectedRoots, file } = await home();
    await writeFile(file, source);

    await expect(protectFromAgentMounts(protectedRoots, { homeDirectory })).rejects.toMatchObject({
      code: 'invalid_mount_allowlist',
      message: expect.stringContaining(file),
    });
    expect(await readFile(file, 'utf8')).toBe(source);
  });

  it("updates a symlinked allowlist's target and keeps the operator's link", async () => {
    const { home: homeDirectory, roots: protectedRoots, file } = await home();
    const target = path.join(homeDirectory, 'dotfiles', 'mount-allowlist.json');
    await mkdir(path.dirname(target), { recursive: true });
    await writeAllowlist(target, { allowedRoots: [], blockedPatterns: [] });
    await symlink(target, file);

    await protectFromAgentMounts(protectedRoots, { homeDirectory });

    expect(await readlink(file)).toBe(target);
    expect((await readAllowlist(target)).blockedPatterns).toEqual([
      protectedRoots.configRoot,
      protectedRoots.stateRoot,
      protectedRoots.logsRoot,
    ]);
  });
});
