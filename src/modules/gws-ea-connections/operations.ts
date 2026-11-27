import { log } from '../../log.js';
import {
  APP_CREDENTIAL_PREFIX,
  admissionDependencies,
  admitAppUrl,
  type AdmissionDependencies,
  type AdmissionRefusal,
} from './admit.js';
import { applyMainServers, MainServersUnreadableError, mainOperatorServers, type OperatorServer } from './apply.js';
import { writeNoteForMain, type NoteForMain, type NoteForMainResult } from '../gws-ea-profile/main-note.js';
import {
  catalogEntry,
  catalogEntryFor,
  isClientCredential,
  isRemoteEntry,
  operatorClient,
  operatorDisabled,
  operatorEnabled,
  placeCatalogApps,
  readCatalogPolicy,
  usesOperatorClient,
  type AvailableCatalogEntry,
  type CatalogEntry,
  type CatalogPolicyState,
  type OperatorClient,
  type RemoteCatalogEntry,
} from './catalog.js';
import type { CatalogRetireReply, RetirableCatalogEntry } from './catalog-retire.js';
import {
  adoptApprovedSignIn,
  cancelDeviceSignIn,
  hostCliClientName,
  signOutHostCli,
  startDeviceSignIn,
  type DeviceSignInCompletion,
} from './device-sign-in.js';
import {
  HostCliUnavailableError,
  isHostCliEntry,
  resolveHostCliLaunch,
  type HostCliEntry,
  type HostCliLaunch,
} from './host-process.js';
import { checkRestartSoon } from './idle-restart.js';
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
  | 'not_offered'
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

export type CatalogConnectOutcome =
  | SignInStartOutcome
  | { readonly status: 'connect_view'; readonly app: ConnectionApp }
  | { readonly status: 'add_refused'; readonly reason: AddRefusal }
  | { readonly status: 'device_sign_in'; readonly app: ConnectionApp }
  | { readonly status: 'not_offered' };

/**
 * The only facts a sign-in's return reports; anything more could tell a forged return apart from a real one. A
 * refused client is reported only after a sign-in this host started was claimed, so a forged return never reaches it.
 */
export type SignInReturn =
  'connected' | 'cancelled' | 'expired' | 'failed' | 'client_refused' | 'assistant_client_refused';

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
  readonly clientName?: () => Promise<string>;
  readonly writeNote?: (note: NoteForMain) => Promise<NoteForMainResult>;
}

/** What the page and the home summary show; it holds no URL and nothing sealed. */
export interface ConnectionsListing {
  /** False when the store cannot be read at all, so the principal's apps are unknown. */
  readonly listed: boolean;
  /** Apps can be added and connected: the store's secrets and main's servers are readable. */
  readonly canChange: boolean;
  readonly apps: readonly ConnectionApp[];
  readonly operators: readonly OperatorServer[];
  readonly catalogEntries?: Readonly<Record<string, CatalogEntry>>;
  readonly available?: readonly AvailableCatalogEntry[];
  /** Pinned tool metadata per principal app id, read without Keychain. */
  readonly pins?: Readonly<Record<string, AppPin>>;
  /** Pinned tools per principal app id, read without Keychain. */
  readonly toolsByApp?: Readonly<Record<string, readonly PinnedAppTool[]>>;
  /** Pending held-call approvals waiting for the principal. */
  readonly pendingApprovals?: readonly PendingHeldCallItem[];
}

export interface ListingSources {
  readonly operatorServers: () => Promise<readonly OperatorServer[]>;
  readonly catalogPolicy: () => Promise<CatalogPolicyState>;
}

export const defaultListingSources: ListingSources = {
  operatorServers: mainOperatorServers,
  catalogPolicy: () => readCatalogPolicy(),
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
      const [apps, pinList, allTools, availability, policy] = await Promise.all([
        store.apps(),
        store.listPins(),
        store.listAllTools(),
        options.includeAvailability === false ? Promise.resolve({ available: false }) : store.availability(),
        sources.catalogPolicy(),
      ]);
      const pins = Object.fromEntries(pinList.map((pin) => [pin.appId, pin]));
      const toolsByApp: Record<string, PinnedAppTool[]> = {};
      for (const tool of allTools) {
        (toolsByApp[tool.appId] ??= []).push(tool);
      }
      return {
        listed: true as const,
        catalog: placeCatalogApps(apps, policy),
        pins,
        toolsByApp,
        available: availability.available,
      };
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
    apps: storeResult.catalog.apps,
    operators: opResult.operators,
    catalogEntries: storeResult.catalog.entries,
    available: storeResult.catalog.available,
    pins: storeResult.pins,
    toolsByApp: storeResult.toolsByApp,
    ...(pendingApprovals.length > 0 ? { pendingApprovals } : {}),
  };
}

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
  if (!isClientCredential(clientId) || (clientSecret && !isClientCredential(clientSecret))) return undefined;
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
  private readonly clientName: () => Promise<string>;
  private readonly writeNote: (note: NoteForMain) => Promise<NoteForMainResult>;

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
    this.clientName = options.clientName ?? hostCliClientName;
    this.writeNote = options.writeNote ?? writeNoteForMain;
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
    return readListing(this.store, { ...defaultListingSources, operatorServers: this.operators });
  }

  add(input: { readonly url: string; readonly name?: string }): Promise<AddOutcome> {
    const given = input.name?.trim();
    return this.addApp(input.url, (advertisedName, host) =>
      given ? [given] : [...new Set([advertisedName ?? host, host])],
    );
  }

  /**
   * Adds the entry's app, or reuses the one an earlier connect left, and starts its sign-in. The entry's lock keeps a
   * second tab from adding it twice.
   */
  async connectCatalogEntry(entry: CatalogEntry, principalId: string): Promise<CatalogConnectOutcome> {
    if (!operatorEnabled(entry, await readCatalogPolicy())) return { status: 'not_offered' };
    if (isHostCliEntry(entry)) return this.connectHostCliEntry(entry);
    if (!isRemoteEntry(entry)) return { status: 'not_offered' };
    return this.connectRemoteEntry(entry, principalId);
  }

  private connectRemoteEntry(entry: RemoteCatalogEntry, principalId: string): Promise<CatalogConnectOutcome> {
    return withAppLock(`catalog:${entry.id}`, async (): Promise<CatalogConnectOutcome> => {
      let app = (await this.store.apps()).find((candidate) => catalogEntryFor(candidate)?.id === entry.id);
      if (app?.status === 'connected') return refusedConnect('already_connected');
      if (!app) {
        const added = await this.addApp(entry.transport.url, (_advertised, host) => [entry.name, host], entry.id);
        if (added.status === 'refused') return { status: 'add_refused', reason: added.reason };
        app = added.app;
      }
      if (app.auth !== 'oauth' || (!app.hasClient && !usesOperatorClient(entry)))
        return { status: 'connect_view', app };
      return this.startSignIn(app.id, app.version, principalId);
    });
  }

  /**
   * Starts the CLI's device login for the entry's app, or finds the one under way, and answers once its address and
   * phrase are known. The login outlives this request; approval connects the app from the login itself.
   */
  private connectHostCliEntry(entry: HostCliEntry): Promise<CatalogConnectOutcome> {
    return withAppLock(`catalog:${entry.id}`, async (): Promise<CatalogConnectOutcome> => {
      let app = (await this.store.apps()).find((candidate) => candidate.catalogId === entry.id);
      if (app?.status === 'connected') return refusedConnect('already_connected');
      let launch: HostCliLaunch;
      try {
        launch = await resolveHostCliLaunch(entry);
      } catch (error) {
        if (error instanceof HostCliUnavailableError) return { status: 'not_offered' };
        throw error;
      }
      if (!app) {
        try {
          app = await this.store.create({ name: entry.name, transport: 'host_cli', catalogId: entry.id });
        } catch (error) {
          if (error instanceof ConnectionsStoreError && error.reason === 'duplicate_name')
            return { status: 'add_refused', reason: 'duplicate_name' };
          throw error;
        }
      }
      const appId = app.id;
      const clientName = await this.clientName();
      // Under the app's lock too, so no login starts while a disconnect is still signing out and clearing pending files.
      await withAppLock(appId, () =>
        startDeviceSignIn({
          appId,
          entry,
          launch,
          clientName,
          complete: (pendingFile, current) => this.completeDeviceSignIn(entry, appId, launch, pendingFile, current),
        }),
      );
      return { status: 'device_sign_in', app };
    });
  }

  /**
   * Under the app's lock, so a disconnect that cancelled the sign-in meanwhile always wins. The operator may have turned
   * the entry off while the principal was approving; its retirement saw no connected app, so nothing connects now.
   */
  private async completeDeviceSignIn(
    entry: HostCliEntry,
    appId: string,
    launch: HostCliLaunch,
    pendingFile: string,
    current: () => boolean,
  ): Promise<DeviceSignInCompletion> {
    const connected = await withAppLock(appId, async (): Promise<ConnectionApp | 'not_offered' | undefined> => {
      if (!current()) return undefined;
      if (!operatorEnabled(entry, await readCatalogPolicy())) return 'not_offered';
      let app: ConnectionApp;
      try {
        app = await this.store.get(appId);
      } catch (error) {
        if (error instanceof ConnectionsStoreError && error.reason === 'app_not_found') return undefined;
        throw error;
      }
      await adoptApprovedSignIn(pendingFile, launch.authFile);
      const result = await this.store.connect(app.id, app.version, { kind: 'none' });
      await this.notifyDisconnected(result.app.id);
      return result.app;
    });
    if (connected === undefined) return 'not_connected';
    if (connected === 'not_offered') return connected;
    await this.pinConnected(connected);
    await this.apply();
    return 'connected';
  }

  /**
   * Admits and probes the URL, then stores the app Not connected. The document's address needs the stored app's ID,
   * so a document client is set after the store.
   */
  private async addApp(
    url: string,
    names: (advertisedName: string | undefined, host: string) => readonly string[],
    catalogId?: string,
  ): Promise<AddOutcome> {
    const admission = await admitAppUrl(url, this.admission);
    if (!admission.admitted) return { status: 'refused', reason: admission.reason };
    const probe = await probeApp(admission.url, this.oauth);
    if (probe.status !== 'ok') return { status: 'refused', reason: probe.status };
    const { method } = probe;
    let client: ClientRegistration | undefined;
    let usesDocument = false;
    // The operator's client is set at each sign-in instead, so none is made for the app.
    const entry = catalogEntryFor({ catalogId: catalogId ?? null, transport: 'remote', host: admission.host });
    const operatorSignIn = entry !== undefined && usesOperatorClient(entry);
    if (method.kind === 'oauth' && !operatorSignIn && (method.clientDocuments || method.dynamicRegistration)) {
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
    const catalog = catalogId === undefined ? {} : { catalogId };
    let app: ConnectionApp | undefined;
    for (const name of names(probe.advertisedName, admission.host)) {
      try {
        app = await this.store.create(
          method.kind === 'oauth'
            ? { name, url: admission.url, auth: 'oauth', issuer: method.issuer, ...catalog }
            : { name, url: admission.url, auth: method.kind, ...catalog },
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
      if (app.auth === 'oauth' || app.transport === 'host_cli') return refusedConnect('wrong_method');
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
      const operator = own || app.clientEntered ? undefined : await this.operatorClientFor(app);
      if (operator?.status === 'none') return refusedConnect('not_offered');
      if (operator?.status === 'unreadable') return refusedConnect('client_unavailable');
      const probe = await probeApp(app.url, this.oauth);
      if (probe.status !== 'ok') return refusedConnect(probe.status);
      if (probe.method.kind !== 'oauth' || probe.method.issuer !== app.issuer) return refusedConnect('method_changed');
      const { signIn } = probe.method;
      const redirectUri = this.redirectUri(app);
      let prepared: PreparedAuthorization;
      try {
        let client: ClientRegistration;
        // The operator's client replaces whatever the app held, so the one registered now is always the one used.
        const given = own ?? (operator?.status === 'registered' ? operator.client : undefined);
        if (given) {
          client = given;
          app = await this.store.setClient(app.id, app.version, {
            issuer: signIn.server.issuer,
            client,
            entered: own !== undefined,
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
      const app = await this.release(await this.current(id, version));
      await this.apply();
      return app;
    });
  }

  /**
   * Under the app's lock: ends the grant before anything else, so no new call can start, then closes what it had open
   * and revokes. A host-run app's CLI child is closed before its sign-out runs, so one process uses its credentials.
   */
  private async release(before: ConnectionApp): Promise<ConnectionApp> {
    if (before.transport === 'host_cli') cancelDeviceSignIn(before.id);
    const { app, released } = await this.store.disconnect(before.id, before.version);
    await this.notifyDisconnected(app.id);
    const entry = before.transport === 'host_cli' ? catalogEntryFor(before) : undefined;
    if (entry && isHostCliEntry(entry)) await signOutHostCli(entry);
    else await revokeGrant(before.issuer, released, this.oauth);
    return app;
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
      const app = await this.release(before);
      const gatewayCleaned = await this.retireGatewayAppCredentials(app.id, before.host);
      await this.store.remove(app.id, app.version, { pendingGatewayCleanup: !gatewayCleaned });
      await this.apply();
    });
  }

  /**
   * Disconnects every app of the entry once the operator has turned it off on this host, and notes main for each. An
   * app added earlier by address counts as the entry's, as at placement; one signed in with a client the principal
   * entered is theirs, not the operator's, so the operator's turn-off leaves it alone. While the entry is still offered,
   * or the policy cannot be read, nothing is retired.
   */
  async retireCatalogEntry(entryId: RetirableCatalogEntry): Promise<CatalogRetireReply> {
    const entry = catalogEntry(entryId);
    const signsInWithOperatorClient = entry !== undefined && usesOperatorClient(entry);
    const operators = (app: ConnectionApp): boolean => !(signsInWithOperatorClient && app.clientEntered);
    const own = async (): Promise<readonly ConnectionApp[]> =>
      (await this.store.apps()).filter((app) => catalogEntryFor(app)?.id === entryId && operators(app));
    let retired = 0;
    if (entry && operatorDisabled(entry, await readCatalogPolicy())) {
      // Under each app's lock, so a sign-in finishing now has either connected, and is disconnected below, or never will.
      // The principal may have entered their own client since the app was picked; that sign-in is theirs to keep.
      for (const app of await own())
        await withAppLock(app.id, async () => {
          let current: ConnectionApp;
          try {
            current = await this.store.get(app.id);
          } catch (error) {
            if (error instanceof ConnectionsStoreError && error.reason === 'app_not_found') return;
            throw error;
          }
          if (!operators(current)) return;
          cancelDeviceSignIn(app.id);
          await this.store.discardSignIns(app.id);
        });
      for (const app of await own()) {
        if (app.status === 'not_connected') continue;
        try {
          await this.disconnect(app.id, app.version);
        } catch (error) {
          if (!(error instanceof ConnectionsStoreError)) throw error;
          log.warn('Catalog app not retired', { appId: app.id, code: error.reason });
          continue;
        }
        retired += 1;
        await this.noteRetired(app, entry);
      }
    }
    const remaining = (await own()).filter((app) => app.status !== 'not_connected').length;
    return { schemaVersion: 1, entry: entryId, retired, remaining };
  }

  /** Main hears once, without waking, that the app's tools are gone and why; its id makes writing it again a no-op. */
  private async noteRetired(app: ConnectionApp, entry: CatalogEntry): Promise<void> {
    try {
      await this.writeNote({
        id: `connection-retired:${app.id}:${app.version}`,
        timestamp: new Date().toISOString(),
        text:
          `The principal's operator turned ${entry.name} off on this host, so the app ${JSON.stringify(app.name)} ` +
          'was disconnected and its tools are gone. It can be connected again once the operator turns it back on.',
        wake: false,
      });
      /* eslint-disable-next-line no-catch-all/no-catch-all -- the app is already disconnected; a lost note must not undo or block that */
    } catch (error) {
      log.error('Retired app note not written', {
        appId: app.id,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
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
    if (updated) checkRestartSoon();
    return updated;
  }

  markToolsReviewed(id: string, expectedListHash: string, expectedLabelsHash?: string): Promise<boolean> {
    return withAppLock(id, () => this.store.markToolsReviewed(id, expectedListHash, undefined, expectedLabelsHash));
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
      if (!refused.hasClient || this.holdsOperatorClient(refused)) return outcome;
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

  private async operatorClientFor(app: ConnectionApp): Promise<OperatorClient | undefined> {
    const entry = catalogEntryFor(app);
    if (!entry || !usesOperatorClient(entry)) return undefined;
    return operatorClient(entry, await readCatalogPolicy());
  }

  /**
   * Unless the principal entered their own, such an app's client is the operator's: nothing made for the app replaces
   * it, and each sign-in sets the one the operator holds then.
   */
  private holdsOperatorClient(app: ConnectionApp): boolean {
    const entry = catalogEntryFor(app);
    return !app.clientEntered && entry !== undefined && usesOperatorClient(entry);
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
