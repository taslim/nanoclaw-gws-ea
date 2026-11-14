/**
 * The principal's own remote MCP apps. The host owns them in an encrypted store; no agent sees a credential.
 */
import { register } from '../../cli/registry.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { registerWebMount } from '../gws-ea-web/mounts.js';
import { applyMainServers, MainServersUnreadableError, mainOperatorServers } from './apply.js';
import { connectionsRoot } from './config.js';
import { connectionsWebMount } from './connections-mount.js';
import { startRestartChecks, stopRestartChecks } from './idle-restart.js';
import { startConnectionsRefresher, stopConnectionsRefresher } from './refresher.js';
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
  const operatorApps = (await mainOperatorServers()).flatMap(({ key, url }): AppHealth[] => {
    // An entry without a host reaches no server, so there is nothing of it to show.
    const host = URL.parse(url)?.hostname;
    return host ? [{ name: key, host, origin: 'operator', status: 'connected' }] : [];
  });
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

registerWebMount(connectionsWebMount);

onHostStart(async ({ signal }) => {
  // Only a gws-ea assistant has a store; a plain NanoClaw host has nothing to sweep.
  if (!connectionsRoot()) return;
  try {
    const store = await getConnectionsStore();
    await store.sweepExpiredSignIns();
    // Armed first, so a restart a previous host left pending and one this apply records are both served.
    startRestartChecks(store, signal);
    startConnectionsRefresher(store, signal);
    await applyMainServers(store);
  } catch (error) {
    if (error instanceof ConnectionsStoreError) log.warn('Connections store unavailable', { reason: error.reason });
    else if (error instanceof MainServersUnreadableError) log.error('Main apps not applied', { reason: error.message });
    else throw error;
  }
});

onHostShutdown(stopConnectionsRefresher);
onHostShutdown(stopRestartChecks);
