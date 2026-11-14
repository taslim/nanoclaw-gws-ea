/**
 * Adding, connecting, disconnecting, deleting and renaming the principal's apps. The Connections page and main's
 * chat tools both act through these, so an app is changed the same way whoever asked.
 *
 * Every grant change runs under the app's lock and in one order: the store first, then the gateway, then main's
 * servers. A credential is published before main's entry is written, so tools never appear without one; a grant is
 * ended durably before anything is removed, so a failure part way leaves nothing live that the refresher would not
 * clean up. Nothing a server says or a secret the principal entered reaches a result or a log line: failures carry
 * only a code.
 */
import { log } from '../../log.js';
import { admissionDependencies, admitAppUrl, type AdmissionDependencies, type AdmissionRefusal } from './admit.js';
import { applyMainServers, MainServersUnreadableError, mainOperatorServers, type OperatorServer } from './apply.js';
import {
  AppCredentialsUnavailableError,
  gatewayAppConnection,
  publishAppCredential,
  removeAppCredential,
  type AppConnection,
} from './credentials.js';
import { withAppLock } from './locks.js';
import {
  appRedirectUri,
  clientForSignIn,
  completeAuthorization,
  ConnectionOAuthError,
  prepareAuthorization,
  revokeGrant,
  type ConnectionFetches,
  type ConnectionOAuthOptions,
  type IssuedTokens,
} from './oauth.js';
import { checkPastedToken, probeApp } from './probe.js';
import {
  ConnectionsStoreError,
  type ClientRegistration,
  type ConnectionApp,
  type ConnectionsStore,
  type GrantCredentials,
} from './store.js';

export type AddRefusal =
  | AdmissionRefusal
  /** The server did not answer this time. */
  | 'unreachable'
  /** The server's sign-in cannot be used. */
  | 'unsupported'
  | 'duplicate_name'
  | 'invalid_name';

export type AddOutcome =
  | { readonly status: 'added'; readonly app: ConnectionApp }
  | { readonly status: 'refused'; readonly reason: AddRefusal };

export type ConnectRefusal =
  | 'already_connected'
  /** The app signs in another way than this request: OAuth through sign-in, the rest through connect. */
  | 'wrong_method'
  /** The server now signs in differently from when the app was added. */
  | 'method_changed'
  | 'token_missing'
  | 'token_refused'
  | 'invalid_client'
  /** The server registers no clients itself and no client details are stored or were entered. */
  | 'needs_client'
  | 'client_refused'
  | 'unreachable'
  | 'unsupported'
  /** The gateway cannot hold app credentials. */
  | 'credentials_unavailable'
  /** The credential could not be published, so the new grant was ended again. */
  | 'publish_failed';

export type ConnectOutcome =
  | { readonly status: 'connected'; readonly app: ConnectionApp }
  | { readonly status: 'refused'; readonly reason: ConnectRefusal };

export type SignInStartOutcome =
  | { readonly status: 'started'; readonly authorizationUrl: string; readonly app: ConnectionApp }
  | { readonly status: 'refused'; readonly reason: ConnectRefusal; readonly app?: ConnectionApp };

/**
 * The only facts a sign-in's return reports; anything more could tell a forged return apart from a real one. A
 * refused client is reported only after a sign-in this host started was claimed, so a forged return never reaches it.
 */
export type SignInReturn = 'connected' | 'cancelled' | 'expired' | 'failed' | 'client_refused';

/** `credential_kept`: the grant is ended but the gateway still holds its credential, so the app stays listed. */
export type RemoveOutcome = 'deleted' | 'credential_kept';

export interface EnteredClient {
  readonly clientId: string;
  readonly clientSecret?: string;
}

export interface ConnectionOperationsOptions {
  readonly store: ConnectionsStore;
  /** The assistant's web hostname: redirect URIs sit on it and no sign-in endpoint may. */
  readonly webHostname: string;
  readonly fetches?: ConnectionFetches;
  readonly now?: () => number;
  readonly admission?: AdmissionDependencies;
  /** Throws `AppCredentialsUnavailableError` when the gateway cannot hold app credentials. */
  readonly connection?: () => AppConnection;
  readonly operatorServers?: () => Promise<readonly OperatorServer[]>;
  readonly applyMain?: (store: ConnectionsStore) => Promise<boolean>;
}

/** What the page and the home summary show; it holds no URL and nothing sealed. */
export interface ConnectionsListing {
  /** False when the store cannot be read at all, so the principal's apps are unknown. */
  readonly listed: boolean;
  /** Apps can be added and connected: the store's secrets are readable and the gateway can hold credentials. */
  readonly canChange: boolean;
  readonly apps: readonly ConnectionApp[];
  readonly operators: readonly OperatorServer[];
}

export interface ListingSources {
  readonly gatewayAvailable: () => boolean;
  readonly operatorServers: () => Promise<readonly OperatorServer[]>;
}

function canConnectWith(connection: () => AppConnection): boolean {
  try {
    connection();
    return true;
  } catch (error) {
    if (error instanceof AppCredentialsUnavailableError) return false;
    throw error;
  }
}

export const defaultListingSources: ListingSources = {
  gatewayAvailable: () => canConnectWith(gatewayAppConnection),
  operatorServers: mainOperatorServers,
};

/**
 * App metadata is read without Keychain, so existing apps are listed even when nothing can be changed. Without a
 * store, or with main's servers unreadable, the parts that can be read are still shown.
 */
export async function readListing(
  store: ConnectionsStore | undefined,
  sources: ListingSources = defaultListingSources,
): Promise<ConnectionsListing> {
  let operators: readonly OperatorServer[] = [];
  let operatorsRead = true;
  try {
    operators = await sources.operatorServers();
  } catch (error) {
    if (!(error instanceof MainServersUnreadableError)) throw error;
    operatorsRead = false;
  }
  if (!store) return { listed: false, canChange: false, apps: [], operators };
  try {
    const apps = await store.apps();
    const readable = (await store.availability()).available;
    return { listed: true, canChange: operatorsRead && readable && sources.gatewayAvailable(), apps, operators };
  } catch (error) {
    if (!(error instanceof ConnectionsStoreError)) throw error;
    return { listed: false, canChange: false, apps: [], operators };
  }
}

/** RFC 6749 client credentials are visible ASCII. */
const CLIENT_VALUE = /^[\x21-\x7e]{1,2048}$/u;

function refusedConnect(reason: ConnectRefusal): { readonly status: 'refused'; readonly reason: ConnectRefusal } {
  return { status: 'refused', reason };
}

function oauthRefusal(code: ConnectionOAuthError['code']): ConnectRefusal {
  switch (code) {
    case 'unreachable':
      return 'unreachable';
    case 'needs_client':
      return 'needs_client';
    case 'client_refused':
      return 'client_refused';
    case 'unsupported':
    case 'resource_mismatch':
    case 'issuer_changed':
    case 'issuer_mismatch':
    case 'grant_refused':
    case 'cancelled':
    case 'failed':
      return 'unsupported';
  }
}

function enteredClient(entered: EnteredClient): ClientRegistration | undefined {
  const clientId = entered.clientId.trim();
  const clientSecret = entered.clientSecret?.trim();
  if (!CLIENT_VALUE.test(clientId) || (clientSecret && !CLIENT_VALUE.test(clientSecret))) return undefined;
  return { clientId, ...(clientSecret ? { clientSecret } : {}) };
}

export class ConnectionOperations {
  readonly store: ConnectionsStore;
  private readonly webHostname: string;
  private readonly oauth: ConnectionOAuthOptions;
  private readonly admission: AdmissionDependencies;
  private readonly connection: () => AppConnection;
  private readonly operators: () => Promise<readonly OperatorServer[]>;
  private readonly applyMain: (store: ConnectionsStore) => Promise<boolean>;

  constructor(options: ConnectionOperationsOptions) {
    this.store = options.store;
    this.webHostname = options.webHostname;
    this.oauth = {
      assistantHost: options.webHostname,
      ...(options.fetches ? { fetches: options.fetches } : {}),
      ...(options.now ? { now: options.now } : {}),
    };
    this.admission = options.admission ?? admissionDependencies(options.store);
    this.connection = options.connection ?? gatewayAppConnection;
    this.operators = options.operatorServers ?? mainOperatorServers;
    this.applyMain = options.applyMain ?? applyMainServers;
  }

  private gatewayAvailable(): boolean {
    return canConnectWith(this.connection);
  }

  private redirectUri(app: Pick<ConnectionApp, 'host'>): string {
    return appRedirectUri(this.webHostname, app.host);
  }

  listing(): Promise<ConnectionsListing> {
    return readListing(this.store, {
      gatewayAvailable: () => this.gatewayAvailable(),
      operatorServers: this.operators,
    });
  }

  /**
   * Admits and probes the URL, then stores the app Not connected. A server that registers clients itself is
   * registered with now, for this app alone, so the app records whether the principal must enter client details.
   */
  async add(input: { readonly url: string; readonly name?: string }): Promise<AddOutcome> {
    const admission = await admitAppUrl(input.url, this.admission);
    if (!admission.admitted) return { status: 'refused', reason: admission.reason };
    const probe = await probeApp(admission.url, this.oauth);
    if (probe.status !== 'ok') return { status: 'refused', reason: probe.status };
    const { method } = probe;
    let client: ClientRegistration | undefined;
    if (method.kind === 'oauth' && method.dynamicRegistration) {
      try {
        ({ client } = await clientForSignIn(
          method.signIn,
          { issuer: null, client: undefined },
          { host: admission.host, redirectUri: this.redirectUri(admission) },
          this.oauth,
        ));
      } catch (error) {
        if (!(error instanceof ConnectionOAuthError)) throw error;
        if (error.code === 'unreachable') return { status: 'refused', reason: 'unreachable' };
        // A server that refuses automatic registration takes client details from the principal instead.
        log.info('App registration refused; client details needed', { code: error.code });
      }
    }
    const given = input.name?.trim();
    const names = given ? [given] : [...new Set([probe.advertisedName ?? admission.host, admission.host])];
    let app: ConnectionApp | undefined;
    for (const name of names) {
      try {
        app = await this.store.create(
          method.kind === 'oauth'
            ? { name, url: admission.url, auth: 'oauth', issuer: method.issuer }
            : { name, url: admission.url, auth: method.kind },
        );
        break;
      } catch (error) {
        if (!(error instanceof ConnectionsStoreError)) throw error;
        if (error.reason === 'duplicate_host') return { status: 'refused', reason: 'host_in_use' };
        if (error.reason === 'invalid_details') return { status: 'refused', reason: 'invalid_name' };
        if (error.reason !== 'duplicate_name') throw error;
      }
    }
    if (!app) return { status: 'refused', reason: 'duplicate_name' };
    if (client && method.kind === 'oauth')
      app = await this.store.setClient(app.id, app.version, { issuer: method.issuer, client });
    return { status: 'added', app };
  }

  /** A server without sign-in, or one taking a pasted token; OAuth apps connect through `startSignIn`. */
  async connect(id: string, version: number, input: { readonly token?: string } = {}): Promise<ConnectOutcome> {
    return withAppLock(id, async () => {
      const app = await this.current(id, version);
      if (app.status === 'connected') return refusedConnect('already_connected');
      if (app.auth === 'oauth') return refusedConnect('wrong_method');
      if (app.auth === 'none') {
        const probe = await probeApp(app.url, this.oauth);
        if (probe.status !== 'ok') return refusedConnect(probe.status);
        if (probe.method.kind !== 'none') return refusedConnect('method_changed');
        const result = await this.store.connect(id, version, { kind: 'none' });
        await this.apply();
        return { status: 'connected', app: result.app };
      }
      const token = input.token?.trim();
      if (!token) return refusedConnect('token_missing');
      let connection: AppConnection;
      try {
        connection = this.connection();
      } catch (error) {
        if (error instanceof AppCredentialsUnavailableError) return refusedConnect('credentials_unavailable');
        throw error;
      }
      const check = await checkPastedToken(app.url, token, this.oauth);
      if (check !== 'valid') return refusedConnect(check === 'refused' ? 'token_refused' : check);
      const result = await this.store.connect(id, version, { kind: 'token', token });
      if (!(await this.published(result.app, token, connection))) return refusedConnect('publish_failed');
      await this.apply();
      return { status: 'connected', app: result.app };
    });
  }

  /**
   * Re-reads how the app signs in, settles its client, and returns the server's sign-in page for this attempt. The
   * pending sign-in replaces any earlier one, so an older tab's return reads as expired.
   */
  async startSignIn(
    id: string,
    version: number,
    principalId: string,
    entered?: EnteredClient,
  ): Promise<SignInStartOutcome> {
    return withAppLock(id, async () => {
      let app = await this.current(id, version);
      if (app.status === 'connected') return refusedConnect('already_connected');
      if (app.auth !== 'oauth') return refusedConnect('wrong_method');
      const own = entered && enteredClient(entered);
      if (entered && !own) return refusedConnect('invalid_client');
      if (!this.gatewayAvailable()) return refusedConnect('credentials_unavailable');
      const probe = await probeApp(app.url, this.oauth);
      if (probe.status !== 'ok') return refusedConnect(probe.status);
      if (probe.method.kind !== 'oauth') return refusedConnect('method_changed');
      const { signIn } = probe.method;
      const redirectUri = this.redirectUri(app);
      let client: ClientRegistration;
      try {
        if (own) {
          client = own;
          app = await this.store.setClient(app.id, app.version, { issuer: signIn.server.issuer, client });
        } else {
          const settled = await clientForSignIn(
            signIn,
            await this.store.readClient(app.id, app.version),
            { host: app.host, redirectUri },
            this.oauth,
          );
          client = settled.client;
          if (settled.registered)
            app = await this.store.setClient(app.id, app.version, { issuer: signIn.server.issuer, client });
        }
      } catch (error) {
        if (!(error instanceof ConnectionOAuthError)) throw error;
        return this.refusedSignIn(app, error.code);
      }
      let prepared;
      try {
        prepared = await prepareAuthorization(signIn, client, redirectUri);
      } catch (error) {
        if (!(error instanceof ConnectionOAuthError)) throw error;
        return this.refusedSignIn(app, error.code);
      }
      const { state } = await this.store.startSignIn(app.id, app.version, {
        principalId,
        verifier: prepared.verifier,
        issuer: signIn.server.issuer,
        redirectUri,
        resource: signIn.resource,
      });
      return { status: 'started', authorizationUrl: prepared.authorizationUrl(state), app };
    });
  }

  /**
   * The server's answer at `/connections/callback/<host>`. The pending sign-in is claimed before anything else, so a
   * replay finds nothing; a failure discards it and leaves the app as it was.
   */
  async finishSignIn(host: string, principalId: string, returned: URLSearchParams): Promise<SignInReturn> {
    const states = returned.getAll('state');
    if (states.length !== 1 || !states[0]) return 'expired';
    const claim = await this.store.claimSignIn(states[0], { host, principalId });
    if (!claim) return 'expired';
    return withAppLock(claim.appId, async () => {
      let tokens: IssuedTokens;
      let client: ClientRegistration | undefined;
      let connection: AppConnection;
      let previousIssuer: string | null;
      try {
        connection = this.connection();
        ({ issuer: previousIssuer, client } = await this.store.readClient(claim.appId));
        if (!client) throw new ConnectionOAuthError('client_refused');
        tokens = await completeAuthorization(returned, claim, client, this.oauth);
      } catch (error) {
        await this.store.discardSignIn(claim);
        if (error instanceof ConnectionOAuthError) {
          log.info('App sign-in did not complete', { appId: claim.appId, code: error.code });
          if (error.code === 'client_refused' && client) return this.replaceRefusedClient(claim.appId);
          return error.code === 'cancelled' ? 'cancelled' : 'failed';
        }
        if (error instanceof AppCredentialsUnavailableError) return 'failed';
        if (error instanceof ConnectionsStoreError) return error.reason === 'app_not_found' ? 'expired' : 'failed';
        throw error;
      }
      const issued = (refreshToken: string | undefined): GrantCredentials => ({
        kind: 'oauth',
        generation: 0,
        refreshToken,
        client,
      });
      const completion = await this.store.completeSignIn(claim, {
        kind: 'oauth',
        ...(tokens.refreshToken === undefined ? {} : { refreshToken: tokens.refreshToken }),
        accessIssuedAt: tokens.accessIssuedAt,
        accessExpiresAt: tokens.accessExpiresAt,
      });
      if (completion.status === 'expired') {
        // A disconnect or a newer sign-in won meanwhile; the grant just issued is not kept, so it is ended.
        await revokeGrant(claim.issuer, issued(tokens.refreshToken), this.oauth);
        return 'expired';
      }
      if (!(await this.published(completion.app, tokens.accessToken, connection))) {
        await revokeGrant(claim.issuer, issued(tokens.refreshToken), this.oauth);
        return 'failed';
      }
      await revokeGrant(previousIssuer, completion.replaced, this.oauth);
      await this.apply();
      return 'connected';
    });
  }

  /** Revocation is best-effort; the app stays listed, Not connected. */
  async disconnect(id: string, version: number): Promise<ConnectionApp> {
    return withAppLock(id, async () => {
      const before = await this.current(id, version);
      const { app, released } = await this.store.disconnect(id, version);
      await this.removeCredential(app);
      await revokeGrant(before.issuer, released, this.oauth);
      await this.apply();
      return app;
    });
  }

  /**
   * Disconnects, then forgets the app and its client; a server that refuses revocation does not stop it. The app is
   * forgotten only once the gateway no longer holds its credential: a credential left on a host no app uses could
   * no longer be found, so a failed removal leaves the app listed Not connected for the refresher's sweep and
   * another Delete.
   */
  async remove(id: string, version: number): Promise<RemoveOutcome> {
    return withAppLock(id, async () => {
      const before = await this.current(id, version);
      const { app, released } = await this.store.disconnect(id, version);
      const removed = await this.removeCredential(app);
      await revokeGrant(before.issuer, released, this.oauth);
      if (removed) await this.store.remove(app.id, app.version);
      await this.apply();
      return removed ? 'deleted' : 'credential_kept';
    });
  }

  /** A label only: the app's server key, and so main's tools, stay as they are. */
  rename(id: string, version: number, name: string): Promise<ConnectionApp> {
    return withAppLock(id, () => this.store.rename(id, version, name));
  }

  /**
   * A client the server refused, or one stored for an authorization server the app no longer names, cannot sign in,
   * so it is forgotten and the next Connect asks for client details again.
   */
  private async refusedSignIn(app: ConnectionApp, code: ConnectionOAuthError['code']): Promise<SignInStartOutcome> {
    const forget = (code === 'needs_client' || code === 'client_refused') && app.hasClient;
    const settled = forget ? await this.store.clearClient(app.id, app.version) : app;
    return { status: 'refused', reason: oauthRefusal(code), app: settled };
  }

  /**
   * The server refused the app's client at the code exchange, so it is forgotten. A server that registers clients
   * itself is given a new registration now, as when the app was added, so the next Connect signs in again; otherwise
   * the next Connect asks the principal for client details.
   */
  private async replaceRefusedClient(appId: string): Promise<SignInReturn> {
    try {
      const refused = await this.store.get(appId);
      if (!refused.hasClient) return 'client_refused';
      const app = await this.store.clearClient(refused.id, refused.version);
      const probe = await probeApp(app.url, this.oauth);
      if (probe.status !== 'ok' || probe.method.kind !== 'oauth' || !probe.method.dynamicRegistration)
        return 'client_refused';
      const { signIn } = probe.method;
      const { client } = await clientForSignIn(
        signIn,
        { issuer: null, client: undefined },
        { host: app.host, redirectUri: this.redirectUri(app) },
        this.oauth,
      );
      await this.store.setClient(app.id, app.version, { issuer: signIn.server.issuer, client });
    } catch (error) {
      if (error instanceof ConnectionOAuthError)
        log.info('App registration refused; client details needed', { appId, code: error.code });
      else if (error instanceof ConnectionsStoreError)
        log.warn('Refused app client not replaced', { appId, code: error.reason });
      else throw error;
    }
    return 'client_refused';
  }

  private async current(id: string, version: number): Promise<ConnectionApp> {
    const app = await this.store.get(id);
    if (app.version !== version) throw new ConnectionsStoreError('app_changed');
    return app;
  }

  /** A grant whose credential the gateway did not take is ended again, so the app reads as it truly is. */
  private async published(app: ConnectionApp, token: string, connection: AppConnection): Promise<boolean> {
    try {
      await publishAppCredential(app, token, connection);
      return true;
      /* eslint-disable no-catch-all/no-catch-all -- Any gateway failure ends the new grant; only its kind is logged, never the token. */
    } catch (error) {
      log.warn('App credential not published', {
        appId: app.id,
        error: error instanceof Error ? error.name : 'unknown',
      });
      /* eslint-enable no-catch-all/no-catch-all */
      await this.store.disconnect(app.id, app.version);
      await this.removeCredential(app);
      return false;
    }
  }

  /** The grant is already ended, so the refresher's sweep retries a removal that fails here. */
  private async removeCredential(app: ConnectionApp): Promise<boolean> {
    try {
      await removeAppCredential(app, this.connection());
      return true;
      /* eslint-disable no-catch-all/no-catch-all -- Any gateway failure leaves the ended grant for the sweep; only the failure's kind is logged. */
    } catch (error) {
      log.warn('App credential not removed', {
        appId: app.id,
        error: error instanceof Error ? error.name : 'unknown',
      });
      return false;
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }

  /** Main's servers are reconciled again at host start and by the refresher, so an unreadable config only waits. */
  private async apply(): Promise<void> {
    try {
      await this.applyMain(this.store);
    } catch (error) {
      if (!(error instanceof MainServersUnreadableError)) throw error;
      log.error('Main apps not applied', { reason: error.message });
    }
  }
}
