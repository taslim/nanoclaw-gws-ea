import path from 'node:path';

import { getInstallScopedNames } from '../install-slug.js';

export type InstanceServicePlatform = 'macos' | 'linux';

/** The platform an instance service runs on: macOS for `darwin`, Linux for anything else. */
export function instanceServicePlatform(platform: NodeJS.Platform = process.platform): InstanceServicePlatform {
  return platform === 'darwin' ? 'macos' : 'linux';
}
export type InstanceServiceManager = 'launchd' | 'systemd-system' | 'systemd-user';

export interface InstanceServiceCoordinateInput {
  readonly installId: string;
  readonly homeDirectory: string;
  readonly platform: InstanceServicePlatform;
  readonly runningAsRoot: boolean;
}

export interface InstanceServiceCoordinates {
  readonly manager: InstanceServiceManager;
  readonly serviceIdentity: string;
  readonly serviceDefinitionPath: string;
  readonly imageTag: string;
  readonly installLabel: string;
}

export function createInstanceServiceCoordinates(input: InstanceServiceCoordinateInput): InstanceServiceCoordinates {
  const names = getInstallScopedNames(input.installId);
  const manager: InstanceServiceManager =
    input.platform === 'macos' ? 'launchd' : input.runningAsRoot ? 'systemd-system' : 'systemd-user';
  const serviceIdentity = manager === 'launchd' ? names.launchdLabel : names.systemdUnit;
  const serviceDefinitionPath =
    manager === 'launchd'
      ? path.join(input.homeDirectory, 'Library', 'LaunchAgents', `${serviceIdentity}.plist`)
      : manager === 'systemd-system'
        ? path.join('/etc/systemd/system', `${serviceIdentity}.service`)
        : path.join(input.homeDirectory, '.config', 'systemd', 'user', `${serviceIdentity}.service`);
  return {
    manager,
    serviceIdentity,
    serviceDefinitionPath,
    imageTag: names.defaultContainerImage,
    installLabel: names.containerInstallLabel,
  };
}
