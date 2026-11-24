/**
 * Disconnecting a server the operator added to main. Removing only the entry would leave the operator's gateway
 * credential on the server's host, still attached to main's own requests there, so the host's credentials go too,
 * unless another of the operator's servers in main still reaches that host and needs them.
 *
 * The credentials go first and the entry last: while any credential remains, the entry keeps the server listed, so
 * the principal can try again and the next attempt finds whatever is left. The host is always read from main's
 * entry; the page only names the host it showed, so an entry that now points elsewhere is not disconnected on a
 * confirmation that named another host.
 */
import type { GatewayCredentialRemoval, GatewayHostCredential } from '../../gateway-providers/credential-connection.js';
import { getGatewayProvider } from '../../gateway-providers/index.js';
import { log } from '../../log.js';
import { AGENT_GOOGLE_CREDENTIALS } from '../gws-ea-google/grant.js';
import { APP_CREDENTIAL_PREFIX, assistantProtectedHosts, hostOf } from './admit.js';
import { MainServersUnreadableError, mainOperatorServers, removeOperatorServer, type OperatorServer } from './apply.js';
import { withAppLock } from './locks.js';
import type { ConnectionsStore } from './store.js';

export type OperatorDisconnectOutcome =
  | 'disconnected'
  /** Some of the host's credentials are still in the gateway, so the server stays listed for another try. */
  | 'credentials_kept'
  /** The entry now points at another host than the one the principal confirmed. */
  | 'changed'
  /** Main has no operator `http` server under that key. */
  | 'not_found'
  /** The gateway cannot list and remove credentials by host, or main's servers cannot be read. */
  | 'unavailable';

export interface OperatorDisconnectRequest {
  readonly key: string;
  /** The host the confirmation named; empty for an entry without one. */
  readonly host: string;
}

export interface OperatorCredentials {
  listForHost(host: string): Promise<readonly GatewayHostCredential[]>;
  removeById(ids: readonly string[]): Promise<readonly GatewayCredentialRemoval[]>;
}

export interface OperatorDisconnectDependencies {
  /** Undefined when the gateway cannot list and remove credentials by host. */
  readonly credentials: OperatorCredentials | undefined;
  readonly protectedHosts: () => Promise<ReadonlySet<string>>;
}

/** Google's credentials are the assistant's own, kept under these names whichever host they sit on. */
const GOOGLE_CREDENTIAL_NAMES: ReadonlySet<string> = new Set(
  AGENT_GOOGLE_CREDENTIALS.map((credential) => credential.secretName),
);

function assistantCredential(credential: GatewayHostCredential): boolean {
  return credential.name.startsWith(APP_CREDENTIAL_PREFIX) || GOOGLE_CREDENTIAL_NAMES.has(credential.name);
}

/** The host the gateway matches the entry's requests by; an entry that names none reaches no server. */
export function operatorServerHost(server: OperatorServer): string | undefined {
  return hostOf(server.url);
}

export function gatewayHostCredentials(): OperatorCredentials | undefined {
  const credentials = getGatewayProvider().credentials;
  const listForHost = credentials?.listForHost;
  const removeById = credentials?.removeById;
  return credentials && listForHost && removeById
    ? {
        listForHost: (host) => listForHost.call(credentials, host),
        removeById: (ids) => removeById.call(credentials, ids),
      }
    : undefined;
}

export function gatewayOperatorDependencies(): OperatorDisconnectDependencies {
  return {
    credentials: gatewayHostCredentials(),
    protectedHosts: assistantProtectedHosts,
  };
}

/**
 * A protected host carries only the assistant's own credentials, the model's or Google's, so none of them is the
 * server's to take. Anywhere else, every credential on the host except the assistant's own is the operator's.
 */
async function removeHostCredentials(
  host: string,
  credentials: OperatorCredentials,
  protectedHosts: () => Promise<ReadonlySet<string>>,
): Promise<boolean> {
  if ((await protectedHosts()).has(host)) return true;
  try {
    const ids = (await credentials.listForHost(host))
      .filter((credential) => !assistantCredential(credential))
      .map((credential) => credential.id);
    if (ids.length === 0) return true;
    const outcomes = new Map((await credentials.removeById(ids)).map((removal) => [removal.id, removal.outcome]));
    // An id the gateway did not report on may still be there, so it counts as kept.
    const kept = ids.filter((id) => outcomes.get(id) !== 'removed' && outcomes.get(id) !== 'gone').length;
    if (kept === 0) return true;
    log.warn('Operator server credentials not all removed', { host, kept, of: ids.length });
    return false;
    /* eslint-disable no-catch-all/no-catch-all -- Any gateway failure keeps the server for another try; only the failure's kind is logged. */
  } catch (error) {
    log.warn('Operator server credentials not removed', {
      host,
      error: error instanceof Error ? error.name : 'unknown',
    });
    return false;
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

/** Main restarts once idle when its entry goes, through the same request every change to its servers makes. */
export async function disconnectOperatorServer(
  store: ConnectionsStore,
  request: OperatorDisconnectRequest,
  dependencies: OperatorDisconnectDependencies = gatewayOperatorDependencies(),
): Promise<OperatorDisconnectOutcome> {
  const { credentials, protectedHosts } = dependencies;
  if (!credentials) return 'unavailable';
  // One host at a time: two of its servers going together would each see the other and leave the host's credentials
  // behind. The prefix keeps this lock apart from every app's, whose keys are bare UUIDs.
  return withAppLock(`operator:${request.host}`, async () => {
    try {
      const servers = await mainOperatorServers();
      const server = servers.find((candidate) => candidate.key === request.key);
      if (!server) return 'not_found';
      const host = operatorServerHost(server);
      if ((host ?? '') !== request.host) return 'changed';
      const shared = servers.some((other) => other.key !== request.key && operatorServerHost(other) === host);
      if (host && !shared && !(await removeHostCredentials(host, credentials, protectedHosts)))
        return 'credentials_kept';
      const removal = await removeOperatorServer(store, request.key);
      if (removal === 'not_operator') return 'not_found';
      log.info('Operator server disconnected', { key: request.key });
      return 'disconnected';
    } catch (error) {
      if (!(error instanceof MainServersUnreadableError)) throw error;
      return 'unavailable';
    }
  });
}
