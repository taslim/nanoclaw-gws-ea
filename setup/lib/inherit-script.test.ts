import { describe, expect, it } from 'vitest';

import { buildInteractiveEnvironment, runInheritScript } from './inherit-script.js';

describe('interactive child environment', () => {
  it('preserves terminal and browser integration without inheriting ambient credentials', () => {
    const environment = buildInteractiveEnvironment({
      HOME: '/Users/operator',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      TERM: 'xterm-256color',
      DISPLAY: ':0',
      BROWSER: 'open',
      ANTHROPIC_API_KEY: 'must-not-reach-auth-child',
      GOOGLE_APPLICATION_CREDENTIALS: '/tmp/cloud-key.json',
      ONECLI_API_KEY: 'must-not-reach-auth-child',
      NPM_TOKEN: 'must-not-reach-pnpm',
    });

    expect(environment).toEqual({
      NANOCLAW_SETUP_WIZARD: '1',
      HOME: '/Users/operator',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      TERM: 'xterm-256color',
      DISPLAY: ':0',
      BROWSER: 'open',
    });
  });

  it('returns a nonzero result when an interactive child cannot start', async () => {
    await expect(runInheritScript('/gws-ea-command-that-does-not-exist', [])).resolves.toBe(1);
  });
});
