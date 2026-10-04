import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
  GatewayCredentialConnection,
  GatewayCredentialTarget,
} from '../../src/gateway-providers/credential-connection.js';
import { loadGatewayCatalog } from './catalog.js';
import { resolveGatewaySelection } from './selection.js';

// The connection contract lives with the host, which compiles only `src/`;
// providers keep importing it from here.
export type {
  ChatGptOAuthCredential,
  GatewayCredentialConnection,
  GatewayCredentialTarget,
  GatewayOAuthCredential,
} from '../../src/gateway-providers/credential-connection.js';

/** Bumped only when a provider needs a gateway capability an older core's store cannot offer. */
export const PROVIDER_CREDENTIAL_CONNECTION_SEAM_VERSION = 1;

/** Login belongs to the agent provider; custody and refresh belong to its gateway. */
export type ProviderCredential = { kind: 'api-key'; value: string } | { kind: 'oauth'; file: string };

export interface ProviderCredentialStore {
  has(provider: string): Promise<boolean>;
  save(provider: string, credential: ProviderCredential): Promise<void>;
  /** Caller-described credentials. Absent when the gateway supports only provider-named ones. */
  connection?(target: GatewayCredentialTarget): GatewayCredentialConnection;
  /** Validate a model endpoint now; route it through the gateway after the user completes setup. */
  modelEndpoint?(url: string): { configure(): Promise<void> };
}

function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function';
}

export async function getCredentialStore(root = process.cwd()): Promise<ProviderCredentialStore> {
  const selected = process.env.NANOCLAW_GATEWAY_PROVIDER?.trim() || resolveGatewaySelection(root);
  const gateway = loadGatewayCatalog(root).gateways.find((entry) => entry.kind === selected);
  if (!gateway) throw new Error(`Unknown gateway: ${selected}`);
  const file = path.join(gateway.skillPath, 'scripts', 'credential-store.ts');
  if (!fs.existsSync(file)) throw new Error(`Gateway ${selected} does not provide a credential store`);
  const adapter = await import(pathToFileURL(file).href);
  const store = adapter.createCredentialStore?.(root);
  if (
    !store ||
    !isFunction(store.has) ||
    !isFunction(store.save) ||
    (store.connection !== undefined && !isFunction(store.connection)) ||
    (store.modelEndpoint !== undefined && !isFunction(store.modelEndpoint))
  )
    throw new Error(`Gateway ${selected} has an invalid credential store`);
  if (!store.connection) return store;
  // The adapter is loaded dynamically; check the connection shape once here so
  // a provider never has to reason about a half-implemented gateway.
  const connection = store.connection.bind(store);
  return {
    ...store,
    connection(target) {
      const result = connection(target);
      if (!result || !isFunction(result.find) || !isFunction(result.save) || !isFunction(result.keep))
        throw new Error(`Gateway ${selected} has an invalid provider credential connection`);
      return result;
    },
  };
}
