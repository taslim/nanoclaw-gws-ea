import { describe, expect, it } from 'vitest';

import { renderLaunchdService, renderSystemdService } from './service-definition.js';

describe('service definition rendering', () => {
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
