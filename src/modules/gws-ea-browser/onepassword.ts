import { randomUUID } from 'node:crypto';
import type { Client, ItemOverview, Website } from '@1password/sdk';
import { getDomain } from 'tldts';
import { readPrivateFile } from './paths.js';
import { readBrowserPolicy } from './policy.js';

export type BrowserSecretField = 'username' | 'password' | 'otp';
export type BrowserVaultReason = 'vault_unavailable' | 'rate_limited' | 'no_item_for_site' | 'origin_mismatch';
export class BrowserVaultError extends Error {
  constructor(readonly reason: BrowserVaultReason) {
    super(reason);
  }
}

/** Playwright protocol logging can contain cookies, field reads and native keyboard payloads. */
export function browserDiagnosticsUnsafe(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (environment.PWDEBUG && environment.PWDEBUG !== '0') return true;
  return (environment.DEBUG ?? '').split(/[\s,]+/u).some((pattern) => {
    if (!pattern || pattern.startsWith('-')) return false;
    const wildcard = pattern.indexOf('*');
    if (wildcard === -1) return pattern === 'pw' || pattern.startsWith('pw:');
    const prefix = pattern.slice(0, wildcard);
    return 'pw:'.startsWith(prefix) || prefix.startsWith('pw:');
  });
}
export interface BrowserVaultItem {
  title: string;
  item_handle: string;
}

export function httpsOrigin(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password ? url : undefined;
  } catch (_error) {
    return undefined;
  }
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
const CACHE_MS = 300_000;
const REFRESH_INTERVAL_MS = 30_000;
const RATE_LIMIT_BACKOFF_MS = 60_000;
const active = async (): Promise<void> => undefined;

/** Only list overviews and resolve a selected field: this runtime never reads an item's value-bearing object. */
export class BrowserVault {
  private client: Promise<Client> | undefined;
  private token: string | undefined;
  private vaultId: string | undefined;
  private handles = new Map<string, ItemOverview>();
  private refreshedAt = -Infinity;
  private rateLimitedUntil = 0;
  private refreshing: Promise<void> | undefined;

  constructor(private readonly policyFile?: string) {}

  private reset(): void {
    this.client = undefined;
    this.token = undefined;
    this.vaultId = undefined;
    this.handles.clear();
    this.refreshedAt = -Infinity;
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
    const policy = await readBrowserPolicy(this.policyFile);
    if (!policy.enabled || policy.credentialMode !== '1password') {
      this.reset();
      throw new BrowserVaultError('vault_unavailable');
    }
    let token: string;
    try {
      token = (await readPrivateFile(policy.paths.tokenFile, 16 * 1024)).trim();
    } catch (_error) {
      this.reset();
      throw new BrowserVaultError('vault_unavailable');
    }
    if (!token) {
      this.reset();
      throw new BrowserVaultError('vault_unavailable');
    }
    if (this.token !== token) {
      this.reset();
      this.token = token;
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
        const vaults = await client.vaults.list();
        await assertActive();
        if (vaults.length !== 1 || !/^[a-z\d_-]+$/iu.test(vaults[0].id))
          throw new BrowserVaultError('vault_unavailable');
        this.vaultId = vaults[0].id;
        return client;
      })();
    }
    try {
      const client = await this.client;
      await assertActive();
      return client;
    } catch (error) {
      this.client = undefined;
      throw await this.error(error);
    }
  }

  private async refresh(client: Client, assertActive: () => Promise<void>, force = false): Promise<void> {
    if (Date.now() < this.rateLimitedUntil) throw new BrowserVaultError('rate_limited');
    if (!force && Date.now() - this.refreshedAt < REFRESH_INTERVAL_MS) return;
    this.refreshing ??= (async () => {
      if (!this.vaultId) throw new BrowserVaultError('vault_unavailable');
      await assertActive();
      const items = await client.items.list(this.vaultId, {
        type: 'ByState',
        content: { active: true, archived: false },
      });
      await assertActive();
      const overviews = items.filter(
        (item) =>
          item.category === 'Login' &&
          item.state === 'active' &&
          item.vaultId === this.vaultId &&
          /^[a-z\d_-]+$/iu.test(item.id),
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
      this.refreshedAt = Date.now();
    })();
    try {
      await this.refreshing;
    } catch (error) {
      throw await this.error(error);
    } finally {
      this.refreshing = undefined;
    }
  }

  async itemsForOrigin(raw: string, assertActive = active): Promise<BrowserVaultItem[]> {
    if (!httpsOrigin(raw)) return [];
    const client = await this.ready(assertActive);
    if (Date.now() - this.refreshedAt >= CACHE_MS) await this.refresh(client, assertActive, true);
    const matches = (): BrowserVaultItem[] =>
      [...this.handles]
        .filter(([, item]) => item.websites.some((site) => websitePermitsOrigin(site, raw)))
        .map(([item_handle, item]) => ({
          item_handle,
          title: item.title.replace(/\p{Cc}/gu, ' ').slice(0, 200),
        }));
    if (!matches().length) await this.refresh(client, assertActive);
    return matches();
  }

  /** A host-only lazy resolver; callers must bind and recheck the exact frame origin around this call. */
  async resolve(handle: string, field: BrowserSecretField, origin: string, assertActive = active): Promise<string> {
    if (!httpsOrigin(origin)) throw new BrowserVaultError('origin_mismatch');
    const client = await this.ready(assertActive);
    if (Date.now() - this.refreshedAt >= CACHE_MS) await this.refresh(client, assertActive, true);
    let item = this.handles.get(handle);
    if (!item) {
      await this.refresh(client, assertActive);
      item = this.handles.get(handle);
    }
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
