import { chmod, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { preparePrivateLocalDirectory } from './paths.js';
import { readOwnerOnlyFile, writeOwnerOnlyFileExclusive } from './secrets.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-secret-'));
  roots.push(root);
  const directory = path.join(root, 'secrets');
  await preparePrivateLocalDirectory(directory);
  return directory;
}

describe('GWS-EA owner-only files', () => {
  it('creates and reads a regular owner-only file', async () => {
    const directory = await fixture();
    const file = path.join(directory, 'runtime-api-key');
    await writeOwnerOnlyFileExclusive(file, 'runtime-secret');

    expect(await readOwnerOnlyFile(file)).toBe('runtime-secret');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('rejects symlinks and group-readable files before reading contents', async () => {
    const directory = await fixture();
    const target = path.join(directory, 'target');
    const linked = path.join(directory, 'linked');
    await writeFile(target, 'secret', { mode: 0o600 });
    await symlink(target, linked);
    await expect(readOwnerOnlyFile(linked)).rejects.toThrow(/regular|symlink|safe/i);

    await chmod(target, 0o640);
    await expect(readOwnerOnlyFile(target)).rejects.toThrow(/0600/);
  });

  it('refuses to overwrite an existing secret', async () => {
    const directory = await fixture();
    const file = path.join(directory, 'credential');
    await writeOwnerOnlyFileExclusive(file, 'first');
    await expect(writeOwnerOnlyFileExclusive(file, 'second')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readOwnerOnlyFile(file)).toBe('first');
  });
});
