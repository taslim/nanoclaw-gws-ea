/**
 * Setup's side of OneCLI's credential connection. The implementation is the
 * skill's payload (`payload/src/gateway-providers/onecli-credentials.ts`),
 * imported in place so setup needs no install, and installed unchanged for
 * the host. This file only reads this installation's management settings.
 */
import { readEnvFile } from '../../../../src/env.js';
import type {
  GatewayCredentialConnection,
  GatewayCredentialTarget,
} from '../../../../setup/gateways/credential-store.js';
import {
  createOneCliCredentialConnection as connectDescriptor,
  createProviderCredentialConnection as connectTarget,
  type OneCliCredential,
  type OneCliCredentialConnection,
  type OneCliManagement,
} from '../payload/src/gateway-providers/onecli-credentials.js';

export {
  encodeOneCliValue,
  findOneCliCredential,
  type KeyInjection,
  type OneCliCredential,
  type OneCliCredentialConnection,
} from '../payload/src/gateway-providers/onecli-credentials.js';

/**
 * This installation's management connection, independently of the global
 * OneCLI CLI configuration. Read at each call: the setup wizard may have
 * written `.env` after src/config was imported.
 */
function management(root: string, url?: string, apiKey?: string, fetchImpl?: typeof fetch): OneCliManagement {
  const saved = readEnvFile(['ONECLI_URL', 'ONECLI_API_KEY', 'ONECLI_PROJECT_ID'], root);
  return {
    url: url ?? (process.env.ONECLI_URL || saved.ONECLI_URL),
    apiKey: apiKey ?? (process.env.ONECLI_API_KEY || saved.ONECLI_API_KEY),
    projectId: process.env.ONECLI_PROJECT_ID || saved.ONECLI_PROJECT_ID,
    fetch: fetchImpl ?? globalThis.fetch,
  };
}

export function createOneCliCredentialConnection(
  descriptor: OneCliCredential,
  url?: string,
  apiKey?: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  root = process.cwd(),
): OneCliCredentialConnection {
  return connectDescriptor(descriptor, management(root, url, apiKey, fetchImpl));
}

export function createProviderCredentialConnection(
  target: GatewayCredentialTarget,
  root = process.cwd(),
): GatewayCredentialConnection {
  return connectTarget(target, management(root));
}
