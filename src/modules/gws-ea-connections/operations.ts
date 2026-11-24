import { log } from '../../log.js';
import {
  APP_CREDENTIAL_PREFIX,
  admissionDependencies,
  admitAppUrl,
  type AdmissionDependencies,
  type AdmissionRefusal,
} from './admit.js';
import {
  applyMainServers,
  MainServersUnreadableError,
  mainOperatorServers,
  notifyMainToolsChanged,
  type OperatorServer,
} from './apply.js';
import { withAppLock } from './locks.js';
import {
  listPendingHeldCallApprovals,
  withdrawHeldAppCalls,
  withdrawToolAskApprovals,
  type PendingHeldCallItem,
} from './held-calls.js';
import { getAppRelay } from './relay.js';
import {
  appClientDocumentUrl,
  appRedirectUri,
  clientForSignIn,
  completeAuthorization,
  ConnectionOAuthError,
  documentClient,
  newClientKind,
  prepareAuthorization,
  revokeGrant,
  type ClientDocumentOffer,
  type ConnectionFetches,
  type ConnectionOAuthOptions,
  type IssuedTokens,
  type PreparedAuthorization,
  type SignInServer,
} from './oauth.js';
import { gatewayHostCredentials, type OperatorCredentials } from './operator.js';
import { checkPastedToken, probeApp } from './probe.js';
import {
  ConnectionsStoreError,
  type AppPin,
  type ClientRegistration,
  type ConnectionApp,
  type ConnectionsStore,
  type GrantCredentials,
  type PinnedAppTool,
  type ToolLabel,
} from './store.js';

export type AddRefusal =
  | AdmissionRefusal
  /** The server did not answer this time. */
  | 'unreachable'
  /** The server's sign-in cannot be used. */
  | 'unsupported'
  | 'client_unavailable'
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
  | 'client_unavailable'
  | 'unreachable'
  | 'unsupported';

export type ConnectOutcome =
  | { readonly status: 'connected'; readonly app: ConnectionApp }
  | { readonly status: 'refused'; readonly reason: ConnectRefusal };

export type ClientChangeOutcome =
  | { readonly status: 'cleared'; readonly app: ConnectionApp }
  | { readonly status: 'refused'; readonly reason: 'already_connected' | 'wrong_method' };

export type SignInStartOutcome =
  | { readonly status: 'started'; readonly authorizationUrl: string; readonly app: ConnectionApp }
  | { readonly status: 'refused'; readonly reason: ConnectRefusal; readonly app?: ConnectionApp };

/**
 * The only facts a sign-in's return reports; anything more could tell a forged return apart from a real one. A
 * refused client is reported only after a sign-in this host started was claimed, so a forged return never reaches it.
 */
export type SignInReturn =
  | 'connected'
  | 'cancelled'
  | 'expired'
  | 'failed'
  | 'client_refused'
  | 'assistant_client_refused';

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
  readonly operatorServers?: () => Promise<readonly OperatorServer[]>;
  readonly applyMain?: (store: ConnectionsStore) => Promise<boolean>;
  readonly clientDocumentsServed: () => boolean;
  /** Runs after a grant is stored and before main's servers update, e.g. to pin tool definitions. */
  readonly onConnected?: (app: ConnectionApp) => Promise<void>;
  /** Runs when an app is disconnected, removed or reconnected, e.g. to close its relay client and withdraw cards. */
  readonly onDisconnected?: (appId: string) => Promise<void>;
  /** Optional gateway credential handle for retiring legacy `gws-ea-app-` credentials when removing an app. */
  readonly gateway?: OperatorCredentials | null;
}

/** What the page and the home summary show; it holds no URL and nothing sealed. */
export interface ConnectionsListing {
  /** False when the store cannot be read at all, so the principal's apps are unknown. */
  readonly listed: boolean;
  /** Apps can be added and connected: the store's secrets and main's servers are readable. */
  readonly canChange: boolean;
  readonly apps: readonly ConnectionApp[];
  readonly operators: readonly OperatorServer[];
  /** Pinned tool metadata per principal app id, read without Keychain. */
  readonly pins?: Readonly<Record<string, AppPin>>;
  /** Pinned tools per principal app id, read without Keychain. */
  readonly toolsByApp?: Readonly<Record<string, readonly PinnedAppTool[]>>;
  /** Pending held-call approvals waiting for the principal. */
  readonly pendingApprovals?: readonly PendingHeldCallItem[];
}

export interface ListingSources {
  readonly operatorServers: () => Promise<readonly OperatorServer[]>;
}

export const defaultListingSources: ListingSources = {
  operatorServers: mainOperatorServers,
};

/**
 * App metadata is read without Keychain, so existing apps are listed even when nothing can be changed. Without a
 * store, or with main's servers unreadable, the parts that can be read are still shown.
 */
export async function readListing(
  store: ConnectionsStore | undefined,
  sources: ListingSources = defaultListingSources,
  options: { readonly includeAvailability?: boolean } = {},
): Promise<ConnectionsListing> {
  const operatorsPromise = (async () => {
    try {
      return { operators: await sources.operatorServers(), ok: true };
    } catch (error) {
      if (!(error instanceof MainServersUnreadableError)) throw error;
      return { operators: [] as readonly OperatorServer[], ok: false };
    }
  })();

  const pendingApprovalsPromise = listPendingHeldCallApprovals().catch((): readonly PendingHeldCallItem[] => []);

  if (!store) {
    const [{ operators }, pendingApprovals] = await Promise.all([operatorsPromise, pendingApprovalsPromise]);
    return {
      listed: false,
      canChange: false,
      apps: [],
      operators,
      ...(pendingApprovals.length > 0 ? { pendingApprovals } : {}),
    };
  }

  const storePromise = (async () => {
    try {
      const [apps, pinList, allTools, availability] = await Promise.all([
        store.apps(),
        store.listPins(),
        store.listAllTools(),
        options.includeAvailability === false ? Promise.resolve({ available: false }) : store.availability(),
      ]);
      const pins = Object.fromEntries(pinList.map((pin) => [pin.appId, pin]));
      const toolsByApp: Record<string, PinnedAppTool[]> = {};
      for (const tool of allTools) {
        (toolsByApp[tool.appId] ??= []).push(tool);
      }
      return { listed: true as const, apps, pins, toolsByApp, available: availability.available };
    } catch (error) {
      if (!(error instanceof ConnectionsStoreError)) throw error;
      return { listed: false as const };
    }
  })();

  const [opResult, storeResult, pendingApprovals] = await Promise.all([
    operatorsPromise,
    storePromise,
    pendingApprovalsPromise,
  ]);
  if (!storeResult.listed)
    return {
      listed: false,
      canChange: false,
      apps: [],
      operators: opResult.operators,
      ...(pendingApprovals.length > 0 ? { pendingApprovals } : {}),
    };
  return {
    listed: true,
    canChange: opResult.ok && storeResult.available,
    apps: storeResult.apps,
    operators: opResult.operators,
    pins: storeResult.pins,
    toolsByApp: storeResult.toolsByApp,
    ...(pendingApprovals.length > 0 ? { pendingApprovals } : {}),
  };
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
    case 'client_unavailable':
      return 'client_unavailable';
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
  private readonly operators: () => Promise<readonly OperatorServer[]>;
  private readonly applyMain: (store: ConnectionsStore) => Promise<boolean>;
  private readonly documentsServed: () => boolean;
  private readonly onConnected: (app: ConnectionApp) => Promise<void>;
  private readonly onDisconnected: (appId: string) => Promise<void>;
  private readonly gateway: OperatorCredentials | null | undefined;

  constructor(options: ConnectionOperationsOptions) {
    this.store = options.store;
    this.webHostname = options.webHostname;
    this.oauth = {
      assistantHost: options.webHostname,
      ...(options.fetches ? { fetches: options.fetches } : {}),
      ...(options.now ? { now: options.now } : {}),
    };
    this.admission = options.admission ?? admissionDependencies(options.store);
    this.operators = options.operatorServers ?? mainOperatorServers;
    this.applyMain = options.applyMain ?? applyMainServers;
    this.documentsServed = options.clientDocumentsServed;
    this.gateway = options.gateway;
    this.onConnected =
      options.onConnected ??
      (async (app) => {
        const relay = getAppRelay();
        if (relay) await relay.pinApp(app.id);
      });
    this.onDisconnected =
      options.onDisconnected ??
      (async (appId) => {
        const relay = getAppRelay();
        const settled = await Promise.allSettled([
          relay ? relay.closeApp(appId) : Promise.resolve(),
          withdrawHeldAppCalls(appId),
          withdrawToolAskApprovals(appId),
        ]);
        const rejected = settled.filter((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
        if (rejected.length > 0) {
          throw new AggregateError(
            rejected.map((entry) => entry.reason),
            'One or more post-disconnect cleanup steps failed',
          );
        }
      });
  }

  private redirectUri(app: Pick<ConnectionApp, 'host'>): string {
    return appRedirectUri(this.webHostname, app.host);
  }

  private documentOffer(app: Pick<ConnectionApp, 'id'>, refused: boolean): ClientDocumentOffer {
    return { url: appClientDocumentUrl(this.webHostname, app.id), served: this.documentsServed(), refused };
  }

  listing(): Promise<ConnectionsListing> {
    return readListing(this.store, {
      operatorServers: this.operators,
    });
  }

  /**
   * Admits and probes the URL, then stores the app Not connected. The document's address needs the stored app's ID,
   * so a document client is set after the store.
   */
  async add(input: { readonly url: string; readonly name?: string }): Promise<AddOutcome> {
    const admission = await admitAppUrl(input.url, this.admission);
    if (!admission.admitted) return { status: 'refused', reason: admission.reason };
    const probe = await probeApp(admission.url, this.oauth);
    if (probe.status !== 'ok') return { status: 'refused', reason: probe.status };
    const { method } = probe;
    let client: ClientRegistration | undefined;
    let usesDocument = false;
    if (method.kind === 'oauth' && (method.clientDocuments || method.dynamicRegistration)) {
      try {
        const kind = newClientKind(method.signIn.server, { served: this.documentsServed(), refused: false });
        if (kind === 'document') usesDocument = true;
        else client = await this.registerClient(method.signIn, admission);
      } catch (error) {
        if (!(error instanceof ConnectionOAuthError)) throw error;
        if (error.code === 'unreachable' || error.code === 'client_unavailable')
          return { status: 'refused', reason: error.code };
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
    if (usesDocument) client = documentClient(appClientDocumentUrl(this.webHostname, app.id));
    if (client && method.kind === 'oauth')
      app = await this.store.setClient(app.id, app.version, { issuer: method.issuer, client, entered: false });
    return { status: 'added', app };
  }

  /** A server without sign-in, or one taking a pasted token; OAuth apps connect through `startSignIn`. */
  async connect(id: string, version: number, input: { readonly token?: string } = {}): Promise<ConnectOutcome> {
    const outcome = await withAppLock(id, async (): Promise<ConnectOutcome> => {
      const app = await this.current(id, version);
      if (app.status === 'connected') return refusedConnect('already_connected');
      if (app.auth === 'oauth') return refusedConnect('wrong_method');
      if (app.auth === 'none') {
        const probe = await probeApp(app.url, this.oauth);
        if (probe.status !== 'ok') return refusedConnect(probe.status);
        if (probe.method.kind !== 'none') return refusedConnect('method_changed');
        const result = await this.store.connect(id, version, { kind: 'none' });
        await this.notifyDisconnected(result.app.id);
        return { status: 'connected', app: result.app };
      }
      const token = input.token?.trim();
      if (!token) return refusedConnect('token_missing');
      const check = await checkPastedToken(app.url, token, this.oauth);
      if (check !== 'valid') return refusedConnect(check === 'refused' ? 'token_refused' : check);
      const result = await this.store.connect(id, version, { kind: 'token', token });
      await this.notifyDisconnected(result.app.id);
      return { status: 'connected', app: result.app };
    });
    if (outcome.status === 'connected') {
      await this.pinConnected(outcome.app);
      await this.apply();
    }
    return outcome;
  }

  /**
   * Re-reads how the app signs in, settles its client, and returns the server's sign-in page for this attempt. The
   * pending sign-in replaces any earlier one, so an older tab's return reads as expired. Client details go only to
   * the authorization server the Connect view named: one the app names now instead is refused before anything is
   * stored.
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
      const probe = await probeApp(app.url, this.oauth);
      if (probe.status !== 'ok') return refusedConnect(probe.status);
      if (probe.method.kind !== 'oauth' || probe.method.issuer !== app.issuer) return refusedConnect('method_changed');
      const { signIn } = probe.method;
      const redirectUri = this.redirectUri(app);
      let prepared: PreparedAuthorization;
      try {
        let client: ClientRegistration;
        if (own) {
          client = own;
          app = await this.store.setClient(app.id, app.version, {
            issuer: signIn.server.issuer,
            client,
            entered: true,
          });
        } else {
          const stored = await this.store.readClient(app.id, app.version);
          const settled = await clientForSignIn(
            signIn,
            stored,
            {
              host: app.host,
              redirectUri,
              // Without a stored client nothing shows the document was never refused, so no document is offered.
              ...(stored.client === undefined ? {} : { document: this.documentOffer(app, false) }),
            },
            this.oauth,
          );
          client = settled.client;
          if (settled.created)
            app = await this.store.setClient(app.id, app.version, {
              issuer: signIn.server.issuer,
              client,
              entered: false,
            });
        }
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
    let connectedApp: ConnectionApp | undefined;
    const outcome = await withAppLock(claim.appId, async (): Promise<SignInReturn> => {
      let tokens: IssuedTokens;
      let client: ClientRegistration | undefined;
      let previousIssuer: string | null;
      try {
        ({ issuer: previousIssuer, client } = await this.store.readClient(claim.appId));
        if (!client) throw new ConnectionOAuthError('client_refused');
        tokens = await completeAuthorization(returned, claim, client, this.oauth);
      } catch (error) {
        await this.store.discardSignIn(claim);
        if (error instanceof ConnectionOAuthError) {
          log.info('App sign-in did not complete', { appId: claim.appId, code: error.code });
          if (error.code === 'client_refused' && client) return this.replaceRefusedClient(claim.appId, client);
          return error.code === 'cancelled' ? 'cancelled' : 'failed';
        }
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
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken === undefined ? {} : { refreshToken: tokens.refreshToken }),
        accessIssuedAt: tokens.accessIssuedAt,
        accessExpiresAt: tokens.accessExpiresAt,
      });
      if (completion.status === 'expired') {
        // A disconnect or a newer sign-in won meanwhile; the grant just issued is not kept, so it is ended.
        await revokeGrant(claim.issuer, issued(tokens.refreshToken), this.oauth);
        return 'expired';
      }
      await this.notifyDisconnected(completion.app.id);
      await revokeGrant(previousIssuer, completion.replaced, this.oauth);
      connectedApp = completion.app;
      return 'connected';
    });
    if (outcome === 'connected' && connectedApp) {
      await this.pinConnected(connectedApp);
      await this.apply();
    }
    return outcome;
  }

  /** Revocation is best-effort; the app stays listed, Not connected. */
  async disconnect(id: string, version: number): Promise<ConnectionApp> {
    return withAppLock(id, async () => {
      const before = await this.current(id, version);
      const { app, released } = await this.store.disconnect(id, version);
      await this.notifyDisconnected(app.id);
      await revokeGrant(before.issuer, released, this.oauth);
      await this.apply();
      return app;
    });
  }

  /** Best-effort cleanup of any legacy `gws-ea-app-` gateway credentials on the removed app's host. */
  private async retireGatewayAppCredentials(appId: string, host: string): Promise<boolean> {
    if (this.gateway === null) return true;
    /* eslint-disable no-catch-all/no-catch-all -- best-effort gateway cleanup must never block removing an app */
    try {
      const gateway = this.gateway ?? gatewayHostCredentials();
      if (!gateway) return true;
      const held = await gateway.listForHost(host);
      const legacyIds = held.filter(({ name }) => name.startsWith(APP_CREDENTIAL_PREFIX)).map(({ id }) => id);
      if (legacyIds.length === 0) return true;
      const removals = await gateway.removeById(legacyIds);
      if (removals.some(({ outcome }) => outcome === 'failed')) {
        log.warn('Could not retire all legacy gateway app credentials during removal', { appId, host });
        return false;
      }
      return true;
    } catch (error) {
      log.warn('Could not retire legacy gateway app credentials during removal', {
        appId,
        host,
        error: error instanceof Error ? error.name : 'unknown',
      });
      return false;
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }

  /** Disconnects, then forgets the app and its client; a server that refuses revocation does not stop it. */
  async remove(id: string, version: number): Promise<void> {
    return withAppLock(id, async () => {
      const before = await this.current(id, version);
      const { app, released } = await this.store.disconnect(id, version);
      await this.notifyDisconnected(app.id);
      await revokeGrant(before.issuer, released, this.oauth);
      const gatewayCleaned = await this.retireGatewayAppCredentials(app.id, before.host);
      await this.store.remove(app.id, app.version, { pendingGatewayCleanup: !gatewayCleaned });
      await this.apply();
    });
  }

  /**
   * Forgets client details the principal entered, so Connect asks for them again: a server that rejects a client on
   * its own sign-in page never returns to say so. A registration made for the app is not the principal's to change.
   */
  async changeClient(id: string, version: number): Promise<ClientChangeOutcome> {
    return withAppLock(id, async () => {
      const app = await this.current(id, version);
      if (app.status === 'connected') return { status: 'refused', reason: 'already_connected' };
      if (app.auth !== 'oauth' || !app.clientEntered) return { status: 'refused', reason: 'wrong_method' };
      return { status: 'cleared', app: await this.store.clearClient(id, version) };
    });
  }

  /** A label only: the app's server key, and so main's tools, stay as they are. */
  rename(id: string, version: number, name: string): Promise<ConnectionApp> {
    return withAppLock(id, () => this.store.rename(id, version, name));
  }

  async setToolLabel(
    id: string,
    toolName: string,
    label: ToolLabel,
    options?: { readonly expectedHash?: string },
  ): Promise<boolean> {
    const updated = await withAppLock(id, () =>
      this.store.setToolLabel(
        id,
        toolName,
        label,
        'principal',
        options?.expectedHash === undefined ? {} : { expectedHash: options.expectedHash },
      ),
    );
    if (updated) await notifyMainToolsChanged(this.store);
    return updated;
  }

  markToolsReviewed(id: string, expectedListHash: string): Promise<boolean> {
    return withAppLock(id, () => this.store.markToolsReviewed(id, expectedListHash));
  }

  /**
   * A client the server refused, or a stored one that can no longer sign in with nothing to replace it, is
   * forgotten, so the next Connect asks for client details.
   */
  private async refusedSignIn(app: ConnectionApp, code: ConnectionOAuthError['code']): Promise<SignInStartOutcome> {
    const forget = (code === 'client_refused' || code === 'needs_client') && app.hasClient;
    const settled = forget ? await this.store.clearClient(app.id, app.version) : app;
    return { status: 'refused', reason: oauthRefusal(code), app: settled };
  }

  /**
   * A refused client is never replaced by one of its own kind. Entered client details give way to a registration
   * only, since nothing shows whether the document was refused before.
   */
  private async replaceRefusedClient(appId: string, refusedClient: ClientRegistration): Promise<SignInReturn> {
    let outcome: SignInReturn = 'assistant_client_refused';
    try {
      const refused = await this.store.get(appId);
      if (refused.clientEntered) outcome = 'client_refused';
      if (!refused.hasClient) return outcome;
      const app = await this.store.clearClient(refused.id, refused.version);
      const probe = await probeApp(app.url, this.oauth);
      if (
        probe.status !== 'ok' ||
        probe.method.kind !== 'oauth' ||
        (!probe.method.dynamicRegistration && !probe.method.clientDocuments)
      )
        return outcome;
      const { signIn } = probe.method;
      const document = refused.clientEntered ? undefined : this.documentOffer(app, refusedClient.kind === 'document');
      const { client } = await clientForSignIn(
        signIn,
        { issuer: null, client: undefined },
        { host: app.host, redirectUri: this.redirectUri(app), ...(document ? { document } : {}) },
        this.oauth,
      );
      await this.store.setClient(app.id, app.version, { issuer: signIn.server.issuer, client, entered: false });
    } catch (error) {
      if (error instanceof ConnectionOAuthError)
        log.info('Refused app client not replaced; client details needed', { appId, code: error.code });
      else if (error instanceof ConnectionsStoreError)
        log.warn('Refused app client not replaced', { appId, code: error.reason });
      else throw error;
    }
    return outcome;
  }

  /** A new registration for this app alone, whatever client it held before. */
  private async registerClient(signIn: SignInServer, app: Pick<ConnectionApp, 'host'>): Promise<ClientRegistration> {
    const { client } = await clientForSignIn(
      signIn,
      { issuer: null, client: undefined },
      { host: app.host, redirectUri: this.redirectUri(app) },
      this.oauth,
    );
    return client;
  }

  private async current(id: string, version: number): Promise<ConnectionApp> {
    const app = await this.store.get(id);
    if (app.version !== version) throw new ConnectionsStoreError('app_changed');
    return app;
  }

  private async pinConnected(app: ConnectionApp): Promise<void> {
    try {
      await this.onConnected(app);
      /* eslint-disable-next-line no-catch-all/no-catch-all -- pinning is retried on first list or host start if the app hiccups */
    } catch {
      log.warn('Could not pin app tools on connect', { appId: app.id });
    }
  }

  private async notifyDisconnected(appId: string): Promise<void> {
    try {
      await this.onDisconnected(appId);
      /* eslint-disable-next-line no-catch-all/no-catch-all -- closing cached relay clients or withdrawing holds must not block disconnect */
    } catch {
      log.warn('Post-disconnect hook did not finish cleanly', { appId });
    }
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
