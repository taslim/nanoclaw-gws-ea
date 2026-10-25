/**
 * Agents' Google tokens. Each tick publishes a live token for every agent
 * credential through the selected gateway's credential connection, renewing
 * one close to expiry, so the first tick after the host starts, or after the
 * machine wakes, puts a fresh one in place. The host is the only writer of
 * these credentials.
 *
 * When Google refuses part of a credential while the grant still works, its
 * first service is published alone, and every tick asks for the full set
 * again until Google grants it. A revoked sign-in is reported once and not
 * retried until a new grant is written; any other failure is retried on the
 * next tick.
 */
import type {
  GatewayCredentialTarget,
  GatewayRuntimeCredentialConnection,
} from '../../gateway-providers/credential-connection.js';
import { AGENT_GOOGLE_CREDENTIALS, googleGrantIdentity as grantIdentity, type GoogleGrant } from './grant.js';
import { GoogleGrantRevokedError, mintCredentialToken, RENEW_BEFORE_EXPIRY_MS, type TokenOptions } from './tokens.js';

/** What agents' tools send in place of a token; the gateway replaces it on the credential's host. */
export const GATEWAY_TOKEN_PLACEHOLDER = 'gateway-managed';

const BEARER = { headerName: 'Authorization', valueFormat: 'Bearer {value}' } as const;

function bearerTarget(name: string, host: string): GatewayCredentialTarget {
  return { kind: 'api-key', name, host, proxyValue: GATEWAY_TOKEN_PLACEHOLDER, injection: { ...BEARER } };
}

export interface RefresherLog {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface RefresherOptions {
  /** The current grant, or undefined before the assistant has signed in. */
  readonly readGrant: () => Promise<GoogleGrant | undefined>;
  /** The selected gateway's connection for one credential: the only way a token is stored. */
  readonly connection: (target: GatewayCredentialTarget) => GatewayRuntimeCredentialConnection;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly log: RefresherLog;
}

export interface GoogleTokenRefresher {
  tick(): Promise<void>;
}

/** `partial`: the token carries its credential's first service alone. */
interface Published {
  readonly expiresAt: number;
  readonly partial: boolean;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createGoogleTokenRefresher(options: RefresherOptions): GoogleTokenRefresher {
  const now = options.now ?? Date.now;
  const tokenOptions: TokenOptions = { ...(options.fetch ? { fetch: options.fetch } : {}), now };
  const published = new Map<string, Published>();
  let revoked: string | undefined;
  let current: string | undefined;

  return {
    async tick() {
      let grant: GoogleGrant | undefined;
      try {
        grant = await options.readGrant();
        /* eslint-disable-next-line no-catch-all/no-catch-all -- A background loop: any failure is logged and the next tick retries. */
      } catch (error) {
        options.log.error("Could not read the assistant's Google sign-in", { error: message(error) });
        return;
      }
      if (!grant) return;
      const identity = grantIdentity(grant);
      if (identity !== current) {
        // A new sign-in: every token is minted from it afresh.
        current = identity;
        published.clear();
      }
      if (revoked === identity) return;

      for (const credential of AGENT_GOOGLE_CREDENTIALS) {
        const held = published.get(credential.host);
        const fresh = held !== undefined && held.expiresAt - now() > RENEW_BEFORE_EXPIRY_MS;
        if (fresh && !held.partial) continue;
        // A fresh token carrying its first service alone stays until Google grants the full set.
        const retrying = fresh;
        try {
          const token = await mintCredentialToken(grant, credential, { ...tokenOptions, fallBack: !retrying });
          if (!token) continue;
          const connection = options.connection(bearerTarget(credential.secretName, credential.host));
          await connection.find();
          await connection.save(token.accessToken);
          published.set(credential.host, { expiresAt: token.expiresAt, partial: token.fallback !== undefined });
          const fields = { host: credential.host, expiresAt: new Date(token.expiresAt).toISOString() };
          if (token.fallback) {
            options.log.warn("Google refused part of agents' access; publishing the rest", {
              ...fields,
              refused: token.fallback.refused,
              reason: token.fallback.reason,
            });
          } else {
            options.log.info('Renewed Google access for agents', fields);
          }
          /* eslint-disable-next-line no-catch-all/no-catch-all -- A revoked grant stops; any other failure is logged and the next tick retries. */
        } catch (error) {
          if (error instanceof GoogleGrantRevokedError) {
            revoked = identity;
            options.log.error(error.message, { account: grant.account });
            return;
          }
          if (retrying) continue;
          options.log.warn('Could not renew Google access for agents; retrying', {
            host: credential.host,
            error: message(error),
          });
        }
      }
    },
  };
}
