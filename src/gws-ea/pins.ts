/**
 * gws-ea's version pins: the OneCLI gateway and CLI, and the
 * cloudflared image. They live in `src/gws-ea/versions.json`, outside the
 * upstream-owned root `versions.json`. A release carries its own copy, which
 * release preflight compares with this launcher's at create only.
 */
import { createRequire } from 'node:module';

import launcherPins from './versions.json' with { type: 'json' };

import { GwsEaError } from './types.js';
import { requireRecord } from './validation.js';

export const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const CLOUDFLARED_IMAGE_PATTERN = /^cloudflare\/cloudflared:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?@sha256:[0-9a-f]{64}$/u;

export interface GwsEaPins {
  readonly onecliGateway: string;
  readonly onecliCli: string;
  readonly cloudflaredImage: string;
}

/** What each pin is called where an operator reads it. */
export const PIN_NAMES: Readonly<Record<keyof GwsEaPins, string>> = {
  onecliGateway: 'OneCLI gateway',
  onecliCli: 'OneCLI CLI',
  cloudflaredImage: 'cloudflared image',
};

export function exactVersion(value: unknown, label: string): string {
  if (typeof value !== 'string' || !EXACT_VERSION_PATTERN.test(value)) {
    throw new GwsEaError('invalid_release_pin', `${label} must be pinned to one exact version`);
  }
  return value;
}

export function validateCloudflaredImagePin(value: unknown): string {
  if (typeof value !== 'string' || !CLOUDFLARED_IMAGE_PATTERN.test(value)) {
    throw new GwsEaError(
      'invalid_release_pin',
      'cloudflared must be pinned to an exact version and immutable sha256 manifest digest',
    );
  }
  return value;
}

export function parsePins(value: unknown, label = 'gws-ea versions.json'): GwsEaPins {
  const pins = requireRecord(value, label, 'invalid_release_pin');
  return {
    onecliGateway: exactVersion(pins['onecli-gateway'], PIN_NAMES.onecliGateway),
    onecliCli: exactVersion(pins['onecli-cli'], PIN_NAMES.onecliCli),
    cloudflaredImage: validateCloudflaredImagePin(pins.cloudflared),
  };
}

export const LAUNCHER_PINS = parsePins(launcherPins);
export const ONECLI_GATEWAY_VERSION = LAUNCHER_PINS.onecliGateway;
export const ONECLI_CLI_VERSION = LAUNCHER_PINS.onecliCli;
export const CLOUDFLARED_IMAGE = LAUNCHER_PINS.cloudflaredImage;

export type OnecliCliTarget = 'darwin_amd64' | 'darwin_arm64' | 'linux_amd64' | 'linux_arm64';

/**
 * The sha256 of each OneCLI CLI release archive the launcher may install, for
 * the pinned CLI version; bump them with the version (GitHub lists each
 * asset's digest). Only the launcher installs the CLI, so a release's copy
 * need not carry them.
 */
export function parseOnecliCliArchiveDigests(value: unknown): Readonly<Record<OnecliCliTarget, string>> {
  const digests = requireRecord(value, 'onecli-cli-archives', 'invalid_release_pin');
  const digest = (target: OnecliCliTarget): string => {
    const pinned = digests[target];
    if (typeof pinned !== 'string' || !/^[0-9a-f]{64}$/u.test(pinned)) {
      throw new GwsEaError('invalid_release_pin', `The OneCLI CLI ${target} archive must be pinned to a sha256 digest`);
    }
    return pinned;
  };
  return {
    darwin_amd64: digest('darwin_amd64'),
    darwin_arm64: digest('darwin_arm64'),
    linux_amd64: digest('linux_amd64'),
    linux_arm64: digest('linux_arm64'),
  };
}

export const ONECLI_CLI_ARCHIVE_DIGESTS = parseOnecliCliArchiveDigests(launcherPins['onecli-cli-archives']);

/** The OneCLI SDK is pinned by the checkout's own package.json. */
const packageManifest: unknown = createRequire(import.meta.url)('../../package.json');
export const ONECLI_SDK_VERSION = exactVersion(
  requireRecord(
    requireRecord(packageManifest, 'package.json', 'invalid_release_pin').dependencies,
    'package.json dependencies',
    'invalid_release_pin',
  )['@onecli-sh/sdk'],
  'OneCLI SDK',
);
