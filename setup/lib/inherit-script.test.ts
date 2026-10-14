import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { buildInteractiveEnvironment, runInheritScript } from './inherit-script.js';

describe('interactive child environment', () => {
  it('preserves terminal and browser integration without inheriting ambient credentials', () => {
    const environment = buildInteractiveEnvironment({
      HOME: '/Users/operator',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      TERM: 'xterm-256color',
      NO_COLOR: '1',
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
      NO_COLOR: '1',
      DISPLAY: ':0',
      BROWSER: 'open',
    });
  });

  it('routes real child stdout to the diagnostic descriptor for managed callers', async () => {
    const module = new URL('./inherit-script.ts', import.meta.url).href;
    const childScript = 'process.stdout.write("auth progress\\n"); process.stderr.write("auth diagnostic\\n")';
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import { runInheritScript } from ${JSON.stringify(module)};
      process.exitCode = await runInheritScript(process.execPath, ['-e', ${JSON.stringify(childScript)}], { output: process.stderr }); process.stdin.pause();`,
    ]);
    expect(stdout).toBe('');
    expect(stderr).toBe('auth progress\nauth diagnostic\n');
  });

  it('returns a nonzero result when an interactive child cannot start', async () => {
    await expect(runInheritScript('/gws-ea-command-that-does-not-exist', [])).resolves.toBe(1);
  });
});
