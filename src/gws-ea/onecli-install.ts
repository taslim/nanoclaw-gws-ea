/**
 * gws-ea's own OneCLI CLI. Each pinned version is installed once, into its
 * own directory under gws-ea's state root, from its GitHub release, and
 * refused unless the archive matches its pinned sha256. Nothing else writes
 * there, so another program installing or upgrading `onecli` never changes
 * the CLI an assistant was created with.
 */
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { errorCode } from '../community-portal/errors.js';
import { isRegularFile, preparePrivateDirectory, type ControlPlanePaths } from './paths.js';
import {
  exactVersion,
  ONECLI_CLI_ARCHIVE_DIGESTS,
  ONECLI_CLI_VERSION,
  parseOnecliCliArchiveDigests,
  PIN_NAMES,
  type OnecliCliTarget,
} from './pins.js';
import { buildToolEnvironment, runSanitizedCommand } from './process.js';
import { activeStep } from './run-log.js';
import { GwsEaError } from './types.js';
import { parseJson, requireRecord } from './validation.js';

const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

/** One OneCLI CLI version and the sha256 of each of its release archives. */
export interface OnecliCliPin {
  readonly version: string;
  readonly digests: Readonly<Record<OnecliCliTarget, string>>;
}

/** The OneCLI CLI this launcher pins. */
const LAUNCHER_ONECLI_CLI: OnecliCliPin = { version: ONECLI_CLI_VERSION, digests: ONECLI_CLI_ARCHIVE_DIGESTS };

/** The OneCLI CLI a release checkout pins, from its own `src/gws-ea/versions.json`. */
export async function releaseOnecliCliPin(checkoutRoot: string): Promise<OnecliCliPin> {
  const file = path.join(checkoutRoot, 'src', 'gws-ea', 'versions.json');
  const pins = requireRecord(
    parseJson(await readFile(file, 'utf8'), 'the release pins', 'invalid_release_pin'),
    'the release pins',
    'invalid_release_pin',
  );
  return {
    version: exactVersion(pins['onecli-cli'], PIN_NAMES.onecliCli),
    digests: parseOnecliCliArchiveDigests(pins['onecli-cli-archives']),
  };
}

export interface OnecliInstallDependencies {
  readonly fetch?: typeof fetch;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

/** The archive's bytes, read no further than `MAX_ARCHIVE_BYTES`. */
async function archiveBytes(response: Response, archive: string): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ARCHIVE_BYTES) {
      await reader.cancel();
      throw new GwsEaError('onecli_download_failed', `${archive} is larger than any OneCLI CLI release`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** The release archive at `url`; however the download fails, it fails as `onecli_download_failed`. */
async function downloadArchive(fetchArchive: typeof fetch, url: string, archive: string): Promise<Buffer> {
  try {
    const response = await fetchArchive(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) {
      throw new GwsEaError('onecli_download_failed', `Downloading ${url} failed with HTTP ${response.status}`);
    }
    return await archiveBytes(response, archive);
  } catch (error) {
    if (error instanceof GwsEaError) throw error;
    const reason =
      error instanceof Error ? [error.message, errorCode(error.cause, '')].filter(Boolean).join(': ') : String(error);
    throw new GwsEaError('onecli_download_failed', `Downloading ${url} failed: ${reason}`, { cause: error });
  }
}

function releaseTarget(platform: NodeJS.Platform, arch: string): OnecliCliTarget | undefined {
  const system = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : undefined;
  const machine = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : undefined;
  return system && machine ? `${system}_${machine}` : undefined;
}

/** gws-ea's copy of a pinned OneCLI CLI, installed first when it is missing; returns its path. */
export async function ensurePinnedOnecliCli(
  paths: Pick<ControlPlanePaths, 'onecliCliFile'>,
  pin: OnecliCliPin = LAUNCHER_ONECLI_CLI,
  dependencies: OnecliInstallDependencies = {},
): Promise<string> {
  const installed = paths.onecliCliFile(exactVersion(pin.version, PIN_NAMES.onecliCli));
  if (await isRegularFile(installed)) return installed;

  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  const target = releaseTarget(platform, arch);
  if (!target) {
    throw new GwsEaError(
      'onecli_install_unsupported',
      `OneCLI CLI ${pin.version} has no build for ${platform} ${arch}`,
    );
  }
  activeStep()?.write(`Installing OneCLI CLI ${pin.version} for gws-ea into ${installed}\n`);
  const archive = `onecli_${pin.version}_${target}.tar.gz`;
  const url = `https://github.com/onecli/onecli-cli/releases/download/v${pin.version}/${archive}`;
  const bytes = await downloadArchive(dependencies.fetch ?? fetch, url, archive);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== pin.digests[target]) {
    throw new GwsEaError(
      'onecli_digest_mismatch',
      `${archive} does not match its pinned sha256 (got ${digest}); nothing was installed`,
    );
  }

  const staging = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-onecli-'));
  try {
    await writeFile(path.join(staging, archive), bytes, { mode: 0o600 });
    await runSanitizedCommand({
      command: 'tar',
      args: ['-xzf', archive, 'onecli'],
      cwd: staging,
      env: buildToolEnvironment(process.env, { HOME: os.homedir() }),
      timeoutMs: 60_000,
    });
    const extracted = path.join(staging, 'onecli');
    if (!(await isRegularFile(extracted))) {
      throw new GwsEaError('onecli_download_failed', `${archive} does not contain the onecli program`);
    }
    await preparePrivateDirectory(path.dirname(installed));
    // Staged beside its target, so the rename that publishes it is atomic.
    const pending = `${installed}.gws-ea-${process.pid}`;
    try {
      await copyFile(extracted, pending);
      await chmod(pending, 0o755);
      await rename(pending, installed);
    } finally {
      await rm(pending, { force: true });
    }
    return installed;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
