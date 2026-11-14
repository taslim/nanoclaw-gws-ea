/**
 * The principal's own remote MCP apps. The host owns them in an encrypted store; no agent sees a credential.
 */
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { applyMainServers, MainServersUnreadableError } from './apply.js';
import { connectionsRoot } from './config.js';
import { startRestartChecks, stopRestartChecks } from './idle-restart.js';
import { ConnectionsStoreError, getConnectionsStore } from './store.js';

onHostStart(async ({ signal }) => {
  // Only a gws-ea assistant has a store; a plain NanoClaw host has nothing to sweep.
  if (!connectionsRoot()) return;
  try {
    const store = await getConnectionsStore();
    await store.sweepExpiredSignIns();
    // Armed first, so a restart a previous host left pending and one this apply records are both served.
    startRestartChecks(store, signal);
    await applyMainServers(store);
  } catch (error) {
    if (error instanceof ConnectionsStoreError) log.warn('Connections store unavailable', { reason: error.reason });
    else if (error instanceof MainServersUnreadableError) log.error('Main apps not applied', { reason: error.message });
    else throw error;
  }
});

onHostShutdown(stopRestartChecks);
