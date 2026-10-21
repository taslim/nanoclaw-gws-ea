import type { Page } from 'playwright-core';

import { browserDiagnosticsUnsafe } from './authentication-signatures.js';
import { prepareChromeProfile, spawnChrome, stopChrome, type OwnedChrome } from './chrome.js';
import { connectChrome, verifyChromePolicy, type ChromeConnection } from './connection.js';
import { DEFAULT_BROWSER_POLICY, type BrowserPolicy } from './policy.js';
import { readHostBrowserPolicy } from './access.js';
import { startPublicBrowserProxy, type PublicBrowserProxy } from './proxy.js';
import { JobWindows } from './windows.js';

export class BrowserUnavailableError extends Error {
  readonly code = 'browser_unavailable';
  constructor() {
    super('Browser is unavailable; the operator can check browser health.');
  }
}

type EnabledPolicy = Extract<BrowserPolicy, { enabled: true }>;

export class BrowserRuntime {
  private policy: BrowserPolicy = DEFAULT_BROWSER_POLICY;
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
  private restart: NodeJS.Timeout | undefined;
  private lastFailure: { reason: 'browser_unavailable'; at: string } | null = null;
  private readonly disconnectListeners = new Set<() => void>();

  constructor(
    private readonly policyFile?: string,
    private readonly admissionReady: () => boolean = () => true,
  ) {}

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Re-read policy on each use; enabled policy prewarms the proxy without starting Chrome. */
  async reconcile(): Promise<void> {
    if (this.startup && !(await readHostBrowserPolicy(this.policyFile)).enabled) this.startup?.abort();
    return this.exclusive(() => this.reconcilePolicy());
  }

  private async reconcilePolicy(): Promise<void> {
    if (this.stopped) {
      await this.stopOwned();
      return;
    }
    const current = await readHostBrowserPolicy(this.policyFile);
    if (!current.enabled) {
      this.policy = current;
      await this.stopOwned();
      return;
    }
    if (browserDiagnosticsUnsafe()) {
      this.policy = current;
      await this.stopOwned();
      this.lastFailure = { reason: 'browser_unavailable', at: new Date().toISOString() };
      return;
    }
    if (
      this.policy.enabled &&
      (this.policy.paths.policyFile !== current.paths.policyFile || this.policy.chromePath !== current.chromePath)
    ) {
      await this.stopOwned();
    }
    this.policy = current;
    if (!this.proxy) this.proxy = await startPublicBrowserProxy();
  }

  async assertEnabled(): Promise<void> {
    await this.reconcile();
    if (!this.policy.enabled) throw new BrowserUnavailableError();
  }

  /** Host internals only. No endpoint/session/browser object is ever serialized to a tool response. */
  connection(): Promise<ChromeConnection> {
    return this.exclusive(async () => {
      await this.reconcilePolicy();
      if (this.stopped || !this.policy.enabled || !this.proxy) throw new BrowserUnavailableError();
      await this.retiring;
      if (this.attached?.browser.isConnected()) return this.attached;
      return this.launch(this.policy, this.proxy);
    });
  }

  private async launch(policy: EnabledPolicy, proxy: PublicBrowserProxy): Promise<ChromeConnection> {
    this.starting = true;
    const generation = ++this.generation;
    const startup = new AbortController();
    this.startup = startup;
    const startupTimer = setTimeout(() => startup.abort(), 30_000);
    startupTimer.unref();
    let connection: ChromeConnection | undefined;
    let owned: OwnedChrome | undefined;
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
        await prepareChromeProfile(policy.paths);
        check();
        owned = await spawnChrome(
          { chromePath: policy.chromePath, paths: policy.paths, proxyUrl: proxy.url },
          startup.signal,
        );
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
        this.retiring = stopChrome(attached.child);
        for (const listener of this.disconnectListeners) listener();
        this.restart = setTimeout(() => {
          this.restart = undefined;
          if (generation !== this.generation) return;
          void this.connection().catch(() => undefined);
        }, 1_000);
        this.restart.unref();
      });
      return attached;
    } catch {
      startup.abort();
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
    await this.connection();
    const windows = this.windows;
    if (!windows) throw new BrowserUnavailableError();
    const page = await windows.pageForJob(jobId);
    await this.assertEnabled();
    if (!this.windows || this.windows !== windows || page.isClosed()) throw new BrowserUnavailableError();
    return page;
  }

  async closeJob(jobId: string): Promise<void> {
    await this.windows?.closeJob(jobId);
  }
  async closeIdleWindows(): Promise<void> {
    await this.windows?.closeIdle();
  }

  onDisconnected(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  /** Stop owned processes and proxy; a future explicit enable may start a fresh runtime. */
  stop(): Promise<void> {
    this.startup?.abort();
    return this.exclusive(() => this.stopOwned());
  }

  shutdown(): Promise<void> {
    this.stopped = true;
    return this.stop();
  }

  private async stopOwned(): Promise<void> {
    this.closing = true;
    ++this.generation;
    if (this.restart) clearTimeout(this.restart);
    this.restart = undefined;
    try {
      try {
        await this.windows?.close();
      } finally {
        try {
          await this.attached?.close();
          await this.retiring;
        } finally {
          await this.proxy?.close();
        }
      }
    } finally {
      this.attached = undefined;
      this.windows = undefined;
      this.proxy = undefined;
      this.closing = false;
    }
  }

  state(): {
    enabled: boolean;
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
      enabled: this.policy.enabled,
      ready: this.admissionReady() && this.policy.enabled && this.proxy !== undefined && !this.stopped,
      ...(this.policy.enabled ? {} : { reason: this.policy.reason }),
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
