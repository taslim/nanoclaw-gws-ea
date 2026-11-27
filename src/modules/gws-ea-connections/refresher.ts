import { setTimeout as delay } from 'node:timers/promises';

import type { GatewayHostCredential } from '../../gateway-providers/credential-connection.js';
import { log as hostLog } from '../../log.js';
import { APP_CREDENTIAL_PREFIX, webHostname } from './admit.js';
import { applyMainServers, MainServersUnreadableError } from './apply.js';
import { withAppLock } from './locks.js';
import { ConnectionOAuthError, refreshAccess, type ConnectionFetches, type ConnectionOAuthCode } from './oauth.js';
import { gatewayHostCredentials, type OperatorCredentials } from './operator.js';
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

export type AppGateway = OperatorCredentials;

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
  /** Best-effort cleanup when a grant is refused (e.g., closing cached relay client and withdrawing held cards). */
  readonly onDisconnected?: (appId: string) => void | Promise<void>;
  /** Called at the end of each tick when not aborted (e.g. retrying unsettled tool sorts). */
  readonly onTick?: () => void | Promise<void>;
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
  refuse(appId: string, generation: number): Promise<void>;
}

type OAuthGrant = Extract<LiveGrant, { kind: 'oauth' }>;

type TerminalCode = ConnectionOAuthCode | 'access_expired' | 'access_missing';

/**
 * A renewal the server issued that could not be stored. The server may already refuse the refresh token it replaced,
 * so the next attempt stores this rotation before asking for anything new.
 */
interface Unstored {
  readonly generation: number;
  readonly rotation: GrantRotation;
}

function refusedForGood(code: ConnectionOAuthCode): boolean {
  switch (code) {
    case 'grant_refused':
    case 'issuer_changed':
    case 'resource_mismatch':
    case 'client_refused':
    case 'needs_client':
      return true;
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

/** Reads an already-stored bearer token without triggering renewal; skips Keychain when the OAuth token is absent or expired. */
export async function readStoredUsableToken(
  store: ConnectionsStore,
  appId: string,
  grant: LiveGrant,
  now: () => number,
): Promise<UsableToken | undefined> {
  if (grant.kind === 'none') return undefined;
  if (grant.kind === 'token') {
    const creds = await store.readGrant(appId, grant.generation);
    return creds?.kind === 'token' ? { generation: creds.generation, token: creds.token } : undefined;
  }
  if (!grant.hasAccessToken || Date.parse(grant.accessExpiresAt) <= now()) return undefined;
  const stored = await store.readAccessToken(appId, grant.generation);
  return stored && Date.parse(stored.expiresAt) > now()
    ? { generation: stored.generation, token: stored.token }
    : undefined;
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
  const onDisconnected = dependencies.onDisconnected ?? (() => undefined);
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

  async function endRefused(app: ConnectionApp, generation: number, code: TerminalCode): Promise<void> {
    unstored.delete(app.id);
    if (!(await store.markRefused(app.id, generation))) return;
    log.warn('App needs reconnecting', { appId: app.id, code });
    await attempt(app.id, 'Could not clean up refused app state', 'failed', async () => {
      await onDisconnected(app.id);
    });
    await applyStore();
    await attempt(app.id, 'Could not report a refused app', 'failed', async () => {
      await onRefused({ appId: app.id, generation });
    });
  }

  async function storeRenewal(app: ConnectionApp, renewal: Unstored): Promise<UsableToken | undefined> {
    unstored.set(app.id, renewal);
    const stored = await store.rotateGrant(app.id, renewal.generation, renewal.rotation);
    unstored.delete(app.id);
    if (!stored) return undefined;
    log.info('Renewed app access', { appId: app.id });
    if (Date.parse(renewal.rotation.accessExpiresAt) <= now()) return undefined;
    return { generation: renewal.generation, token: renewal.rotation.accessToken };
  }

  async function renew(
    app: ConnectionApp,
    grant: OAuthGrant,
    host: string | undefined,
  ): Promise<UsableToken | undefined> {
    const held = unstored.get(app.id);
    if (held?.generation === grant.generation) return storeRenewal(app, held);
    unstored.delete(app.id);
    const credentials = await store.readGrant(app.id, grant.generation);
    if (credentials?.kind !== 'oauth' || credentials.refreshToken === undefined) return undefined;
    if (app.issuer === null) throw new ConnectionsStoreError('store_unavailable');
    let issued: Awaited<ReturnType<typeof refreshAccess>>;
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
      const documentUnserved =
        error instanceof ConnectionOAuthError &&
        error.code === 'client_refused' &&
        credentials.client?.kind === 'document' &&
        !(servedBefore && dependencies.clientDocumentsServed());
      if (error instanceof ConnectionOAuthError && refusedForGood(error.code) && !documentUnserved) {
        await endRefused(app, grant.generation, error.code);
        return undefined;
      }
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
    if (hasPendingRotation || !grant.hasAccessToken || renewalDue(grant, at)) {
      await renew(app, grant, host);
    }
  }

  async function sweepGatewayAppCredentials(
    held: readonly GatewayHostCredential[],
    logFields: Readonly<Record<string, string>>,
  ): Promise<boolean> {
    if (!gateway) return true;
    const gatewayAppCredentials = held.filter(({ name }) => name.startsWith(APP_CREDENTIAL_PREFIX));
    if (gatewayAppCredentials.length === 0) return true;
    const removals = await gateway.removeById(gatewayAppCredentials.map(({ id }) => id));
    if (removals.some(({ outcome }) => outcome === 'failed')) {
      log.warn('Could not remove a gateway app credential; retrying', {
        ...logFields,
        code: 'remove_failed',
      });
      return false;
    }
    log.info('Removed gateway app credentials', logFields);
    return true;
  }

  async function sweepPendingGatewayCleanups(): Promise<void> {
    if (!gateway) return;
    let hosts: readonly string[];
    try {
      hosts = await store.listPendingGatewayCleanups();
    } catch (error) {
      if (!(error instanceof ConnectionsStoreError)) throw error;
      log.warn('Connections store unavailable', { code: error.reason });
      return;
    }
    for (const pendingHost of hosts) {
      if (dependencies.signal?.aborted) return;
      let held: readonly GatewayHostCredential[] | undefined;
      try {
        held = await gateway.listForHost(pendingHost);
        /* eslint-disable-next-line no-catch-all/no-catch-all -- background retry loop logs by code and retries next tick */
      } catch (error) {
        log.warn('Could not list app credentials; retrying', {
          code: failureCode(error, 'gateway_failed'),
        });
        continue;
      }
      try {
        const cleaned = await sweepGatewayAppCredentials(held, {});
        if (cleaned) await store.clearPendingGatewayCleanup(pendingHost);
        /* eslint-disable-next-line no-catch-all/no-catch-all -- background retry loop logs by code and retries next tick */
      } catch (error) {
        log.warn('Could not remove gateway app credentials; retrying', {
          code: failureCode(error, 'remove_failed'),
        });
      }
    }
  }

  async function reconcileApp(appId: string, host: string | undefined): Promise<void> {
    await withAppLock(appId, async () => {
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
      if (live?.kind !== 'oauth' || live.generation !== unstored.get(app.id)?.generation) unstored.delete(app.id);
      if (gateway) {
        let held: readonly GatewayHostCredential[] | undefined;
        await attempt(app.id, 'Could not list app credentials; retrying', 'gateway_failed', async () => {
          held = await gateway.listForHost(app.host);
        });
        if (held) {
          const listed = held;
          await attempt(app.id, 'Could not remove gateway app credentials; retrying', 'remove_failed', async () => {
            await sweepGatewayAppCredentials(listed, { appId: app.id });
          });
        }
      }
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
      if (!dependencies.signal?.aborted) {
        await sweepPendingGatewayCleanups();
      }
      if (!dependencies.signal?.aborted) {
        await applyStore();
        await dependencies.onTick?.();
      }
    },

    refuse(appId: string, generation: number): Promise<void> {
      return withAppLock(appId, async () => {
        let app: ConnectionApp;
        try {
          app = await store.get(appId);
        } catch (error) {
          if (error instanceof ConnectionsStoreError && error.reason === 'app_not_found') return;
          throw error;
        }
        await endRefused(app, generation, 'grant_refused');
      });
    },

    async ensureToken(
      appId: string,
      options: { readonly forceRenew?: boolean } = {},
    ): Promise<UsableToken | undefined> {
      const forceRenew = options.forceRenew === true;
      if (!forceRenew) {
        const grant = await store.currentGrant(appId);
        if (!grant || grant.kind === 'none') return undefined;
        const usable = await readStoredUsableToken(store, appId, grant, now);
        if (usable || grant.kind === 'token') return usable;
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
        if (grant.kind === 'token') return readStoredUsableToken(store, appId, grant, now);
        if (!forceRenew) {
          const usable = await readStoredUsableToken(store, appId, grant, now);
          if (usable) return usable;
        }
        if (!grant.renewable) {
          if (!grant.hasAccessToken) await endRefused(app, grant.generation, 'access_missing');
          else if (Date.parse(grant.accessExpiresAt) <= now())
            await endRefused(app, grant.generation, 'access_expired');
          return undefined;
        }
        const host = await readHost();
        let renewed: UsableToken | undefined;
        await attempt(app.id, 'Could not renew app access; retrying', 'renew_failed', async () => {
          renewed = await renew(app, grant, host);
        });
        return renewed;
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
  const gateway = overrides.gateway ?? gatewayHostCredentials();
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
