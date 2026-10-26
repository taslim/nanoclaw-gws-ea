import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { browserAvailability, browserConfigured } from './availability.js';

let temporary: string;
beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'browser-availability-'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(temporary, { recursive: true, force: true });
});

it('distinguishes a configured browser from its missing Chrome prerequisite', async () => {
  const root = path.join(temporary, 'browser');
  expect(browserConfigured(root)).toBe(true);
  expect(await browserAvailability(root, path.join(temporary, 'missing-chrome'))).toEqual({
    available: false,
    reason: 'chrome-missing',
  });
});

it('becomes available without a policy file when Chrome is installed', async () => {
  const chrome = path.join(temporary, 'chrome');
  await writeFile(chrome, '#!/bin/sh\nexit 0\n');
  await chmod(chrome, 0o700);
  const root = path.join(temporary, 'browser');
  expect(await browserAvailability(root, chrome)).toMatchObject({
    available: true,
    paths: { root },
    chromePath: chrome,
  });
});

it('refuses a symlink profile before browser admission', async () => {
  const chrome = path.join(temporary, 'chrome');
  await writeFile(chrome, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await symlink(temporary, path.join(temporary, 'profile'));
  expect(await browserAvailability(temporary, chrome)).toEqual({
    available: false,
    reason: 'browser-path-unavailable',
  });
});

it('keeps an unconfigured host unavailable', async () => {
  vi.stubEnv('GWS_EA_BROWSER_ROOT', '');
  expect(browserConfigured('')).toBe(false);
  expect(await browserAvailability('', process.execPath)).toEqual({
    available: false,
    reason: 'browser-root-unconfigured',
  });
});

it('ignores an existing retired policy and leaves its contents untouched', async () => {
  const root = temporary;
  const retiredPolicy = path.join(root, 'policy.json');
  const contents = JSON.stringify({ schemaVersion: 1, enabled: false, chromePath: '/old/custom/chrome' });
  await writeFile(retiredPolicy, contents);
  expect(await browserAvailability(root, process.execPath)).toMatchObject({ available: true });
  expect(await readFile(retiredPolicy, 'utf8')).toBe(contents);
});
