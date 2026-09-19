import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createInstanceServiceCoordinates,
  type InstanceServiceCoordinateInput,
  type InstanceServiceCoordinates,
} from './service-coordinates.js';

describe('GWS-EA service coordinates', () => {
  const homeDirectory = '/home/operator';
  const installId = '1234567890abcdef1234567890abcdef';
  const shared = {
    imageTag: `nanoclaw-agent-v2-${installId}:latest`,
    installLabel: `nanoclaw-install=${installId}`,
  } as const;

  const cases: readonly {
    readonly name: string;
    readonly input: InstanceServiceCoordinateInput;
    readonly expected: InstanceServiceCoordinates;
  }[] = [
    {
      name: 'launchd',
      input: { installId, homeDirectory, platform: 'macos', runningAsRoot: false },
      expected: {
        manager: 'launchd',
        serviceIdentity: `com.nanoclaw-v2-${installId}`,
        serviceDefinitionPath: path.join(
          homeDirectory,
          'Library',
          'LaunchAgents',
          `com.nanoclaw-v2-${installId}.plist`,
        ),
        ...shared,
      },
    },
    {
      name: 'user systemd',
      input: { installId, homeDirectory, platform: 'linux', runningAsRoot: false },
      expected: {
        manager: 'systemd-user',
        serviceIdentity: `nanoclaw-v2-${installId}`,
        serviceDefinitionPath: path.join(
          homeDirectory,
          '.config',
          'systemd',
          'user',
          `nanoclaw-v2-${installId}.service`,
        ),
        ...shared,
      },
    },
    {
      name: 'root systemd',
      input: { installId, homeDirectory, platform: 'linux', runningAsRoot: true },
      expected: {
        manager: 'systemd-system',
        serviceIdentity: `nanoclaw-v2-${installId}`,
        serviceDefinitionPath: path.join('/etc/systemd/system', `nanoclaw-v2-${installId}.service`),
        ...shared,
      },
    },
  ];

  it.each(cases)('derives $name coordinates shared by provisioning and removal', ({ input, expected }) => {
    expect(createInstanceServiceCoordinates(input)).toEqual(expected);
  });
});
