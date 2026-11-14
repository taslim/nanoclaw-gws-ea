/**
 * The principal's own remote MCP apps. The host owns them in an encrypted store; no agent sees a credential.
 */
import { onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { connectionsRoot } from './config.js';
import { ConnectionsStoreError, getConnectionsStore } from './store.js';

onHostStart(async () => {
  // Only a gws-ea assistant has a store; a plain NanoClaw host has nothing to sweep.
  if (!connectionsRoot()) return;
  try {
    await (await getConnectionsStore()).sweepExpiredSignIns();
  } catch (error) {
    if (!(error instanceof ConnectionsStoreError)) throw error;
    log.warn('Connections store unavailable', { reason: error.reason });
  }
});
