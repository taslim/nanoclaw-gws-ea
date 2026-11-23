import { ALLOW, DENY, defineGuardedAction } from '../../guard/index.js';
import { getMainAgentGroupId } from '../gws-ea-profile/db.js';
import type { PrincipalPageMount, PublicMount } from '../gws-ea-web/mounts.js';
import { hostOf } from './admit.js';
import type { OperatorServer } from './apply.js';
import { createClientDocumentHandler } from './client-document.js';
import { CLIENT_DOCUMENT_PATH } from './oauth.js';
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
  return connected ? count(connected, 'app connected', 'apps connected') : 'No apps yet';
}

export interface ConnectionLinkFact {
  readonly name: string;
  readonly key: string;
  readonly host: string;
  readonly origin: 'principal' | 'operator';
  readonly status: AppStatus;
}

/** The host knows nothing of an operator server beyond its entry, so a present entry is connected. */
export function operatorAsApp(server: OperatorServer): ConnectionLinkFact | undefined {
  const host = hostOf(server.url);
  // An entry without a host reaches no server, so there is nothing of it to show.
  return host ? { name: server.key, key: server.key, host, origin: 'operator', status: 'connected' } : undefined;
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
      ...operators.flatMap((server) => operatorAsApp(server) ?? []),
    ],
  };
}

export const connectionsWebMount: PrincipalPageMount = {
  name: 'connections',
  audience: 'principal',
  path: '/connections',
  methods: ['GET', 'HEAD', 'POST'],
  title: 'Connections',
  icon: 'plug',
  status: () => connectionsStatus(),
  linkGuard: connectionsPageGuard,
  linkFacts: () => connectionsLinkFacts(),
  handler: (config, identity) => createConnectionsPageHandler({ hostname: config.hostname, identity }),
};

export const clientDocumentsWebMount: PublicMount = {
  name: 'client-documents',
  audience: 'public',
  path: CLIENT_DOCUMENT_PATH,
  methods: ['GET', 'HEAD'],
  handler: (config) => createClientDocumentHandler({ hostname: config.hostname }),
};
