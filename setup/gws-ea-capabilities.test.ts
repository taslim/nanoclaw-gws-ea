import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as prompts from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main } from './gws-ea.js';

vi.mock('@clack/prompts', async (original) => ({
  ...(await original<typeof import('@clack/prompts')>()),
  confirm: vi.fn(() => {
    throw new Error('Unexpected confirmation');
  }),
  spinner: vi.fn(() => {
    throw new Error('Unexpected spinner');
  }),
  note: vi.fn(() => {
    throw new Error('Unexpected prompt note');
  }),
}));
let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'capability-driver-')));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
describe('native capability driver', () => {
  it.each(['--json', '--no-input'])(
    'runs the actual driver with %s without invoking interaction hooks',
    async (mode) => {
      await mkdir(path.join(root, 'config'), { mode: 0o700 });
      vi.stubEnv('GWS_EA_CONFIG_ROOT', path.join(root, 'config'));
      vi.stubEnv('GWS_EA_STATE_ROOT', path.join(root, 'state'));
      const output: string[] = [];
      const errors: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        errors.push(String(chunk));
        return true;
      });
      const { confirm, spinner, note } = prompts;
      expect(await main(['capabilities', 'check', 'voice', mode], { interactive: true })).toBe(0);
      if (mode === '--json')
        expect(JSON.parse(output.join(''))).toMatchObject({
          schema_version: 1,
          command: 'capabilities check',
          outcome: 'succeeded',
          changed: false,
          data: { name: 'voice', assets: { status: 'absent' }, activation: { status: 'disabled' } },
        });
      else {
        expect(output.join('')).toContain('voice (host)');
        expect(output.join('')).toContain('Selected assets: absent');
        expect(output.join('')).toContain('Actions: show, check, install, enable, disable, uninstall');
        expect(output.join('')).toContain('recognition or model quality');
      }
      expect(errors).toEqual([]);
      expect(confirm).not.toHaveBeenCalled();
      expect(spinner).not.toHaveBeenCalled();
      expect(note).not.toHaveBeenCalled();
      expect(await readdir(path.join(root, 'config'))).toEqual([]);
      await expect(readdir(path.join(root, 'state'))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
});
