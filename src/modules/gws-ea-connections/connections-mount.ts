import { ALLOW, DENY, defineGuardedAction } from '../../guard/index.js';
import { getMainAgentGroupId } from '../gws-ea-profile/db.js';
import type { PrincipalPageMount } from '../gws-ea-web/mounts.js';
import { readListing, type ConnectionsListing } from './operations.js';
import { createConnectionsPageHandler } from './page.js';
import { ConnectionsStoreError, getConnectionsStore, type AppStatus } from './store.js';

export const connectionsPageGuard = defineGuardedAction({
  action: 'gws_ea_connections.connections_page',
  async decide({ actor }) {
    return actor.kind === 'agent' && actor.agentGroupId === (await getMainAgentGroupId())
      ? ALLOW("Main asks for the principal's Connections page.")
      : DENY("Only main may obtain the principal's Connections page.");
  },
});

async function currentListing(): Promise<ConnectionsListing> {
  try {
    return await readListing(await getConnectionsStore());
  } catch (error) {
    if (!(error instanceof ConnectionsStoreError)) throw error;
    return readListing(undefined);
  }
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What needs the principal comes first: an app to reconnect outranks how many work. */
export async function connectionsStatus(read: () => Promise<ConnectionsListing> = currentListing): Promise<string> {
  const listing = await read();
  if (!listing.canChange) return 'Unavailable';
  const reconnect = listing.apps.filter((app) => app.status === 'needs_reconnecting').length;
  if (reconnect) return count(reconnect, 'app needs reconnecting', 'apps need reconnecting');
  const connected = listing.apps.filter((app) => app.status === 'connected').length + listing.operators.length;
  return connected ? count(connected, 'app connected', 'apps connected') : 'None yet';
}

export interface ConnectionLinkFact {
  readonly name: string;
  readonly key: string;
  readonly host: string;
  readonly origin: 'principal' | 'operator';
  readonly status: AppStatus;
}

/** Main learns which apps exist and how they stand, never an address that could carry a credential. */
export async function connectionsLinkFacts(
  read: () => Promise<ConnectionsListing> = currentListing,
): Promise<{ readonly apps: readonly ConnectionLinkFact[] }> {
  const { apps, operators } = await read();
  return {
    apps: [
      ...apps.map(
        ({ name, serverKey, host, status }): ConnectionLinkFact => ({
          name,
          key: serverKey,
          host,
          origin: 'principal',
          status,
        }),
      ),
      ...operators.flatMap(({ key, url }): ConnectionLinkFact[] => {
        const host = URL.parse(url)?.hostname;
        return host ? [{ name: key, key, host, origin: 'operator', status: 'connected' }] : [];
      }),
    ],
  };
}

export const connectionsWebMount: PrincipalPageMount = {
  name: 'connections',
  audience: 'principal',
  path: '/connections',
  methods: ['GET', 'HEAD', 'POST'],
  title: 'Connections',
  status: () => connectionsStatus(),
  linkGuard: connectionsPageGuard,
  linkFacts: () => connectionsLinkFacts(),
  handler: (config, identity) => createConnectionsPageHandler({ hostname: config.hostname, identity }),
};
