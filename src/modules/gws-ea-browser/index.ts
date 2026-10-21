/** Optional, host-owned Chrome runtime. Importing registers lifecycle only; Chrome is lazy. */

import { register } from '../../cli/registry.js';
import { registerMigration } from '../../db/migrations/index.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { browserHealth } from './health.js';
import { BrowserRuntime } from './runtime.js';
import { readBrowserEvidence } from './evidence.js';
import {
  browserConsentMigration,
  browserCredentialAttemptsMigration,
  browserDisclosuresMigration,
  browserGenericCheckoutMigration,
  browserIncidentsMigration,
  browserPurchaseMigration,
  browserPurchaseOutcomesMigration,
  browserReservationBoundsMigration,
  browserQueueMigration,
  browserRecipesMigration,
  browserWatchesMigration,
  browserWatchRegionMigration,
  browserWatchReleaseMigration,
  browserSiteLeasesMigration,
} from './migration.js';
import { BrowserStore } from './db.js';
import { notifyPendingIncidents } from './incidents.js';
import { BrowserQueue, registerBrowserActionDelivery } from './queue.js';
import './executor.js';
import './recipes.js';
import './capability.js';
import './fill.js';
import { registerCredentialAuthorityDelivery } from './credential-operations.js';
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
import {
  registerBrowserPurchaseDelivery,
  resumeBrowserPurchaseCommits,
  sweepBrowserPurchaseState,
} from './purchase.js';
import { registerPurchaseOutcomeDelivery } from './purchase-outcome.js';
import { registerReservationGuaranteeDelivery } from './reservation-guarantee.js';
import { registerConsentGrantsDelivery } from './consent-approval.js';
import { registerDisclosureDelivery } from './disclosures.js';
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
registerMigration(browserConsentMigration);
registerMigration(browserIncidentsMigration);
registerMigration(browserDisclosuresMigration);
registerMigration(browserGenericCheckoutMigration);
registerMigration(browserWatchRegionMigration);
registerMigration(browserPurchaseOutcomesMigration);

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
      () => notifyPendingIncidents(),
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
registerBrowserActionDelivery('request_consent', getBrowserQueue);
for (const name of ['watch', 'list_watches', 'cancel_watch']) registerBrowserActionDelivery(name, getBrowserQueue);
registerBrowserCancellationDelivery(getBrowserQueue);
registerSignInMailDelivery(getBrowserQueue);
registerBrowserPurchaseDelivery(getBrowserQueue);
registerPurchaseOutcomeDelivery(getBrowserQueue);
registerReservationGuaranteeDelivery();
registerConsentGrantsDelivery();
registerDisclosureDelivery();
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
  const scheduler = watchScheduler;
  watchScheduler = undefined;
  try {
    await scheduler?.stop();
  } finally {
    try {
      await queue?.stop();
    } finally {
      try {
        await recoverBrowserSignInMail();
      } finally {
        queue = undefined;
        await runtime.shutdown();
      }
    }
  }
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
  handler: async () => browserHealth(runtime.state()),
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
