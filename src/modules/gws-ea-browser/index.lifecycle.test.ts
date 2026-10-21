import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import type { ChildProcess } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { lookup } from '../../cli/registry.js';
import { getBrowserRuntime } from './index.js';
import { BrowserRuntime } from './runtime.js';
import { getHostShutdownCallbacks, getHostStartCallbacks } from '../../host-lifecycle.js';
import { closeDb, initTestDb } from '../../db/index.js';
import { BrowserQueue } from './queue.js';
import { BrowserWatchScheduler } from './scheduler.js';
import * as group from './group.js';
import * as reconciliation from './reconcile.js';
import * as signInMail from './sign-in-mail.js';
import * as purchases from './purchase.js';
import * as cancellation from './cancel.js';
import * as startup from './start-sweep.js';
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
  it('keeps recovered browser work available when optional watch scheduling cannot start', async () => {
    const db = await initTestDb();
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
        throw new Error('Watch scheduling unavailable');
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
      expect(stop).toHaveBeenCalledOnce();
      expect(retry).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(30_001);
      expect(schedule).toHaveBeenCalledTimes(2);
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
  });

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
  it('registers read-only browser health as a host-only command', () => {
    expect(lookup('gws-ea-browser-health')).toMatchObject({ access: 'hidden', hostOnly: true });
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
      const connect = connection.connectChromePipe;
      const spawn = vi.spyOn(chrome, 'spawnChrome');
      vi.spyOn(connection, 'connectChromePipe').mockImplementationOnce(async (child, paths) => {
        const attached = await connect(child, paths);
        vi.spyOn(attached.context, 'newCDPSession').mockRejectedValueOnce(new Error('Target lost during setup'));
        return attached;
      });
      try {
        await expect(runtime.connection()).rejects.toMatchObject({ code: 'browser_unavailable' });
        const spawned = spawn.mock.results[0];
        if (spawned?.type !== 'return') throw new Error('Expected an owned Chrome process');
        const child = spawned.value;
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
  it('bounds a stalled Chrome attachment and reports unavailable without retaining startup admission', async () => {
    await ensureBrowserPaths(browserPaths(file));
    await writePrivateFile(file, JSON.stringify({ schemaVersion: 1, enabled: true }));
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
  it.skipIf(!process.env.GWS_EA_BROWSER_TEST_CHROME)(
    'closes the owned Chrome and proxy when optional scheduler shutdown fails',
    async () => {
      const db = await initTestDb();
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
