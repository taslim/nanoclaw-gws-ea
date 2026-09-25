import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DOGFOOD_SOURCE_FILE,
  GWS_EA_RELEASE_REMOTE,
  isPublicReleaseRemote,
  resolveReleaseSource,
} from './release-tracks.js';

const roots: string[] = [];
const PRIVATE_REMOTE = 'https://github.com/example/nanoclaw-gws-ea-private.git';

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function configRoot(source?: string, mode = 0o600): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-tracks-'));
  roots.push(root);
  const config = path.join(root, 'config');
  await mkdir(config, { mode: 0o700 });
  if (source !== undefined) {
    const file = path.join(config, DOGFOOD_SOURCE_FILE);
    await writeFile(file, source, { mode });
    await chmod(file, mode);
  }
  return config;
}

describe('release sources', () => {
  it.each([
    GWS_EA_RELEASE_REMOTE,
    'https://github.com/taslim/nanoclaw-gws-ea',
    'https://GitHub.com/Taslim/nanoclaw-gws-ea/',
    'git@github.com:taslim/nanoclaw-gws-ea.git',
    'ssh://git@github.com/taslim/nanoclaw-gws-ea.git',
  ])('recognizes %s as the public origin', (remote) => {
    expect(isPublicReleaseRemote(remote)).toBe(true);
  });

  it('does not mistake a private fork for the public origin', () => {
    expect(isPublicReleaseRemote(PRIVATE_REMOTE)).toBe(false);
    expect(isPublicReleaseRemote('/srv/git/nanoclaw-gws-ea.git')).toBe(false);
  });

  it('maps only prod to the public repository', async () => {
    const root = await configRoot(`${PRIVATE_REMOTE}\n`);
    await expect(resolveReleaseSource({ track: 'prod', configRoot: root })).resolves.toBe(GWS_EA_RELEASE_REMOTE);
    await expect(resolveReleaseSource({ track: 'dogfood', configRoot: root })).resolves.toBe(PRIVATE_REMOTE);
    await expect(resolveReleaseSource({ track: 'canary', configRoot: root })).rejects.toMatchObject({
      message: expect.stringContaining('--source-remote'),
    });
  });

  it('lets --source-remote override the source file', async () => {
    const root = await configRoot(`${PRIVATE_REMOTE}\n`);
    await expect(
      resolveReleaseSource({ track: 'dogfood', sourceRemote: '/srv/git/dogfood.git', configRoot: root }),
    ).resolves.toBe('/srv/git/dogfood.git');
  });

  it('refuses a dogfood source naming the public origin from either source', async () => {
    const root = await configRoot('git@github.com:taslim/nanoclaw-gws-ea.git\n');
    await expect(resolveReleaseSource({ track: 'dogfood', configRoot: root })).rejects.toMatchObject({
      code: 'public_dogfood_source',
    });
    await expect(
      resolveReleaseSource({ track: 'dogfood', sourceRemote: GWS_EA_RELEASE_REMOTE, configRoot: await configRoot() }),
    ).rejects.toMatchObject({ code: 'public_dogfood_source' });
  });

  it('fails without a source naming both the flag and the file', async () => {
    const root = await configRoot();
    await expect(resolveReleaseSource({ track: 'dogfood', configRoot: root })).rejects.toMatchObject({
      code: 'release_source_required',
      message: expect.stringContaining(path.join(root, DOGFOOD_SOURCE_FILE)),
    });
    await expect(resolveReleaseSource({ track: 'dogfood', configRoot: root })).rejects.toMatchObject({
      message: expect.stringContaining('--source-remote'),
    });
  });

  it('treats a config root that does not exist yet as having no source file', async () => {
    const root = path.join(await configRoot(), 'not-created');
    await expect(resolveReleaseSource({ track: 'dogfood', configRoot: root })).rejects.toMatchObject({
      code: 'release_source_required',
    });
  });

  it('refuses a source file others can read, or one holding more than a remote', async () => {
    await expect(
      resolveReleaseSource({ track: 'dogfood', configRoot: await configRoot(`${PRIVATE_REMOTE}\n`, 0o644) }),
    ).rejects.toMatchObject({ code: 'unsafe_source_file' });
    await expect(
      resolveReleaseSource({ track: 'dogfood', configRoot: await configRoot(`${PRIVATE_REMOTE}\nsecond line\n`) }),
    ).rejects.toMatchObject({ code: 'invalid_source_file' });
  });
});
