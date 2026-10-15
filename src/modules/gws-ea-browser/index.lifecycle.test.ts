import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import type { ChildProcess } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { lookup } from '../../cli/registry.js';
import { BrowserRuntime } from './index.js';
import * as chrome from './chrome.js';
import * as connection from './connection.js';
import { browserPaths, ensureBrowserPaths, writePrivateFile } from './paths.js';

let root: string;
let runtime: BrowserRuntime;
let file: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'browser-lifecycle-'));
  file = path.join(root, 'browser', 'policy.json');
  runtime = new BrowserRuntime(file);
});
afterEach(async () => {
  await runtime.stop();
  await rm(root, { recursive: true, force: true });
});

async function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

describe('optional host browser lifecycle', () => {
  it('does no browser work without an enabled policy', async () => {
    await runtime.reconcile();
    expect(runtime.state()).toMatchObject({
      enabled: false,
      proxy: { state: 'stopped' },
      chrome: { state: 'stopped' },
    });
    await expect(runtime.pageForJob('job')).rejects.toMatchObject({ code: 'browser_unavailable' });
  });
  it('prewarms the public proxy with no job or token and stops it on policy disable', async () => {
    await ensureBrowserPaths(browserPaths(file));
    await writePrivateFile(file, JSON.stringify({ schemaVersion: 1, enabled: true, credentialMode: 'email' }));
    await runtime.reconcile();
    const state = runtime.state();
    expect(state).toMatchObject({
      enabled: true,
      credentialMode: 'email',
      proxy: { state: 'listening' },
      chrome: { state: 'stopped' },
      windows: 0,
    });
    if (state.proxy.state !== 'listening') throw new Error('Proxy not started');
    expect(await listening(state.proxy.port)).toBe(true);
    await writePrivateFile(file, JSON.stringify({ schemaVersion: 1, enabled: false, credentialMode: 'email' }));
    await runtime.reconcile();
    expect(await listening(state.proxy.port)).toBe(false);
    expect(runtime.state()).toMatchObject({ enabled: false, proxy: { state: 'stopped' } });
  });
  it('never reopens the proxy after host shutdown even while the policy stays enabled', async () => {
    await ensureBrowserPaths(browserPaths(file));
    await writePrivateFile(file, JSON.stringify({ schemaVersion: 1, enabled: true, credentialMode: 'email' }));
    await runtime.reconcile();
    await runtime.shutdown();
    await runtime.reconcile();
    await expect(runtime.connection()).rejects.toMatchObject({ code: 'browser_unavailable' });
    expect(runtime.state().proxy).toEqual({ state: 'stopped' });
  });
  it('keeps messaging-host health available when its owned Chrome cannot spawn', async () => {
    await ensureBrowserPaths(browserPaths(file));
    await writePrivateFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        credentialMode: 'email',
        chromePath: '/no-such-browser-runtime/chrome',
      }),
    );
    await expect(runtime.pageForJob('job')).rejects.toMatchObject({ code: 'browser_unavailable' });
    expect(runtime.state()).toMatchObject({
      enabled: true,
      chrome: { state: 'unavailable' },
      lastFailure: { reason: 'browser_unavailable' },
    });
  });
  it('registers read-only browser health as a host-only command', () => {
    expect(lookup('gws-ea-browser-health')).toMatchObject({ access: 'hidden', hostOnly: true });
  });
  it('bounds a stalled Chrome attachment and reports unavailable without retaining startup admission', async () => {
    await ensureBrowserPaths(browserPaths(file));
    await writePrivateFile(file, JSON.stringify({ schemaVersion: 1, enabled: true, credentialMode: 'email' }));
    await runtime.reconcile();
    let entered!: () => void;
    const connecting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let rejectConnection!: (error: Error) => void;
    vi.spyOn(chrome, 'spawnChrome').mockReturnValue({} as ChildProcess);
    vi.spyOn(chrome, 'stopChrome').mockResolvedValue();
    vi.spyOn(connection, 'connectChromePipe').mockImplementation(() => {
      entered();
      return new Promise((_resolve, reject) => {
        rejectConnection = reject;
      });
    });
    vi.useFakeTimers();
    let outcome = 'pending';
    const pending = runtime.pageForJob('stalled').then(
      () => {
        outcome = 'opened';
      },
      () => {
        outcome = 'browser_unavailable';
      },
    );
    try {
      await connecting;
      await vi.advanceTimersByTimeAsync(30_001);
      expect(outcome).toBe('browser_unavailable');
      expect(runtime.state().chrome).toEqual({ state: 'unavailable' });
    } finally {
      rejectConnection(new Error('Owned test connection cleanup'));
      await pending;
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});
