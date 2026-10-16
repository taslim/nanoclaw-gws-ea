/**
 * The host's read path into the assistant's own 1Password vault (KTD5). It
 * uses only what provisioning recorded for this assistant: the host policy
 * names the account, this instance's resource record names the one vault it
 * may use, and the runtime token beside it is scoped to that vault. Login
 * metadata is listed once per binding and kept until an explicit refresh
 * (KTD11); a secret is resolved only at fill time. Item IDs, vault IDs,
 * tokens and values stay in this module: callers see opaque handles, titles
 * and constant reasons.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Client, ItemOverview, Website } from '@1password/sdk';
import { getDomain } from 'tldts';
import { readEnvFile } from '../../env.js';
import { instanceMarkerFile } from '../../gws-ea/paths.js';
import { readInstanceMarkerFile } from '../../gws-ea/registry.js';
import { instanceLayout } from '../../gws-ea/release-layout.js';
import { GwsEaError } from '../../gws-ea/types.js';
import { httpsOrigin, type BrowserSecretField } from './authentication-signatures.js';
import {
  ONEPASSWORD_POLICY_FILE_ENV,
  onePasswordInstancePaths,
  readOnePasswordHostPolicy,
  readOnePasswordResources,
  readOnePasswordToken,
} from './onepassword-policy.js';
import { browserPaths } from './paths.js';
import { browserPolicyFile } from './policy.js';

export type BrowserVaultReason = 'vault_unavailable' | 'rate_limited' | 'no_item_for_site' | 'origin_mismatch';
export class BrowserVaultError extends Error {
  constructor(readonly reason: BrowserVaultReason) {
    super(reason);
  }
}

export interface BrowserVaultItem {
  title: string;
  item_handle: string;
}

/** Where the host finds its records. Each defaults to its host locator, re-read for every use. */
export interface BrowserVaultLocators {
  /** This assistant's browser policy, always `<instance root>/browser/policy.json`; it locates the instance root. */
  readonly browserPolicyFile?: string;
  /** The operator's 1Password host policy. */
  readonly onePasswordPolicyFile?: string;
}

/** The host-process locator of the 1Password host policy, read like the voice and browser policy locators. */
function onePasswordPolicyFile(): string | undefined {
  return (
    process.env[ONEPASSWORD_POLICY_FILE_ENV]?.trim() ||
    readEnvFile([ONEPASSWORD_POLICY_FILE_ENV])[ONEPASSWORD_POLICY_FILE_ENV]?.trim() ||
    undefined
  );
}

/**
 * Why the vault cannot be used: 1Password is not enabled on this host; this
 * assistant's vault, runtime account or token is not provisioned yet; or a
 * record is unsafe, malformed, or names another instance or account.
 */
export type BrowserVaultUnavailableReason = 'not_enabled' | 'not_provisioned' | 'invalid_state';

/** The provisioned identifiers the vault is bound to; host-only, and never a token. */
export interface BrowserVaultBinding {
  readonly instanceId: string;
  readonly accountId: string;
  readonly vaultId: string;
  readonly runtimeServiceAccountId: string;
}

export type BrowserVaultAvailability =
  | { readonly status: 'available'; readonly binding: BrowserVaultBinding }
  | { readonly status: 'unavailable'; readonly reason: BrowserVaultUnavailableReason };

type RuntimeAccess =
  | { readonly status: 'available'; readonly binding: BrowserVaultBinding; readonly token: string }
  | Extract<BrowserVaultAvailability, { status: 'unavailable' }>;

const unavailable = (reason: BrowserVaultUnavailableReason): RuntimeAccess => ({ status: 'unavailable', reason });

/** The instance root a browser policy path names, only where provisioning puts that policy. */
function instanceRootOf(policyFile: string): string | undefined {
  if (!path.isAbsolute(policyFile) || path.normalize(policyFile) !== policyFile) return undefined;
  const { root } = browserPaths(policyFile);
  return path.basename(policyFile) === 'policy.json' && path.basename(root) === 'browser'
    ? path.dirname(root)
    : undefined;
}

/**
 * Local reads only: the host policy, then this instance (named by the marker
 * in its own state) and the resource record for exactly that instance and the
 * policy's account, then its owner-only runtime token.
 */
async function readRuntimeAccess(locators: BrowserVaultLocators): Promise<RuntimeAccess> {
  const policyFile = locators.onePasswordPolicyFile ?? onePasswordPolicyFile();
  if (!policyFile) return unavailable('not_enabled');
  const host = await readOnePasswordHostPolicy(policyFile);
  if (host.status !== 'ready') return unavailable(host.status === 'absent' ? 'not_enabled' : 'invalid_state');
  const located = locators.browserPolicyFile ?? browserPolicyFile();
  const instanceRoot = located ? instanceRootOf(located) : undefined;
  if (!instanceRoot) return unavailable('invalid_state');
  let instanceId: string;
  try {
    instanceId = (await readInstanceMarkerFile(instanceMarkerFile(instanceLayout(instanceRoot).state))).instance_id;
  } catch (error) {
    if (error instanceof GwsEaError) return unavailable('invalid_state');
    throw error;
  }
  const files = onePasswordInstancePaths(instanceRoot);
  const record = await readOnePasswordResources(files.resourceFile, { instanceId, accountId: host.policy.accountId });
  if (record.status !== 'ready') return unavailable(record.status === 'absent' ? 'not_provisioned' : 'invalid_state');
  const { resources } = record;
  if (resources.runtimeServiceAccountId === null) return unavailable('not_provisioned');
  const token = await readOnePasswordToken(files.runtimeTokenFile);
  if (token.status !== 'ready') return unavailable(token.status === 'absent' ? 'not_provisioned' : 'invalid_state');
  return {
    status: 'available',
    binding: {
      instanceId,
      accountId: resources.accountId,
      vaultId: resources.vault.id,
      runtimeServiceAccountId: resources.runtimeServiceAccountId,
    },
    token: token.token,
  };
}

/** The full selected origin is bound separately; this applies the item's autofill policy. */
export function websitePermitsOrigin(
  website: Pick<Website, 'url'> & { autofillBehavior: string },
  raw: string,
): boolean {
  const target = httpsOrigin(raw);
  const source = httpsOrigin(website.url);
  if (!target || !source) return false;
  switch (website.autofillBehavior) {
    case 'ExactDomain':
      return source.origin === target.origin;
    case 'AnywhereOnWebsite': {
      const domain = getDomain(source.hostname, { allowPrivateDomains: true });
      return Boolean(domain && domain === getDomain(target.hostname, { allowPrivateDomains: true }));
    }
    default:
      return false;
  }
}

// Dynamic import also defers sdk-core's WASM instantiation. The module loader compiles it once.
let sdkModule: Promise<typeof import('@1password/sdk')> | undefined;
const sdk = (): Promise<typeof import('@1password/sdk')> => (sdkModule ??= import('@1password/sdk'));
const RATE_LIMIT_BACKOFF_MS = 60_000;
const ITEM_ID = /^[a-z\d_-]+$/iu;
const active = async (): Promise<void> => undefined;

/** Only list overviews and resolve a selected field: this runtime never reads an item's value-bearing object. */
export class BrowserVault {
  private client: Promise<Client> | undefined;
  private token: string | undefined;
  private vaultId: string | undefined;
  private handles = new Map<string, ItemOverview>();
  private loaded = false;
  /** Advances whenever the binding resets, so a listing begun under another binding is never kept. */
  private epoch = 0;
  private rateLimitedUntil = 0;
  private loading: Promise<void> | undefined;

  constructor(private readonly locators: BrowserVaultLocators = {}) {}

  private reset(): void {
    this.epoch += 1;
    this.client = undefined;
    this.token = undefined;
    this.vaultId = undefined;
    this.handles.clear();
    this.loaded = false;
    this.loading = undefined;
  }

  /** Whether the provisioned resources are in place, from local records alone: it spends no provider request. */
  async availability(): Promise<BrowserVaultAvailability> {
    const access = await readRuntimeAccess(this.locators);
    return access.status === 'available' ? { status: 'available', binding: access.binding } : access;
  }

  private async error(error: unknown): Promise<BrowserVaultError> {
    if (error instanceof BrowserVaultError) return error;
    const { RateLimitExceededError } = await sdk();
    if (error instanceof RateLimitExceededError) {
      this.rateLimitedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
      return new BrowserVaultError('rate_limited');
    }
    return new BrowserVaultError('vault_unavailable');
  }

  private async ready(assertActive: () => Promise<void>): Promise<Client> {
    await assertActive();
    const access = await readRuntimeAccess(this.locators);
    if (access.status !== 'available') {
      this.reset();
      throw new BrowserVaultError('vault_unavailable');
    }
    const { token } = access;
    const { vaultId } = access.binding;
    if (this.token !== token || this.vaultId !== vaultId) {
      this.reset();
      this.token = token;
      this.vaultId = vaultId;
    }
    if (Date.now() < this.rateLimitedUntil) throw new BrowserVaultError('rate_limited');
    if (!this.client) {
      this.client = (async () => {
        const { createClient } = await sdk();
        await assertActive();
        const client = await createClient({
          auth: token,
          integrationName: 'GWS-EA host browser',
          integrationVersion: '1.0.0',
        });
        await assertActive();
        // The record pins the vault: one the token cannot reach is refused, and any other it can is never used.
        const vaults = await client.vaults.list();
        await assertActive();
        if (!vaults.some((vault) => vault.id === vaultId)) throw new BrowserVaultError('vault_unavailable');
        return client;
      })();
    }
    const pending = this.client;
    try {
      const client = await pending;
      await assertActive();
      return client;
    } catch (error) {
      if (this.client === pending) this.client = undefined;
      throw await this.error(error);
    }
  }

  private async load(client: Client, assertActive: () => Promise<void>): Promise<void> {
    if (Date.now() < this.rateLimitedUntil) throw new BrowserVaultError('rate_limited');
    const { epoch, vaultId } = this;
    const loading = (this.loading ??= (async () => {
      if (!vaultId) throw new BrowserVaultError('vault_unavailable');
      await assertActive();
      const items = await client.items.list(vaultId, {
        type: 'ByState',
        content: { active: true, archived: false },
      });
      await assertActive();
      if (epoch !== this.epoch) throw new BrowserVaultError('vault_unavailable');
      const overviews = items.filter(
        (item) =>
          item.category === 'Login' && item.state === 'active' && item.vaultId === vaultId && ITEM_ID.test(item.id),
      );
      const byId = new Map(overviews.map((item) => [item.id, item]));
      for (const [handle, previous] of this.handles) {
        const current = byId.get(previous.id);
        if (current) this.handles.set(handle, current);
        else this.handles.delete(handle);
      }
      const retainedIds = new Set([...this.handles.values()].map((item) => item.id));
      for (const item of overviews)
        if (!retainedIds.has(item.id)) {
          this.handles.set(`vault_${randomUUID()}`, item);
          retainedIds.add(item.id);
        }
      this.loaded = true;
    })());
    try {
      await loading;
    } catch (error) {
      throw await this.error(error);
    } finally {
      if (this.loading === loading) this.loading = undefined;
    }
  }

  /** Listings come from the cache; only the first use under a binding, or `refresh`, lists the vault. */
  async itemsForOrigin(raw: string, assertActive = active): Promise<BrowserVaultItem[]> {
    if (!httpsOrigin(raw)) return [];
    const client = await this.ready(assertActive);
    if (!this.loaded) await this.load(client, assertActive);
    return [...this.handles]
      .filter(([, item]) => item.websites.some((site) => websitePermitsOrigin(site, raw)))
      .map(([item_handle, item]) => ({
        item_handle,
        title: item.title.replace(/\p{Cc}/gu, ' ').slice(0, 200),
      }));
  }

  /**
   * An explicit retry (AE6): list the vault's logins again now, bypassing the
   * cache, so a login the principal just added is usable. Handles of logins
   * still listed stay valid. A rate-limit backoff still holds.
   */
  async refresh(assertActive = active): Promise<void> {
    await this.load(await this.ready(assertActive), assertActive);
  }

  /** A host-only lazy resolver; callers must bind and recheck the exact frame origin around this call. */
  async resolve(handle: string, field: BrowserSecretField, origin: string, assertActive = active): Promise<string> {
    if (!httpsOrigin(origin)) throw new BrowserVaultError('origin_mismatch');
    const client = await this.ready(assertActive);
    if (!this.loaded) await this.load(client, assertActive);
    const item = this.handles.get(handle);
    if (!item) throw new BrowserVaultError('no_item_for_site');
    if (!item.websites.some((site) => websitePermitsOrigin(site, origin)))
      throw new BrowserVaultError('origin_mismatch');
    const name = field === 'otp' ? 'one-time password?attribute=otp' : field;
    try {
      await assertActive();
      const value = await client.secrets.resolve(`op://${item.vaultId}/${item.id}/${name}`);
      await assertActive();
      if (!value) throw new BrowserVaultError('no_item_for_site');
      return value;
    } catch (error) {
      throw await this.error(error);
    }
  }
}

export const browserVault = new BrowserVault();
