import type { Page } from 'playwright-core';

import { browserDiagnosticsUnsafe } from './authentication-signatures.js';
import { prepareChromeProfile, retireChromeProfile, spawnChrome, stopChrome, type OwnedChrome } from './chrome.js';
import { connectChrome, verifyChromePolicy, type ChromeConnection } from './connection.js';
import {
  browserAvailability,
  browserConfigured,
  browserUnavailableMessage,
  SYSTEM_CHROME,
  type BrowserAvailability,
} from './availability.js';
import { startPublicBrowserProxy, type PublicBrowserProxy } from './proxy.js';
import { JobWindows } from './windows.js';
import { log } from '../../log.js';

const CHROME_IDLE_GRACE_MS = 30_000;

export class BrowserUnavailableError extends Error {
  readonly code = 'browser_unavailable';
  constructor() {
    super('Browser is unavailable; ask your operator to check Chrome and browser health.');
  }
}

type AvailableBrowser = Extract<BrowserAvailability, { available: true }>;

export class BrowserRuntime {
  private availability: BrowserAvailability = { available: false, reason: 'browser-root-unconfigured' };
  private proxy: PublicBrowserProxy | undefined;
  private attached: ChromeConnection | undefined;
  private windows: JobWindows | undefined;
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private starting = false;
  private startup: AbortController | undefined;
  private stopped = false;
  private retiring: Promise<void> = Promise.resolve();
  private generation = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  private activities = 0;
  private activityVersion = 0;
  private recoveredProfile: string | undefined;
  private lastFailure: { reason: 'browser_unavailable'; at: string } | null = null;
  private readonly disconnectListeners = new Set<() => void>();

  constructor(
    private readonly root?: string,
    private readonly admissionReady: () => boolean = () => true,
    private readonly chromePath: string = SYSTEM_CHROME,
    private readonly keepJobPage: (jobId: string) => Promise<boolean> = async () => true,
  ) {}

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Check availability on each use; a configured browser prewarms the proxy without starting Chrome. */
  async reconcile(): Promise<void> {
    if (this.startup && !(await browserAvailability(this.root, this.chromePath)).available) this.startup?.abort();
    return this.exclusive(() => this.reconcileAvailability());
  }

  private async reconcileAvailability(): Promise<void> {
    if (this.stopped) {
      await this.stopOwned();
      return;
    }
    const current = await browserAvailability(this.root, this.chromePath);
    if (!current.available) {
      await this.stopOwned();
      this.availability = current;
      return;
    }
    if (browserDiagnosticsUnsafe()) {
      this.availability = current;
      await this.stopOwned();
      this.lastFailure = { reason: 'browser_unavailable', at: new Date().toISOString() };
      return;
    }
    if (
      this.availability.available &&
      (this.availability.paths.root !== current.paths.root || this.availability.chromePath !== current.chromePath)
    ) {
      await this.stopOwned();
      this.recoveredProfile = undefined;
    }
    this.availability = current;
    if (this.recoveredProfile !== current.paths.profileDir) {
      await retireChromeProfile(current.paths, current.chromePath);
      this.recoveredProfile = current.paths.profileDir;
    }
    if (this.stopped) return;
    if (!this.proxy) this.proxy = await startPublicBrowserProxy();
  }

  async assertAvailable(): Promise<void> {
    await this.reconcile();
    if (!this.availability.available) throw new BrowserUnavailableError();
  }

  /** Host internals only. No endpoint/session/browser object is ever serialized to a tool response. */
  connection(): Promise<ChromeConnection> {
    return this.exclusive(async () => {
      await this.reconcileAvailability();
      if (this.stopped || !this.availability.available || !this.proxy) throw new BrowserUnavailableError();
      await this.retiring;
      if (this.attached?.browser.isConnected()) return this.attached;
      return this.launch(this.availability, this.proxy);
    });
  }

  private async launch(policy: AvailableBrowser, proxy: PublicBrowserProxy): Promise<ChromeConnection> {
    this.starting = true;
    const generation = ++this.generation;
    const startup = new AbortController();
    this.startup = startup;
    const startupTimer = setTimeout(() => startup.abort(), 30_000);
    startupTimer.unref();
    let connection: ChromeConnection | undefined;
    let owned: OwnedChrome | undefined;
    let preparing: Promise<void> | undefined;
    let spawning: Promise<OwnedChrome> | undefined;
    let rejectAborted!: (reason: BrowserUnavailableError) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = reject;
    });
    const onAbort = (): void => rejectAborted(new BrowserUnavailableError());
    startup.signal.addEventListener('abort', onAbort, { once: true });
    const check = (): void => {
      startup.signal.throwIfAborted();
      if (this.stopped || generation !== this.generation) throw new BrowserUnavailableError();
    };
    const onExit = (): void => startup.abort();
    try {
      const attaching = (async () => {
        await retireChromeProfile(policy.paths, policy.chromePath);
        check();
        preparing = prepareChromeProfile(policy.paths);
        await preparing;
        check();
        spawning = spawnChrome(
          { chromePath: policy.chromePath, paths: policy.paths, proxyUrl: proxy.url },
          startup.signal,
        );
        owned = await spawning;
        owned.child.once('exit', onExit);
        owned.child.once('error', onExit);
        try {
          check();
          connection = await connectChrome(owned, policy.paths, startup.signal);
          check();
          const windows = new JobWindows(connection);
          const probe = await windows.pageForJob('__host_launch_probe__');
          try {
            await verifyChromePolicy(probe);
          } finally {
            await windows.close();
          }
          check();
          if (!connection.browser.isConnected()) throw new BrowserUnavailableError();
          return connection;
        } catch (error) {
          await stopChrome(owned.child);
          void connection?.close().catch(() => undefined);
          throw error;
        }
      })();
      const attached = await Promise.race([attaching, aborted]);
      check();
      if (!attached.browser.isConnected()) throw new BrowserUnavailableError();
      this.attached = attached;
      this.windows = new JobWindows(attached);
      this.lastFailure = null;
      attached.browser.once('disconnected', () => {
        if (this.closing || this.attached !== attached) return;
        this.attached = undefined;
        this.windows = undefined;
        this.retiring = stopChrome(attached.child).catch(() => {
          this.lastFailure = { reason: 'browser_unavailable', at: new Date().toISOString() };
          log.warn('Browser process cleanup will be rechecked', { reason: 'browser_unavailable' });
        });
        for (const listener of this.disconnectListeners) listener();
      });
      this.scheduleIdleStop();
      return attached;
    } catch {
      startup.abort();
      await preparing?.catch(() => undefined);
      if (!owned && spawning) owned = await spawning.catch(() => undefined);
      if (owned) await stopChrome(owned.child);
      void connection?.close().catch(() => undefined);
      this.lastFailure = { reason: 'browser_unavailable', at: new Date().toISOString() };
      throw new BrowserUnavailableError();
    } finally {
      clearTimeout(startupTimer);
      startup.signal.removeEventListener('abort', onAbort);
      owned?.child.removeListener('exit', onExit);
      owned?.child.removeListener('error', onExit);
      if (this.startup === startup) this.startup = undefined;
      this.starting = false;
    }
  }

  async pageForJob(jobId: string): Promise<Page> {
    return this.withActivity(async () => {
      await this.connection();
      const windows = this.windows;
      if (!windows) throw new BrowserUnavailableError();
      const page = await windows.pageForJob(jobId);
      await this.assertAvailable();
      if (!this.windows || this.windows !== windows || page.isClosed()) throw new BrowserUnavailableError();
      return page;
    });
  }

  async closeJob(jobId: string): Promise<void> {
    await this.windows?.closeJob(jobId);
    this.scheduleIdleStop();
  }

  async withActivity<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped) throw new BrowserUnavailableError();
    ++this.activityVersion;
    this.activities++;
    this.cancelIdleStop();
    try {
      return await operation();
    } finally {
      this.activities--;
      await this.releaseUnusedPages().catch(() => {
        log.warn('Browser page cleanup will retry', { reason: 'browser_unavailable' });
        this.scheduleIdleStop();
      });
    }
  }

  async releaseUnusedPages(): Promise<void> {
    await this.releasePages();
    this.scheduleIdleStop();
  }

  private async releasePages(): Promise<void> {
    if (this.activities || this.stopped) return;
    const windows = this.windows;
    const version = this.activityVersion;
    for (const jobId of windows?.jobs() ?? []) {
      if (await this.keepJobPage(jobId)) continue;
      if (this.activities || this.stopped || this.windows !== windows || this.activityVersion !== version) return;
      await windows?.closeJob(jobId);
    }
  }

  private cancelIdleStop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private scheduleIdleStop(): void {
    if (this.stopped || this.activities || this.windows?.size || !this.attached || this.idleTimer) return;
    const timer = setTimeout(() => {
      void this.exclusive(async () => {
        if (this.idleTimer !== timer) return;
        this.idleTimer = undefined;
        if (!this.activities && !this.windows?.size) await this.stopOwnedChrome();
      }).catch(() => {
        this.lastFailure = { reason: 'browser_unavailable', at: new Date().toISOString() };
        log.warn('Browser cleanup failed', { reason: 'browser_unavailable' });
      });
    }, CHROME_IDLE_GRACE_MS);
    this.idleTimer = timer;
    timer.unref();
  }

  onDisconnected(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  /** Unlike shutdown(), the next reconcile or connection while Chrome is available restarts the proxy and Chrome. */
  stop(): Promise<void> {
    this.startup?.abort();
    return this.exclusive(() => this.stopOwned());
  }

  shutdown(): Promise<void> {
    this.closeAdmission();
    return this.stop();
  }

  closeAdmission(): void {
    this.stopped = true;
    this.startup?.abort();
    this.cancelIdleStop();
  }

  private async stopOwned(): Promise<void> {
    try {
      await this.stopOwnedChrome();
    } finally {
      await this.proxy?.close();
      this.proxy = undefined;
    }
  }

  private async stopOwnedChrome(): Promise<void> {
    this.closing = true;
    ++this.generation;
    this.cancelIdleStop();
    try {
      try {
        await this.attached?.close();
      } finally {
        try {
          await this.retiring;
        } finally {
          if (this.availability.available)
            await retireChromeProfile(this.availability.paths, this.availability.chromePath);
        }
      }
    } finally {
      this.attached = undefined;
      this.windows = undefined;
      this.closing = false;
    }
  }

  state(): {
    configured: boolean;
    available: boolean;
    ready: boolean;
    reason?: string;
    proxy: { state: 'listening'; port: number } | { state: 'stopped' };
    chrome:
      | { state: 'running'; pid: number | undefined; version: string; debuggerPort: number }
      | { state: 'starting' | 'stopped' | 'unavailable' };
    windows: number;
    lastFailure: { reason: 'browser_unavailable'; at: string } | null;
  } {
    return {
      configured: browserConfigured(this.root),
      available: this.availability.available,
      ready: this.admissionReady() && this.availability.available && this.proxy !== undefined && !this.stopped,
      ...(this.availability.available ? {} : { reason: browserUnavailableMessage(this.availability.reason) }),
      proxy: this.proxy ? { state: 'listening', port: this.proxy.port } : { state: 'stopped' },
      chrome: this.attached
        ? {
            state: 'running',
            pid: this.attached.child.pid,
            version: this.attached.browser.version(),
            debuggerPort: this.attached.debuggerPort,
          }
        : { state: this.starting ? 'starting' : this.lastFailure ? 'unavailable' : 'stopped' },
      windows: this.windows?.size ?? 0,
      lastFailure: this.lastFailure,
    };
  }
}
