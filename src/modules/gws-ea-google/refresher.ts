/**
 * Keeps OneCLI's Google secrets holding a live token for each exposed service
 * (KTD2). Each tick renews a token close to expiry, so the first tick after
 * the host starts, or after the machine wakes, puts a fresh one in place. A
 * revoked sign-in is reported once and not retried until a new grant is
 * written; any other failure is retried on the next tick.
 */
import { EXPOSED_GOOGLE_SERVICES, GOOGLE_SERVICES, type GoogleGrant, type GoogleServiceId } from './grant.js';
import { upsertBearerSecret, type OnecliApi } from './onecli-secrets.js';
import { GoogleGrantRevokedError, mintServiceToken } from './tokens.js';

/** Renew a token this long before Google expires it. */
export const RENEW_BEFORE_EXPIRY_MS = 15 * 60_000;

export interface RefresherLog {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface RefresherOptions {
  /** The current grant, or undefined before the assistant has signed in. */
  readonly readGrant: () => Promise<GoogleGrant | undefined>;
  readonly onecli: OnecliApi;
  readonly services?: readonly GoogleServiceId[];
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly log: RefresherLog;
}

export interface GoogleTokenRefresher {
  tick(): Promise<void>;
}

/** A grant is identified by its sign-in, so a new sign-in clears a revoked one. */
function grantIdentity(grant: GoogleGrant): string {
  return `${grant.account}\0${grant.granted_at}`;
}

export function createGoogleTokenRefresher(options: RefresherOptions): GoogleTokenRefresher {
  const services = options.services ?? EXPOSED_GOOGLE_SERVICES;
  const now = options.now ?? Date.now;
  const expiresAt = new Map<GoogleServiceId, number>();
  let revoked: string | undefined;
  let current: string | undefined;

  return {
    async tick() {
      let grant: GoogleGrant | undefined;
      try {
        grant = await options.readGrant();
        /* eslint-disable-next-line no-catch-all/no-catch-all -- A background loop: any failure is logged and the next tick retries. */
      } catch (error) {
        options.log.error("Could not read the assistant's Google sign-in", {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (!grant) return;
      const identity = grantIdentity(grant);
      if (identity !== current) {
        // A new sign-in: every token is minted from it afresh.
        current = identity;
        expiresAt.clear();
      }
      if (revoked === identity) return;

      for (const id of services) {
        const service = GOOGLE_SERVICES[id];
        if ((expiresAt.get(id) ?? 0) - now() > RENEW_BEFORE_EXPIRY_MS) continue;
        try {
          const token = await mintServiceToken(grant, service, {
            ...(options.fetch ? { fetch: options.fetch } : {}),
            now,
          });
          await upsertBearerSecret(options.onecli, {
            name: service.secretName,
            hostPattern: service.hostPattern,
            value: token.accessToken,
          });
          expiresAt.set(id, token.expiresAt);
          options.log.info('Renewed Google access for agents', {
            service: id,
            expiresAt: new Date(token.expiresAt).toISOString(),
          });
          /* eslint-disable-next-line no-catch-all/no-catch-all -- A revoked grant stops; any other failure is logged and the next tick retries. */
        } catch (error) {
          if (error instanceof GoogleGrantRevokedError) {
            revoked = identity;
            options.log.error(error.message, { account: grant.account });
            return;
          }
          options.log.warn('Could not renew Google access for agents; retrying', {
            service: id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
  };
}
