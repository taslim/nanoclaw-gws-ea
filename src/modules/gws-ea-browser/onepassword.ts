/**
 * The host's path into the assistant's own 1Password vault (KTD5). It uses
 * only what provisioning recorded for this assistant: the host policy names
 * the account, this instance's resource record names the one vault it may
 * use, and the runtime token beside it is scoped to that vault. Login
 * metadata is listed once per binding and kept until an explicit refresh or a
 * write that changes what is listed (KTD11); a secret is resolved only at
 * fill time. The host-private writes behind credential attempts (KTD6) read
 * and save whole items here, in host memory only. Item IDs, vault IDs, tokens
 * and values stay on the host: agents see opaque handles, titles and constant
 * reasons.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Client, Item, ItemCreateParams, ItemField, ItemOverview, Website } from '@1password/sdk';
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
export function onePasswordPolicyFile(): string | undefined {
  return (
    process.env[ONEPASSWORD_POLICY_FILE_ENV]?.trim() ||
    readEnvFile([ONEPASSWORD_POLICY_FILE_ENV])[ONEPASSWORD_POLICY_FILE_ENV]?.trim() ||
    undefined
  );
}

/**
 * Why the vault cannot be used: 1Password is not enabled on this host, or the
 * operator disabled it; this assistant's vault, runtime account or token is
 * not provisioned yet; or a record is unsafe, malformed, or names another
 * instance or account.
 */
export type BrowserVaultUnavailableReason = 'not_enabled' | 'disabled' | 'not_provisioned' | 'invalid_state';

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
  // The operator's published disable stops every use, however far a job got.
  if (!host.policy.enabled) return unavailable('disabled');
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

/** The registrable domain of an HTTPS URL, as autofill matches sites; undefined for anything else. */
export function registrableDomain(raw: string): string | undefined {
  const url = httpsOrigin(raw);
  return (url && getDomain(url.hostname, { allowPrivateDomains: true })) || undefined;
}

/**
 * Every candidate the host saves carries its own operation's tag until it is
 * published: a lost create response is found by that exact marker, and no
 * ordinary suggestion lists a candidate. 1Password nests these tags under
 * one "gws-ea-pending" tag.
 */
const CANDIDATE_TAG = 'gws-ea-pending';
export const credentialCandidateTag = (operationId: string): string => `${CANDIDATE_TAG}/${operationId}`;
// An overview or item without a tag list counts as untagged.
const isCandidateTag = (tag: string): boolean => tag === CANDIDATE_TAG || tag.startsWith(`${CANDIDATE_TAG}/`);
const pendingCandidate = (tags: readonly string[] | undefined): boolean => (tags ?? []).some(isCandidateTag);

/** A rotation candidate's own section: the account it belongs to, and the password it replaces. */
const CHANGE_SECTION = 'gws-ea-password-change';

/** One fresh read of an item, in host memory only: none of its values leave the host. */
export interface VaultItemRead {
  readonly itemId: string;
  readonly vaultId: string;
  readonly category: 'login' | 'password' | 'other';
  readonly version: number;
  readonly tags: readonly string[];
  /** Still tagged as a host candidate, so ordinary suggestions leave it out. */
  readonly pending: boolean;
  /** A Login's built-in username, or the account a rotation candidate belongs to. */
  readonly username: string | undefined;
  /** The built-in password. */
  readonly password: string | undefined;
  /** The password a rotation candidate replaces. */
  readonly previousPassword: string | undefined;
  /** The registrable domains of the item's HTTPS websites. */
  readonly domains: readonly string[];
}

/** A signup saves a pending Login; a password change saves a separate Password item beside the Login. */
export type VaultCandidateSpec = {
  readonly vaultId: string;
  readonly operationId: string;
  readonly site: string;
  readonly username: string;
  readonly password: string;
} & (
  | { readonly kind: 'signup'; readonly origin: string }
  | { readonly kind: 'rotation'; readonly previousPassword: string }
);

/** Each read keeps the item it came from, so an update writes back exactly what was checked. */
const readItems = new WeakMap<VaultItemRead, Item>();

/** The one value of a field: built in when `section` is undefined, else in that section. */
function fieldValue(item: Item, id: string, section: string | undefined, concealed: boolean): string | undefined {
  const matches = item.fields.filter(
    (field) => field.id === id && (section === undefined ? !field.sectionId : field.sectionId === section),
  );
  if (matches.length !== 1 || (concealed && matches[0].fieldType !== 'Concealed')) return undefined;
  return matches[0].value || undefined;
}

function remember(item: Item): VaultItemRead {
  const login = item.category === 'Login';
  const read: VaultItemRead = {
    itemId: item.id,
    vaultId: item.vaultId,
    category: login ? 'login' : item.category === 'Password' ? 'password' : 'other',
    version: item.version,
    tags: [...(item.tags ?? [])],
    pending: pendingCandidate(item.tags),
    username: login
      ? fieldValue(item, 'username', undefined, false)
      : fieldValue(item, 'account', CHANGE_SECTION, false),
    password: fieldValue(item, 'password', undefined, true),
    previousPassword: login ? undefined : fieldValue(item, 'previous-password', CHANGE_SECTION, true),
    domains: [...new Set(item.websites.flatMap((site) => registrableDomain(site.url) ?? []))],
  };
  readItems.set(read, item);
  return read;
}

// Dynamic import also defers sdk-core's WASM instantiation. The module loader compiles it once.
let sdkModule: Promise<typeof import('@1password/sdk')> | undefined;
const sdk = (): Promise<typeof import('@1password/sdk')> => (sdkModule ??= import('@1password/sdk'));
const RATE_LIMIT_BACKOFF_MS = 60_000;
const ITEM_ID = /^[a-z\d_-]+$/iu;
const active = async (): Promise<void> => undefined;

/** 1Password's own generator, run in this process: it spends no provider request, and its result stays in memory. */
export async function generateCandidatePassword(): Promise<string> {
  const { Secrets } = await sdk();
  return Secrets.generatePassword({
    type: 'Random',
    parameters: { includeDigits: true, includeSymbols: true, length: 20 },
  }).password;
}

async function candidateParams(spec: VaultCandidateSpec): Promise<ItemCreateParams> {
  const { AutofillBehavior, ItemCategory, ItemFieldType } = await sdk();
  const tags = [credentialCandidateTag(spec.operationId)];
  const password: ItemField = {
    id: 'password',
    title: 'password',
    fieldType: ItemFieldType.Concealed,
    value: spec.password,
  };
  if (spec.kind === 'signup')
    return {
      category: ItemCategory.Login,
      vaultId: spec.vaultId,
      title: spec.site,
      tags,
      fields: [{ id: 'username', title: 'username', fieldType: ItemFieldType.Text, value: spec.username }, password],
      websites: [{ url: spec.origin, label: 'website', autofillBehavior: AutofillBehavior.AnywhereOnWebsite }],
    };
  // No website: 1Password never offers the candidate in place of the Login it may replace.
  return {
    category: ItemCategory.Password,
    vaultId: spec.vaultId,
    title: `New password for ${spec.site}`,
    tags,
    sections: [{ id: CHANGE_SECTION, title: 'Password change' }],
    fields: [
      password,
      {
        id: 'account',
        title: 'username',
        sectionId: CHANGE_SECTION,
        fieldType: ItemFieldType.Text,
        value: spec.username,
      },
      {
        id: 'previous-password',
        title: 'previous password',
        sectionId: CHANGE_SECTION,
        fieldType: ItemFieldType.Concealed,
        value: spec.previousPassword,
      },
    ],
  };
}

/**
 * Lists overviews and resolves a selected field for fills; fresh item reads
 * and writes serve credential attempts alone, and their values stay here.
 */
export class BrowserVault {
  private client: Promise<Client> | undefined;
  private token: string | undefined;
  private vaultId: string | undefined;
  private handles = new Map<string, ItemOverview>();
  private loaded = false;
  /** Advances whenever the binding resets, so a listing begun under another binding is never kept. */
  private epoch = 0;
  /** Advances when a write changes what is listed, so a listing begun before it never marks the cache current. */
  private generation = 0;
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

  /** Every fresh read and write stays in the vault the provisioned record names. */
  private async bound(vaultId: string, assertActive: () => Promise<void>): Promise<Client> {
    const client = await this.ready(assertActive);
    if (vaultId !== this.vaultId) throw new BrowserVaultError('vault_unavailable');
    return client;
  }

  /** The next listing lists the vault again: a write changed what ordinary suggestions show. */
  private invalidate(): void {
    this.generation += 1;
    this.loaded = false;
  }

  private async load(client: Client, assertActive: () => Promise<void>): Promise<void> {
    if (Date.now() < this.rateLimitedUntil) throw new BrowserVaultError('rate_limited');
    const { epoch, vaultId, generation } = this;
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
          item.category === 'Login' &&
          item.state === 'active' &&
          item.vaultId === vaultId &&
          ITEM_ID.test(item.id) &&
          !pendingCandidate(item.tags),
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
      if (generation === this.generation) this.loaded = true;
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

  /** The listed Login a handle names, once the selected origin is one its websites permit. */
  private async listed(
    handle: string,
    origin: string,
    assertActive: () => Promise<void>,
  ): Promise<{ client: Client; item: ItemOverview }> {
    if (!httpsOrigin(origin)) throw new BrowserVaultError('origin_mismatch');
    const client = await this.ready(assertActive);
    if (!this.loaded) await this.load(client, assertActive);
    const item = this.handles.get(handle);
    if (!item) throw new BrowserVaultError('no_item_for_site');
    if (!item.websites.some((site) => websitePermitsOrigin(site, origin)))
      throw new BrowserVaultError('origin_mismatch');
    return { client, item };
  }

  /** Host-only: the vault item behind a listed handle, under the same origin check a fill applies. */
  async itemForHandle(
    handle: string,
    origin: string,
    assertActive = active,
  ): Promise<{ readonly vaultId: string; readonly itemId: string }> {
    const { item } = await this.listed(handle, origin, assertActive);
    return { vaultId: item.vaultId, itemId: item.id };
  }

  /** One fresh read of an item in the bound vault: one request, never cached. */
  async readItem(vaultId: string, itemId: string, assertActive = active): Promise<VaultItemRead> {
    if (!ITEM_ID.test(itemId)) throw new BrowserVaultError('vault_unavailable');
    const client = await this.bound(vaultId, assertActive);
    try {
      const item = await client.items.get(vaultId, itemId);
      await assertActive();
      if (item.id !== itemId || item.vaultId !== vaultId) throw new BrowserVaultError('vault_unavailable');
      return remember(item);
    } catch (error) {
      throw await this.error(error);
    }
  }

  /** The active items that carry exactly one operation's marker: one listing, which never feeds the cache. */
  async findCandidates(vaultId: string, operationId: string, assertActive = active): Promise<string[]> {
    const client = await this.bound(vaultId, assertActive);
    const marker = credentialCandidateTag(operationId);
    try {
      const items = await client.items.list(vaultId, { type: 'ByState', content: { active: true, archived: false } });
      await assertActive();
      return items
        .filter(
          (item) =>
            item.vaultId === vaultId &&
            item.state === 'active' &&
            ITEM_ID.test(item.id) &&
            (item.tags ?? []).includes(marker),
        )
        .map((item) => item.id);
    } catch (error) {
      throw await this.error(error);
    }
  }

  /**
   * Saves a candidate. `beforeCreate` runs once the binding is ready and the
   * request is about to be issued, so the caller records that a write may
   * happen; a failure after it leaves the outcome unknown. The created item is
   * returned without another liveness check, so the caller can record it first.
   */
  async createCandidate(
    spec: VaultCandidateSpec,
    beforeCreate: () => Promise<void>,
    assertActive = active,
  ): Promise<{ readonly itemId: string; readonly version: number }> {
    const client = await this.bound(spec.vaultId, assertActive);
    const params = await candidateParams(spec);
    await beforeCreate();
    try {
      const item = await client.items.create(params);
      if (item.vaultId !== spec.vaultId || !ITEM_ID.test(item.id)) throw new BrowserVaultError('vault_unavailable');
      return { itemId: item.id, version: item.version };
    } catch (error) {
      throw await this.error(error);
    }
  }

  /**
   * Writes a new built-in password into exactly the item a fresh read
   * returned, keeping every other field, section, tag, website and note. The
   * read's version goes with it, so the provider can refuse a stale write.
   */
  async replacePassword(read: VaultItemRead, password: string, assertActive = active): Promise<VaultItemRead> {
    const item = readItems.get(read);
    if (!item || read.password === undefined) throw new BrowserVaultError('vault_unavailable');
    const fields = item.fields.map((field) =>
      field.id === 'password' && !field.sectionId ? { ...field, value: password } : field,
    );
    return this.put({ ...item, fields }, assertActive);
  }

  /** Publishes a signup candidate as an ordinary Login: its pending tags go, and the next listing shows it. */
  async publishCandidate(read: VaultItemRead, assertActive = active): Promise<VaultItemRead> {
    const item = readItems.get(read);
    if (!item) throw new BrowserVaultError('vault_unavailable');
    try {
      return await this.put({ ...item, tags: (item.tags ?? []).filter((tag) => !isCandidateTag(tag)) }, assertActive);
    } finally {
      // Even a failed request may have published it.
      this.invalidate();
    }
  }

  /** Retires a candidate the host no longer needs; the principal can still restore it from the archive. */
  async archiveItem(vaultId: string, itemId: string, assertActive = active): Promise<void> {
    if (!ITEM_ID.test(itemId)) throw new BrowserVaultError('vault_unavailable');
    const client = await this.bound(vaultId, assertActive);
    try {
      await client.items.archive(vaultId, itemId);
    } catch (error) {
      throw await this.error(error);
    }
  }

  private async put(next: Item, assertActive: () => Promise<void>): Promise<VaultItemRead> {
    const client = await this.bound(next.vaultId, assertActive);
    try {
      const saved = await client.items.put(next);
      if (saved.id !== next.id || saved.vaultId !== next.vaultId) throw new BrowserVaultError('vault_unavailable');
      return remember(saved);
    } catch (error) {
      throw await this.error(error);
    }
  }

  /** A host-only lazy resolver; callers must bind and recheck the exact frame origin around this call. */
  async resolve(handle: string, field: BrowserSecretField, origin: string, assertActive = active): Promise<string> {
    const { client, item } = await this.listed(handle, origin, assertActive);
    const name = field === 'otp' ? 'one-time password?attribute=otp' : field;
    let value: string;
    try {
      await assertActive();
      value = await client.secrets.resolve(`op://${item.vaultId}/${item.id}/${name}`);
      await assertActive();
    } catch (error) {
      throw await this.error(error);
    }
    if (!value) throw new BrowserVaultError('no_item_for_site');
    // A disable or rebinding published while 1Password answered keeps the value out of the page.
    await this.stillBound(item.vaultId);
    return value;
  }

  /** The binding still holds, from local records alone: otherwise it resets and the use is refused. */
  private async stillBound(vaultId: string): Promise<void> {
    const access = await readRuntimeAccess(this.locators);
    if (access.status === 'available' && access.token === this.token && access.binding.vaultId === vaultId) return;
    this.reset();
    throw new BrowserVaultError('vault_unavailable');
  }
}

export const browserVault = new BrowserVault();
