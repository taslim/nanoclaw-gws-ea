/**
 * Keeps every connected app's credential current in the gateway and heals drift between the store, the gateway and
 * main's servers. Each tick renews an access token close to its expiry, republishes a credential the gateway lost,
 * removes app credentials no live grant owns, and reconciles main's servers to the store, so a crash, a failed
 * removal or a rollback heals itself within a tick.
 *
 * Every step for one app runs under that app's lock, which connect, disconnect and delete also take. A renewal's new
 * refresh token is stored before its access token is published, and only while the grant is still live at the
 * generation it was renewed for. A refusal the server will repeat ends the grant durably first; the credential and
 * main's entry follow.
 *
 * Log lines name the app by ID and the outcome by code, nothing more: a server's words and every token stay out.
 */
import { setTimeout as delay } from 'node:timers/promises';

import type { GatewayCredentialRemoval, GatewayHostCredential } from '../../gateway-providers/credential-connection.js';
import { getGatewayProvider } from '../../gateway-providers/index.js';
import { log as hostLog } from '../../log.js';
import { APP_CREDENTIAL_PREFIX, appCredentialName, webHostname } from './admit.js';
import { applyMainServers, MainServersUnreadableError } from './apply.js';
import { publishAppCredential, removeAppCredential, type AppConnection } from './credentials.js';
import { withAppLock } from './locks.js';
import { ConnectionOAuthError, refreshAccess, type ConnectionFetches, type ConnectionOAuthCode } from './oauth.js';
import { ConnectionsStoreError, type ConnectionApp, type ConnectionsStore, type LiveGrant } from './store.js';

export const REFRESH_TICK_MS = 60_000;
/** Renewal starts when less than this, or half the token's issued lifetime if shorter, remains. */
export const RENEW_WITHIN_MS = 15 * 60_000;
/** How long host shutdown waits for a tick in flight, so a renewal's new refresh token is stored. */
export const SHUTDOWN_WAIT_MS = 10_000;

/** The gateway's view of app credentials: one connection per app, plus listing and removal by exact host. */
export interface AppGateway {
  readonly connection: AppConnection;
  readonly listForHost: (host: string) => Promise<readonly GatewayHostCredential[]>;
  readonly removeById: (ids: readonly string[]) => Promise<readonly GatewayCredentialRemoval[]>;
}

export interface RefresherLog {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** A grant the server refused for good, after its credential and main's entry were taken away. */
export interface RefusedApp {
  readonly appId: string;
  readonly generation: number;
}

export interface ConnectionsRefresherDependencies {
  readonly store: ConnectionsStore;
  readonly gateway: AppGateway;
  readonly apply?: (store: ConnectionsStore) => Promise<boolean>;
  /** Heard once per refused generation, under the app's lock, so it records what is owed and returns. */
  readonly onRefused?: (app: RefusedApp) => void | Promise<void>;
  /** The assistant's own web hostname, on which no sign-in endpoint may sit. */
  readonly assistantHost?: () => Promise<string | undefined>;
  readonly fetches?: ConnectionFetches;
  readonly now?: () => number;
  /** Once aborted, a tick finishes the app it is on and starts no other. */
  readonly signal?: AbortSignal;
  readonly log?: RefresherLog;
}

export interface ConnectionsRefresher {
  tick(): Promise<void>;
}

type OAuthGrant = Extract<LiveGrant, { kind: 'oauth' }>;

/** A server's refusal it will repeat on every attempt, or a token that lapsed with nothing to renew it. */
type TerminalCode = ConnectionOAuthCode | 'access_expired';

/** An access token stored as renewed but not yet in the gateway: published on the next tick without renewing again. */
interface Unpublished {
  readonly generation: number;
  readonly accessExpiresAt: string;
  readonly accessToken: string;
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
    // A renewal never answers issuer_mismatch or cancelled; only a sign-in return does.
    case 'unreachable':
    case 'unsupported':
    case 'failed':
    case 'issuer_mismatch':
    case 'cancelled':
      return false;
  }
}

export function renewalDue(grant: Pick<OAuthGrant, 'accessIssuedAt' | 'accessExpiresAt'>, now: number): boolean {
  const issued = Date.parse(grant.accessIssuedAt);
  const expires = Date.parse(grant.accessExpiresAt);
  return expires - now < Math.min(RENEW_WITHIN_MS, (expires - issued) / 2);
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
  const unpublished = new Map<string, Unpublished>();
  let applyFailing = false;

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
    unpublished.delete(app.id);
    if (!(await store.markRefused(app.id, generation))) return;
    log.warn('App needs reconnecting', { appId: app.id, code });
    // A removal that fails here is retried by the sweep on the next tick.
    await attempt(app.id, 'Could not remove a refused app credential; retrying', 'gateway_failed', () =>
      removeAppCredential(app, gateway.connection),
    );
    await applyStore();
    await attempt(app.id, 'Could not report a refused app', 'failed', async () => {
      await onRefused({ appId: app.id, generation });
    });
  }

  async function publish(app: ConnectionApp, token: Unpublished): Promise<void> {
    unpublished.set(app.id, token);
    await publishAppCredential(app, token.accessToken, gateway.connection);
    unpublished.delete(app.id);
  }

  async function renew(app: ConnectionApp, grant: OAuthGrant, host: string | undefined): Promise<void> {
    const credentials = await store.readGrant(app.id, grant.generation);
    if (credentials?.kind !== 'oauth' || credentials.refreshToken === undefined) return;
    if (app.issuer === null) throw new ConnectionsStoreError('store_unavailable');
    let issued: Awaited<ReturnType<typeof refreshAccess>>;
    try {
      issued = await refreshAccess(
        { url: app.url, issuer: app.issuer },
        { refreshToken: credentials.refreshToken, client: credentials.client },
        {
          ...(dependencies.fetches ? { fetches: dependencies.fetches } : {}),
          ...(host === undefined ? {} : { assistantHost: host }),
          now,
        },
      );
    } catch (error) {
      if (error instanceof ConnectionOAuthError && refusedForGood(error.code))
        return endRefused(app, grant.generation, error.code);
      throw error;
    }
    const rotation = {
      ...(issued.refreshToken === undefined ? {} : { refreshToken: issued.refreshToken }),
      accessIssuedAt: issued.accessIssuedAt,
      accessExpiresAt: issued.accessExpiresAt,
    };
    // A grant ended or replaced meanwhile keeps its own credential; this token is discarded unpublished.
    if (!(await store.rotateGrant(app.id, grant.generation, rotation))) return;
    const token = {
      generation: grant.generation,
      accessExpiresAt: issued.accessExpiresAt,
      accessToken: issued.accessToken,
    };
    await publish(app, token);
    log.info('Renewed app access', { appId: app.id });
  }

  /** The gateway's own credential is present unless the listing says otherwise. */
  async function keepOAuth(
    app: ConnectionApp,
    grant: OAuthGrant,
    present: boolean,
    host: string | undefined,
  ): Promise<void> {
    const at = now();
    const held = unpublished.get(app.id);
    const pending =
      held?.generation === grant.generation &&
      held.accessExpiresAt === grant.accessExpiresAt &&
      Date.parse(held.accessExpiresAt) > at
        ? held
        : undefined;
    if (!pending) unpublished.delete(app.id);
    if (!grant.renewable) {
      if (Date.parse(grant.accessExpiresAt) <= at) return endRefused(app, grant.generation, 'access_expired');
      if (pending) await publish(app, pending);
      return;
    }
    if (renewalDue(grant, at)) return renew(app, grant, host);
    if (pending) return publish(app, pending);
    // Without the token in memory, a credential the gateway lost comes back only through a renewal.
    if (!present) return renew(app, grant, host);
  }

  async function republishToken(app: ConnectionApp, generation: number): Promise<void> {
    const credentials = await store.readGrant(app.id, generation);
    if (credentials?.kind !== 'token') return;
    await publishAppCredential(app, credentials.token, gateway.connection);
    log.info('Republished an app credential the gateway lost', { appId: app.id });
  }

  /** Every app credential on the host except the live grant's own belongs to no grant. */
  async function sweep(app: ConnectionApp, held: readonly GatewayHostCredential[], own: string | undefined) {
    const orphans = held.filter(({ name }) => name.startsWith(APP_CREDENTIAL_PREFIX) && name !== own);
    if (orphans.length === 0) return;
    const removals = await gateway.removeById(orphans.map(({ id }) => id));
    if (removals.some(({ outcome }) => outcome === 'failed'))
      log.warn('Could not remove an app credential without a live grant; retrying', {
        appId: app.id,
        code: 'remove_failed',
      });
    else log.info('Removed app credentials without a live grant', { appId: app.id });
  }

  async function reconcileApp(appId: string, grant: LiveGrant | undefined, host: string | undefined): Promise<void> {
    await withAppLock(appId, async () => {
      // Read again under the lock: a connect or disconnect may have finished since the tick began.
      let app: ConnectionApp;
      try {
        app = await store.get(appId);
      } catch (error) {
        if (!(error instanceof ConnectionsStoreError)) throw error;
        if (error.reason !== 'app_not_found') log.warn('Connections store unavailable', { appId, code: error.reason });
        return;
      }
      // The current state decides what the gateway keeps; the tick's earlier read of the grant only drives renewal.
      const own = app.status === 'connected' && app.auth !== 'none' ? appCredentialName(app.id) : undefined;
      const live = app.status === 'connected' ? grant : undefined;
      let held: readonly GatewayHostCredential[] | undefined;
      await attempt(app.id, 'Could not list app credentials; retrying', 'gateway_failed', async () => {
        held = await gateway.listForHost(app.host);
      });
      if (held) {
        const listed = held;
        await attempt(app.id, 'Could not remove app credentials without a live grant; retrying', 'remove_failed', () =>
          sweep(app, listed, own),
        );
      }
      // A grant replaced since by one of another kind is left to the next tick.
      if (!live || live.kind !== app.auth) return;
      const present = held === undefined || held.some(({ name }) => name === own);
      switch (live.kind) {
        case 'none':
          return;
        case 'token':
          if (!present)
            await attempt(app.id, 'Could not republish an app credential; retrying', 'publish_failed', () =>
              republishToken(app, live.generation),
            );
          return;
        case 'oauth':
          await attempt(app.id, 'Could not renew app access; retrying', 'renew_failed', () =>
            keepOAuth(app, live, present, host),
          );
      }
    });
  }

  return {
    async tick() {
      let apps: readonly ConnectionApp[];
      let grants: readonly LiveGrant[];
      try {
        [apps, grants] = await Promise.all([store.apps(), store.liveGrants()]);
      } catch (error) {
        if (!(error instanceof ConnectionsStoreError)) throw error;
        log.warn('Connections store unavailable', { code: error.reason });
        return;
      }
      for (const appId of unpublished.keys()) if (!apps.some(({ id }) => id === appId)) unpublished.delete(appId);
      let host: string | undefined;
      try {
        host = await assistantHost();
        /* eslint-disable-next-line no-catch-all/no-catch-all -- An unreadable web policy leaves only the own-hostname check out; renewal goes on. */
      } catch {
        host = undefined;
      }
      for (const app of apps) {
        if (dependencies.signal?.aborted) return;
        await reconcileApp(
          app.id,
          grants.find(({ appId }) => appId === app.id),
          host,
        );
      }
      if (!dependencies.signal?.aborted) await applyStore();
    },
  };
}

let stopController: AbortController | undefined;
let inFlight: Promise<void> | undefined;

/**
 * Renews from now on, every minute, until the host stops. Without a gateway that can hold, list and remove
 * credentials no app can be added or kept, so nothing starts.
 */
export function startConnectionsRefresher(
  store: ConnectionsStore,
  signal: AbortSignal,
  overrides: Partial<Omit<ConnectionsRefresherDependencies, 'store' | 'signal'>> = {},
): void {
  if (signal.aborted) return;
  let gateway = overrides.gateway;
  if (!gateway) {
    const provider = getGatewayProvider();
    const credentials = provider.credentials;
    const listForHost = credentials?.listForHost;
    const removeById = credentials?.removeById;
    if (!credentials || !listForHost || !removeById) {
      hostLog.error('Connected apps are off: the gateway cannot hold, list and remove their credentials', {
        gateway: provider.kind,
      });
      return;
    }
    gateway = {
      connection: (target) => credentials.connection(target),
      listForHost: (host) => listForHost.call(credentials, host),
      removeById: (ids) => removeById.call(credentials, ids),
    };
  }
  const controller = new AbortController();
  stopController = controller;
  const stopped = AbortSignal.any([signal, controller.signal]);
  const refresher = createConnectionsRefresher({ ...overrides, store, gateway, signal: stopped });
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
