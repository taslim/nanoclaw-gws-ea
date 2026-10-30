/**
 * The host's path into the assistant's own 1Password vault. It uses only what provisioning recorded for this
 * assistant: the host policy names the account, this instance's resource record names the one vault it may use, and
 * the runtime token beside it is scoped to that vault. Login metadata is listed once per binding and kept until an
 * explicit refresh or a write that changes what is listed; usernames are read lazily without retaining passwords.
 * A selected secret is resolved only at fill time. The host-private
 * writes behind credential attempts read and save whole items here, in host memory only, and delete a candidate
 * once its operation no longer needs it. Item IDs, vault IDs, tokens and values stay on the host: agents see opaque
 * handles, titles and constant reasons.
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
import { httpsOrigin, onePasswordWebsiteOrigin, type BrowserSecretField } from './authentication-signatures.js';
import {
  isNormalizedAbsolute,
  ONEPASSWORD_POLICY_FILE_ENV,
  onePasswordInstancePaths,
  readOnePasswordHostPolicy,
  readOnePasswordResources,
  readOnePasswordToken,
} from './onepassword-policy.js';
import { browserRoot } from './availability.js';

export type BrowserVaultReason =
  | 'vault_not_set_up'
  | 'vault_unavailable'
  | 'rate_limited'
  | 'no_item_for_site'
  | 'origin_mismatch';
export class BrowserVaultError extends Error {
  constructor(readonly reason: BrowserVaultReason) {
    super(reason);
  }
}

export function vaultFailureStatus(
  error: BrowserVaultError,
): 'rate_limited' | 'vault_not_set_up' | 'vault_unavailable' {
  return error.reason === 'rate_limited' || error.reason === 'vault_not_set_up' ? error.reason : 'vault_unavailable';
}

export interface BrowserVaultItem {
  title: string;
  item_handle: string;
}

/** Host-only metadata, with no password or other credential values. */
export interface BrowserVaultLogin {
  readonly username: string | undefined;
  readonly websites: readonly Website[];
}

/** Each defaults to its host locator, re-read for every use. */
export interface BrowserVaultLocators {
  /** This assistant's browser policy, always `<instance root>/browser`; it locates the instance root. */
  readonly browserRoot?: string;
  readonly onePasswordPolicyFile?: string;
}

export function onePasswordPolicyFile(): string | undefined {
  return (
    process.env[ONEPASSWORD_POLICY_FILE_ENV]?.trim() ||
    readEnvFile([ONEPASSWORD_POLICY_FILE_ENV])[ONEPASSWORD_POLICY_FILE_ENV]?.trim() ||
    undefined
  );
}

/**
 * Why the vault cannot be used: 1Password is not enabled on this host, or the operator disabled it; this
 * assistant's vault, runtime account or token is not provisioned yet; or a record is unsafe, malformed, or names
 * another instance or account.
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
function instanceRootOf(root: string): string | undefined {
  return isNormalizedAbsolute(root) && path.basename(root) === 'browser' ? path.dirname(root) : undefined;
}

/**
 * Local reads only. The instance is the one the marker in its own state names, and its resource record must match
 * both that instance and the policy's account.
 */
async function readRuntimeAccess(locators: BrowserVaultLocators): Promise<RuntimeAccess> {
  const policyFile = locators.onePasswordPolicyFile ?? onePasswordPolicyFile();
  if (!policyFile) return unavailable('not_enabled');
  const host = await readOnePasswordHostPolicy(policyFile);
  if (host.status !== 'ready') return unavailable(host.status === 'absent' ? 'not_enabled' : 'invalid_state');
  // The operator's published disable stops every use, however far a job got.
  if (!host.policy.enabled) return unavailable('disabled');
  const located = locators.browserRoot ?? browserRoot();
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
  const source = onePasswordWebsiteOrigin(website.url);
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

export function registrableDomain(raw: string): string | undefined {
  const url = httpsOrigin(raw);
  return (url && getDomain(url.hostname, { allowPrivateDomains: true })) || undefined;
}

/** A saved website field accepts a missing scheme; callers' page origins remain strict HTTPS. */
export function websiteDomain(raw: string): string | undefined {
  const url = onePasswordWebsiteOrigin(raw);
  return (url && getDomain(url.hostname, { allowPrivateDomains: true })) || undefined;
}

/**
 * Every candidate the host saves carries its own operation's tag until it is published: a lost create response is
 * found by that exact marker, and no ordinary suggestion lists a candidate. 1Password nests these tags under one
 * "gws-ea-pending" tag.
 */
const CANDIDATE_TAG = 'gws-ea-pending';
export const credentialCandidateTag = (operationId: string): string => `${CANDIDATE_TAG}/${operationId}`;
// An overview or item without a tag list counts as untagged.
const isCandidateTag = (tag: string): boolean => tag === CANDIDATE_TAG || tag.startsWith(`${CANDIDATE_TAG}/`);
const pendingCandidate = (tags: readonly string[] | undefined): boolean => (tags ?? []).some(isCandidateTag);

/** A rotation candidate's own section: its account, and the password it replaces while the change is open. */
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
  readonly password: string | undefined;
  /** The password a rotation candidate replaces, until the change no longer needs it. */
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
    domains: [...new Set(item.websites.flatMap((site) => websiteDomain(site.url) ?? []))],
  };
  readItems.set(read, item);
  return read;
}

// Dynamic import also defers sdk-core's WASM instantiation. The module loader compiles it once.
let sdkModule: Promise<typeof import('@1password/sdk')> | undefined;
const sdk = (): Promise<typeof import('@1password/sdk')> => (sdkModule ??= import('@1password/sdk'));
const RATE_LIMIT_BACKOFF_MS = 60_000;
/** The first hold after a failure to reach or list the vault; each consecutive failure doubles it, up to the cap. */
const UNAVAILABLE_BACKOFF_MS = 60_000;
const UNAVAILABLE_BACKOFF_MAX_MS = 60 * 60_000;
const ITEM_ID = /^[a-z\d_-]+$/iu;
/** The default activity check: a caller without a cancellable job is always active. */
export const active = async (): Promise<void> => undefined;

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
 * Lists overviews, caches Login metadata and resolves a selected field for
 * fills. Fresh item reads and writes serve credential attempts, and their
 * values stay here.
 */
export class BrowserVault {
  private client: Promise<Client> | undefined;
  private token: string | undefined;
  private vaultId: string | undefined;
  private handles = new Map<string, ItemOverview>();
  private usernames = new Map<string, { readonly updatedAt: number; readonly login: BrowserVaultLogin }>();
  private loaded = false;
  /** Advances whenever the binding resets, so a listing begun under another binding is never kept. */
  private epoch = 0;
  /** Advances when a write changes what is listed, so a listing begun before it never marks the cache current. */
  private generation = 0;
  private rateLimitedUntil = 0;
  /** Consecutive failures to reach or list the vault, and the hold the last one set. */
  private failures = 0;
  private unavailableUntil = 0;
  private loading: Promise<void> | undefined;

  constructor(private readonly locators: BrowserVaultLocators = {}) {}

  private reset(): void {
    this.epoch += 1;
    this.client = undefined;
    this.token = undefined;
    this.vaultId = undefined;
    this.handles.clear();
    this.usernames.clear();
    this.loaded = false;
    this.loading = undefined;
    this.clearHold();
  }

  /** The vault answered, the binding changed, or an explicit refresh retries: no failure holds the next attempt off. */
  private clearHold(): void {
    this.failures = 0;
    this.unavailableUntil = 0;
  }

  /** Refuses while a hold lasts: the provider's own rate limit, or the backoff after the vault could not be reached. */
  private refuseWhileHeld(): void {
    if (Date.now() < this.rateLimitedUntil) throw new BrowserVaultError('rate_limited');
    if (Date.now() < this.unavailableUntil) throw new BrowserVaultError('vault_unavailable');
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

  /**
   * A request that reaches or lists the vault under the binding of `epoch`. While these keep failing for any reason
   * but the rate limit, each failure holds every use off twice as long as the last, from a minute up to an hour:
   * page observations would otherwise spend, on a vault that stays unreachable, the daily request limit every
   * service account in the account shares.
   */
  private async reach<T>(epoch: number, request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      const failure = await this.error(error);
      if (failure.reason === 'vault_unavailable' && epoch === this.epoch) {
        this.unavailableUntil =
          Date.now() + Math.min(UNAVAILABLE_BACKOFF_MS * 2 ** this.failures, UNAVAILABLE_BACKOFF_MAX_MS);
        this.failures += 1;
      }
      throw failure;
    }
  }

  private async ready(assertActive: () => Promise<void>): Promise<Client> {
    await assertActive();
    const access = await readRuntimeAccess(this.locators);
    if (access.status !== 'available') {
      this.reset();
      throw new BrowserVaultError('vault_not_set_up');
    }
    const { token } = access;
    const { vaultId } = access.binding;
    if (this.token !== token || this.vaultId !== vaultId) {
      this.reset();
      this.token = token;
      this.vaultId = vaultId;
    }
    this.refuseWhileHeld();
    if (!this.client) {
      const { epoch } = this;
      this.client = (async () => {
        const { createClient } = await sdk();
        await assertActive();
        const client = await this.reach(epoch, () =>
          createClient({
            auth: token,
            integrationName: 'GWS-EA host browser',
            integrationVersion: '1.0.0',
          }),
        );
        await assertActive();
        // The record pins the vault: one the token cannot reach is refused, and any other it can is never used.
        await this.reach(epoch, async () => {
          const vaults = await client.vaults.list();
          if (!vaults.some((vault) => vault.id === vaultId)) throw new BrowserVaultError('vault_unavailable');
        });
        if (epoch === this.epoch) this.clearHold();
        await assertActive();
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
    this.refuseWhileHeld();
    const { epoch, vaultId, generation } = this;
    const loading = (this.loading ??= (async () => {
      if (!vaultId) throw new BrowserVaultError('vault_unavailable');
      await assertActive();
      const items = await this.reach(epoch, () =>
        client.items.list(vaultId, {
          type: 'ByState',
          content: { active: true, archived: false },
        }),
      );
      await assertActive();
      if (epoch !== this.epoch) throw new BrowserVaultError('vault_unavailable');
      this.clearHold();
      const overviews = items.filter(
        (item) =>
          item.category === 'Login' &&
          item.state === 'active' &&
          item.vaultId === vaultId &&
          ITEM_ID.test(item.id) &&
          !pendingCandidate(item.tags),
      );
      const byId = new Map(overviews.map((item) => [item.id, item]));
      for (const [id, cached] of this.usernames)
        if (byId.get(id)?.updatedAt.getTime() !== cached.updatedAt) this.usernames.delete(id);
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

  /** Listings come from the cache until a reset, `invalidate` or `refresh` has the vault listed again. */
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
   * An explicit retry: list the vault's logins again now, bypassing the cache, so a login the principal just added
   * is usable. Handles of logins still listed stay valid. It skips the hold after a failure to reach the vault, so
   * one the principal just shared again is tried at once; a rate-limit backoff still holds, because that limit is
   * the provider's own.
   */
  async refresh(assertActive = active): Promise<void> {
    this.clearHold();
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

  /**
   * Read a Login's username only when needed, then retain just its username
   * and websites until the listing reports another updatedAt. Full items,
   * including their passwords, are never held in this cache.
   */
  async loginForHandle(handle: string, origin: string, assertActive = active): Promise<BrowserVaultLogin> {
    const { client, item: overview } = await this.listed(handle, origin, assertActive);
    const cached = this.usernames.get(overview.id);
    if (cached?.updatedAt === overview.updatedAt.getTime()) return cached.login;
    try {
      const item = await client.items.get(overview.vaultId, overview.id);
      await assertActive();
      if (item.id !== overview.id || item.vaultId !== overview.vaultId || item.category !== 'Login')
        throw new BrowserVaultError('no_item_for_site');
      const login: BrowserVaultLogin = {
        username: fieldValue(item, 'username', undefined, false),
        websites: item.websites.map((site) => ({ ...site })),
      };
      // A read racing with an edit can answer this call, but cannot bless the
      // old overview with the new version's metadata.
      if (item.updatedAt.getTime() === overview.updatedAt.getTime())
        this.usernames.set(item.id, { updatedAt: item.updatedAt.getTime(), login });
      return login;
    } catch (error) {
      throw await this.error(error);
    }
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

  /** The IDs of the bound vault's active items: one listing, which never feeds the cache. */
  private async activeItemIds(
    vaultId: string,
    keep: (item: ItemOverview) => boolean,
    assertActive: () => Promise<void>,
  ): Promise<string[]> {
    const client = await this.bound(vaultId, assertActive);
    try {
      const items = await client.items.list(vaultId, { type: 'ByState', content: { active: true, archived: false } });
      await assertActive();
      return items
        .filter((item) => item.vaultId === vaultId && item.state === 'active' && ITEM_ID.test(item.id) && keep(item))
        .map((item) => item.id);
    } catch (error) {
      throw await this.error(error);
    }
  }

  /** The active items that carry exactly one operation's marker. */
  findCandidates(vaultId: string, operationId: string, assertActive = active): Promise<string[]> {
    const marker = credentialCandidateTag(operationId);
    return this.activeItemIds(vaultId, (item) => (item.tags ?? []).includes(marker), assertActive);
  }

  /** Whether the bound vault still lists an item as active; a deleted or archived item is not. */
  async holds(vaultId: string, itemId: string, assertActive = active): Promise<boolean> {
    return (await this.activeItemIds(vaultId, (item) => item.id === itemId, assertActive)).length > 0;
  }

  /**
   * `beforeCreate` runs once the binding is ready and the request is about to be issued, so the caller records that
   * a write may happen; a failure after it leaves the outcome unknown. The created item is returned without another
   * liveness check, so the caller can record it first.
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
   * Writes a new built-in password into exactly the item a fresh read returned, keeping every other field, section,
   * tag, website and note. The read's version goes with it, so the provider can refuse a stale write.
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

  /**
   * A rotation candidate without the password it replaced: it then holds only the new password, for a change the
   * original Login could not take.
   */
  async forgetPreviousPassword(read: VaultItemRead, assertActive = active): Promise<VaultItemRead> {
    const item = readItems.get(read);
    if (!item || read.category !== 'password') throw new BrowserVaultError('vault_unavailable');
    const fields = item.fields.filter(
      (field) => !(field.id === 'previous-password' && field.sectionId === CHANGE_SECTION),
    );
    return this.put({ ...item, fields }, assertActive);
  }

  /** Deletes a candidate the host no longer needs. */
  async deleteItem(vaultId: string, itemId: string, assertActive = active): Promise<void> {
    if (!ITEM_ID.test(itemId)) throw new BrowserVaultError('vault_unavailable');
    const client = await this.bound(vaultId, assertActive);
    try {
      await client.items.delete(vaultId, itemId);
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
    throw new BrowserVaultError(access.status === 'unavailable' ? 'vault_not_set_up' : 'vault_unavailable');
  }
}

export const browserVault = new BrowserVault();
