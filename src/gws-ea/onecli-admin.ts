/**
 * gws-ea's administration of an instance's OneCLI, over its REST API
 * (KTD14): the local API key, the vault's secrets, the agents, and an agent's
 * secret mode. Every call goes to the app URL it is given with the key it is
 * given, never to anything the environment names; it refuses a redirect and
 * has its own timeout. No answer's body ever reaches an error or a log: a new
 * secret's answer previews its value, and the agent list carries each
 * agent's access token.
 */
import { registerSecret } from './redact.js';
import { GwsEaError } from './types.js';
import { isRecord, requireString } from './validation.js';
import type { ProviderCredential, ProviderCredentialMetadata } from '../provider-credential.js';

const REQUEST_TIMEOUT_MS = 30_000;
const FAILED = 'onecli_request_failed';
const INVALID_OUTPUT = 'invalid_onecli_output';
const API_KEY_PATTERN = /^oc_[A-Za-z0-9_-]{20,}$/u;

/** What OneCLI stores as the format of a header or parameter given none: the bare value. */
const DEFAULT_INJECTION_FORMAT = '{value}';

export type OnecliSecretMode = 'all' | 'selective';

/** One of the instance's OneCLI agents; its access token is never read. */
export interface OnecliAgent {
  readonly id: string;
  readonly identifier: string;
  readonly name: string;
  /** `all`, OneCLI's default, when OneCLI omits it, as releases from 1.43 on may. */
  readonly secretMode: string;
}

/** How OneCLI injects a generic secret: into a header, or into a query parameter. */
export type OnecliInjection =
  | { readonly headerName: string; readonly valueFormat: string }
  | { readonly paramName: string; readonly paramFormat: string };

export interface OnecliAdmin {
  /** Every secret's metadata; values never come back. */
  listSecrets(): Promise<readonly Record<string, unknown>[]>;
  /** Store `credential` as a new secret, its value only in the request body, and return the secret's ID. */
  createSecret(credential: ProviderCredential): Promise<string>;
  listAgents(): Promise<readonly OnecliAgent[]>;
  /** Create an agent. One whose identifier exists already (409) is no failure: the list then names it. */
  createAgent(agent: { readonly name: string; readonly identifier: string }): Promise<void>;
  setSecretMode(agentId: string, mode: OnecliSecretMode): Promise<void>;
}

export interface OnecliAdminDependencies {
  readonly fetch?: typeof globalThis.fetch;
}

interface OnecliEndpoint {
  readonly url: string;
  readonly apiKey: string | undefined;
  readonly fetch: typeof globalThis.fetch;
}

interface OnecliCall {
  readonly method: 'GET' | 'POST' | 'PATCH';
  readonly route: string;
  /** What the call asks for, as an error names it. */
  readonly label: string;
  readonly body?: unknown;
  /** A failure status that still answers the call. */
  readonly accepted?: number;
}

/**
 * Send one call; an answer that is neither a success nor `accepted` is
 * refused. A transport error, a refusal, and an unreadable answer are each
 * reported by the call and its status alone, with no cause: a transport
 * error can quote the request, and a parse error the body.
 */
async function send(endpoint: OnecliEndpoint, call: OnecliCall): Promise<Response> {
  let response: Response;
  try {
    response = await endpoint.fetch(new URL(call.route, endpoint.url), {
      method: call.method,
      headers: {
        ...(endpoint.apiKey === undefined ? {} : { authorization: `Bearer ${endpoint.apiKey}` }),
        ...(call.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new GwsEaError(FAILED, `OneCLI did not answer ${call.label}`);
  }
  if (!response.ok && response.status !== call.accepted) {
    throw new GwsEaError(FAILED, `OneCLI refused ${call.label} (HTTP ${response.status})`);
  }
  return response;
}

/** Send one call whose answer is read, and read it. */
async function read(endpoint: OnecliEndpoint, call: OnecliCall): Promise<unknown> {
  const response = await send(endpoint, call);
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new GwsEaError(INVALID_OUTPUT, `OneCLI answered ${call.label} with unreadable JSON`);
  }
}

function records(value: unknown, label: string): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new GwsEaError(INVALID_OUTPUT, `OneCLI returned an invalid ${label}`);
  }
  return value;
}

function parseAgent(agent: Record<string, unknown>): OnecliAgent {
  return {
    id: requireString(agent.id, 'OneCLI agent ID', INVALID_OUTPUT, 256),
    identifier: requireString(agent.identifier, 'OneCLI agent identifier', INVALID_OUTPUT, 256),
    name: requireString(agent.name, 'OneCLI agent name', INVALID_OUTPUT, 256),
    secretMode: requireString(agent.secretMode ?? 'all', 'OneCLI agent secret mode', INVALID_OUTPUT, 32),
  };
}

/**
 * The injection OneCLI stores for a secret with this metadata, a format left
 * out defaulted as OneCLI defaults it; null when it injects neither a header
 * nor a parameter. Creating and matching a secret both read it, so a secret
 * stored without a format is found again.
 */
export function onecliInjection(metadata: ProviderCredentialMetadata): OnecliInjection | null {
  if (metadata.headerName !== undefined) {
    return { headerName: metadata.headerName, valueFormat: metadata.valueFormat ?? DEFAULT_INJECTION_FORMAT };
  }
  if (metadata.paramName !== undefined) {
    return { paramName: metadata.paramName, paramFormat: metadata.paramFormat ?? DEFAULT_INJECTION_FORMAT };
  }
  return null;
}

/**
 * The instance's local API key, which OneCLI's local auth mode hands a
 * keyless caller on its loopback port, creating it on the first read. It is
 * only ever read, so every read returns the same key. It is registered for
 * redaction before it is returned.
 */
export async function fetchOnecliApiKey(url: string, dependencies: OnecliAdminDependencies = {}): Promise<string> {
  const answer = await read(
    { url, apiKey: undefined, fetch: dependencies.fetch ?? globalThis.fetch },
    { method: 'GET', route: '/v1/user/api-key', label: 'the API key request' },
  );
  const apiKey = isRecord(answer) ? answer.apiKey : undefined;
  if (typeof apiKey !== 'string' || !API_KEY_PATTERN.test(apiKey)) {
    throw new GwsEaError('incompatible_onecli', 'OneCLI returned an invalid local API key');
  }
  registerSecret(apiKey);
  return apiKey;
}

/** The OneCLI at `url`, administered with `apiKey`, which is registered for redaction. */
export function createOnecliAdmin(
  url: string,
  apiKey: string,
  dependencies: OnecliAdminDependencies = {},
): OnecliAdmin {
  registerSecret(apiKey);
  const endpoint: OnecliEndpoint = { url, apiKey, fetch: dependencies.fetch ?? globalThis.fetch };
  return {
    async listSecrets() {
      return records(
        await read(endpoint, { method: 'GET', route: '/v1/secrets', label: 'the secret list' }),
        'secret list',
      );
    },
    async createSecret(credential) {
      registerSecret(credential.value);
      const injection = onecliInjection(credential);
      const created = await read(endpoint, {
        method: 'POST',
        route: '/v1/secrets',
        label: `the new ${credential.name} secret`,
        body: {
          name: credential.name,
          type: credential.type,
          value: credential.value,
          hostPattern: credential.hostPattern,
          ...(credential.pathPattern === undefined ? {} : { pathPattern: credential.pathPattern }),
          ...(injection === null ? {} : { injectionConfig: injection }),
        },
      });
      // Only the ID is read: the answer also previews the value.
      return requireString(isRecord(created) ? created.id : undefined, 'OneCLI secret ID', INVALID_OUTPUT, 256);
    },
    async listAgents() {
      const agents = await read(endpoint, { method: 'GET', route: '/v1/agents', label: 'the agent list' });
      return records(agents, 'agent list').map(parseAgent);
    },
    async createAgent(agent) {
      await send(endpoint, {
        method: 'POST',
        route: '/v1/agents',
        label: `agent ${agent.identifier}`,
        body: { name: agent.name, identifier: agent.identifier },
        accepted: 409,
      });
    },
    async setSecretMode(agentId, mode) {
      await send(endpoint, {
        method: 'PATCH',
        route: `/v1/agents/${encodeURIComponent(agentId)}/secret-mode`,
        label: `agent ${agentId}'s secret mode`,
        body: { mode },
      });
    },
  };
}
