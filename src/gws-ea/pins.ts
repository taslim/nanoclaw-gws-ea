/**
 * gws-ea's pins live in `src/gws-ea/versions.json`, outside the upstream-owned
 * root `versions.json`. Each release carries its own copy, which release
 * preflight reads.
 */
import { createRequire } from 'node:module';

import launcherPins from './versions.json' with { type: 'json' };

import { GwsEaError } from './types.js';
import { requireRecord } from './validation.js';

export const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

export interface GwsEaPins {
  readonly onecliGateway: string;
}

export const PIN_NAMES: Readonly<Record<keyof GwsEaPins, string>> = {
  onecliGateway: 'OneCLI gateway',
};

export function exactVersion(value: unknown, label: string): string {
  if (typeof value !== 'string' || !EXACT_VERSION_PATTERN.test(value)) {
    throw new GwsEaError('invalid_release_pin', `${label} must be pinned to one exact version`);
  }
  return value;
}

export function parsePins(value: unknown, label = 'gws-ea versions.json'): GwsEaPins {
  const pins = requireRecord(value, label, 'invalid_release_pin');
  return {
    onecliGateway: exactVersion(pins['onecli-gateway'], PIN_NAMES.onecliGateway),
  };
}

export const LAUNCHER_PINS = parsePins(launcherPins);
export const ONECLI_GATEWAY_VERSION = LAUNCHER_PINS.onecliGateway;

const packageManifest: unknown = createRequire(import.meta.url)('../../package.json');
export const ONECLI_SDK_VERSION = exactVersion(
  requireRecord(
    requireRecord(packageManifest, 'package.json', 'invalid_release_pin').dependencies,
    'package.json dependencies',
    'invalid_release_pin',
  )['@onecli-sh/sdk'],
  'OneCLI SDK',
);
