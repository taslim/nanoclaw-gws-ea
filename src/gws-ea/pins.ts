/**
 * gws-ea's version pins (KTD9): the OneCLI gateway and CLI, and the
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
