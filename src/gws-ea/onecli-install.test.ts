import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensurePinnedOnecliCli, releaseOnecliCliPin, type OnecliCliPin } from './onecli-install.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
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

async function testPaths(): Promise<ControlPlanePaths> {
  const root = await tempDirectory();
  return resolveControlPlanePaths({ configRoot: path.join(root, 'config'), stateRoot: path.join(root, 'state') });
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

function pinFor(version: string, digest: string): OnecliCliPin {
  return {
    version,
    digests: { darwin_amd64: digest, darwin_arm64: digest, linux_amd64: digest, linux_arm64: digest },
  };
}

describe("gws-ea's own OneCLI CLI", () => {
  it('installs a pinned version once, into its own directory, executable and nothing else', async () => {
    const paths = await testPaths();
    const { bytes, digest } = await releaseArchive();
    const fetch = vi.fn(async () => new Response(bytes));
    const install = () =>
      ensurePinnedOnecliCli(paths, pinFor('2.2.5', digest), { fetch, platform: 'linux', arch: 'arm64' });

    const installed = await install();

    expect(installed).toBe(paths.onecliCliFile('2.2.5'));
    expect(fetch).toHaveBeenCalledWith(
      'https://github.com/onecli/onecli-cli/releases/download/v2.2.5/onecli_2.2.5_linux_arm64.tar.gz',
      expect.anything(),
    );
    expect(await readFile(installed, 'utf8')).toBe('#!/bin/sh\necho onecli\n');
    expect((await stat(installed)).mode & 0o777).toBe(0o755);
    expect((await stat(path.dirname(installed))).mode & 0o777).toBe(0o700);
    await expect(stat(path.join(path.dirname(installed), 'README.md'))).rejects.toMatchObject({ code: 'ENOENT' });

    // Installed once: a second call uses the copy it already has.
    await expect(install()).resolves.toBe(installed);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('keeps each version apart, so an assistant created at another version keeps its own', async () => {
    const paths = await testPaths();
    const { bytes, digest } = await releaseArchive();
    const fetch = async () => new Response(bytes);

    const current = await ensurePinnedOnecliCli(paths, pinFor('2.2.5', digest), {
      fetch,
      platform: 'darwin',
      arch: 'arm64',
    });
    const older = await ensurePinnedOnecliCli(paths, pinFor('2.1.0', digest), {
      fetch,
      platform: 'darwin',
      arch: 'arm64',
    });

    expect(new Set([current, older]).size).toBe(2);
    expect(older).toBe(paths.onecliCliFile('2.1.0'));
  });

  it('refuses an archive that is not the pinned build, installing nothing', async () => {
    const paths = await testPaths();
    const { bytes } = await releaseArchive();

    await expect(
      ensurePinnedOnecliCli(paths, pinFor('2.2.5', '0'.repeat(64)), {
        fetch: async () => new Response(bytes),
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).rejects.toMatchObject({ code: 'onecli_digest_mismatch' });
    await expect(stat(path.dirname(paths.onecliCliFile('2.2.5')))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a failed download, stops reading one larger than any release, and refuses a machine without a build', async () => {
    const paths = await testPaths();
    await expect(
      ensurePinnedOnecliCli(paths, pinFor('2.2.5', '0'.repeat(64)), {
        fetch: async () => new Response('missing', { status: 404 }),
        platform: 'darwin',
        arch: 'x64',
      }),
    ).rejects.toMatchObject({ code: 'onecli_download_failed', message: expect.stringContaining('HTTP 404') });

    // A network failure names the archive's URL and the network's reason, like any other failed download.
    await expect(
      ensurePinnedOnecliCli(paths, pinFor('2.2.5', '0'.repeat(64)), {
        fetch: async () => {
          throw new TypeError('fetch failed', {
            cause: Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }),
          });
        },
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).rejects.toMatchObject({
      code: 'onecli_download_failed',
      message: expect.stringMatching(/onecli_2\.2\.5_darwin_arm64\.tar\.gz failed: fetch failed: ENOTFOUND$/u),
    });

    // An endless body is refused as soon as it passes the largest release, not buffered first.
    const chunk = new Uint8Array(1024 * 1024);
    let served = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        served += 1;
        controller.enqueue(chunk);
      },
    });
    await expect(
      ensurePinnedOnecliCli(paths, pinFor('2.2.5', '0'.repeat(64)), {
        fetch: async () => new Response(endless),
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).rejects.toMatchObject({ code: 'onecli_download_failed', message: expect.stringContaining('larger than') });
    expect(served).toBeLessThan(70);
    const fetch = vi.fn();
    await expect(
      ensurePinnedOnecliCli(paths, pinFor('2.2.5', '0'.repeat(64)), { fetch, platform: 'win32', arch: 'x64' }),
    ).rejects.toMatchObject({ code: 'onecli_install_unsupported' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads a release checkout's own OneCLI CLI pin and digests", async () => {
    const checkout = await tempDirectory();
    await mkdir(path.join(checkout, 'src', 'gws-ea'), { recursive: true });
    const pins = { 'onecli-cli': '2.1.0', 'onecli-cli-archives': ONECLI_CLI_ARCHIVE_DIGESTS };
    await writeFile(path.join(checkout, 'src', 'gws-ea', 'versions.json'), JSON.stringify(pins));

    await expect(releaseOnecliCliPin(checkout)).resolves.toEqual({
      version: '2.1.0',
      digests: ONECLI_CLI_ARCHIVE_DIGESTS,
    });

    await writeFile(path.join(checkout, 'src', 'gws-ea', 'versions.json'), JSON.stringify({ 'onecli-cli': '2.1.0' }));
    await expect(releaseOnecliCliPin(checkout)).rejects.toMatchObject({ code: 'invalid_release_pin' });
  });

  it('pins a sha256 for every macOS and Linux build of the launcher CLI, and refuses a missing one', () => {
    expect(ONECLI_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/u);
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
  });
});
