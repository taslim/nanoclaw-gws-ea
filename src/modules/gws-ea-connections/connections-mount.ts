import { ALLOW, DENY, defineGuardedAction } from '../../guard/index.js';
import { getMainAgentGroupId } from '../gws-ea-profile/db.js';
import type { PrincipalPageMount, PrincipalSubpathLinkContext, PublicMount } from '../gws-ea-web/mounts.js';
import { hostOf } from './admit.js';
import type { OperatorServer } from './apply.js';
import { catalogEntryFor, isConfirmedByApp, type AvailableCatalogEntry } from './catalog.js';
import { createClientDocumentHandler } from './client-document.js';
import { isLiveHeldCallView } from './held-calls.js';
import { CLIENT_DOCUMENT_PATH } from './oauth.js';
import { readListing, type ConnectionsListing } from './operations.js';
import { createConnectionsPageHandler } from './page.js';
import { ConnectionsStoreError, getConnectionsStore, type AppStatus, type ToolLabel } from './store.js';

const HELD_LINK_PATH = /^\/connections\/held\/([A-Za-z0-9_-]{4,128})$/u;

export const connectionsPageGuard = defineGuardedAction({
  action: 'gws_ea_connections.connections_page',
  async decide({ actor }) {
    return actor.kind === 'agent' && actor.agentGroupId === (await getMainAgentGroupId())
      ? ALLOW("Main asks for the principal's Connections page.")
      : DENY("Only main may obtain the principal's Connections page.");
  },
});

async function currentListing(includeAvailability = true): Promise<ConnectionsListing> {
  try {
    return await readListing(await getConnectionsStore(), undefined, { includeAvailability });
  } catch (error) {
    if (!(error instanceof ConnectionsStoreError)) throw error;
    return readListing(undefined);
  }
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What needs the principal comes first: pending approvals, then reconnecting, then review, then healthy count. */
export async function connectionsStatus(read: () => Promise<ConnectionsListing> = currentListing): Promise<string> {
  const listing = await read();
  if (!listing.canChange) return 'Unavailable';
  const pending = listing.pendingApprovals?.length ?? 0;
  if (pending) return count(pending, 'approval waiting', 'approvals waiting');
  const reconnect = listing.apps.filter((app) => app.status === 'needs_reconnecting').length;
  if (reconnect) return count(reconnect, 'app needs reconnecting', 'apps need reconnecting');
  const needsReview = listing.apps.filter(
    (app) => app.status === 'connected' && listing.pins?.[app.id]?.needsReview === true,
  ).length;
  if (needsReview) return count(needsReview, 'app needs review', 'apps need review');
  const connected = listing.apps.filter((app) => app.status === 'connected').length + listing.operators.length;
  return connected ? count(connected, 'app connected', 'apps connected') : 'No apps yet';
}

export interface ConnectionToolFact {
  readonly name: string;
  readonly label: ToolLabel | 'unsorted';
  readonly summary?: string;
  readonly reason: string | null;
  readonly confirmedByApp?: true;
}

export interface ConnectionLinkFact {
  readonly name: string;
  readonly key: string;
  /** Absent for an app the host runs itself, whose stored host is a placeholder that names nothing. */
  readonly host?: string;
  readonly origin: 'principal' | 'operator';
  readonly status: AppStatus;
  /** Present for pinned principal apps: true until the principal confirms review or after definitions change. */
  readonly needsReview?: boolean;
  /** Present for pinned principal apps: current approval label and reason for each pinned tool. */
  readonly tools?: readonly ConnectionToolFact[];
}

export interface AvailableAppFact {
  readonly id: string;
  readonly name: string;
  readonly goodFor: string;
  readonly requirements?: string;
  readonly signIn: 'phrase_approval' | 'sign_in_page';
  readonly app?: { readonly name: string; readonly key: string };
}

function availableFact({ entry, app }: AvailableCatalogEntry): AvailableAppFact {
  return {
    id: entry.id,
    name: entry.name,
    goodFor: entry.goodFor,
    ...(entry.requirements ? { requirements: entry.requirements } : {}),
    signIn: entry.transport.kind === 'host_cli' ? 'phrase_approval' : 'sign_in_page',
    ...(app ? { app: { name: app.name, key: app.serverKey } } : {}),
  };
}

/** The host knows nothing of an operator server beyond its entry, so a present entry is connected. */
export function operatorAsApp(server: OperatorServer): (ConnectionLinkFact & { readonly host: string }) | undefined {
  const host = hostOf(server.url);
  // An entry without a host reaches no server, so there is nothing of it to show.
  return host ? { name: server.key, key: server.key, host, origin: 'operator', status: 'connected' } : undefined;
}

/** Never an address that carries a secret. */
export async function connectionsLinkFacts(
  read: () => Promise<ConnectionsListing> = () => currentListing(false),
): Promise<{ readonly apps: readonly ConnectionLinkFact[]; readonly available?: readonly AvailableAppFact[] }> {
  const { apps, operators, pins, toolsByApp, available } = await read();
  return {
    apps: [
      ...apps.map((app): ConnectionLinkFact => {
        const { id, name, serverKey, host, status } = app;
        const pin = pins?.[id];
        const pinnedTools = toolsByApp?.[id];
        const entry = catalogEntryFor(app);
        const tools =
          pin && pinnedTools
            ? pinnedTools.map((tool): ConnectionToolFact => ({
                name: tool.name,
                label: tool.label ?? 'unsorted',
                ...(tool.summary ? { summary: tool.summary } : {}),
                reason: tool.reason,
                ...(entry && isConfirmedByApp(entry, tool.name) ? { confirmedByApp: true as const } : {}),
              }))
            : undefined;
        return {
          name,
          key: serverKey,
          ...(app.transport === 'remote' ? { host } : {}),
          origin: 'principal',
          status,
          ...(pin ? { needsReview: pin.needsReview } : {}),
          ...(tools ? { tools } : {}),
        };
      }),
      ...operators.flatMap((server) => operatorAsApp(server) ?? []),
    ],
    ...(available ? { available: available.map(availableFact) } : {}),
  };
}

async function allowConnectionsSubpathLink(pathname: string, context?: PrincipalSubpathLinkContext): Promise<boolean> {
  const match = HELD_LINK_PATH.exec(pathname);
  if (!match) return false;
  if (context?.terminalCardEdit === true) return true;
  return isLiveHeldCallView(match[1]!);
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
  allowSubpathLink: allowConnectionsSubpathLink,
  handler: (config, identity) => createConnectionsPageHandler({ hostname: config.hostname, identity }),
};

export const clientDocumentsWebMount: PublicMount = {
  name: 'client-documents',
  audience: 'public',
  path: CLIENT_DOCUMENT_PATH,
  methods: ['GET', 'HEAD'],
  handler: (config) => createClientDocumentHandler({ hostname: config.hostname }),
};
