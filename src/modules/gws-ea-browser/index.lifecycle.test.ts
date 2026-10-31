import * as availability from './availability.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

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
import { browserPaths, ensureBrowserPaths } from './paths.js';

let root: string;
let runtime: BrowserRuntime;
let file: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'browser-lifecycle-'));
  file = path.join(root, 'browser');
  runtime = new BrowserRuntime(file, undefined, process.env.GWS_EA_BROWSER_TEST_CHROME ?? process.execPath);
});
afterEach(async () => {
  await runtime.stop();
  vi.restoreAllMocks();
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

async function ownedRuntime(keepJob: (jobId: string) => Promise<boolean> = async () => false) {
  runtime = new BrowserRuntime(file, undefined, process.execPath, keepJob);
  const events = new EventEmitter();
  const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null as number | null, signalCode: null });
  let connected = true;
  const close = vi.fn(async () => {
    connected = false;
    child.exitCode = 0;
    events.emit('disconnected');
  });
  const attached = {
    child,
    debuggerPort: 45679,
    browser: Object.assign(events, { isConnected: () => connected, version: () => 'fixture' }),
    close,
  } as unknown as connection.ChromeConnection;
  const spawn = vi
    .spyOn(chrome, 'spawnChrome')
    .mockResolvedValue({ child: child as ChildProcess, debuggerPort: 45679 });
  vi.spyOn(chrome, 'retireChromeProfile').mockResolvedValue();
  vi.spyOn(chrome, 'stopChrome').mockResolvedValue();
  vi.spyOn(connection, 'connectChrome').mockResolvedValue(attached);
  vi.spyOn(connection, 'verifyChromePolicy').mockResolvedValue();
  vi.spyOn(connection, 'createBackgroundPage').mockImplementation(async () => {
    const pageEvents = new EventEmitter();
    let closed = false;
    return Object.assign(pageEvents, {
      isClosed: () => closed,
      async close() {
        closed = true;
        pageEvents.emit('close');
      },
    }) as unknown as Page;
  });
  await ensureBrowserPaths(browserPaths(file));
  return { close, spawn, events };
}

describe('Chrome follows browser work', () => {
  it('retires a prior host browser during reconciliation without starting a new one', async () => {
    const { spawn } = await ownedRuntime();
    await runtime.reconcile();
    expect(chrome.retireChromeProfile).toHaveBeenCalledExactlyOnceWith(browserPaths(file), process.execPath);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('closes an exited worker page, preserves another worker or checkout, then stops after the last release', async () => {
    const held = new Set(['other-worker', 'checkout']);
    const { close } = await ownedRuntime(async (jobId) => held.has(jobId));
    const released = await runtime.pageForJob('exited-worker');
    const other = await runtime.pageForJob('other-worker');
    const checkout = await runtime.pageForJob('checkout');
    vi.useFakeTimers();
    await runtime.releaseUnusedPages();
    expect(released.isClosed()).toBe(true);
    expect(other.isClosed()).toBe(false);
    expect(checkout.isClosed()).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(close).not.toHaveBeenCalled();
    held.clear();
    await runtime.releaseUnusedPages();
    expect(other.isClosed()).toBe(true);
    expect(checkout.isClosed()).toBe(true);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(runtime.state()).toMatchObject({ chrome: { state: 'stopped' }, proxy: { state: 'listening' } });
    vi.useRealTimers();
  });

  it('keeps a host operation alive without a worker and restarts the idle grace after new work', async () => {
    const { close } = await ownedRuntime();
    vi.useFakeTimers();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const work = runtime.withActivity(async () => {
      await runtime.connection();
      await waiting;
    });
    await vi.waitFor(() => expect(runtime.state().chrome.state).toBe('running'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(close).not.toHaveBeenCalled();
    release();
    await work;
    await vi.advanceTimersByTimeAsync(20_000);
    await runtime.withActivity(async () => undefined);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    vi.useRealTimers();
  });

  it('interrupts a disconnected browser without launching an unused replacement', async () => {
    const { spawn, events } = await ownedRuntime();
    const disconnected = vi.fn();
    runtime.onDisconnected(disconnected);
    await runtime.connection();
    vi.useFakeTimers();
    events.emit('disconnected');
    await vi.advanceTimersByTimeAsync(5_000);
    await runtime.reconcile();
    expect(disconnected).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledOnce();
    expect(runtime.state().chrome.state).toBe('stopped');
    vi.useRealTimers();
  });

  it('rechecks process ownership on demand after a disconnected child could not initially be retired', async () => {
    const { events, spawn } = await ownedRuntime();
    await runtime.connection();
    vi.mocked(chrome.stopChrome).mockRejectedValueOnce(new Error('Process inspection unavailable'));
    events.emit('disconnected');
    await expect(runtime.connection()).resolves.toBeDefined();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('cancels an idle close already queued behind reconciliation when new work resets the grace period', async () => {
    const { close } = await ownedRuntime();
    vi.useFakeTimers();
    await runtime.connection();
    const policy = await availability.browserAvailability(file, process.execPath);
    let reconcile!: (value: availability.BrowserAvailability) => void;
    vi.spyOn(availability, 'browserAvailability').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          reconcile = resolve;
        }),
    );
    const reconciling = runtime.reconcile();
    await vi.waitFor(() => expect(reconcile).toBeDefined());
    await vi.advanceTimersByTimeAsync(30_000);
    const next = runtime.withActivity(async () => undefined);
    reconcile(policy);
    await reconciling;
    await next;
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    vi.useRealTimers();
  });

  it('waits for a spawn racing cancellation to retire before completing host shutdown', async () => {
    await ownedRuntime();
    let spawned!: (owned: chrome.OwnedChrome) => void;
    vi.mocked(chrome.spawnChrome).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          spawned = resolve;
        }),
    );
    const connecting = runtime.connection();
    const refused = expect(connecting).rejects.toMatchObject({ code: 'browser_unavailable' });
    await vi.waitFor(() => expect(chrome.spawnChrome).toHaveBeenCalledOnce());
    let stopped = false;
    const shutdown = runtime.shutdown().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    const child = Object.assign(new EventEmitter(), { pid: 23456, exitCode: null, signalCode: null });
    spawned({ child: child as ChildProcess, debuggerPort: 45679 });
    await refused;
    await shutdown;
    expect(chrome.stopChrome).toHaveBeenCalledWith(child);
    await expect(runtime.withActivity(async () => undefined)).rejects.toMatchObject({ code: 'browser_unavailable' });
    expect(runtime.state().proxy.state).toBe('stopped');
  });

  it('waits for cancelled profile preparation to settle before releasing its owner', async () => {
    await ownedRuntime();
    const prepare = chrome.prepareChromeProfile;
    let prepared!: () => void;
    const entered = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    let finish!: () => void;
    const pendingWrite = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(chrome, 'prepareChromeProfile').mockImplementationOnce(async (paths) => {
      await prepare(paths);
      prepared();
      await pendingWrite;
    });
    const connecting = runtime.connection();
    const refused = expect(connecting).rejects.toMatchObject({ code: 'browser_unavailable' });
    await entered;
    const stopping = runtime.shutdown();
    let timeout: NodeJS.Timeout | undefined;
    try {
      expect(
        await Promise.race([
          stopping.then(() => true),
          new Promise<boolean>((resolve) => {
            timeout = setTimeout(() => resolve(false), 50);
          }),
        ]),
      ).toBe(false);
    } finally {
      if (timeout) clearTimeout(timeout);
      finish();
      await refused;
      await stopping;
    }
    expect(chrome.spawnChrome).not.toHaveBeenCalled();
  });

  it('keeps a page used by new work when an earlier ownership read finishes late', async () => {
    let keep = true;
    let staleRead: ((value: boolean) => void) | undefined;
    let block = false;
    await ownedRuntime(async () => {
      if (block) {
        block = false;
        return new Promise<boolean>((resolve) => {
          staleRead = resolve;
        });
      }
      return keep;
    });
    const page = await runtime.pageForJob('worker');
    block = true;
    const releasing = runtime.releaseUnusedPages();
    await vi.waitFor(() => expect(staleRead).toBeDefined());
    await runtime.withActivity(async () => {
      keep = true;
    });
    staleRead?.(false);
    await releasing;
    expect(page.isClosed()).toBe(false);
  });
});

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
    vi.spyOn(getBrowserRuntime(), 'closeAdmission').mockImplementation(() => undefined);
    const idle = vi.spyOn(getBrowserRuntime(), 'releaseUnusedPages').mockResolvedValue();
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
    vi.spyOn(getBrowserRuntime(), 'closeAdmission').mockImplementation(() => undefined);
    vi.spyOn(getBrowserRuntime(), 'releaseUnusedPages').mockResolvedValue();
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
      vi.spyOn(getBrowserRuntime(), 'closeAdmission').mockImplementation(() => undefined);
      vi.spyOn(getBrowserRuntime(), 'releaseUnusedPages').mockResolvedValue();
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

    const spawn = vi.spyOn(chrome, 'spawnChrome').mockImplementation(() => {
      throw new Error('Would spawn Chrome while protocol diagnostics are enabled');
    });
    vi.stubEnv('DEBUG', 'pw:protocol');
    try {
      await runtime.reconcile();
      await expect(runtime.connection()).rejects.toMatchObject({ code: 'browser_unavailable' });
      expect(spawn).not.toHaveBeenCalled();
      expect(runtime.state()).toMatchObject({
        configured: true,
        available: true,
        proxy: { state: 'stopped' },
        lastFailure: { reason: 'browser_unavailable' },
      });
    } finally {
      spawn.mockRestore();
    }
  });
  it('does no browser work without a configured root', async () => {
    runtime = new BrowserRuntime('');
    await runtime.reconcile();
    expect(runtime.state()).toMatchObject({
      configured: false,
      available: false,
      proxy: { state: 'stopped' },
      chrome: { state: 'stopped' },
    });
    await expect(runtime.pageForJob('job')).rejects.toMatchObject({ code: 'browser_unavailable' });
  });
  it('prewarms the public proxy with no job or token and stops it on Chrome removal', async () => {
    await ensureBrowserPaths(browserPaths(file));

    await runtime.reconcile();
    const state = runtime.state();
    expect(state).toMatchObject({
      configured: true,
      available: true,
      proxy: { state: 'listening' },
      chrome: { state: 'stopped' },
      windows: 0,
    });
    if (state.proxy.state !== 'listening') throw new Error('Proxy not started');
    expect(await listening(state.proxy.port)).toBe(true);
    vi.spyOn(availability, 'browserAvailability').mockResolvedValue({ available: false, reason: 'chrome-missing' });
    await runtime.reconcile();
    expect(await listening(state.proxy.port)).toBe(false);
    expect(runtime.state()).toMatchObject({ configured: true, available: false, proxy: { state: 'stopped' } });
  });
  it('never reopens the proxy after host shutdown even while the Chrome stays available', async () => {
    await ensureBrowserPaths(browserPaths(file));

    await runtime.reconcile();
    await runtime.shutdown();
    await runtime.reconcile();
    await expect(runtime.connection()).rejects.toMatchObject({ code: 'browser_unavailable' });
    expect(runtime.state().proxy).toEqual({ state: 'stopped' });
  });
  it('keeps messaging-host health available when Chrome is missing', async () => {
    runtime = new BrowserRuntime(file, undefined, '/no-such-browser-runtime/chrome');
    await ensureBrowserPaths(browserPaths(file));

    await expect(runtime.pageForJob('job')).rejects.toMatchObject({ code: 'browser_unavailable' });
    expect(runtime.state()).toMatchObject({
      configured: true,
      available: false,
      chrome: { state: 'stopped' },
      reason: expect.stringContaining('Chrome is not installed'),
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
    await initTestDb();
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

          configured: false,
          available: false,
          proxy: { state: 'stopped' },
          chrome: { state: 'stopped' },
        });
      expect(registration).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
      expect(getHostStartCallbacks()).toEqual(callbacks);
    } finally {
      await closeDb();
      registration.mockRestore();
      reconcile.mockRestore();
    }
  });
  it.skipIf(!process.env.GWS_EA_BROWSER_TEST_CHROME)(
    'retires an unresponsive Chrome and every profile helper without waiting for page disposal',
    async () => {
      let keep = true;
      runtime = new BrowserRuntime(file, undefined, process.env.GWS_EA_BROWSER_TEST_CHROME, async () => keep);
      await ensureBrowserPaths(browserPaths(file));
      const page = await runtime.pageForJob('paused');
      const attached = await runtime.connection();
      const pid = attached.child.pid;
      if (pid === undefined) throw new Error('Owned Chrome unavailable');
      const profileProcesses = async (): Promise<number[]> => {
        const { stdout } = await promisify(execFile)('/bin/ps', ['-A', '-ww', '-o', 'pid=,args=']);
        return stdout
          .split('\n')
          .filter((line) => line.includes(file))
          .map((line) => Number(line.trim().split(/\s+/u)[0]));
      };
      expect(await profileProcesses()).toContain(pid);
      const resume = (): void => {
        try {
          process.kill(pid, 'SIGCONT');
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
        }
      };
      process.kill(pid, 'SIGSTOP');
      keep = false;
      const pageClose = vi.spyOn(page, 'close');
      const releasing = runtime.releaseUnusedPages();
      await vi.waitFor(() => expect(pageClose).toHaveBeenCalled());
      const stopping = runtime.shutdown();
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.all([stopping, releasing]),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error('Chrome retirement did not reach its process fallback')),
              8_000,
            );
          }),
        ]);
        expect(await profileProcesses()).toEqual([]);
      } finally {
        if (timeout) clearTimeout(timeout);
        resume();
        await Promise.all([stopping, releasing]);
      }
    },
    30_000,
  );
  it.skipIf(!process.env.GWS_EA_BROWSER_TEST_CHROME)(
    'preserves persistent sign-in cookies when Chrome stops and launches on demand again',
    async () => {
      await ensureBrowserPaths(browserPaths(file));
      const first = await runtime.connection();
      await first.context.addCookies([
        {
          name: 'fixture-session',
          value: 'saved-sign-in',
          url: 'https://fixture.example',
          expires: Math.floor(Date.now() / 1_000) + 3_600,
          secure: true,
          httpOnly: true,
        },
      ]);
      await runtime.stop();
      expect(first.child.exitCode !== null || first.child.signalCode !== null).toBe(true);
      const second = await runtime.connection();
      expect(second.child.pid).not.toBe(first.child.pid);
      expect(await second.context.cookies('https://fixture.example')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'fixture-session', value: 'saved-sign-in', secure: true, httpOnly: true }),
        ]),
      );
    },
    30_000,
  );
  it.skipIf(!process.env.GWS_EA_BROWSER_TEST_CHROME)(
    'starts under the service PATH and keeps the other native job page usable when one job closes',
    async () => {
      vi.stubEnv('PATH', '/usr/local/bin:/usr/bin:/bin');
      await ensureBrowserPaths(browserPaths(file));

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

  it.each(['shutdown', 'chrome-removed'] as const)(
    'cancels pending setup on %s and closes a later attach',
    async (action) => {
      await ensureBrowserPaths(browserPaths(file));

      await runtime.reconcile();
      const child = Object.assign(new EventEmitter(), {
        pid: 12345,
        exitCode: null as number | null,
        signalCode: null,
      });
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
        if (action === 'chrome-removed')
          vi.spyOn(availability, 'browserAvailability').mockResolvedValue({
            available: false,
            reason: 'chrome-missing',
          });
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
    },
  );

  it('keeps the single startup deadline through background browser admission and retires before client disposal', async () => {
    await ensureBrowserPaths(browserPaths(file));

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

      vi.stubEnv('GWS_EA_BROWSER_ROOT', file);
      const inspectAvailability = availability.browserAvailability;
      vi.spyOn(availability, 'browserAvailability').mockImplementation((root) =>
        inspectAvailability(root, process.env.GWS_EA_BROWSER_TEST_CHROME),
      );
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
        const disconnected = new Promise<void>((resolve) => attached.browser.once('disconnected', () => resolve()));
        stopQueue.mockImplementation(() => disconnected);
        const stopping = getHostShutdownCallbacks().at(-1)!();
        let timeout: NodeJS.Timeout | undefined;
        try {
          await expect(
            Promise.race([
              stopping,
              new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(() => reject(new Error('Queue drain blocked Chrome retirement')), 8_000);
              }),
            ]),
          ).rejects.toThrow('Scheduler cleanup failed');
        } finally {
          if (timeout) clearTimeout(timeout);
          await owned.shutdown();
          await Promise.resolve(stopping).catch(() => undefined);
        }
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
