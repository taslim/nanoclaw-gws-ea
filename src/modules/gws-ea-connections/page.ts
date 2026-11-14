import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { isPrincipalWebIdentity, type WebIdentity } from '../gws-ea-web/access.js';
import {
  InvalidSubmission,
  pageHeaders,
  pageNonce,
  readShell,
  readSubmission,
  refuse,
  sameOriginJson,
  sendJson,
  sendPage,
  sendUnavailable,
} from '../gws-ea-web/kit/index.js';
import {
  ConnectionOperations,
  readListing,
  type AddRefusal,
  type ConnectRefusal,
  type ConnectionsListing,
  type SignInReturn,
} from './operations.js';
import { appRedirectUri } from './oauth.js';
import { renderConnectionsPage, type ConnectionsView } from './page-view.js';
import { ConnectionsStoreError, getConnectionsStore } from './store.js';

/** Builds the operations for one request; a store that cannot be opened leaves the page listing what it can. */
export type ConnectionsOperationsFactory = (webHostname: string) => Promise<ConnectionOperations>;

interface ConnectionsPageOptions {
  readonly hostname: string;
  readonly identity: WebIdentity;
  readonly operations?: ConnectionsOperationsFactory;
}

type WriteAction = 'add' | 'connect' | 'sign-in' | 'disconnect' | 'delete' | 'rename';
type Route =
  | { readonly kind: 'view'; readonly view: ConnectionsView; readonly outcome?: SignInReturn }
  | { readonly kind: 'callback'; readonly host: string; readonly query: URLSearchParams }
  | { readonly kind: 'write'; readonly action: WriteAction };

const WRITES: readonly WriteAction[] = ['add', 'connect', 'sign-in', 'disconnect', 'delete', 'rename'];
const RETURNS: readonly SignInReturn[] = ['connected', 'cancelled', 'expired', 'failed'];
const APP_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const APP_VIEW = new RegExp(`^/connections/app/(${APP_ID})/(connect|rename)$`, 'u');
const CALLBACK = /^\/connections\/callback\/([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)$/u;

/** Each code's one message: the outcome of a sign-in says nothing about why it ended. */
const RETURN_MESSAGES = {
  connected: 'App connected. Your assistant can use it from your next message.',
  cancelled: 'Sign-in was cancelled. The app wasn’t changed.',
  expired: 'That sign-in expired or was already used. Connect the app again to start a new one.',
  failed: 'Sign-in didn’t finish. The app wasn’t changed. Try connecting again.',
} satisfies Record<SignInReturn, string>;

const CHANGED = 'This app changed since you opened the page. Reload the page and try again.';
const STORE_UNAVAILABLE = 'Your apps can’t be read right now. Ask your operator.';
const UNREACHABLE = 'The app’s server didn’t answer. Check the address and try again.';
const UNSUPPORTED = 'This app signs in in a way your assistant doesn’t support.';
const HOST_IN_USE =
  'Another app or one of your operator’s servers already uses this address. Remove it first to add this one.';
const OPERATOR_NEEDED = 'Apps can’t be added or connected right now. Ask your operator.';

function addMessage(reason: AddRefusal): string {
  switch (reason) {
    case 'invalid_url':
      return 'Enter the app’s full address, such as https://example.com/mcp.';
    case 'not_https':
      return 'The address must start with https://.';
    case 'credentials_in_url':
      return 'Remove the sign-in details or query from the address. You can enter a token when you connect.';
    case 'host_in_use':
      return HOST_IN_USE;
    case 'own_service':
      return 'This address belongs to one of your assistant’s own services, so it can’t be added as an app.';
    case 'unavailable':
      return OPERATOR_NEEDED;
    case 'unreachable':
      return UNREACHABLE;
    case 'unsupported':
      return UNSUPPORTED;
    case 'duplicate_name':
      return 'Another app already has that name. Choose a different name.';
    case 'invalid_name':
      return 'Enter a name of at most 100 characters, without control characters.';
  }
}

function connectMessage(reason: ConnectRefusal): string {
  switch (reason) {
    case 'already_connected':
      return 'This app is already connected.';
    case 'wrong_method':
      return CHANGED;
    case 'method_changed':
      return 'This app now signs in differently. Delete it and add it again.';
    case 'token_missing':
      return 'Enter an access token.';
    case 'token_refused':
      return 'The app didn’t accept that token. Check it and try again.';
    case 'invalid_client':
      return 'Enter the client ID and secret exactly as the app’s sign-in service gave them.';
    case 'needs_client':
      return 'Enter the client details this app’s sign-in service gave you. Reload the page to see the fields.';
    case 'client_refused':
      return 'The app’s sign-in service refused the client details. Check them, or delete the app and add it again.';
    case 'unreachable':
      return UNREACHABLE;
    case 'unsupported':
      return UNSUPPORTED;
    case 'credentials_unavailable':
    case 'publish_failed':
      return OPERATOR_NEEDED;
  }
}

function storeFailure(error: ConnectionsStoreError): { readonly status: number; readonly message: string } {
  switch (error.reason) {
    case 'app_changed':
    case 'app_not_found':
      return { status: 409, message: CHANGED };
    case 'duplicate_name':
      return { status: 400, message: addMessage('duplicate_name') };
    case 'duplicate_host':
      return { status: 400, message: HOST_IN_USE };
    case 'invalid_details':
      return { status: 400, message: addMessage('invalid_name') };
    case 'store_unavailable':
      return { status: 503, message: STORE_UNAVAILABLE };
  }
}

function readRoute(method: string | undefined, url: string | undefined): Route | undefined {
  if (!url) return undefined;
  const [pathname = '', search] = url.split(/\?(.*)/su, 2);
  if (method === 'POST') {
    const action = WRITES.find((write) => pathname === `/connections/${write}`);
    return action && search === undefined ? { kind: 'write', action } : undefined;
  }
  if (method === 'GET') {
    const callback = CALLBACK.exec(pathname);
    if (callback) return { kind: 'callback', host: callback[1], query: new URLSearchParams(search ?? '') };
  }
  if (method !== 'GET' && method !== 'HEAD') return undefined;
  if (pathname === '/connections') {
    if (search === undefined) return { kind: 'view', view: { kind: 'list' } };
    const query = new URLSearchParams(search);
    const outcome = RETURNS.find((code) => code === query.get('outcome'));
    return outcome && [...query.keys()].length === 1 ? { kind: 'view', view: { kind: 'list' }, outcome } : undefined;
  }
  if (search !== undefined) return undefined;
  if (pathname === '/connections/new') return { kind: 'view', view: { kind: 'add' } };
  const match = APP_VIEW.exec(pathname);
  if (!match) return undefined;
  return { kind: 'view', view: { kind: match[2] === 'connect' ? 'connect' : 'rename', id: match[1] } };
}

function viewLocation(view: ConnectionsView): string {
  switch (view.kind) {
    case 'list':
      return '/connections';
    case 'add':
      return '/connections/new';
    case 'connect':
    case 'rename':
      return `/connections/app/${view.id}/${view.kind}`;
  }
}

function only(data: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const keys = Object.keys(data);
  if (required.some((key) => !keys.includes(key)) || keys.some((key) => ![...required, ...optional].includes(key)))
    throw new InvalidSubmission();
  for (const key of keys) if (typeof data[key] !== 'string') throw new InvalidSubmission();
}

function text(data: Record<string, unknown>, name: string): string {
  const value = data[name];
  return typeof value === 'string' ? value : '';
}

function appReference(data: Record<string, unknown>): { readonly id: string; readonly version: number } {
  const id = text(data, 'id');
  const raw = text(data, 'version');
  const version = Number(raw);
  if (!new RegExp(`^${APP_ID}$`, 'u').test(id) || !/^[1-9]\d*$/u.test(raw) || !Number.isSafeInteger(version))
    throw new InvalidSubmission();
  return { id, version };
}

/** The Access-verified principal, checked afresh on this request; their address names a sign-in's owner. */
async function principalOf(request: IncomingMessage, options: ConnectionsPageOptions): Promise<string | undefined> {
  if (request.headers.host !== options.hostname) return undefined;
  const email = await options.identity(request);
  return (await isPrincipalWebIdentity(email)) ? email : undefined;
}

async function defaultOperations(webHostname: string): Promise<ConnectionOperations> {
  return new ConnectionOperations({ store: await getConnectionsStore(), webHostname });
}

async function openOperations(
  factory: ConnectionsOperationsFactory,
  hostname: string,
): Promise<ConnectionOperations | undefined> {
  try {
    return await factory(hostname);
  } catch (error) {
    if (error instanceof ConnectionsStoreError) return undefined;
    throw error;
  }
}

function sendReturn(response: ServerResponse, outcome: SignInReturn): void {
  response.writeHead(302, { ...pageHeaders(), location: `/connections?outcome=${outcome}` });
  response.end();
}

interface WriteResult {
  readonly view: ConnectionsView;
  readonly outcome: string;
  readonly status: number;
  readonly saved: boolean;
  /** A saved change that did not finish, shown as an error. */
  readonly failed?: boolean;
  readonly addName?: string;
}

async function write(
  action: Exclude<WriteAction, 'sign-in'>,
  data: Record<string, unknown>,
  operations: ConnectionOperations,
): Promise<WriteResult> {
  const done = (view: ConnectionsView, outcome: string): WriteResult => ({ view, outcome, status: 200, saved: true });
  const refused = (view: ConnectionsView, outcome: string, status = 400): WriteResult => ({
    view,
    outcome,
    status,
    saved: false,
  });
  switch (action) {
    case 'add': {
      only(data, ['url'], ['name']);
      const addName = text(data, 'name');
      const added = await operations.add({ url: text(data, 'url'), name: addName });
      if (added.status === 'refused')
        return { ...refused({ kind: 'add' }, addMessage(added.reason)), addName: addName.slice(0, 100) };
      return done({ kind: 'connect', id: added.app.id }, 'App added. Connect it to give your assistant its tools.');
    }
    case 'connect': {
      only(data, ['id', 'version'], ['token']);
      const { id, version } = appReference(data);
      const connected = await operations.connect(id, version, { token: text(data, 'token') });
      if (connected.status === 'refused')
        return refused(
          { kind: 'connect', id },
          connectMessage(connected.reason),
          connected.reason === 'wrong_method' || connected.reason === 'already_connected' ? 409 : 400,
        );
      return done({ kind: 'list' }, RETURN_MESSAGES.connected);
    }
    case 'disconnect': {
      only(data, ['id', 'version']);
      const { id, version } = appReference(data);
      await operations.disconnect(id, version);
      return done({ kind: 'list' }, 'App disconnected. Your assistant no longer has its tools.');
    }
    case 'delete': {
      only(data, ['id', 'version']);
      const { id, version } = appReference(data);
      if ((await operations.remove(id, version)) === 'deleted') return done({ kind: 'list' }, 'App deleted.');
      return {
        ...done(
          { kind: 'list' },
          'The app is disconnected, but its access couldn’t be removed yet, so it’s still listed. Try deleting it again.',
        ),
        failed: true,
      };
    }
    case 'rename': {
      only(data, ['id', 'version', 'name']);
      const { id, version } = appReference(data);
      await operations.rename(id, version, text(data, 'name'));
      return done({ kind: 'list' }, 'App renamed.');
    }
  }
}

/** A sign-in start answers JSON: the page opens the server's sign-in address itself. */
async function startSignIn(
  response: ServerResponse,
  data: Record<string, unknown>,
  principal: string,
  operations: ConnectionOperations | undefined,
): Promise<void> {
  only(data, ['id', 'version'], ['clientId', 'clientSecret']);
  const { id, version } = appReference(data);
  if (!operations) return sendJson(response, 503, { error: STORE_UNAVAILABLE });
  const clientId = text(data, 'clientId');
  const clientSecret = text(data, 'clientSecret');
  try {
    const started = await operations.startSignIn(
      id,
      version,
      principal,
      clientId || clientSecret ? { clientId, clientSecret } : undefined,
    );
    if (started.status === 'started') return sendJson(response, 200, { authorizationUrl: started.authorizationUrl });
    const conflict = started.reason === 'wrong_method' || started.reason === 'already_connected';
    sendJson(response, conflict ? 409 : 400, { error: connectMessage(started.reason) });
  } catch (error) {
    if (!(error instanceof ConnectionsStoreError)) throw error;
    const failure = storeFailure(error);
    sendJson(response, failure.status, { error: failure.message });
  }
}

/**
 * The Access-verified principal is checked afresh before every read or write, the sign-in return included. A
 * client secret or pasted token arrives once in a POST body and is never written back to any response.
 */
export function createConnectionsPageHandler(options: ConnectionsPageOptions): RequestListener {
  const factory = options.operations ?? defaultOperations;
  return (request, response) => {
    const serve = async (): Promise<void> => {
      const route = readRoute(request.method, request.url);
      if (!route) return refuse(response);
      const principal = await principalOf(request, options);
      if (!principal) return refuse(response);
      if (route.kind === 'write' && !sameOriginJson(request, options.hostname)) return refuse(response);
      const data = route.kind === 'write' ? await readSubmission(request) : undefined;
      const operations = await openOperations(factory, options.hostname);
      if (route.kind === 'callback') {
        if (!operations) return sendReturn(response, 'failed');
        return sendReturn(response, await operations.finishSignIn(route.host, principal, route.query));
      }
      if (route.kind === 'write' && route.action === 'sign-in')
        return startSignIn(response, data ?? {}, principal, operations);
      // Before any write, so a page that cannot be drawn changes nothing.
      const shell = await readShell();
      let result: WriteResult = {
        view: route.kind === 'view' ? route.view : { kind: 'list' },
        outcome: route.kind === 'view' && route.outcome ? RETURN_MESSAGES[route.outcome] : '',
        status: 200,
        saved: false,
      };
      if (route.kind === 'write' && route.action !== 'sign-in' && data) {
        if (!operations) result = { ...result, outcome: STORE_UNAVAILABLE, status: 503 };
        else {
          try {
            result = await write(route.action, data, operations);
          } catch (error) {
            if (!(error instanceof ConnectionsStoreError)) throw error;
            const failure = storeFailure(error);
            result = {
              view: failure.status === 409 ? { kind: 'list' } : result.view,
              outcome: failure.message,
              status: failure.status,
              saved: false,
            };
          }
        }
      }
      const listing: ConnectionsListing = operations ? await operations.listing() : await readListing(undefined);
      const { view } = result;
      let status = result.status;
      if (route.kind === 'view' && (view.kind === 'connect' || view.kind === 'rename')) {
        if (!listing.listed) status = 503;
        else if (!listing.apps.some((app) => app.id === view.id)) status = 404;
      }
      const outcome = route.kind === 'view' && !listing.listed && !result.outcome ? STORE_UNAVAILABLE : result.outcome;
      const nonce = pageNonce();
      sendPage(response, {
        status,
        nonce,
        location: viewLocation(view),
        saved: result.saved,
        body:
          request.method === 'HEAD'
            ? undefined
            : renderConnectionsPage(
                {
                  view,
                  listing,
                  outcome,
                  error: result.failed === true || (!result.saved && (status >= 400 || !listing.listed)),
                  ...(result.addName === undefined ? {} : { addName: result.addName }),
                  redirectUri: (app) => appRedirectUri(options.hostname, app.host),
                },
                shell,
                nonce,
              ),
      });
    };
    void serve().catch((error: unknown) => {
      if (response.headersSent) response.destroy();
      else if (error instanceof InvalidSubmission) refuse(response);
      else sendUnavailable(response);
    });
  };
}
