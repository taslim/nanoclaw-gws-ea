/**
 * OneCLI's side of the caller-described credential connection
 * (`credential-connection.ts`): one OneCLI secret per connection name,
 * managed through its `/v1/secrets` API. Native OneCLI translation is
 * confined here: the vault id, the PATCH-versus-POST choice, and the stored
 * JSON shape never leave this file.
 *
 * One implementation serves setup and the host. The host's provider
 * definition uses the installed copy; the skill's setup scripts import this
 * payload copy in place, before or without an install, so the file has no
 * runtime import and each caller supplies its own management settings.
 */
import type {
  GatewayCredentialTarget,
  GatewayOAuthCredential,
  GatewayRuntimeCredentialConnection,
} from './credential-connection.js';

export interface KeyInjection {
  headerName: string;
  valueFormat: string;
}

export interface OneCliCredential {
  name: string;
  type: 'openai' | 'generic';
  hostPattern: string;
  injectionConfig?: KeyInjection;
  authMode?: 'oauth';
}

/** Where this installation's OneCLI management API is, and how to reach it. */
export interface OneCliManagement {
  readonly url: string | undefined;
  readonly apiKey?: string | undefined;
  /** Sent as `X-Project-Id` when set. */
  readonly projectId?: string | undefined;
  readonly fetch?: typeof fetch;
}

export interface OneCliCredentialConnection {
  find(options?: { confirmHostChange: (previous: string, next: string) => Promise<boolean> }): Promise<string | null>;
  save(value: string, existingId: string | null): Promise<string>;
  keep(existingId: string): Promise<void>;
  remove(existingId: string): Promise<void>;
}

const BEARER: KeyInjection = { headerName: 'Authorization', valueFormat: 'Bearer {value}' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameInjection(value: unknown, expected: KeyInjection): boolean {
  return (
    isRecord(value) &&
    value.headerName === expected.headerName &&
    value.valueFormat === expected.valueFormat &&
    Object.keys(value).every((key) => key === 'headerName' || key === 'valueFormat')
  );
}

function namedSecret(payload: unknown, name: string): Record<string, unknown> | undefined {
  if (!Array.isArray(payload) || !payload.every(isRecord)) {
    throw new Error('OneCLI returned invalid secret metadata.');
  }
  const matches = payload.filter((row) => row.name === name);
  if (matches.length > 1) {
    throw new Error(`Multiple ${name} credentials exist. Resolve duplicates in OneCLI before continuing.`);
  }
  return matches[0];
}

function exactHost(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.includes('*')) return false;
  try {
    const url = new URL(`https://${value}`);
    return url.hostname === value && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
    /* eslint-disable-next-line no-catch-all/no-catch-all -- A value URL cannot parse is not an exact host. */
  } catch {
    return false;
  }
}

/** Read metadata only. Never edit an inherited, ambiguous, or differently scoped credential. */
export function findOneCliCredential(payload: unknown, descriptor: OneCliCredential): string | null {
  const secret = namedSecret(payload, descriptor.name);
  if (!secret) return null;
  const injection = descriptor.injectionConfig;
  // Older OpenCode setup used bearer injection for every generic key. Only
  // that known mistake may be repaired; arbitrary rules belong to the operator.
  const knownKeyMapping =
    !injection || sameInjection(secret.injectionConfig, injection) || sameInjection(secret.injectionConfig, BEARER);
  const mismatches = [
    typeof secret.id !== 'string' || !secret.id.trim() ? 'id' : undefined,
    secret.type !== descriptor.type ? 'type' : undefined,
    secret.hostPattern !== descriptor.hostPattern ? 'hostPattern' : undefined,
    // Legacy OneCLI responses omitted both source fields and only supported
    // inline values. Explicit external or unknown sources remain ineligible.
    secret.valueSource !== undefined && secret.valueSource !== 'inline' ? 'valueSource' : undefined,
    secret.opRef !== undefined && secret.opRef !== null ? 'opRef' : undefined,
    secret.scope !== 'project' ? 'scope' : undefined,
    secret.pathPattern ? 'pathPattern' : undefined,
    !knownKeyMapping ? 'injectionConfig' : undefined,
    descriptor.authMode && (!isRecord(secret.metadata) || secret.metadata.authMode !== descriptor.authMode)
      ? 'metadata.authMode'
      : undefined,
  ].filter((field) => field !== undefined);
  if (mismatches.length) {
    throw new Error(
      `The ${descriptor.name} vault entry has unexpected metadata in: ${mismatches.join(', ')}. Check those fields in OneCLI.`,
    );
  }
  return secret.id as string;
}

/** Use this installation's management connection, independently of the global OneCLI CLI configuration. */
export function createOneCliCredentialConnection(
  descriptor: OneCliCredential,
  management: OneCliManagement,
): OneCliCredentialConnection {
  const { url, apiKey, projectId } = management;
  const fetchImpl = management.fetch ?? globalThis.fetch;
  if (!url) throw new Error(`Configure ONECLI_URL before connecting the ${descriptor.name} credential.`);
  const base = new URL(url);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('ONECLI_URL must be an HTTP(S) gateway URL without embedded credentials, query, or fragment.');
  }
  const send = async (suffix: string, method: string, body?: unknown): Promise<unknown> => {
    const response = await fetchImpl(`${base.href.replace(/\/+$/, '')}/v1/secrets${suffix}`, {
      method,
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(projectId ? { 'X-Project-Id': projectId } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('refused');
    // A deletion answers with no body to read.
    return method === 'DELETE' ? undefined : await response.json();
  };
  const request = async (suffix: string, method: string, body?: unknown): Promise<unknown> => {
    // API responses can include previews of secrets, and a parse error quotes
    // them. Never echo a response or a transport error, including when a
    // successful write's response is lost: every failure is this one message.
    const result = await send(suffix, method, body).then(
      (value) => ({ value }),
      () => undefined,
    );
    if (!result) {
      throw new Error(
        `Could not confirm the ${descriptor.name} credential in OneCLI. Check gateway connectivity and management permissions, then retry.`,
      );
    }
    return result.value;
  };
  const changed = () =>
    new Error(`The ${descriptor.name} vault entry changed since it was looked up. Check OneCLI and retry.`);
  // A host move is explicit and keeps the granted ID. Revalidate the old
  // descriptor on the final read so an edit during prompts cannot be adopted.
  let expected = descriptor;
  const find: OneCliCredentialConnection['find'] = async (options) => {
    const metadata = await request('', 'GET');
    const secret = namedSecret(metadata, descriptor.name);
    if (
      options &&
      expected === descriptor &&
      descriptor.type === 'generic' &&
      descriptor.injectionConfig &&
      !descriptor.authMode &&
      secret &&
      secret.hostPattern !== descriptor.hostPattern &&
      exactHost(secret.hostPattern) &&
      exactHost(descriptor.hostPattern)
    ) {
      const previous = { ...descriptor, hostPattern: secret.hostPattern };
      findOneCliCredential(metadata, previous);
      if (!(await options.confirmHostChange(previous.hostPattern, descriptor.hostPattern))) {
        throw new Error(`The ${descriptor.name} credential's host change was cancelled. It is unchanged.`);
      }
      expected = previous;
    }
    return findOneCliCredential(metadata, expected);
  };
  const hostUpdate = () =>
    expected.hostPattern === descriptor.hostPattern ? {} : { hostPattern: descriptor.hostPattern };
  return {
    find,
    async keep(existingId) {
      const metadata = await request('', 'GET');
      if (findOneCliCredential(metadata, expected) !== existingId) throw changed();
      const secret = (metadata as Array<Record<string, unknown>>).find((row) => row.id === existingId)!;
      const changes = {
        ...hostUpdate(),
        ...(descriptor.injectionConfig && !sameInjection(secret.injectionConfig, descriptor.injectionConfig)
          ? { injectionConfig: descriptor.injectionConfig }
          : {}),
      };
      if (Object.keys(changes).length) {
        await request(`/${encodeURIComponent(existingId)}`, 'PATCH', changes);
        expected = descriptor;
      }
    },
    async save(value, existingId) {
      if (!value.trim()) throw new Error(`Cannot save an empty ${descriptor.name} credential.`);
      if ((await find()) !== existingId) throw changed();
      if (existingId) {
        await request(`/${encodeURIComponent(existingId)}`, 'PATCH', {
          value,
          ...hostUpdate(),
          ...(descriptor.injectionConfig ? { injectionConfig: descriptor.injectionConfig } : {}),
        });
        expected = descriptor;
        return existingId;
      }
      const result = await request('', 'POST', {
        name: descriptor.name,
        type: descriptor.type,
        valueSource: 'inline',
        hostPattern: descriptor.hostPattern,
        value,
        ...(descriptor.injectionConfig ? { injectionConfig: descriptor.injectionConfig } : {}),
      });
      // Return the ID alone: the create response may also contain a key preview.
      if (!isRecord(result) || typeof result.id !== 'string' || !result.id) {
        throw new Error('OneCLI did not confirm the saved credential ID. Check its entries before retrying.');
      }
      return result.id;
    },
    async remove(existingId) {
      if (findOneCliCredential(await request('', 'GET'), expected) !== existingId) throw changed();
      await request(`/${encodeURIComponent(existingId)}`, 'DELETE');
    },
  };
}

/**
 * The caller-described connection over one OneCLI secret. The seam hands
 * over a destination, a header scheme, and parsed values; a target's
 * placeholder is never matched, because OneCLI injects by host pattern.
 */
export function createProviderCredentialConnection(
  target: GatewayCredentialTarget,
  management: OneCliManagement,
): GatewayRuntimeCredentialConnection {
  if (target.kind === 'oauth' && target.oauth.profile !== 'chatgpt') {
    throw new Error(
      `OneCLI stores only the ChatGPT subscription OAuth profile; ${String(target.oauth.profile)} is not supported.`,
    );
  }
  const vault = createOneCliCredentialConnection(
    {
      name: target.name,
      // OneCLI's `openai` type is its native ChatGPT-subscription record: it
      // refreshes the token and injects the account header itself.
      type: target.kind === 'oauth' ? 'openai' : 'generic',
      hostPattern: target.host,
      ...(target.kind === 'api-key' ? { injectionConfig: target.injection } : { authMode: 'oauth' as const }),
    },
    management,
  );
  let observed: string | null | undefined;
  const require = (): string | null => {
    if (observed === undefined) {
      throw new Error(`Look up the ${target.name} credential before keeping, saving, or removing it.`);
    }
    return observed;
  };
  return {
    async find(options) {
      observed = await vault.find(options);
      // An inline OneCLI entry can always be kept: a host move is a metadata PATCH.
      return observed === null ? null : { reusable: true };
    },
    async keep() {
      const id = require();
      if (id === null) throw new Error(`No stored ${target.name} credential to keep; enter a value.`);
      await vault.keep(id);
    },
    async save(value) {
      const id = require();
      observed = await vault.save(encodeOneCliValue(target, value), id);
    },
    async remove() {
      const id = require();
      if (id === null) return;
      await vault.remove(id);
      observed = null;
    },
  };
}

/** OneCLI's `openai` record is the Codex login-file shape; OpenCode's parsed login is re-encoded into it. */
export function encodeOneCliValue(target: GatewayCredentialTarget, value: string | GatewayOAuthCredential): string {
  if (target.kind === 'api-key') {
    if (typeof value !== 'string') throw new Error('An API-key connection stores a string value.');
    return value;
  }
  if (typeof value === 'string' || value.profile !== target.oauth.profile) {
    throw new Error(`This connection stores the ${target.oauth.profile} OAuth profile.`);
  }
  // NanoClaw's pinned OneCLI cannot refresh this record on its own; see
  // .claude/skills/add-opencode/ONECLI-LEGACY.md for the manual procedure.
  return JSON.stringify({
    tokens: {
      access_token: value.accessToken,
      refresh_token: value.refreshToken,
      account_id: value.accountId,
    },
    OPENAI_API_KEY: null,
    last_refresh: new Date().toISOString(),
  });
}
