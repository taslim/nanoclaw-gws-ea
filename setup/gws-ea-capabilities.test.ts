import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as prompts from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectResultContract } from '../src/gws-ea/testing/result-contract.js';
import { chooseOnePasswordAccount, main } from './gws-ea.js';

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
  select: vi.fn(() => {
    throw new Error('Unexpected selection');
  }),
  text: vi.fn(() => {
    throw new Error('Unexpected text prompt');
  }),
  password: vi.fn(() => {
    throw new Error('Unexpected secret prompt');
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
      if (mode === '--json') {
        expectResultContract('capabilities check', JSON.parse(output.join('')));
        expect(JSON.parse(output.join(''))).toMatchObject({
          schema_version: 1,
          command: 'capabilities check',
          outcome: 'succeeded',
          changed: false,
          data: { name: 'voice', assets: { status: 'absent' }, activation: { status: 'disabled' } },
        });
      } else {
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

  it.each(['--json', '--no-input'])(
    'checks and enables 1Password with %s without any prompt, reporting the missing CLI as the prerequisite',
    async (mode) => {
      await mkdir(path.join(root, 'config'), { mode: 0o700 });
      await mkdir(path.join(root, 'empty-path'), { mode: 0o700 });
      vi.stubEnv('GWS_EA_CONFIG_ROOT', path.join(root, 'config'));
      vi.stubEnv('GWS_EA_STATE_ROOT', path.join(root, 'state'));
      // The operator's PATH has no 1Password CLI.
      vi.stubEnv('PATH', path.join(root, 'empty-path'));
      const output: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      expect(await main(['capabilities', 'check', 'onepassword', mode], { interactive: true })).toBe(0);
      if (mode === '--json') {
        const checked = JSON.parse(output.join('')) as unknown;
        expectResultContract('capabilities check onepassword', checked);
        expect(checked).toMatchObject({
          outcome: 'succeeded',
          changed: false,
          data: { activation: { status: 'disabled' } },
        });
      } else expect(output.join('')).toContain('onepassword (host)');
      expect(await readdir(path.join(root, 'config'))).toEqual([]);

      output.length = 0;
      expect(await main(['capabilities', 'enable', 'onepassword', mode], { interactive: true })).toBe(1);
      if (mode === '--json') {
        const enabled = JSON.parse(output.join('')) as unknown;
        expectResultContract('capabilities enable onepassword', enabled);
        expect(enabled).toMatchObject({ outcome: 'failed', error: { code: 'onepassword_cli_missing' } });
      }
      const { confirm, spinner, note, select, text, password } = prompts;
      for (const prompt of [confirm, spinner, note, select, text, password]) expect(prompt).not.toHaveBeenCalled();
      expect(await readdir(path.join(root, 'config'))).toEqual([]);
    },
  );

  it('asks a terminal operator which 1Password account assistants use, by its exact ID', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const accounts = [
      {
        accountId: 'HALEFAMILY0000000000000001',
        userId: 'MORGANELLERY00000000000001',
        url: 'hale.1password.com',
        email: 'morgan@example.test',
      },
      {
        accountId: 'VANCETEAM00000000000000002',
        userId: 'MORGANELLERY00000000000002',
        url: 'vance.1password.com',
        email: 'morgan@example.test',
      },
    ];
    vi.mocked(prompts.select).mockResolvedValueOnce('VANCETEAM00000000000000002');
    expect(await chooseOnePasswordAccount(accounts)).toBe('VANCETEAM00000000000000002');
    expect(vi.mocked(prompts.select).mock.calls[0][0]).toMatchObject({
      options: [
        { value: 'HALEFAMILY0000000000000001', label: 'morgan@example.test on hale.1password.com' },
        { value: 'VANCETEAM00000000000000002', label: 'morgan@example.test on vance.1password.com' },
      ],
    });
    vi.mocked(prompts.select).mockResolvedValueOnce(Symbol('clack:cancel'));
    expect(await chooseOnePasswordAccount(accounts)).toBeUndefined();
  });
});
