import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeDb, initTestDb } from '../../db/index.js';
import type { SanitizedCommand } from '../../gws-ea/process.js';
import { browserHealth } from './health.js';
import * as loginStores from './login-store.js';
import { BrowserRuntime } from './runtime.js';

let directory: string;
let store: loginStores.LoginStore;
let key: string | undefined;
let locked: boolean;
let commands: SanitizedCommand[];
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'login-health-'));
  key = 'e2'.repeat(32);
  locked = false;
  commands = [];
  store = new loginStores.LoginStore({
    browserRoot: path.join(directory, 'browser'),
    instanceId: '41c276de-9cf4-47dc-a257-c09549cfa300',
    runCommand: async (command) => {
      commands.push(command);
      return { exitCode: locked ? 36 : key ? 0 : 44, stdout: locked ? '' : (key ?? ''), stderr: '' };
    },
  });
  vi.spyOn(loginStores, 'getLoginStore').mockResolvedValue(store);
  await initTestDb();
});
afterEach(async () => {
  await closeDb();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

it.each(['key_missing', 'key_mismatch', 'keychain_unavailable'] as const)(
  'reports only the host-observed login store availability (%s)',
  async (reason) => {
    const password = 'Clover!71-river';
    await store.create({ site: 'cedar.example', username: 'mira', title: 'Cedar', password });
    if (reason === 'key_missing') key = undefined;
    if (reason === 'key_mismatch') key = '39'.repeat(32);
    if (reason === 'keychain_unavailable') locked = true;
    const secret = vi.spyOn(store, 'secret');
    const health = await browserHealth(new BrowserRuntime(path.join(directory, 'browser')).state());
    expect(health.loginStore).toEqual({ available: false, reason });
    expect(secret).not.toHaveBeenCalled();
    expect(JSON.stringify(health)).not.toMatch(/Clover|mira|Cedar|e2e2e2/u);
    expect(commands.every((command) => command.args[0] === 'find-generic-password')).toBe(true);
  },
);

it('checks the key without decrypting saved passwords or creating a missing key', async () => {
  await store.create({ site: 'cedar.example', username: 'mira', title: 'Cedar', password: 'Clover!71-river' });
  const database = new Database(path.join(directory, 'browser', 'logins.db'));
  database.prepare('UPDATE logins SET password = zeroblob(28)').run();
  database.close();
  expect((await browserHealth(new BrowserRuntime(path.join(directory, 'browser')).state())).loginStore).toEqual({
    available: true,
  });
  await store.remove((await store.all())[0]!.id, 1);
  key = undefined;
  commands = [];
  expect((await browserHealth(new BrowserRuntime(path.join(directory, 'browser')).state())).loginStore).toEqual({
    available: true,
  });
  expect(commands).toHaveLength(1);
  expect(commands[0]?.args[0]).toBe('find-generic-password');
});
