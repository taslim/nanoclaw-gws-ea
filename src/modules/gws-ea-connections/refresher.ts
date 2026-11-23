/**
 * Keeps every connected app's sealed OAuth access token current in the host store, sweeps legacy or rolled-back
 * `gws-ea-app-*` credentials out of the gateway, and reconciles main's servers to the store.
 *
 * Every step for one app runs under that app's lock, which connect, disconnect, delete and on-demand renewal also
 * take, and reads the app and its grant afresh under it. A renewal stores both the rotated refresh token and the
 * sealed access token atomically, only while the grant is still live at the generation it was renewed for. A refusal
 * the server will repeat ends the grant durably first; main's entry follows.
 *
 * Log lines name the app by ID and the outcome by code, nothing more: a server's words and every token stay out.
 */
import { setTimeout as delay } from 'node:timers/promises';

import type { GatewayCredentialRemoval, GatewayHostCredential } from '../../gateway-providers/credential-connection.js';
import { getGatewayProvider } from '../../gateway-providers/index.js';
import { log as hostLog } from '../../log.js';
import { APP_CREDENTIAL_PREFIX, webHostname } from './admit.js';
import { applyMainServers, MainServersUnreadableError } from './apply.js';
import { withAppLock } from './locks.js';
import { ConnectionOAuthError, refreshAccess, type ConnectionFetches, type ConnectionOAuthCode } from './oauth.js';
import {
  ConnectionsStoreError,
  type ConnectionApp,
  type ConnectionsStore,
  type GrantRotation,
  type LiveGrant,
} from './store.js';

export const REFRESH_TICK_MS = 60_000;
/**
 * Renewal starts once less than this, or half the token's issued lifetime if shorter, would remain at the next tick:
 * a renewal point that falls between two ticks is met at the earlier one.
 */
export const RENEW_WITHIN_MS = 15 * 60_000;
/**
 * How long host shutdown waits for a tick in flight, so a renewal's new refresh token is stored: longer than the
 * egress's 10-second cap on the token exchange, plus the store write after it.
 */
export const SHUTDOWN_WAIT_MS = 15_000;

/** The gateway's read/remove surface, used solely to sweep legacy or rolled-back `gws-ea-app-*` credentials. */
export interface AppGateway {
  readonly listForHost: (host: string) => Promise<readonly GatewayHostCredential[]>;
  readonly removeById: (ids: readonly string[]) => Promise<readonly GatewayCredentialRemoval[]>;
}

export interface RefresherLog {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** A grant the server refused for good, after its token and main's entry were taken away. */
export interface RefusedApp {
  readonly appId: string;
  readonly generation: number;
}

export interface UsableToken {
  readonly generation: number;
  readonly token: string;
}

export interface ConnectionsRefresherDependencies {
  readonly store: ConnectionsStore;
  /** Optional: when present, every tick sweeps `gws-ea-app-*` credentials off each app's host. */
  readonly gateway?: AppGateway;
  readonly apply?: (store: ConnectionsStore) => Promise<boolean>;
  /** Heard once per refused generation, under the app's lock, so it records what is owed and returns. */
  readonly onRefused?: (app: RefusedApp) => void | Promise<void>;
  /** The assistant's own web hostname, on which no sign-in endpoint may sit. */
  readonly assistantHost?: () => Promise<string | undefined>;
  readonly clientDocumentsServed: () => boolean;
  readonly fetches?: ConnectionFetches;
  readonly now?: () => number;
  /** Once aborted, a tick finishes the app it is on, starts no other, and asks for no new token. */
  readonly signal?: AbortSignal;
  readonly log?: RefresherLog;
}

export interface ConnectionsRefresher {
  tick(): Promise<void>;
  /**
   * Returns a usable bearer token for a connected app, renewing an OAuth grant on demand when its token is missing or
   * expired (or when `forceRenew` is set). Returns undefined for apps without auth or when no usable token exists.
   */
  ensureToken(appId: string, options?: { readonly forceRenew?: boolean }): Promise<UsableToken | undefined>;
}

type OAuthGrant = Extract<LiveGrant, { kind: 'oauth' }>;

/** A server's refusal it will repeat on every attempt, or a non-renewable grant whose token lapsed or is missing. */
type TerminalCode = ConnectionOAuthCode | 'access_expired' | 'access_missing';

/**
 * A renewal the server issued that could not be stored. The server may already refuse the refresh token it replaced,
 * so the next attempt stores this rotation before asking for anything new.
 */
interface Unstored {
  readonly generation: number;
  readonly rotation: GrantRotation;
}

/**
 * A refused client stays refused until the principal reconnects with a new registration, so it ends the grant like a
 * refused refresh token. A missing or malformed sign-in description, or any other unexpected answer, may be a server
 * mid-deploy: the grant is kept and asked again, and the app stays Connected.
 */
function refusedForGood(code: ConnectionOAuthCode): boolean {
  switch (code) {
    case 'grant_refused':
    case 'issuer_changed':
    case 'resource_mismatch':
    case 'client_refused':
    case 'needs_client':
      return true;
    // A renewal never answers issuer_mismatch, cancelled or client_unavailable; only a sign-in does.
    case 'unreachable':
    case 'unsupported':
    case 'failed':
    case 'issuer_mismatch':
    case 'cancelled':
    case 'client_unavailable':
      return false;
  }
}

export function renewalDue(grant: Pick<OAuthGrant, 'accessIssuedAt' | 'accessExpiresAt'>, now: number): boolean {
  const issued = Date.parse(grant.accessIssuedAt);
  const expires = Date.parse(grant.accessExpiresAt);
  return expires - (now + REFRESH_TICK_MS) < Math.min(RENEW_WITHIN_MS, (expires - issued) / 2);
}

/** Only a code crosses into a log line: an error's message may quote a server or name a URL. */
function failureCode(error: unknown, fallback: string): string {
  if (error instanceof ConnectionOAuthError) return error.code;
  if (error instanceof ConnectionsStoreError) return error.reason;
  if (error instanceof MainServersUnreadableError) return 'main_servers_unreadable';
  return fallback;
}

export function createConnectionsRefresher(dependencies: ConnectionsRefresherDependencies): ConnectionsRefresher {
  const { store, gateway } = dependencies;
  const apply = dependencies.apply ?? applyMainServers;
  const onRefused = dependencies.onRefused ?? (() => undefined);
  const assistantHost = dependencies.assistantHost ?? webHostname;
  const now = dependencies.now ?? Date.now;
  const log = dependencies.log ?? hostLog;
  const unstored = new Map<string, Unstored>();
  let applyFailing = false;

  async function readHost(): Promise<string | undefined> {
    try {
      return await assistantHost();
      /* eslint-disable-next-line no-catch-all/no-catch-all -- An unreadable web policy leaves only the own-hostname check out; renewal goes on. */
    } catch {
      return undefined;
    }
  }

  /**
   * Runs one step of a background loop: any failure is logged by code and the next tick tries again.
   */
  async function attempt(appId: string, message: string, fallback: string, step: () => Promise<void>): Promise<void> {
    try {
      await step();
      /* eslint-disable-next-line no-catch-all/no-catch-all -- A background loop: the failure is logged by code and the next tick retries. */
    } catch (error) {
      log.warn(message, { appId, code: failureCode(error, fallback) });
    }
  }

  async function applyStore(): Promise<void> {
    try {
      await apply(store);
      applyFailing = false;
      /* eslint-disable-next-line no-catch-all/no-catch-all -- A background loop: the failure is logged once by code and every tick retries. */
    } catch (error) {
      if (!applyFailing) log.error("Could not reconcile main's apps; retrying", { code: failureCode(error, 'failed') });
      applyFailing = true;
    }
  }

  /** Durably ended first, so nothing removed afterwards can come back if a later step fails or the host stops. */
  async function endRefused(app: ConnectionApp, generation: number, code: TerminalCode): Promise<void> {
    unstored.delete(app.id);
    if (!(await store.markRefused(app.id, generation))) return;
    log.warn('App needs reconnecting', { appId: app.id, code });
    await applyStore();
    await attempt(app.id, 'Could not report a refused app', 'failed', async () => {
      await onRefused({ appId: app.id, generation });
    });
  }

  async function storeRenewal(app: ConnectionApp, renewal: Unstored): Promise<void> {
    unstored.set(app.id, renewal);
    const stored = await store.rotateGrant(app.id, renewal.generation, renewal.rotation);
    unstored.delete(app.id);
    if (!stored) return;
    log.info('Renewed app access', { appId: app.id });
  }

  async function renew(app: ConnectionApp, grant: OAuthGrant, host: string | undefined): Promise<void> {
    const held = unstored.get(app.id);
    if (held?.generation === grant.generation) return storeRenewal(app, held);
    unstored.delete(app.id);
    const credentials = await store.readGrant(app.id, grant.generation);
    if (credentials?.kind !== 'oauth' || credentials.refreshToken === undefined) return;
    if (app.issuer === null) throw new ConnectionsStoreError('store_unavailable');
    let issued: Awaited<ReturnType<typeof refreshAccess>>;
    // The server may fetch the document at any point during the request, so either reading can be the one it saw.
    const servedBefore = dependencies.clientDocumentsServed();
    try {
      issued = await refreshAccess(
        { url: app.url, issuer: app.issuer },
        { refreshToken: credentials.refreshToken, client: credentials.client },
        {
          ...(dependencies.fetches ? { fetches: dependencies.fetches } : {}),
          ...(host === undefined ? {} : { assistantHost: host }),
          ...(dependencies.signal ? { signal: dependencies.signal } : {}),
          now,
        },
      );
    } catch (error) {
      // A server that could not fetch the client document refuses the client only until it is served again.
      const documentUnserved =
        error instanceof ConnectionOAuthError &&
        error.code === 'client_refused' &&
        credentials.client?.kind === 'document' &&
        !(servedBefore && dependencies.clientDocumentsServed());
      if (error instanceof ConnectionOAuthError && refusedForGood(error.code) && !documentUnserved)
        return endRefused(app, grant.generation, error.code);
      throw error;
    }
    const rotation: GrantRotation = {
      ...(issued.refreshToken === undefined ? {} : { refreshToken: issued.refreshToken }),
      accessToken: issued.accessToken,
      accessIssuedAt: issued.accessIssuedAt,
      accessExpiresAt: issued.accessExpiresAt,
    };
    return storeRenewal(app, { generation: grant.generation, rotation });
  }

  async function keepOAuth(app: ConnectionApp, grant: OAuthGrant, host: string | undefined): Promise<void> {
    const at = now();
    if (!grant.renewable) {
      if (!grant.hasAccessToken) return endRefused(app, grant.generation, 'access_missing');
      if (Date.parse(grant.accessExpiresAt) <= at) return endRefused(app, grant.generation, 'access_expired');
      return;
    }
    const hasPendingRotation = unstored.get(app.id)?.generation === grant.generation;
    if (hasPendingRotation || !grant.hasAccessToken || renewalDue(grant, at)) return renew(app, grant, host);
  }

  /** Principal-app credentials belong in the host store, so every `gws-ea-app-*` entry in the gateway is removed. */
  async function sweep(app: ConnectionApp, held: readonly GatewayHostCredential[]) {
    if (!gateway) return;
    const orphans = held.filter(({ name }) => name.startsWith(APP_CREDENTIAL_PREFIX));
    if (orphans.length === 0) return;
    const removals = await gateway.removeById(orphans.map(({ id }) => id));
    if (removals.some(({ outcome }) => outcome === 'failed'))
      log.warn('Could not remove a gateway app credential; retrying', {
        appId: app.id,
        code: 'remove_failed',
      });
    else log.info('Removed gateway app credentials', { appId: app.id });
  }

  async function reconcileApp(appId: string, host: string | undefined): Promise<void> {
    await withAppLock(appId, async () => {
      // Read under the lock: a connect, sign-in or disconnect may have finished since the tick began.
      let app: ConnectionApp;
      let grant: LiveGrant | undefined;
      try {
        [app, grant] = await Promise.all([store.get(appId), store.currentGrant(appId)]);
      } catch (error) {
        if (!(error instanceof ConnectionsStoreError)) throw error;
        if (error.reason !== 'app_not_found') log.warn('Connections store unavailable', { appId, code: error.reason });
        return;
      }
      const live = app.status === 'connected' ? grant : undefined;
      // A held renewal belongs only to the live grant it was issued for.
      if (live?.kind !== 'oauth' || live.generation !== unstored.get(app.id)?.generation) unstored.delete(app.id);
      if (gateway) {
        let held: readonly GatewayHostCredential[] | undefined;
        await attempt(app.id, 'Could not list app credentials; retrying', 'gateway_failed', async () => {
          held = await gateway.listForHost(app.host);
        });
        if (held) {
          const listed = held;
          await attempt(app.id, 'Could not remove gateway app credentials; retrying', 'remove_failed', () =>
            sweep(app, listed),
          );
        }
      }
      // A grant replaced since by one of another kind is left to the next tick.
      if (!live || live.kind !== app.auth) return;
      if (live.kind === 'oauth') {
        await attempt(app.id, 'Could not renew app access; retrying', 'renew_failed', () => keepOAuth(app, live, host));
      }
    });
  }

  return {
    async tick() {
      let apps: readonly ConnectionApp[];
      try {
        apps = await store.apps();
      } catch (error) {
        if (!(error instanceof ConnectionsStoreError)) throw error;
        log.warn('Connections store unavailable', { code: error.reason });
        return;
      }
      for (const appId of unstored.keys()) if (!apps.some(({ id }) => id === appId)) unstored.delete(appId);
      const host = await readHost();
      for (const app of apps) {
        if (dependencies.signal?.aborted) return;
        await reconcileApp(app.id, host);
      }
      if (!dependencies.signal?.aborted) await applyStore();
    },

    async ensureToken(
      appId: string,
      options: { readonly forceRenew?: boolean } = {},
    ): Promise<UsableToken | undefined> {
      const forceRenew = options.forceRenew === true;
      if (!forceRenew) {
        const grant = await store.currentGrant(appId);
        if (!grant || grant.kind === 'none') return undefined;
        if (grant.kind === 'token') {
          const creds = await store.readGrant(appId, grant.generation);
          return creds?.kind === 'token' ? { generation: creds.generation, token: creds.token } : undefined;
        }
        const stored = await store.readAccessToken(appId, grant.generation);
        if (stored && Date.parse(stored.expiresAt) > now()) {
          return { generation: stored.generation, token: stored.token };
        }
      }
      return withAppLock(appId, async () => {
        let app: ConnectionApp;
        let grant: LiveGrant | undefined;
        try {
          [app, grant] = await Promise.all([store.get(appId), store.currentGrant(appId)]);
        } catch (error) {
          if (error instanceof ConnectionsStoreError) return undefined;
          throw error;
        }
        if (app.status !== 'connected' || !grant || grant.kind !== app.auth || grant.kind === 'none') return undefined;
        if (grant.kind === 'token') {
          const creds = await store.readGrant(appId, grant.generation);
          return creds?.kind === 'token' ? { generation: creds.generation, token: creds.token } : undefined;
        }
        if (grant.kind !== 'oauth') return undefined;
        const oauthGrant: OAuthGrant = grant;
        const stored = await store.readAccessToken(appId, oauthGrant.generation);
        if (!forceRenew && stored && Date.parse(stored.expiresAt) > now()) {
          return { generation: stored.generation, token: stored.token };
        }
        if (!oauthGrant.renewable) {
          if (!stored) await endRefused(app, oauthGrant.generation, 'access_missing');
          else if (Date.parse(stored.expiresAt) <= now())
            await endRefused(app, oauthGrant.generation, 'access_expired');
          return undefined;
        }
        const host = await readHost();
        await attempt(app.id, 'Could not renew app access; retrying', 'renew_failed', () =>
          renew(app, oauthGrant, host),
        );
        const after = await store.readAccessToken(appId, oauthGrant.generation);
        if (after && Date.parse(after.expiresAt) > now()) {
          return { generation: after.generation, token: after.token };
        }
        return undefined;
      });
    },
  };
}

let stopController: AbortController | undefined;
let inFlight: Promise<void> | undefined;
let activeRefresher: ConnectionsRefresher | undefined;

export function getConnectionsRefresher(): ConnectionsRefresher | undefined {
  return activeRefresher;
}

/** Renews from now on, every minute, until the host stops, sweeping any gateway app credentials when supported. */
export function startConnectionsRefresher(
  store: ConnectionsStore,
  signal: AbortSignal,
  overrides: Partial<Omit<ConnectionsRefresherDependencies, 'store' | 'signal'>> &
    Pick<ConnectionsRefresherDependencies, 'clientDocumentsServed'>,
): void {
  if (signal.aborted) return;
  let gateway = overrides.gateway;
  if (!gateway) {
    const credentials = getGatewayProvider().credentials;
    const listForHost = credentials?.listForHost;
    const removeById = credentials?.removeById;
    if (credentials && listForHost && removeById) {
      gateway = {
        listForHost: (host) => listForHost.call(credentials, host),
        removeById: (ids) => removeById.call(credentials, ids),
      };
    }
  }
  const controller = new AbortController();
  stopController = controller;
  const stopped = AbortSignal.any([signal, controller.signal]);
  const refresher = createConnectionsRefresher({
    ...overrides,
    store,
    ...(gateway ? { gateway } : {}),
    signal: stopped,
  });
  activeRefresher = refresher;
  // Started, not awaited: host startup never waits on a server.
  void (async () => {
    while (!stopped.aborted) {
      const tick = refresher.tick().catch((err: unknown) => {
        hostLog.error('Connected apps refresh failed', { err });
      });
      inFlight = tick;
      await tick;
      if (inFlight === tick) inFlight = undefined;
      await delay(REFRESH_TICK_MS, undefined, { signal: stopped }).catch(() => undefined);
    }
  })();
}

/** Starts no further tick and waits, within a bound, for the one in flight to store what it renewed. */
export async function stopConnectionsRefresher(waitMs = SHUTDOWN_WAIT_MS): Promise<void> {
  stopController?.abort();
  stopController = undefined;
  activeRefresher = undefined;
  const tick = inFlight;
  if (!tick) return;
  const bound = new AbortController();
  const finished = await Promise.race([
    tick.then(() => true),
    delay(waitMs, false, { signal: bound.signal }).catch(() => false),
  ]);
  bound.abort();
  if (!finished) hostLog.warn('Stopped before an app renewal finished', { waitMs });
}
