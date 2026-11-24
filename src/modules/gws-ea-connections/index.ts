/**
 * The principal's own remote MCP apps. The host owns them in an encrypted store; no agent sees a credential.
 */
import { register } from '../../cli/registry.js';
import { onHostShutdown, onHostStart, runHostCleanup } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { clientDocumentsServed } from '../gws-ea-web/index.js';
import { registerWebMount } from '../gws-ea-web/mounts.js';
import { registerAppActions } from './actions.js';
import { applyMainServers, MainServersUnreadableError, mainOperatorServers } from './apply.js';
import { connectionsRoot } from './config.js';
import { clientDocumentsWebMount, connectionsWebMount, operatorAsApp } from './connections-mount.js';
import {
  createHoldCallHandler,
  registerHeldAppCallHandlers,
  withdrawHeldAppCalls,
  withdrawToolAskApprovals,
} from './held-calls.js';
import { startRestartChecks, stopRestartChecks } from './idle-restart.js';
import { oweReconnectNote, startReconnectNotes, stopReconnectNotes } from './note.js';
import { startConnectionsRefresher, stopConnectionsRefresher } from './refresher.js';
import { drainRelayActions, registerRelayAction } from './relay-actions.js';
import { getAppRelay, startAppRelay, stopAppRelay, type AppRelay } from './relay.js';
import {
  getAppToolSorter,
  registerSortToolsAction,
  startAppToolSorter,
  stopAppToolSorter,
  type AppToolSorter,
} from './sorter.js';
import {
  ConnectionsStoreError,
  getConnectionsStore,
  type AppStatus,
  type ConnectionApp,
  type ConnectionsStore,
  type ConnectionsStoreAvailability,
} from './store.js';

export type AppOrigin = 'principal' | 'operator';

/** What the operator may see of one app: never its URL, which can carry a credential, nor anything sealed. */
export interface AppHealth {
  readonly name: string;
  readonly host: string;
  readonly origin: AppOrigin;
  readonly status: AppStatus;
}

export interface ConnectionsHealth {
  readonly schemaVersion: 1;
  readonly store: ConnectionsStoreAvailability;
  readonly apps: readonly AppHealth[];
}

/**
 * App metadata is read without Keychain, so the principal's apps are listed even while their secrets are
 * unreadable. The host knows nothing of an operator server beyond its entry, so a present entry is connected.
 */
export async function connectionsHealth(
  openStore: () => Promise<ConnectionsStore> = getConnectionsStore,
): Promise<ConnectionsHealth> {
  let store: ConnectionsStoreAvailability;
  let principalApps: readonly ConnectionApp[] = [];
  try {
    const opened = await openStore();
    store = await opened.availability();
    principalApps = await opened.apps();
  } catch (error) {
    if (!(error instanceof ConnectionsStoreError)) throw error;
    store = { available: false, reason: 'keychain_unavailable' };
  }
  const operatorApps = (await mainOperatorServers())
    .flatMap((server) => operatorAsApp(server) ?? [])
    .map(({ key: _key, ...app }): AppHealth => app);
  return {
    schemaVersion: 1,
    store,
    apps: [
      ...principalApps.map(({ name, host, status }): AppHealth => ({ name, host, origin: 'principal', status })),
      ...operatorApps,
    ],
  };
}

register({
  name: 'gws-ea-connections-health',
  description: 'Report connected-app store availability and each app’s name, host, origin and status.',
  access: 'hidden',
  hostOnly: true,
  parseArgs(raw) {
    if (Object.keys(raw).length) throw new Error('This connections host command takes no arguments.');
    return undefined;
  },
  handler: () => connectionsHealth(),
});

interface ConnectionsRuntime {
  readonly store: ConnectionsStore;
  readonly sorter: AppToolSorter;
  readonly relay: AppRelay;
}

let runtimeController: AbortController | undefined;
let runtimePromise: Promise<ConnectionsRuntime | undefined> | undefined;
let activeStore: ConnectionsStore | undefined;
let hostHookConsumed = false;
let shuttingDown = false;
let runtimeGeneration = 0;

function ensureConnectionsRuntime(
  hostSignal?: AbortSignal,
  forceRestart = false,
): Promise<ConnectionsRuntime | undefined> {
  if (shuttingDown || !connectionsRoot()) return Promise.resolve(undefined);
  if (forceRestart) {
    runtimePromise = undefined;
    hostHookConsumed = false;
  }
  if (hostSignal) {
    if (hostSignal.aborted) {
      runtimeController?.abort();
    } else if (runtimeController) {
      const controller = runtimeController;
      hostSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }
  if (runtimePromise) return runtimePromise;
  const generation = ++runtimeGeneration;
  const controller = new AbortController();
  runtimeController = controller;
  if (hostSignal) {
    if (hostSignal.aborted) controller.abort();
    else hostSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const signal = controller.signal;
  const start = async (): Promise<ConnectionsRuntime | undefined> => {
    let restartStarted = false;
    let reconnectStarted = false;
    let refresherStarted = false;
    let startedSorter: AppToolSorter | undefined;
    let startedRelay: AppRelay | undefined;
    const rollbackStarted = async (): Promise<void> => {
      if (startedRelay) {
        if (getAppRelay() === startedRelay) await stopAppRelay();
        else await startedRelay.drain();
      }
      if (startedSorter) {
        if (getAppToolSorter() === startedSorter) await stopAppToolSorter();
        else await startedSorter.stop();
      }
      if (runtimeGeneration === generation) {
        if (refresherStarted) await stopConnectionsRefresher();
        if (reconnectStarted) await stopReconnectNotes();
        if (restartStarted) await stopRestartChecks();
        activeStore = undefined;
      }
    };
    try {
      if (signal.aborted || shuttingDown) return undefined;
      const store = await getConnectionsStore();
      if (signal.aborted || shuttingDown) return undefined;
      try {
        await store.sweepExpiredSignIns();
      } catch (error) {
        // Expired sign-ins are refused when read; a failed sweep must not leave the apps unserved for this host.
        if (!(error instanceof ConnectionsStoreError)) throw error;
        log.warn('Expired connection sign-ins not swept', { reason: error.reason });
      }
      if (signal.aborted || shuttingDown) return undefined;
      // Armed first, so a restart a previous host left pending and one this apply records are both served.
      startRestartChecks(store, signal);
      restartStarted = true;
      await startReconnectNotes(store, signal);
      reconnectStarted = true;
      if (signal.aborted || shuttingDown) {
        await rollbackStarted();
        return undefined;
      }
      const sorter = startAppToolSorter({ store, signal });
      startedSorter = sorter;
      startConnectionsRefresher(store, signal, {
        onRefused: oweReconnectNote,
        onDisconnected: async (appId) => {
          await getAppRelay()?.closeApp(appId);
          await withdrawHeldAppCalls(appId);
          await withdrawToolAskApprovals(appId);
        },
        onTick: () => sorter.enqueuePending(),
        clientDocumentsServed,
      });
      refresherStarted = true;
      if (signal.aborted || shuttingDown) {
        await rollbackStarted();
        return undefined;
      }
      const relay = startAppRelay({
        store,
        onToolsNeedSort: (appId, listHash) => {
          void sorter.enqueue(appId, listHash);
        },
        onHoldCall: createHoldCallHandler({ store }),
      });
      startedRelay = relay;
      if (signal.aborted || shuttingDown) {
        await rollbackStarted();
        return undefined;
      }
      activeStore = store;
      return { store, sorter, relay };
    } catch (error) {
      await rollbackStarted();
      if (runtimePromise === started) runtimePromise = undefined;
      if (error instanceof ConnectionsStoreError) {
        log.warn('Connections store unavailable', { reason: error.reason });
        return undefined;
      }
      throw error;
    } finally {
      if ((signal.aborted || shuttingDown) && runtimePromise === started) runtimePromise = undefined;
    }
  };
  const started = Promise.resolve().then(start);
  runtimePromise = started;
  return started;
}

/**
 * Ensures the app relay is running before replaying approved calls or handling early inbound requests,
 * even when the approvals module's startup hook runs before this module's `onHostStart`.
 */
export async function ensureAppRelayStarted(): Promise<AppRelay | undefined> {
  if (shuttingDown) return undefined;
  const existing = getAppRelay();
  if (existing) return existing;
  const runtime = await ensureConnectionsRuntime();
  return runtime?.relay ?? getAppRelay();
}

registerWebMount(connectionsWebMount);
registerWebMount(clientDocumentsWebMount);
registerAppActions();
registerRelayAction({ relay: ensureAppRelayStarted });
registerSortToolsAction();
registerHeldAppCallHandlers({ relay: ensureAppRelayStarted, store: () => activeStore });

onHostStart(async ({ signal }) => {
  shuttingDown = false;
  // Only a gws-ea assistant has a store; a plain NanoClaw host has nothing to sweep.
  if (!connectionsRoot()) return;
  try {
    const runtime = await ensureConnectionsRuntime(signal, hostHookConsumed);
    hostHookConsumed = true;
    if (!runtime) return;
    await applyMainServers(runtime.store);
    void (async () => {
      if (signal.aborted) return;
      await runtime.relay.pinUnpinnedApps();
      if (signal.aborted) return;
      await runtime.sorter.enqueuePending();
    })().catch((err: unknown) => {
      log.warn('Initial app tool pin/sort failed', {
        reason: err instanceof ConnectionsStoreError ? err.reason : 'failed',
      });
    });
  } catch (error) {
    if (error instanceof ConnectionsStoreError) log.warn('Connections store unavailable', { reason: error.reason });
    else if (error instanceof MainServersUnreadableError) log.error('Main apps not applied', { reason: error.message });
    else throw error;
  }
});

onHostShutdown(async () => {
  shuttingDown = true;
  runtimeGeneration += 1;
  const pending = runtimePromise;
  runtimeController?.abort();
  runtimeController = undefined;
  runtimePromise = undefined;
  activeStore = undefined;
  hostHookConsumed = false;
  if (pending) await pending.catch(() => undefined);
  await drainRelayActions();
  await runHostCleanup([
    stopAppToolSorter,
    stopAppRelay,
    stopConnectionsRefresher,
    stopReconnectNotes,
    stopRestartChecks,
  ]);
});
