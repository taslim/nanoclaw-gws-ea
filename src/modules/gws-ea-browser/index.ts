/** Optional, host-owned Chrome runtime. Importing registers lifecycle only; Chrome is lazy. */
import type { Page } from 'playwright-core';

import { register } from '../../cli/registry.js';
import { registerMigration } from '../../db/migrations/index.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { prepareChromeProfile, spawnChrome, stopChrome } from './chrome.js';
import { connectChromePipe, type ChromeConnection } from './connection.js';
import { browserHealth } from './health.js';
import { readBrowserEvidence } from './evidence.js';
import {
  browserCredentialAttemptsMigration,
  browserPurchaseMigration,
  browserReservationBoundsMigration,
  browserQueueMigration,
  browserRecipesMigration,
  browserWatchesMigration,
  browserWatchReleaseMigration,
  browserSiteLeasesMigration,
} from './migration.js';
import { BrowserStore } from './db.js';
import { BrowserQueue, registerBrowserActionDelivery } from './queue.js';
import './executor.js';
import './recipes.js';
import './capability.js';
import './fill.js';
import { registerCredentialAuthorityDelivery } from './credential-operations.js';
import { browserDiagnosticsUnsafe } from './authentication-signatures.js';
import { browserAdmissionReady, setBrowserAdmissionReady } from './group.js';
import './destination-policy.js';
import './guidance.js';
import {
  configureBrowserCancellation,
  registerBrowserCancellationDelivery,
  sweepBrowserJobSessions,
} from './cancel.js';
import { reconcileBrowserGroup } from './reconcile.js';
import { browserSignInMigration } from './sign-in-migration.js';
import { cleanupBrowserSignInMail, recoverBrowserSignInMail, registerSignInMailDelivery } from './sign-in-mail.js';
import { readBrowserPolicy, type BrowserPolicy } from './policy.js';
import { startPublicBrowserProxy, type PublicBrowserProxy } from './proxy.js';
import { JobWindows } from './windows.js';
import {
  registerBrowserPurchaseDelivery,
  resumeBrowserPurchaseCommits,
  sweepBrowserPurchaseState,
} from './purchase.js';
import { registerReservationGuaranteeDelivery } from './reservation-guarantee.js';
import { registerVaultAccessDelivery } from './vault-access.js';
import './watches.js';
import { createBrowserWatchScheduler, type BrowserWatchScheduler } from './scheduler.js';

registerMigration(browserSiteLeasesMigration);
registerMigration(browserQueueMigration);
registerMigration(browserPurchaseMigration);
registerMigration(browserReservationBoundsMigration);
registerMigration(browserSignInMigration);
registerMigration(browserRecipesMigration);
registerMigration(browserWatchesMigration);
registerMigration(browserWatchReleaseMigration);
registerMigration(browserCredentialAttemptsMigration);

export class BrowserUnavailableError extends Error {
  readonly code = 'browser_unavailable';
  constructor() {
    super('Browser is unavailable; the operator can check browser health.');
  }
}

type EnabledPolicy = Extract<BrowserPolicy, { enabled: true }>;

export class BrowserRuntime {
  private policy: BrowserPolicy = { status: 'disabled', enabled: false, reason: 'operator-enablement-required' };
  private proxy: PublicBrowserProxy | undefined;
  private attached: ChromeConnection | undefined;
  private windows: JobWindows | undefined;
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private starting = false;
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
  reconcile(): Promise<void> {
    return this.exclusive(() => this.reconcilePolicy());
  }

  private async reconcilePolicy(): Promise<void> {
    if (this.stopped) {
      await this.stopOwned();
      return;
    }
    const current = await readBrowserPolicy(this.policyFile);
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

  /** Host internals only. No pipe/session/browser object is ever serialized to a tool response. */
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
    let connection: ChromeConnection | undefined;
    let child: ReturnType<typeof spawnChrome> | undefined;
    let startupTimer: NodeJS.Timeout | undefined;
    try {
      await prepareChromeProfile(policy.paths);
      child = spawnChrome({ chromePath: policy.chromePath, paths: policy.paths, proxyUrl: proxy.url });
      const spawned = child;
      const attaching = (async () => {
        connection = await connectChromePipe(spawned, policy.paths);
        const windows = new JobWindows(connection);
        const probe = await windows.pageForJob('__host_launch_probe__');
        try {
          await this.verifyLaunch(probe);
        } finally {
          await windows.close();
        }
        return connection;
      })();
      const attached = await Promise.race([
        attaching,
        new Promise<never>((_resolve, reject) => {
          startupTimer = setTimeout(() => reject(new BrowserUnavailableError()), 30_000);
          startupTimer.unref();
        }),
      ]);
      this.attached = attached;
      this.windows = new JobWindows(attached);
      this.lastFailure = null;
      attached.browser.once('disconnected', () => {
        if (this.closing || this.attached !== attached) return;
        this.attached = undefined;
        this.windows = undefined;
        this.retiring = stopChrome(attached.child);
        for (const listener of this.disconnectListeners) listener();
        // A crash never replays a request; the queue owns interrupted answers.
        // Only the runtime is replaced, under the same current policy.
        this.restart = setTimeout(() => {
          this.restart = undefined;
          if (generation !== this.generation) return;
          void this.connection().catch(() => undefined);
        }, 1_000);
        this.restart.unref();
      });
      return attached;
    } catch (_error) {
      await connection?.close().catch(() => undefined);
      if (child) await stopChrome(child);
      this.lastFailure = { reason: 'browser_unavailable', at: new Date().toISOString() };
      throw new BrowserUnavailableError();
    } finally {
      if (startupTimer) clearTimeout(startupTimer);
      this.starting = false;
    }
  }

  /** Fixed, host-owned fixtures detect a missing native WebRTC or external-protocol policy at every launch. */
  private async verifyLaunch(page: Page): Promise<void> {
    const result: unknown = await page.evaluate(`new Promise((resolve) => {
      const peer = new RTCPeerConnection({iceServers: []});
      const candidates = [];
      let finished = false;
      const finish = (complete) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        peer.close();
        resolve({complete, candidates: candidates.length});
      };
      const timer = setTimeout(() => finish(false), 3000);
      peer.onicecandidate = event => {if (event.candidate) candidates.push(event.candidate.candidate);};
      peer.onicegatheringstatechange = () => {if (peer.iceGatheringState === 'complete') finish(true);};
      peer.createDataChannel('host-policy-check');
      peer.createOffer().then(offer => peer.setLocalDescription(offer)).catch(() => finish(false));
    })`);
    if (
      typeof result !== 'object' ||
      result === null ||
      !('complete' in result) ||
      result.complete !== true ||
      !('candidates' in result) ||
      result.candidates !== 0
    ) {
      throw new BrowserUnavailableError();
    }
    let blocked = false;
    try {
      await page.goto('nanoclaw-runtime-policy-check://no-registered-handler');
    } catch (error) {
      if (error instanceof Error && error.message.includes('ERR_BLOCKED_BY_ADMINISTRATOR')) blocked = true;
      else throw error;
    }
    if (!blocked) throw new BrowserUnavailableError();
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
      | { state: 'running'; pid: number | undefined; version: string }
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
        ? { state: 'running', pid: this.attached.child.pid, version: this.attached.browser.version() }
        : { state: this.starting ? 'starting' : this.lastFailure ? 'unavailable' : 'stopped' },
      windows: this.windows?.size ?? 0,
      lastFailure: this.lastFailure,
    };
  }
}

const runtime = new BrowserRuntime(undefined, browserAdmissionReady);
export function getBrowserRuntime(): BrowserRuntime {
  return runtime;
}

let watchScheduler: BrowserWatchScheduler | undefined;
let reconcileTimer: NodeJS.Timeout | undefined;
let reconciling = false;
onHostStart(async ({ signal }) => {
  setBrowserAdmissionReady(false);
  const activeQueue = getBrowserQueue();
  configureBrowserCancellation(activeQueue);
  let recovered = false;
  const optional = async (operation: () => Promise<void>): Promise<boolean> => {
    // Optional capability failures must not stop messaging or later cleanup.
    /* eslint-disable no-catch-all/no-catch-all -- each optional host task has an independent retry boundary */
    try {
      await operation();
      return true;
    } catch (_error) {
      log.warn('Browser runtime unavailable', { reason: 'browser_unavailable' });
      return false;
    }
    /* eslint-enable no-catch-all/no-catch-all */
  };
  const reconcile = async (): Promise<void> => {
    const ready = await optional(async () => {
      if (!recovered) {
        await recoverBrowserSignInMail();
        // Queue startup recovers purchase markers before any worker can run.
        await activeQueue.start();
        await resumeBrowserPurchaseCommits(activeQueue);
        recovered = true;
      }
      await reconcileBrowserGroup();
      await runtime.reconcile();
    });
    setBrowserAdmissionReady(ready && !signal.aborted);
    if (!ready || signal.aborted) {
      const scheduler = watchScheduler;
      watchScheduler = undefined;
      if (scheduler) await optional(() => scheduler.stop());
    } else if (!watchScheduler) {
      watchScheduler = createBrowserWatchScheduler(activeQueue);
      watchScheduler.start(signal);
    }
  };
  const maintain = async (): Promise<void> => {
    // Failed mandatory recovery cannot be bypassed by expiry or session work.
    if (!recovered) return;
    for (const task of [
      () => runtime.closeIdleWindows(),
      () => activeQueue.retryAnswers(),
      () => sweepBrowserJobSessions(),
      () => cleanupBrowserSignInMail(),
      () => sweepBrowserPurchaseState(activeQueue),
    ])
      await optional(task);
  };
  await reconcile();
  await maintain();
  if (signal.aborted) {
    await runtime.stop();
    return;
  }
  reconcileTimer = setInterval(() => {
    if (reconciling) return;
    reconciling = true;
    void (async () => {
      await reconcile();
      await maintain();
    })()
      .catch(() => log.warn('Browser runtime unavailable', { reason: 'browser_unavailable' }))
      .finally(() => {
        reconciling = false;
      });
  }, 30_000);
  reconcileTimer.unref();
});

let queue: BrowserQueue | undefined;
export function getBrowserQueue(): BrowserQueue {
  queue ??= new BrowserQueue(new BrowserStore(), runtime);
  return queue;
}
registerBrowserActionDelivery('browser', getBrowserQueue);
registerBrowserActionDelivery('fill_secret', getBrowserQueue);
registerBrowserActionDelivery('credential_form', getBrowserQueue);
registerBrowserActionDelivery('sign_in_code', getBrowserQueue);
registerBrowserActionDelivery('save_recipe', getBrowserQueue);
registerBrowserActionDelivery('run_recipe', getBrowserQueue);
for (const name of ['watch', 'list_watches', 'cancel_watch']) registerBrowserActionDelivery(name, getBrowserQueue);
registerBrowserCancellationDelivery(getBrowserQueue);
registerSignInMailDelivery(getBrowserQueue);
registerBrowserPurchaseDelivery(getBrowserQueue);
registerReservationGuaranteeDelivery();
registerVaultAccessDelivery();
registerCredentialAuthorityDelivery(getBrowserQueue);

export {
  BrowserStore,
  browserRequestId,
  markBrowserRequestCommitStarted,
  type BrowserJob,
  type BrowserRequest,
} from './db.js';
export {
  registerBrowserQueuedAction,
  registerBrowserActionDelivery,
  type BrowserExecutionContext,
  type BrowserQueuedAction,
} from './queue.js';
export {
  activateControl,
  classifyActivation,
  classifyNavigationUrl,
  ensureBrowserNavigationGuard,
  registerReviewedMerchantFlow,
  withBrowserJobNavigation,
} from './commit-classifier.js';
export {
  observePage,
  pinBrowserRefs,
  disposeBrowserRefs,
  registerPageSecret,
  releasePageSecret,
  redactPageText,
  pageHasSecret,
  type BrowserRef,
  type PinnedBrowserRef,
} from './observe.js';
onHostShutdown(async () => {
  setBrowserAdmissionReady(false);
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = undefined;
  await watchScheduler?.stop();
  watchScheduler = undefined;
  await queue?.stop();
  await recoverBrowserSignInMail();
  queue = undefined;
  await runtime.shutdown();
});

register({
  name: 'gws-ea-browser-health',
  description: 'Report host browser policy, proxy port and owned Chrome state.',
  access: 'hidden',
  hostOnly: true,
  parseArgs(raw) {
    if (Object.keys(raw).length) throw new Error(`Unknown browser health field: --${Object.keys(raw)[0]}`);
    return undefined;
  },
  handler: async () => browserHealth(),
});

register({
  name: 'gws-ea-browser-evidence',
  description: 'Inspect existing browser job timing and operational metadata.',
  access: 'hidden',
  hostOnly: true,
  parseArgs(raw) {
    if (Object.keys(raw).some((key) => key !== 'job') || typeof raw.job !== 'string' || !raw.job.trim())
      throw new Error('Browser evidence requires only --job <thread>.');
    return { job: raw.job };
  },
  async handler({ job }) {
    try {
      return await readBrowserEvidence(job);
    } catch (_error) {
      throw new Error('Browser metadata is unavailable for this job.', { cause: _error });
    }
  },
});
