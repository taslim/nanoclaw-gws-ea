import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser, Page } from 'playwright-core';

import { lookup } from '../../cli/registry.js';
import { browserActions, getBrowserRuntime } from './index.js';
import * as delivery from '../../delivery.js';
import { BrowserRuntime } from './runtime.js';
import { getHostShutdownCallbacks, getHostStartCallbacks } from '../../host-lifecycle.js';
import { closeDb, initTestDb } from '../../db/index.js';
import { BrowserQueue } from './queue.js';
import { BrowserWatchScheduler } from './scheduler.js';
import * as scheduling from './scheduler.js';
import * as group from './group.js';
import * as reconciliation from './reconcile.js';
import * as signInMail from './sign-in-mail.js';
import * as purchases from './purchase.js';
import * as cancellation from './cancel.js';
import * as startup from './start-sweep.js';
import * as chrome from './chrome.js';
import * as connection from './connection.js';
import { JobWindows } from './windows.js';
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
  vi.unstubAllEnvs();
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
  it('contains startup and sweep projection failures while durable maintenance continues and admission stays closed', async () => {
    const db = await initTestDb();
    vi.spyOn(scheduling, 'repairBrowserWatchChecks').mockResolvedValue();
    const recoverMail = vi.spyOn(signInMail, 'recoverBrowserSignInMail').mockResolvedValue();
    const recover = vi.spyOn(startup, 'sweepBrowserStartup').mockResolvedValue();
    const queueStart = vi.spyOn(BrowserQueue.prototype, 'start').mockResolvedValue();
    const resume = vi.spyOn(purchases, 'resumeBrowserPurchaseCommits').mockResolvedValue();
    const reconcile = vi
      .spyOn(reconciliation, 'reconcileBrowserGroup')
      .mockRejectedValue(new Error('EACCES: browser template'));
    vi.spyOn(getBrowserRuntime(), 'reconcile').mockResolvedValue();
    const idle = vi.spyOn(getBrowserRuntime(), 'closeIdleWindows').mockResolvedValue();
    const retry = vi.spyOn(BrowserQueue.prototype, 'retryAnswers').mockResolvedValue();
    const sweep = vi.spyOn(cancellation, 'sweepBrowserJobSessions').mockResolvedValue();
    const cleanup = vi.spyOn(signInMail, 'cleanupBrowserSignInMail').mockResolvedValue();
    const expire = vi.spyOn(purchases, 'sweepBrowserPurchaseState').mockResolvedValue();
    const startWatch = vi.spyOn(BrowserWatchScheduler.prototype, 'start').mockImplementation(() => undefined);
    const stopWatch = vi.spyOn(BrowserWatchScheduler.prototype, 'stop').mockResolvedValue();
    vi.useFakeTimers();
    try {
      const start = getHostStartCallbacks().at(-1)!;
      await expect(
        start({ db, signal: new AbortController().signal, deliveryAdapter: { deliver: async () => undefined } }),
      ).resolves.toBeUndefined();
      expect(recoverMail.mock.invocationCallOrder[0]).toBeLessThan(recover.mock.invocationCallOrder[0]!);
      expect(recover.mock.invocationCallOrder[0]).toBeLessThan(resume.mock.invocationCallOrder[0]!);
      expect(resume.mock.invocationCallOrder[0]).toBeLessThan(queueStart.mock.invocationCallOrder[0]!);
      expect(queueStart.mock.invocationCallOrder[0]).toBeLessThan(reconcile.mock.invocationCallOrder[0]!);
      expect(group.browserAdmissionReady()).toBe(false);
      expect(getBrowserRuntime().state().ready).toBe(false);
      expect(startWatch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_001);
      expect(retry).toHaveBeenCalled();
      expect(sweep).toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalled();
      expect(expire).toHaveBeenCalled();
      reconcile.mockResolvedValue();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(group.browserAdmissionReady()).toBe(true);
      expect(startWatch).toHaveBeenCalledOnce();
      const priorExpiry = expire.mock.calls.length;
      reconcile.mockRejectedValue(new Error('EACCES: active destination projection'));
      idle.mockRejectedValue(new Error('EACCES: idle cleanup'));
      retry.mockRejectedValue(new Error('EACCES: mailbox temporarily unavailable'));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(group.browserAdmissionReady()).toBe(false);
      expect(stopWatch).toHaveBeenCalledOnce();
      expect(expire.mock.calls.length).toBe(priorExpiry + 1);
      expect(cleanup.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.restoreAllMocks();
      await closeDb();
    }
  });

  it('does not reconcile or admit browser work before failed purchase recovery is retried successfully', async () => {
    const db = await initTestDb();
    vi.spyOn(scheduling, 'repairBrowserWatchChecks').mockResolvedValue();
    vi.spyOn(signInMail, 'recoverBrowserSignInMail').mockResolvedValue();
    vi.spyOn(startup, 'sweepBrowserStartup')
      .mockRejectedValueOnce(new Error('EIO: purchase recovery'))
      .mockResolvedValue();
    const startQueue = vi.spyOn(BrowserQueue.prototype, 'start').mockResolvedValue();
    const resume = vi.spyOn(purchases, 'resumeBrowserPurchaseCommits').mockResolvedValue();
    const reconcile = vi.spyOn(reconciliation, 'reconcileBrowserGroup').mockResolvedValue();
    vi.spyOn(getBrowserRuntime(), 'reconcile').mockResolvedValue();
    vi.spyOn(getBrowserRuntime(), 'closeIdleWindows').mockResolvedValue();
    vi.spyOn(BrowserQueue.prototype, 'retryAnswers').mockResolvedValue();
    vi.spyOn(cancellation, 'sweepBrowserJobSessions').mockResolvedValue();
    vi.spyOn(signInMail, 'cleanupBrowserSignInMail').mockResolvedValue();
    vi.spyOn(purchases, 'sweepBrowserPurchaseState').mockResolvedValue();
    vi.spyOn(BrowserWatchScheduler.prototype, 'start').mockImplementation(() => undefined);
    vi.spyOn(BrowserWatchScheduler.prototype, 'stop').mockResolvedValue();
    const controller = new AbortController();
    vi.useFakeTimers();
    try {
      await expect(
        getHostStartCallbacks().at(-1)!({
          db,
          signal: controller.signal,
          deliveryAdapter: { deliver: async () => undefined },
        }),
      ).resolves.toBeUndefined();
      expect(group.browserAdmissionReady()).toBe(false);
      expect(startQueue).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_001);
      expect(resume).toHaveBeenCalledOnce();
      expect(reconcile).toHaveBeenCalledOnce();
      expect(group.browserAdmissionReady()).toBe(true);
    } finally {
      controller.abort();
      await vi.advanceTimersByTimeAsync(30_000);
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.restoreAllMocks();
      await closeDb();
    }
  });
  it.each(['repair', 'start'])(
    'keeps recovered browser work available when optional watch %s fails',
    async (failure) => {
      const db = await initTestDb();
      const repair = vi.spyOn(scheduling, 'repairBrowserWatchChecks');
      if (failure === 'repair') repair.mockRejectedValueOnce(new Error('Watch repair unavailable'));
      repair.mockResolvedValue();
      vi.spyOn(signInMail, 'recoverBrowserSignInMail').mockResolvedValue();
      const recovery = vi.spyOn(startup, 'sweepBrowserStartup').mockResolvedValue();
      const startQueue = vi.spyOn(BrowserQueue.prototype, 'start').mockResolvedValue();
      vi.spyOn(purchases, 'resumeBrowserPurchaseCommits').mockResolvedValue();
      vi.spyOn(reconciliation, 'reconcileBrowserGroup').mockResolvedValue();
      vi.spyOn(getBrowserRuntime(), 'reconcile').mockResolvedValue();
      vi.spyOn(getBrowserRuntime(), 'closeIdleWindows').mockResolvedValue();
      const retry = vi.spyOn(BrowserQueue.prototype, 'retryAnswers').mockResolvedValue();
      vi.spyOn(cancellation, 'sweepBrowserJobSessions').mockResolvedValue();
      vi.spyOn(signInMail, 'cleanupBrowserSignInMail').mockResolvedValue();
      vi.spyOn(purchases, 'sweepBrowserPurchaseState').mockResolvedValue();
      const schedule = vi
        .spyOn(BrowserWatchScheduler.prototype, 'start')
        .mockImplementationOnce(() => {
          if (failure === 'start') throw new Error('Watch scheduling unavailable');
        })
        .mockImplementation(() => undefined);
      const stop = vi.spyOn(BrowserWatchScheduler.prototype, 'stop').mockResolvedValue();
      const controller = new AbortController();
      vi.useFakeTimers();
      try {
        await expect(
          getHostStartCallbacks().at(-1)!({
            db,
            signal: controller.signal,
            deliveryAdapter: { deliver: async () => undefined },
          }),
        ).resolves.toBeUndefined();
        expect(group.browserAdmissionReady()).toBe(true);
        expect(recovery).toHaveBeenCalledOnce();
        expect(startQueue).toHaveBeenCalledOnce();
        expect(repair).toHaveBeenCalledOnce();
        expect(stop).toHaveBeenCalledTimes(failure === 'repair' ? 0 : 1);
        expect(retry).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(30_001);
        expect(repair).toHaveBeenCalledTimes(2);
        expect(schedule).toHaveBeenCalledTimes(failure === 'repair' ? 1 : 2);
        expect(recovery).toHaveBeenCalledOnce();
        expect(group.browserAdmissionReady()).toBe(true);
      } finally {
        controller.abort();
        await vi.advanceTimersByTimeAsync(30_000);
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
        await closeDb();
      }
    },
  );

  it('does not admit a browser while Playwright protocol diagnostics can expose credentials', async () => {
    await ensureBrowserPaths(browserPaths(file));
    await writePrivateFile(file, JSON.stringify({ schemaVersion: 1, enabled: true }));
    const spawn = vi.spyOn(chrome, 'spawnChrome').mockImplementation(() => {
      throw new Error('Would spawn Chrome while protocol diagnostics are enabled');
    });
    vi.stubEnv('DEBUG', 'pw:protocol');
    try {
      await runtime.reconcile();
      await expect(runtime.connection()).rejects.toMatchObject({ code: 'browser_unavailable' });
      expect(spawn).not.toHaveBeenCalled();
      expect(runtime.state()).toMatchObject({
        enabled: true,
        proxy: { state: 'stopped' },
        lastFailure: { reason: 'browser_unavailable' },
      });
    } finally {
      spawn.mockRestore();
    }
  });
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
    await writePrivateFile(file, JSON.stringify({ schemaVersion: 1, enabled: true }));
    await runtime.reconcile();
    const state = runtime.state();
    expect(state).toMatchObject({
      enabled: true,
      proxy: { state: 'listening' },
      chrome: { state: 'stopped' },
      windows: 0,
    });
    if (state.proxy.state !== 'listening') throw new Error('Proxy not started');
    expect(await listening(state.proxy.port)).toBe(true);
    await writePrivateFile(file, JSON.stringify({ schemaVersion: 1, enabled: false }));
    await runtime.reconcile();
    expect(await listening(state.proxy.port)).toBe(false);
    expect(runtime.state()).toMatchObject({ enabled: false, proxy: { state: 'stopped' } });
  });
  it('never reopens the proxy after host shutdown even while the policy stays enabled', async () => {
    await ensureBrowserPaths(browserPaths(file));
    await writePrivateFile(file, JSON.stringify({ schemaVersion: 1, enabled: true }));
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
  it('registers the exact native actions once and reads host-only health without initializing them again', async () => {
    const names = [
      'browser',
      'fill_secret',
      'credential_form',
      'sign_in_code',
      'browser_relay_sign_in',
      'save_recipe',
      'run_recipe',
      'request_consent',
      'purchase',
      'browser_purchase_commit',
      'watch',
      'list_watches',
      'cancel_watch',
      'browser_watch_book',
    ];
    expect(Object.keys(browserActions).sort()).toEqual([...names].sort());
    const internal = new Set(['browser_relay_sign_in', 'browser_purchase_commit', 'browser_watch_book']);
    for (const name of names)
      if (internal.has(name)) expect(delivery.getDeliveryAction(name)).toBeUndefined();
      else expect(delivery.getDeliveryAction(name)).toBeTypeOf('function');
    const health = lookup('gws-ea-browser-health');
    expect(health).toMatchObject({ access: 'hidden', hostOnly: true });
    if (!health) throw new Error('Expected native health command');
    const callbacks = getHostStartCallbacks();
    const registration = vi.spyOn(delivery, 'registerDeliveryAction');
    const reconcile = vi.spyOn(getBrowserRuntime(), 'reconcile');
    try {
      for (let index = 0; index < 2; index++)
        expect(await health.handler(health.parseArgs({}), { caller: 'host' })).toMatchObject({
          schemaVersion: 1,
          policyVersions: [1, 2],
          enabled: false,
          proxy: { state: 'stopped' },
          chrome: { state: 'stopped' },
        });
      expect(registration).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
      expect(getHostStartCallbacks()).toEqual(callbacks);
    } finally {
      registration.mockRestore();
      reconcile.mockRestore();
    }
  });
  it.skipIf(!process.env.GWS_EA_BROWSER_TEST_CHROME)(
    'keeps the other native job page usable when one job closes',
    async () => {
      await ensureBrowserPaths(browserPaths(file));
      await writePrivateFile(
        file,
        JSON.stringify({
          schemaVersion: 1,
          enabled: true,
          chromePath: process.env.GWS_EA_BROWSER_TEST_CHROME,
        }),
      );
      const [first, second] = await Promise.all([runtime.pageForJob('first'), runtime.pageForJob('second')]);
      expect(first).not.toBe(second);
      expect(first.viewportSize()).toBeNull();
      expect(second.viewportSize()).toBeNull();
      const state = runtime.state();
      expect(state.chrome).toMatchObject({ state: 'running', debuggerPort: expect.any(Number) });
      if (state.chrome.state !== 'running') throw new Error('Expected an admitted Chrome');
      expect(state.chrome.debuggerPort).toBeGreaterThan(0);
      await runtime.closeJob('first');
      expect(first.isClosed()).toBe(true);
      expect(await second.evaluate('21 * 2')).toBe(42);
      expect(await runtime.pageForJob('second')).toBe(second);
    },
    30_000,
  );
  it.skipIf(!process.env.GWS_EA_BROWSER_TEST_CHROME)(
    'stops the owned Chrome after its connection loses target setup',
    async () => {
      await ensureBrowserPaths(browserPaths(file));
      await writePrivateFile(
        file,
        JSON.stringify({
          schemaVersion: 1,
          enabled: true,
          chromePath: process.env.GWS_EA_BROWSER_TEST_CHROME,
        }),
      );
      const connect = connection.connectChrome;
      const spawn = vi.spyOn(chrome, 'spawnChrome');
      vi.spyOn(connection, 'connectChrome').mockImplementationOnce(async (child, paths) => {
        const attached = await connect(child, paths);
        vi.spyOn(attached.context, 'newCDPSession').mockRejectedValueOnce(new Error('Target lost during setup'));
        return attached;
      });
      try {
        await expect(runtime.connection()).rejects.toMatchObject({ code: 'browser_unavailable' });
        const spawned = spawn.mock.results[0];
        if (spawned?.type !== 'return') throw new Error('Expected an owned Chrome process');
        const { child } = await spawned.value;
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
        expect(runtime.state().chrome).toEqual({ state: 'unavailable' });
        const state = runtime.state();
        await runtime.shutdown();
        if (state.proxy.state === 'listening') expect(await listening(state.proxy.port)).toBe(false);
      } finally {
        vi.restoreAllMocks();
      }
    },
    30_000,
  );
  it('bounds a stalled attach and disposes a late success without publishing it', async () => {
    await ensureBrowserPaths(browserPaths(file));
    await writePrivateFile(file, JSON.stringify({ schemaVersion: 1, enabled: true }));
    await runtime.reconcile();
    const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null as number | null, signalCode: null });
    vi.spyOn(chrome, 'spawnChrome').mockResolvedValue({ child: child as ChildProcess, debuggerPort: 45679 });
    vi.spyOn(chrome, 'stopChrome').mockImplementation(async () => {
      child.exitCode = 0;
      child.emit('exit', 0, null);
    });
    let entered!: () => void;
    const connecting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resolveConnection!: (attached: connection.ChromeConnection) => void;
    vi.spyOn(connection, 'connectChrome').mockImplementation(() => {
      entered();
      return new Promise((resolve) => {
        resolveConnection = resolve;
      });
    });
    const policy = vi.spyOn(connection, 'verifyChromePolicy').mockResolvedValue();
    const close = vi.fn(async () => undefined);
    const attached = { child, close } as unknown as connection.ChromeConnection;
    vi.useFakeTimers();
    const pending = runtime.connection();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'browser_unavailable' });
    try {
      await connecting;
      await vi.advanceTimersByTimeAsync(30_001);
      await rejected;
      expect(child.exitCode).toBe(0);
      expect(runtime.state().chrome).toEqual({ state: 'unavailable' });
      resolveConnection(attached);
      await vi.advanceTimersByTimeAsync(0);
      expect(close).toHaveBeenCalledOnce();
      expect(policy).not.toHaveBeenCalled();
      expect(runtime.state().chrome).toEqual({ state: 'unavailable' });
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it.each(['shutdown', 'disable'] as const)('cancels pending setup on %s and closes a later attach', async (action) => {
    await ensureBrowserPaths(browserPaths(file));
    await writePrivateFile(file, JSON.stringify({ schemaVersion: 1, enabled: true }));
    await runtime.reconcile();
    const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null as number | null, signalCode: null });
    vi.spyOn(chrome, 'spawnChrome').mockResolvedValue({ child: child as ChildProcess, debuggerPort: 45679 });
    vi.spyOn(chrome, 'stopChrome').mockImplementation(async () => {
      child.exitCode = 0;
      child.emit('exit', 0, null);
    });
    let entered!: () => void;
    const connecting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resolveConnection!: (attached: connection.ChromeConnection) => void;
    vi.spyOn(connection, 'connectChrome').mockImplementation(() => {
      entered();
      return new Promise((resolve) => {
        resolveConnection = resolve;
      });
    });
    const close = vi.fn(async () => undefined);
    const pending = runtime.connection();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'browser_unavailable' });
    try {
      await connecting;
      if (action === 'disable') await writePrivateFile(file, JSON.stringify({ schemaVersion: 1, enabled: false }));
      await (action === 'shutdown' ? runtime.shutdown() : runtime.reconcile());
      await rejected;
      expect(child.exitCode).toBe(0);
      expect(runtime.state()).toMatchObject({ ready: false, proxy: { state: 'stopped' }, windows: 0 });
      resolveConnection({ child, close } as unknown as connection.ChromeConnection);
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(runtime.state().chrome.state).not.toBe('running');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('keeps the single startup deadline through background policy admission and retires before client disposal', async () => {
    await ensureBrowserPaths(browserPaths(file));
    await writePrivateFile(file, JSON.stringify({ schemaVersion: 1, enabled: true }));
    await runtime.reconcile();
    const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null as number | null, signalCode: null });
    vi.spyOn(chrome, 'spawnChrome').mockResolvedValue({ child: child as ChildProcess, debuggerPort: 45679 });
    vi.spyOn(chrome, 'stopChrome').mockImplementation(async () => {
      child.exitCode = 0;
      child.emit('exit', 0, null);
    });
    const close = vi.fn(() => new Promise<never>(() => undefined));
    const browser = { isConnected: () => true } as Browser;
    vi.spyOn(connection, 'connectChrome').mockResolvedValue({
      child,
      browser,
      close,
    } as unknown as connection.ChromeConnection);
    vi.spyOn(JobWindows.prototype, 'pageForJob').mockResolvedValue({} as Page);
    const windowsClosed = vi.spyOn(JobWindows.prototype, 'close').mockResolvedValue();
    let entered!: () => void;
    const probing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finishProbe!: () => void;
    vi.spyOn(connection, 'verifyChromePolicy').mockImplementation(() => {
      entered();
      return new Promise<void>((resolve) => {
        finishProbe = resolve;
      });
    });
    vi.useFakeTimers();
    const pending = runtime.connection();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'browser_unavailable' });
    try {
      await probing;
      await vi.advanceTimersByTimeAsync(30_001);
      await rejected;
      expect(child.exitCode).toBe(0);
      expect(close).toHaveBeenCalledOnce();
      expect(runtime.state().chrome).toEqual({ state: 'unavailable' });
      finishProbe();
      await vi.advanceTimersByTimeAsync(0);
      expect(windowsClosed).toHaveBeenCalledOnce();
      expect(runtime.state().chrome).toEqual({ state: 'unavailable' });
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
  it.skipIf(!process.env.GWS_EA_BROWSER_TEST_CHROME)(
    'closes the owned Chrome and proxy when optional scheduler shutdown fails',
    async () => {
      const db = await initTestDb();
      vi.spyOn(scheduling, 'repairBrowserWatchChecks').mockResolvedValue();
      await ensureBrowserPaths(browserPaths(file));
      await writePrivateFile(
        file,
        JSON.stringify({ schemaVersion: 1, enabled: true, chromePath: process.env.GWS_EA_BROWSER_TEST_CHROME }),
      );
      vi.stubEnv('GWS_EA_BROWSER_POLICY_FILE', file);
      vi.spyOn(signInMail, 'recoverBrowserSignInMail').mockResolvedValue();
      vi.spyOn(signInMail, 'cleanupBrowserSignInMail').mockResolvedValue();
      vi.spyOn(startup, 'sweepBrowserStartup').mockResolvedValue();
      vi.spyOn(BrowserQueue.prototype, 'start').mockResolvedValue();
      const stopQueue = vi.spyOn(BrowserQueue.prototype, 'stop').mockResolvedValue();
      vi.spyOn(BrowserQueue.prototype, 'retryAnswers').mockResolvedValue();
      vi.spyOn(purchases, 'resumeBrowserPurchaseCommits').mockResolvedValue();
      vi.spyOn(purchases, 'sweepBrowserPurchaseState').mockResolvedValue();
      vi.spyOn(cancellation, 'sweepBrowserJobSessions').mockResolvedValue();
      vi.spyOn(reconciliation, 'reconcileBrowserGroup').mockResolvedValue();
      vi.spyOn(BrowserWatchScheduler.prototype, 'start').mockImplementation(() => undefined);
      vi.spyOn(BrowserWatchScheduler.prototype, 'stop').mockRejectedValue(new Error('Scheduler cleanup failed'));
      const owned = getBrowserRuntime();
      try {
        await getHostStartCallbacks().at(-1)!({
          db,
          signal: new AbortController().signal,
          deliveryAdapter: { deliver: async () => undefined },
        });
        const attached = await owned.connection();
        const state = owned.state();
        if (state.proxy.state !== 'listening') throw new Error('Expected an owned proxy');
        expect(await listening(state.proxy.port)).toBe(true);
        await expect(getHostShutdownCallbacks().at(-1)!()).rejects.toThrow('Scheduler cleanup failed');
        expect(attached.browser.isConnected()).toBe(false);
        expect(attached.child.exitCode !== null || attached.child.signalCode !== null).toBe(true);
        expect(await listening(state.proxy.port)).toBe(false);
        expect(stopQueue).toHaveBeenCalledOnce();
      } finally {
        await owned.shutdown();
        vi.restoreAllMocks();
        await closeDb();
      }
    },
    30_000,
  );
});
