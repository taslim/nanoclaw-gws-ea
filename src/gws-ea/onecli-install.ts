/**
 * gws-ea's own OneCLI CLI. Each pinned version is installed once, into its
 * own directory under gws-ea's state root, from its GitHub release, and
 * refused unless the archive matches its pinned sha256. Nothing else writes
 * there, so another program installing or upgrading `onecli` never changes
 * the CLI an assistant was created with.
 */
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import type { ControlPlanePaths } from './paths.js';
import {
  exactVersion,
  ONECLI_CLI_ARCHIVE_DIGESTS,
  ONECLI_CLI_VERSION,
  parseOnecliCliArchiveDigests,
  PIN_NAMES,
  type OnecliCliTarget,
} from './pins.js';
import {
  buildToolEnvironment,
  checkedRunner,
  runSanitizedCommandOutcome,
  type SanitizedCommandOutcomeRunner,
} from './process.js';
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
export const LAUNCHER_ONECLI_CLI: OnecliCliPin = { version: ONECLI_CLI_VERSION, digests: ONECLI_CLI_ARCHIVE_DIGESTS };

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
  readonly runCommand?: SanitizedCommandOutcomeRunner;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

function releaseTarget(platform: NodeJS.Platform, arch: string): OnecliCliTarget | undefined {
  const system = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : undefined;
  const machine = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : undefined;
  return system && machine ? `${system}_${machine}` : undefined;
}

/** Whether a regular file exists at `file`. */
export async function isRegularFile(file: string): Promise<boolean> {
  try {
    return (await lstat(file)).isFile();
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
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
  const response = await (dependencies.fetch ?? fetch)(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) {
    throw new GwsEaError('onecli_download_failed', `Downloading ${url} failed with HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_ARCHIVE_BYTES) {
    throw new GwsEaError('onecli_download_failed', `${archive} is larger than any OneCLI CLI release`);
  }
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
    await checkedRunner(dependencies.runCommand ?? runSanitizedCommandOutcome)({
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
    await mkdir(path.dirname(installed), { recursive: true, mode: 0o700 });
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
