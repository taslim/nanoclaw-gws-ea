import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-presentation-'));
});
afterEach(async () => rm(root, { recursive: true, force: true }));
function environment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GWS_EA_CONFIG_ROOT: path.join(root, 'config'),
    GWS_EA_STATE_ROOT: path.join(root, 'state'),
    NO_COLOR: undefined,
    FORCE_COLOR: undefined,
  };
}
function invoke(args: readonly string[], env: NodeJS.ProcessEnv = environment()) {
  return execute(process.execPath, ['--import', 'tsx', 'setup/gws-ea.ts', ...args], { env });
}

describe('actual driver streams', () => {
  it('retains the same plain observation under redirected, quiet, and NO_COLOR output', async () => {
    const plain = await invoke(['connectors', 'check', 'voice']);
    const quiet = await invoke(['connectors', 'check', 'voice', '--quiet']);
    const noColor = await invoke(['connectors', 'check', 'voice'], {
      ...environment(),
      NO_COLOR: '1',
      FORCE_COLOR: '3',
    });
    for (const result of [plain, quiet, noColor]) {
      expect(result.stdout).toContain('voice (host)');
      expect(result.stdout).toContain('activation: disabled');
      expect(result.stdout).toContain('Observed:');
      expect(result.stdout).not.toMatch(/\x1b\[/u);
      expect(
        result.stderr.replace(
          /\(node:\d+\) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set\.\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/u,
          '',
        ),
      ).toBe('');
    }
    const withoutTime = (text: string) => text.replace(/^Observed:.*$/mu, 'Observed: <time>');
    expect(withoutTime(quiet.stdout)).toBe(withoutTime(plain.stdout));
    expect(withoutTime(noColor.stdout)).toBe(withoutTime(plain.stdout));
    expect(await readdir(root)).toEqual([]);
  });

  it('prints one UTC machine observation and no diagnostic or question', async () => {
    const { stdout, stderr } = await invoke(['connectors', 'check', 'voice', '--json', '--no-input']);
    expect(JSON.parse(stdout)).toMatchObject({
      schema_version: 1,
      command: 'connectors check',
      outcome: 'succeeded',
      changed: false,
      data: {
        observed_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/u),
        activation: { enabled: false },
        assets: { status: 'absent' },
      },
    });
    expect(stderr).toBe('');
    expect(await readdir(root)).toEqual([]);
  });
});
