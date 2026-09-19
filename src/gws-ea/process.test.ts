import { describe, expect, it } from 'vitest';

import { buildAllowlistedEnvironment, runSanitizedCommand } from './process.js';

describe('GWS-EA process boundary', () => {
  it('copies only inert operating-system values and explicit overrides', () => {
    const environment = buildAllowlistedEnvironment(
      {
        PATH: '/safe/bin',
        LANG: 'en_US.UTF-8',
        HOME: '/attacker',
        NODE_OPTIONS: '--import=/tmp/attacker.js',
        NANOCLAW_INSTALL_ID: 'victim',
        ONECLI_API_KEY: 'ambient-secret',
        GCHAT_CREDENTIALS: 'ambient-chat-secret',
      },
      { HOME: '/expected/home', NANOCLAW_INSTALL_ID: 'expected' },
    );

    expect(environment).toEqual({
      PATH: '/safe/bin',
      LANG: 'en_US.UTF-8',
      HOME: '/expected/home',
      NANOCLAW_INSTALL_ID: 'expected',
    });
  });

  it('executes an argument array without a shell or ambient environment', async () => {
    const result = await runSanitizedCommand({
      command: process.execPath,
      args: [
        '--input-type=module',
        '--eval',
        'process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), secret: process.env.AMBIENT_SECRET ?? null }))',
        '$(touch /tmp/gws-ea-must-not-exist)',
      ],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });

    expect(JSON.parse(result.stdout)).toEqual({
      argv: ['$(touch /tmp/gws-ea-must-not-exist)'],
      secret: null,
    });
  });
});
