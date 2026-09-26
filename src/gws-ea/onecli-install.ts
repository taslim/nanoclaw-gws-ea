/**
 * Install the pinned OneCLI CLI into `~/.local/bin` from its GitHub release,
 * where NanoClaw's add-onecli installer puts it and where gws-ea looks first.
 * The archive is refused unless its sha256 is the pinned digest.
 */
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ONECLI_CLI_ARCHIVE_DIGESTS, ONECLI_CLI_VERSION, type OnecliCliTarget } from './pins.js';
import {
  buildToolEnvironment,
  checkedRunner,
  runSanitizedCommandOutcome,
  type SanitizedCommandOutcomeRunner,
} from './process.js';
import { GwsEaError } from './types.js';

const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

export interface OnecliInstallDependencies {
  readonly fetch?: typeof fetch;
  readonly runCommand?: SanitizedCommandOutcomeRunner;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly installDirectory?: string;
  readonly digests?: Readonly<Record<OnecliCliTarget, string>>;
}

function releaseTarget(platform: NodeJS.Platform, arch: string): OnecliCliTarget | undefined {
  const system = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : undefined;
  const machine = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : undefined;
  return system && machine ? `${system}_${machine}` : undefined;
}

/** Where the pinned CLI is installed: the user's `~/.local/bin`. */
export function onecliInstallDirectory(): string {
  return path.join(os.homedir(), '.local', 'bin');
}

/** Download, verify, and install the pinned OneCLI CLI; returns its installed path. */
export async function installPinnedOnecliCli(dependencies: OnecliInstallDependencies = {}): Promise<string> {
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  const target = releaseTarget(platform, arch);
  if (!target) {
    throw new GwsEaError(
      'onecli_install_unsupported',
      `OneCLI CLI ${ONECLI_CLI_VERSION} has no build for ${platform} ${arch}`,
    );
  }
  const archive = `onecli_${ONECLI_CLI_VERSION}_${target}.tar.gz`;
  const url = `https://github.com/onecli/onecli-cli/releases/download/v${ONECLI_CLI_VERSION}/${archive}`;
  const response = await (dependencies.fetch ?? fetch)(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) {
    throw new GwsEaError('onecli_download_failed', `Downloading ${url} failed with HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_ARCHIVE_BYTES) {
    throw new GwsEaError('onecli_download_failed', `${archive} is larger than any OneCLI CLI release`);
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== (dependencies.digests ?? ONECLI_CLI_ARCHIVE_DIGESTS)[target]) {
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
    if (!(await lstat(extracted)).isFile()) {
      throw new GwsEaError('onecli_download_failed', `${archive} does not contain the onecli program`);
    }
    const directory = dependencies.installDirectory ?? onecliInstallDirectory();
    await mkdir(directory, { recursive: true, mode: 0o755 });
    const installed = path.join(directory, 'onecli');
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
