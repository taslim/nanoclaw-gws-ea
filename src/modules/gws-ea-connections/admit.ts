/**
 * Whether a URL may become one of the principal's apps. The gateway attaches credentials by exact host, so a host
 * already holding someone else's credential, or serving the assistant itself, could put the wrong token on a
 * request; one app per host keeps every credential on its own requests.
 */
import { readEnvFile } from '../../env.js';
import { getGatewayProvider } from '../../gateway-providers/index.js';
import type { GatewayHostCredential } from '../../gateway-providers/credential-connection.js';
import { listProviderHostContracts } from '../../provider-contracts/index.js';
import { AGENT_GOOGLE_HOSTS } from '../gws-ea-google/grant.js';
import { readWebPolicy } from '../gws-ea-web/policy.js';
import { mainOperatorServers, type OperatorServer } from './apply.js';
import { isHostCliHost, type ConnectionApp, type ConnectionsStore } from './store.js';

/** Every app credential the host publishes carries this name prefix and the app's ID. */
export const APP_CREDENTIAL_PREFIX = 'gws-ea-app-';

export function appCredentialName(appId: string): string {
  return `${APP_CREDENTIAL_PREFIX}${appId}`;
}

/**
 * The gateway's ChatGPT login is the one OAuth profile every gateway can hold, whether or not a provider that uses
 * it is installed.
 */
const CHATGPT_HOST = 'chatgpt.com';

/** A DNS name in its ASCII form, without a trailing dot, so it compares exactly as the gateway matches hosts. */
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/u;
/** The characters a gateway credential path may carry, so the published path matches the app's requests exactly. */
const PATH = /^\/[A-Za-z0-9._~/-]*$/u;

export type AdmissionRefusal =
  | 'invalid_url'
  | 'not_https'
  /** Sign-in details or a query, which is where a URL carries credentials; an app's address names it and nothing more. */
  | 'credentials_in_url'
  /** Another app, an operator server or a gateway credential already uses the host. */
  | 'host_in_use'
  /** The host serves the assistant itself: its model, Google, its web address or its gateway. */
  | 'own_service'
  /** The gateway cannot list its credentials, so a conflict cannot be ruled out. */
  | 'unavailable';

export type Admission =
  | { readonly admitted: true; readonly url: string; readonly host: string }
  | { readonly admitted: false; readonly reason: AdmissionRefusal };

export interface AdmissionDependencies {
  readonly appByHost: (host: string) => Promise<Pick<ConnectionApp, 'id'> | undefined>;
  readonly operatorServers: () => Promise<readonly OperatorServer[]>;
  /** Undefined when the gateway has no way to list credentials by host. */
  readonly gatewayCredentials: ((host: string) => Promise<readonly GatewayHostCredential[]>) | undefined;
  readonly protectedHosts: () => Promise<ReadonlySet<string>>;
}

export interface AdmissionOptions {
  /** An app checked again keeps its own host and its own credential. */
  readonly appId?: string;
}

function refused(reason: AdmissionRefusal): Admission {
  return { admitted: false, reason };
}

function parsed(input: string): URL | AdmissionRefusal {
  if (typeof input !== 'string' || !URL.canParse(input.trim())) return 'invalid_url';
  const url = new URL(input.trim());
  if (url.protocol !== 'https:') return 'not_https';
  if (url.username || url.password || url.search || input.includes('?')) return 'credentials_in_url';
  if (
    url.hash ||
    input.includes('#') ||
    url.port !== '' ||
    !HOST.test(url.hostname) ||
    !PATH.test(url.pathname) ||
    isHostCliHost(url.hostname)
  )
    return 'invalid_url';
  return url;
}

/** Undefined for a URL that cannot be read or names no host. */
export function hostOf(url: string): string | undefined {
  return URL.parse(url)?.hostname || undefined;
}

/** Refusals are decided from the URL first, so a malformed address never reaches the gateway or the store. */
export async function admitAppUrl(
  input: string,
  dependencies: AdmissionDependencies,
  options: AdmissionOptions = {},
): Promise<Admission> {
  const url = parsed(input);
  if (typeof url === 'string') return refused(url);
  const host = url.hostname;
  if ((await dependencies.protectedHosts()).has(host)) return refused('own_service');
  const app = await dependencies.appByHost(host);
  if (app && app.id !== options.appId) return refused('host_in_use');
  if ((await dependencies.operatorServers()).some((server) => hostOf(server.url) === host))
    return refused('host_in_use');
  if (!dependencies.gatewayCredentials) return refused('unavailable');
  const own = options.appId === undefined ? undefined : appCredentialName(options.appId);
  if ((await dependencies.gatewayCredentials(host)).some((credential) => credential.name !== own))
    return refused('host_in_use');
  return { admitted: true, url: url.href, host };
}

function oneCliHost(): string | undefined {
  const url = process.env.ONECLI_URL || readEnvFile(['ONECLI_URL']).ONECLI_URL;
  return url ? hostOf(url) : undefined;
}

/** The assistant's web address whenever web is configured, enabled or not. */
export async function webHostname(): Promise<string | undefined> {
  const policy = await readWebPolicy();
  return 'config' in policy ? policy.config?.hostname : undefined;
}

/** The hosts whose gateway credentials or traffic belong to the assistant itself. */
export async function assistantProtectedHosts(): Promise<ReadonlySet<string>> {
  const modelHosts = listProviderHostContracts().flatMap((contract) =>
    Object.values(contract.modelEndpoints ?? {}).flatMap((endpoint) => hostOf(endpoint) ?? []),
  );
  const webHost = await webHostname();
  return new Set(
    [...modelHosts, CHATGPT_HOST, ...AGENT_GOOGLE_HOSTS, webHost, oneCliHost()].filter(
      (host): host is string => host !== undefined,
    ),
  );
}

export function admissionDependencies(store: Pick<ConnectionsStore, 'byHost'>): AdmissionDependencies {
  const credentials = getGatewayProvider().credentials;
  const listForHost = credentials?.listForHost;
  return {
    appByHost: (host) => store.byHost(host),
    operatorServers: mainOperatorServers,
    gatewayCredentials: listForHost && ((host) => listForHost.call(credentials, host)),
    protectedHosts: assistantProtectedHosts,
  };
}
