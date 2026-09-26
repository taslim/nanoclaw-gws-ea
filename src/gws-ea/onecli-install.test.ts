import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { installPinnedOnecliCli } from './onecli-install.js';
import { ONECLI_CLI_ARCHIVE_DIGESTS, ONECLI_CLI_VERSION, parseOnecliCliArchiveDigests } from './pins.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-onecli-install-'));
  roots.push(root);
  return root;
}

/** A release-shaped archive holding a stand-in `onecli` program, and its sha256. */
async function releaseArchive(): Promise<{ readonly bytes: Buffer; readonly digest: string }> {
  const root = await tempDirectory();
  await writeFile(path.join(root, 'onecli'), '#!/bin/sh\necho onecli\n', { mode: 0o755 });
  await writeFile(path.join(root, 'README.md'), 'not installed\n');
  execFileSync('tar', ['-czf', 'archive.tar.gz', 'onecli', 'README.md'], { cwd: root });
  const bytes = await readFile(path.join(root, 'archive.tar.gz'));
  return { bytes, digest: createHash('sha256').update(bytes).digest('hex') };
}

function digestsFor(digest: string) {
  return { darwin_amd64: digest, darwin_arm64: digest, linux_amd64: digest, linux_arm64: digest };
}

describe('pinned OneCLI CLI install', () => {
  it('downloads the pinned release for this machine and installs only onecli, executable', async () => {
    const { bytes, digest } = await releaseArchive();
    const installDirectory = path.join(await tempDirectory(), 'bin');
    const fetch = vi.fn(async () => new Response(bytes));

    const installed = await installPinnedOnecliCli({
      fetch,
      platform: 'linux',
      arch: 'arm64',
      installDirectory,
      digests: digestsFor(digest),
    });

    expect(fetch).toHaveBeenCalledWith(
      `https://github.com/onecli/onecli-cli/releases/download/v${ONECLI_CLI_VERSION}/onecli_${ONECLI_CLI_VERSION}_linux_arm64.tar.gz`,
      expect.anything(),
    );
    expect(installed).toBe(path.join(installDirectory, 'onecli'));
    expect(await readFile(installed, 'utf8')).toBe('#!/bin/sh\necho onecli\n');
    expect((await stat(installed)).mode & 0o777).toBe(0o755);
    await expect(stat(path.join(installDirectory, 'README.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses an archive that is not the pinned build, installing nothing', async () => {
    const { bytes } = await releaseArchive();
    const installDirectory = path.join(await tempDirectory(), 'bin');

    await expect(
      installPinnedOnecliCli({
        fetch: async () => new Response(bytes),
        platform: 'darwin',
        arch: 'arm64',
        installDirectory,
        digests: digestsFor('0'.repeat(64)),
      }),
    ).rejects.toMatchObject({ code: 'onecli_digest_mismatch' });
    await expect(stat(installDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a failed download and a machine without a build', async () => {
    await expect(
      installPinnedOnecliCli({
        fetch: async () => new Response('missing', { status: 404 }),
        platform: 'darwin',
        arch: 'x64',
      }),
    ).rejects.toMatchObject({ code: 'onecli_download_failed', message: expect.stringContaining('HTTP 404') });
    const fetch = vi.fn();
    await expect(installPinnedOnecliCli({ fetch, platform: 'win32', arch: 'x64' })).rejects.toMatchObject({
      code: 'onecli_install_unsupported',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('pins a sha256 for every macOS and Linux build, and refuses a missing one', () => {
    expect(Object.keys(ONECLI_CLI_ARCHIVE_DIGESTS).sort()).toEqual([
      'darwin_amd64',
      'darwin_arm64',
      'linux_amd64',
      'linux_arm64',
    ]);
    const { linux_arm64: _omitted, ...incomplete } = ONECLI_CLI_ARCHIVE_DIGESTS;
    expect(() => parseOnecliCliArchiveDigests(incomplete)).toThrow(
      expect.objectContaining({ code: 'invalid_release_pin' }),
    );
    expect(() => parseOnecliCliArchiveDigests({ ...ONECLI_CLI_ARCHIVE_DIGESTS, darwin_arm64: 'not-a-digest' })).toThrow(
      expect.objectContaining({ code: 'invalid_release_pin' }),
    );
  });
});
