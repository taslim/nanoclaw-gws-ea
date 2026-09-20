import { describe, it, expect } from 'vitest';

import { getLaunchdLabel } from '../src/install-slug.js';
import { renderLaunchdService, renderSystemdService } from '../src/service-definition.js';

/**
 * Tests for service configuration generation.
 *
 * These tests verify the generated content of plist/systemd/nohup configs
 * without actually loading services.
 */

// Helper: generate a plist string the same way service.ts does
function generatePlist(nodePath: string, projectRoot: string, homeDir: string): string {
  const label = getLaunchdLabel(projectRoot);
  return renderLaunchdService({
    label,
    programArguments: [nodePath, `${projectRoot}/dist/index.js`],
    workingDirectory: projectRoot,
    environment: {
      PATH: `/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin`,
      HOME: homeDir,
    },
    standardOutputPath: `${projectRoot}/logs/nanoclaw.log`,
    standardErrorPath: `${projectRoot}/logs/nanoclaw.error.log`,
  });
}

function generateSystemdUnit(nodePath: string, projectRoot: string, homeDir: string, isSystem: boolean): string {
  return renderSystemdService({
    programArguments: [nodePath, `${projectRoot}/dist/index.js`],
    workingDirectory: projectRoot,
    environment: {
      HOME: homeDir,
      PATH: `/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin`,
    },
    standardOutputPath: `${projectRoot}/logs/nanoclaw.log`,
    standardErrorPath: `${projectRoot}/logs/nanoclaw.error.log`,
    wantedBy: isSystem ? 'multi-user.target' : 'default.target',
  });
}

describe('plist generation', () => {
  it('contains the slug-scoped label', () => {
    const projectRoot = '/home/user/nanoclaw';
    const plist = generatePlist('/usr/local/bin/node', projectRoot, '/home/user');
    expect(plist).toContain(`<string>${getLaunchdLabel(projectRoot)}</string>`);
    expect(plist).toMatch(/<string>com\.nanoclaw-v2-[0-9a-f]{8}<\/string>/);
  });

  it('uses the correct node path', () => {
    const plist = generatePlist('/opt/node/bin/node', '/home/user/nanoclaw', '/home/user');
    expect(plist).toContain('<string>/opt/node/bin/node</string>');
  });

  it('points to dist/index.js', () => {
    const plist = generatePlist('/usr/local/bin/node', '/home/user/nanoclaw', '/home/user');
    expect(plist).toContain('/home/user/nanoclaw/dist/index.js');
  });

  it('sets log paths', () => {
    const plist = generatePlist('/usr/local/bin/node', '/home/user/nanoclaw', '/home/user');
    expect(plist).toContain('nanoclaw.log');
    expect(plist).toContain('nanoclaw.error.log');
  });
});

describe('systemd unit generation', () => {
  it('user unit uses default.target', () => {
    const unit = generateSystemdUnit('/usr/bin/node', '/home/user/nanoclaw', '/home/user', false);
    expect(unit).toContain('WantedBy=default.target');
  });

  it('system unit uses multi-user.target', () => {
    const unit = generateSystemdUnit('/usr/bin/node', '/home/user/nanoclaw', '/home/user', true);
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it('contains restart policy', () => {
    const unit = generateSystemdUnit('/usr/bin/node', '/home/user/nanoclaw', '/home/user', false);
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('RestartSec=5');
  });

  it('uses KillMode=process to preserve detached children', () => {
    const unit = generateSystemdUnit('/usr/bin/node', '/home/user/nanoclaw', '/home/user', false);
    expect(unit).toContain('KillMode=process');
  });

  it('sets correct ExecStart', () => {
    const unit = generateSystemdUnit('/usr/bin/node', '/srv/nanoclaw', '/home/user', false);
    expect(unit).toContain('ExecStart=/usr/bin/node /srv/nanoclaw/dist/index.js');
  });
});

describe('generic service rendering', () => {
  it('escapes launchd XML without changing argument boundaries', () => {
    const plist = renderLaunchdService({
      label: 'com.example.a&b',
      programArguments: ['/opt/Node & Tools/node', '/tmp/<launcher>.js'],
      workingDirectory: '/tmp/a & b',
      environment: { HOME: '/tmp/a & b' },
      standardOutputPath: '/tmp/a & b/out.log',
      standardErrorPath: '/tmp/a & b/err.log',
    });

    expect(plist).toContain('<string>com.example.a&amp;b</string>');
    expect(plist).toContain('<string>/opt/Node &amp; Tools/node</string>');
    expect(plist).toContain('<string>/tmp/&lt;launcher&gt;.js</string>');
  });

  it('quotes systemd arguments and values containing whitespace', () => {
    const unit = renderSystemdService({
      programArguments: ['/opt/Node Tools/node', '/tmp/host launcher.js'],
      workingDirectory: '/tmp/a b',
      environment: { HOME: '/tmp/a b' },
      standardOutputPath: '/tmp/a b/out.log',
      standardErrorPath: '/tmp/a b/err.log',
      wantedBy: 'default.target',
    });

    expect(unit).toContain('ExecStart="/opt/Node Tools/node" "/tmp/host launcher.js"');
    expect(unit).toContain('WorkingDirectory="/tmp/a b"');
    expect(unit).toContain('Environment="HOME=/tmp/a b"');
  });
});
