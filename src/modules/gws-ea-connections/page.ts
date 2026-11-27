import type { RequestListener, ServerResponse } from 'node:http';
import type { WebIdentity } from '../gws-ea-web/access.js';
import { clientDocumentsServed } from '../gws-ea-web/index.js';
import {
  handle,
  InvalidSubmission,
  pageHeaders,
  pageNonce,
  principalEmail,
  readShell,
  readSubmission,
  refuse,
  sameOriginJson,
  sendJson,
  sendPage,
} from '../gws-ea-web/kit/index.js';
import { getPendingHeldCallApproval, resolveHeldCallFromWeb, resolvePrincipalZoneAt } from './held-calls.js';
import {
  ConnectionOperations,
  readListing,
  type AddRefusal,
  type ConnectRefusal,
  type ConnectionsListing,
  type SignInReturn,
} from './operations.js';
import { appRedirectUri } from './oauth.js';
import {
  disconnectOperatorServer,
  gatewayOperatorDependencies,
  type OperatorDisconnectDependencies,
  type OperatorDisconnectOutcome,
} from './operator.js';
import {
  humanizeToolName,
  renderConnectionsPage,
  sortToolsForDisplay,
  toolDescription,
  type ConnectionsPageState,
  type ConnectionsView,
} from './page-view.js';
import {
  APP_ID_PATTERN,
  ConnectionsStoreError,
  getConnectionsStore,
  NAME_MAX,
  toolLabelsHash,
  type AppPin,
  type ConnectionApp,
  type PinnedAppTool,
} from './store.js';

/** Builds the operations for one request; a store that cannot be opened leaves the page listing what it can. */
export type ConnectionsOperationsFactory = (webHostname: string) => Promise<ConnectionOperations>;

interface ConnectionsPageOptions {
  readonly hostname: string;
  readonly identity: WebIdentity;
  readonly operations?: ConnectionsOperationsFactory;
  /** Read afresh on each request, so the page offers an operator disconnect only while the gateway can do it. */
  readonly operatorDependencies?: () => OperatorDisconnectDependencies;
}

const WRITES = [
  'add',
  'connect',
  'sign-in',
  'change-client',
  'disconnect',
  'delete',
  'rename',
  'disconnect-operator',
  'tool-label',
  'review-tools',
  'held-decision',
] as const;
type WriteAction = (typeof WRITES)[number];
type Route =
  | { readonly kind: 'view'; readonly view: ConnectionsView; readonly outcome?: ListOutcome }
  | { readonly kind: 'tools-status'; readonly id: string }
  | { readonly kind: 'callback'; readonly host: string; readonly query: URLSearchParams }
  | { readonly kind: 'write'; readonly action: WriteAction };

const EXACT_APP_ID = new RegExp(`^${APP_ID_PATTERN}$`, 'u');
const APP_VIEW = new RegExp(`^/connections/app/(${APP_ID_PATTERN})/(connect|rename|tools)$`, 'u');
const APP_TOOLS_STATUS = new RegExp(`^/connections/app/(${APP_ID_PATTERN})/tools-status$`, 'u');
const HELD_VIEW = /^\/connections\/held\/([A-Za-z0-9_-]{4,128})$/u;
const CALLBACK = /^\/connections\/callback\/([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)$/u;

/** Each code's one message. Only a refused client says why a sign-in ended: the principal can correct it. */
const RETURN_MESSAGES = {
  connected: 'App connected. Ready from your next message.',
  cancelled: 'Sign-in cancelled. Nothing changed.',
  expired: 'Sign-in expired. Connect again to start over.',
  failed: 'Sign-in didn’t finish. Try connecting again.',
  client_refused: 'Client details were rejected and cleared. Connect again to enter new ones.',
  assistant_client_refused: 'The sign-in service didn’t accept your assistant’s client. Connect again to continue.',
} satisfies Record<SignInReturn, string>;

const LIST_OUTCOME_MESSAGES = {
  ...RETURN_MESSAGES,
  approved: 'Approved. Your assistant has the result.',
  declined: 'Declined. Nothing was sent.',
} as const;
type ListOutcome = keyof typeof LIST_OUTCOME_MESSAGES;

function isListOutcome(code: string | null): code is ListOutcome {
  return code !== null && Object.hasOwn(LIST_OUTCOME_MESSAGES, code);
}

const CHANGED = 'This app changed in another tab. Reload and try again.';
const STORE_UNAVAILABLE = 'Apps can’t be loaded right now. Ask your operator.';
const UNREACHABLE = 'The app didn’t respond. Check the address and try again.';
const UNSUPPORTED = 'This app’s sign-in method isn’t supported.';
const HOST_IN_USE = 'Another app already uses this address. Remove it first.';
const OPERATOR_NEEDED = 'Apps can’t be added or connected right now. Ask your operator.';
const CLIENT_UNAVAILABLE = 'Can’t sign in to this app right now. Try again in a few minutes.';

function operatorMessage(outcome: Exclude<OperatorDisconnectOutcome, 'disconnected'>): {
  readonly status: number;
  readonly message: string;
} {
  switch (outcome) {
    case 'credentials_kept':
      return {
        status: 200,
        message: 'Not all of its saved access could be removed, so it’s still connected. Try again.',
      };
    case 'changed':
    case 'not_found':
      return { status: 409, message: CHANGED };
    case 'unavailable':
      return { status: 503, message: 'Apps can’t be disconnected right now. Ask your operator.' };
  }
}

/** A refusal that a reload settles is a conflict; any other is the request's own fault. */
function connectRefusalStatus(reason: ConnectRefusal): number {
  return reason === 'wrong_method' || reason === 'already_connected' ? 409 : 400;
}

function addMessage(reason: AddRefusal): string {
  switch (reason) {
    case 'invalid_url':
      return 'Enter the app’s full server address, like https://example.com/mcp.';
    case 'not_https':
      return 'The address needs to start with https://.';
    case 'credentials_in_url':
      return 'Leave sign-in details and query text out of the address. You can enter a token when you connect.';
    case 'host_in_use':
      return HOST_IN_USE;
    case 'own_service':
      return 'That address belongs to your assistant, so it can’t be added as an app.';
    case 'unavailable':
      return OPERATOR_NEEDED;
    case 'unreachable':
      return UNREACHABLE;
    case 'unsupported':
      return UNSUPPORTED;
    case 'client_unavailable':
      return CLIENT_UNAVAILABLE;
    case 'duplicate_name':
      return 'Another app already has that name. Try a different one.';
    case 'invalid_name':
      return `Use a name of up to ${NAME_MAX} characters.`;
  }
}

function connectMessage(reason: ConnectRefusal): string {
  switch (reason) {
    case 'already_connected':
      return 'This app is already connected.';
    case 'wrong_method':
      return CHANGED;
    case 'method_changed':
      return 'This app now signs in differently. Delete it, then add it again.';
    case 'token_missing':
      return 'Enter an access token.';
    case 'token_refused':
      return 'The app didn’t accept that token. Check it and try again.';
    case 'invalid_client':
      return 'Enter the client ID and secret exactly as the sign-in service gave them.';
    case 'needs_client':
      return 'This app now needs client details. Reload the page to enter them.';
    case 'client_refused':
      return 'The sign-in service didn’t accept your assistant’s client. Reload the page to enter client details.';
    case 'client_unavailable':
      return CLIENT_UNAVAILABLE;
    case 'unreachable':
      return UNREACHABLE;
    case 'unsupported':
      return UNSUPPORTED;
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
    case 'duplicate_catalog_entry':
      return { status: 400, message: HOST_IN_USE };
    case 'invalid_details':
      return { status: 400, message: addMessage('invalid_name') };
    case 'store_unavailable':
      return { status: 503, message: STORE_UNAVAILABLE };
  }
}

function singleOutcomeParam(search: string): ListOutcome | undefined {
  const query = new URLSearchParams(search);
  const code = query.get('outcome');
  return [...query.keys()].length === 1 && isListOutcome(code) ? code : undefined;
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
    const statusMatch = search === undefined ? APP_TOOLS_STATUS.exec(pathname) : null;
    if (statusMatch) return { kind: 'tools-status', id: statusMatch[1] };
  }
  if (method !== 'GET' && method !== 'HEAD') return undefined;
  if (pathname === '/connections') {
    if (search === undefined) return { kind: 'view', view: { kind: 'list' } };
    const outcome = singleOutcomeParam(search);
    return outcome ? { kind: 'view', view: { kind: 'list' }, outcome } : undefined;
  }
  const appMatch = APP_VIEW.exec(pathname);
  if (appMatch) {
    const kind = appMatch[2] as 'connect' | 'rename' | 'tools';
    if (search === undefined) return { kind: 'view', view: { kind, id: appMatch[1] } };
    if (kind === 'tools' && singleOutcomeParam(search) === 'connected') {
      return { kind: 'view', view: { kind: 'tools', id: appMatch[1] }, outcome: 'connected' };
    }
    return undefined;
  }
  if (search !== undefined) return undefined;
  if (pathname === '/connections/new') return { kind: 'view', view: { kind: 'add' } };
  const heldMatch = HELD_VIEW.exec(pathname);
  if (heldMatch) return { kind: 'view', view: { kind: 'held', approvalId: heldMatch[1] } };
  return undefined;
}

function viewLocation(view: ConnectionsView): string {
  switch (view.kind) {
    case 'list':
      return '/connections';
    case 'add':
      return '/connections/new';
    case 'connect':
    case 'rename':
    case 'tools':
      return `/connections/app/${view.id}/${view.kind}`;
    case 'held':
      return `/connections/held/${encodeURIComponent(view.approvalId)}`;
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
  if (!EXACT_APP_ID.test(id) || !/^[1-9]\d*$/u.test(raw) || !Number.isSafeInteger(version))
    throw new InvalidSubmission();
  return { id, version };
}

async function defaultOperations(webHostname: string): Promise<ConnectionOperations> {
  return new ConnectionOperations({ store: await getConnectionsStore(), webHostname, clientDocumentsServed });
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

function sendReturn(response: ServerResponse, outcome: SignInReturn, basePath = '/connections'): void {
  response.writeHead(302, { ...pageHeaders(), location: `${basePath}?outcome=${outcome}` });
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
  readonly retryServer?: ConnectionsPageState['retryServer'];
}

async function write(
  action: Exclude<WriteAction, 'sign-in' | 'held-decision'>,
  data: Record<string, unknown>,
  operations: ConnectionOperations,
  operatorDependencies: OperatorDisconnectDependencies,
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
        return { ...refused({ kind: 'add' }, addMessage(added.reason)), addName: addName.slice(0, NAME_MAX) };
      return done({ kind: 'connect', id: added.app.id }, 'App added. Connect it to start using it.');
    }
    case 'connect': {
      only(data, ['id', 'version'], ['token']);
      const { id, version } = appReference(data);
      const connected = await operations.connect(id, version, { token: text(data, 'token') });
      if (connected.status === 'refused')
        return refused(
          { kind: 'connect', id },
          connectMessage(connected.reason),
          connectRefusalStatus(connected.reason),
        );
      return done({ kind: 'tools', id }, RETURN_MESSAGES.connected);
    }
    case 'change-client': {
      only(data, ['id', 'version']);
      const { id, version } = appReference(data);
      const changed = await operations.changeClient(id, version);
      if (changed.status === 'refused')
        return refused({ kind: 'connect', id }, connectMessage(changed.reason), connectRefusalStatus(changed.reason));
      return done({ kind: 'connect', id }, 'Client details cleared. Enter new ones to sign in.');
    }
    case 'disconnect': {
      only(data, ['id', 'version']);
      const { id, version } = appReference(data);
      await operations.disconnect(id, version);
      return done({ kind: 'list' }, 'App disconnected.');
    }
    case 'delete': {
      only(data, ['id', 'version']);
      const { id, version } = appReference(data);
      await operations.remove(id, version);
      return done({ kind: 'list' }, 'App deleted.');
    }
    case 'rename': {
      only(data, ['id', 'version', 'name']);
      const { id, version } = appReference(data);
      await operations.rename(id, version, text(data, 'name'));
      return done({ kind: 'list' }, 'App renamed.');
    }
    case 'disconnect-operator': {
      only(data, ['key', 'host']);
      const key = text(data, 'key');
      if (!key) throw new InvalidSubmission();
      const host = text(data, 'host');
      const outcome = await disconnectOperatorServer(operations.store, { key, host }, operatorDependencies);
      if (outcome === 'disconnected') return done({ kind: 'list' }, 'App disconnected.');
      const { status, message } = operatorMessage(outcome);
      if (outcome !== 'credentials_kept') return refused({ kind: 'list' }, message, status);
      return { ...done({ kind: 'list' }, message), failed: true, retryServer: { key, host } };
    }
    case 'tool-label': {
      only(data, ['id', 'tool', 'label', 'definitionHash']);
      const id = text(data, 'id');
      const tool = text(data, 'tool');
      const label = text(data, 'label');
      const definitionHash = text(data, 'definitionHash').trim();
      if (!EXACT_APP_ID.test(id) || !tool.trim() || !definitionHash || (label !== 'ask_first' && label !== 'just_do'))
        throw new InvalidSubmission();
      const updated = await operations.setToolLabel(id, tool, label, { expectedHash: definitionHash });
      if (!updated) return refused({ kind: 'tools', id }, CHANGED, 409);
      return done(
        { kind: 'tools', id },
        label === 'ask_first'
          ? `${humanizeToolName(tool)} will ask first.`
          : `${humanizeToolName(tool)} runs automatically.`,
      );
    }
    case 'review-tools': {
      only(data, ['id', 'listHash', 'labelsHash']);
      const id = text(data, 'id');
      const listHash = text(data, 'listHash').trim();
      const labelsHash = text(data, 'labelsHash').trim();
      if (!EXACT_APP_ID.test(id) || !listHash || !labelsHash) throw new InvalidSubmission();
      const reviewed = await operations.markToolsReviewed(id, listHash, labelsHash);
      if (!reviewed) return refused({ kind: 'tools', id }, CHANGED, 409);
      return done({ kind: 'list' }, 'Tool approvals saved.');
    }
  }
}

function wantsJson(acceptHeader: string | string[] | undefined): boolean {
  const value = Array.isArray(acceptHeader) ? acceptHeader.join(',') : (acceptHeader ?? '');
  return /\bapplication\/json\b/iu.test(value);
}

/** Safe display metadata for live polling on the tool-approvals screen; never exposes secrets or raw server prompts. */
function buildToolsStatusPayload(app: ConnectionApp, pin: AppPin | undefined, tools: readonly PinnedAppTool[]) {
  const sorted = sortToolsForDisplay(tools);
  const hasUnsorted =
    app.status === 'connected' && (!pin || sorted.some((tool) => tool.label === null || tool.unsettled));
  return {
    appId: app.id,
    status: app.status,
    pinned: pin !== undefined,
    listHash: pin?.listHash ?? null,
    labelsHash: toolLabelsHash(sorted),
    needsReview: pin?.needsReview ?? false,
    hasUnsorted,
    tools: sorted.map((tool) => ({
      name: tool.name,
      displayName: humanizeToolName(tool.name),
      definitionHash: tool.definitionHash,
      label: tool.label,
      unsettled: tool.unsettled,
      description: toolDescription(tool),
    })),
  };
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
    sendJson(response, connectRefusalStatus(started.reason), { error: connectMessage(started.reason) });
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
  const readOperatorDependencies = options.operatorDependencies ?? gatewayOperatorDependencies;
  return (request, response) => {
    const serve = async (): Promise<void> => {
      const route = readRoute(request.method, request.url);
      if (!route) return refuse(response);
      // Their address names a sign-in's owner.
      const principal = await principalEmail(request, options.hostname, options.identity);
      if (!principal) return refuse(response);
      if (route.kind === 'view' && route.view.kind === 'held') {
        const held = await getPendingHeldCallApproval(route.view.approvalId);
        if (!held) return refuse(response);
        const [shell, timezone] = await Promise.all([readShell(), resolvePrincipalZoneAt(held.payload.expiresAt)]);
        const nonce = pageNonce();
        sendPage(response, {
          status: 200,
          nonce,
          location: viewLocation(route.view),
          saved: false,
          body:
            request.method === 'HEAD'
              ? undefined
              : renderConnectionsPage(
                  {
                    view: route.view,
                    listing: { listed: true, canChange: false, apps: [], operators: [] },
                    outcome: '',
                    error: false,
                    redirectUri: (app) => appRedirectUri(options.hostname, app.host),
                    operatorDisconnect: false,
                    heldCall: {
                      approvalId: route.view.approvalId,
                      payload: held.payload,
                      timezone,
                      ...(held.expired ? { resolution: 'expired' as const } : {}),
                    },
                  },
                  shell,
                  nonce,
                ),
        });
        return;
      }
      if (route.kind === 'write' && !sameOriginJson(request, options.hostname)) return refuse(response);
      const data = route.kind === 'write' ? await readSubmission(request) : undefined;
      if (route.kind === 'write' && route.action === 'held-decision') {
        const body = data ?? {};
        only(body, ['viewId', 'decision']);
        const viewId = text(body, 'viewId');
        const decision = text(body, 'decision');
        if (!/^[A-Za-z0-9_-]{4,128}$/u.test(viewId) || (decision !== 'approve' && decision !== 'reject')) {
          throw new InvalidSubmission();
        }
        const decided = await resolveHeldCallFromWeb(viewId, decision);
        if (decided.status === 'unauthorized') return refuse(response);
        const [shell, operations] = await Promise.all([readShell(), openOperations(factory, options.hostname)]);
        const operatorDependencies = readOperatorDependencies();
        const listing = operations ? await operations.listing() : await readListing(undefined);
        const outcome =
          decided.status === 'approved'
            ? 'Approved. Your assistant has the result.'
            : decided.status === 'declined'
              ? 'Declined. Nothing was sent.'
              : decided.status === 'expired'
                ? 'This request expired. Nothing was sent.'
                : decided.status === 'already_resolved'
                  ? 'Already answered. Nothing else was sent.'
                  : 'This request is no longer pending.';
        const saved = decided.status === 'approved' || decided.status === 'declined';
        const location =
          decided.status === 'approved'
            ? '/connections?outcome=approved'
            : decided.status === 'declined'
              ? '/connections?outcome=declined'
              : '/connections';
        const nonce = pageNonce();
        sendPage(response, {
          status: 200,
          nonce,
          location,
          saved,
          body: renderConnectionsPage(
            {
              view: { kind: 'list' },
              listing,
              outcome,
              error: !saved,
              redirectUri: (app) => appRedirectUri(options.hostname, app.host),
              operatorDisconnect: operations !== undefined && operatorDependencies.credentials !== undefined,
            },
            shell,
            nonce,
          ),
        });
        return;
      }
      const operations = await openOperations(factory, options.hostname);
      if (route.kind === 'tools-status') {
        if (!operations) return sendJson(response, 503, { error: STORE_UNAVAILABLE });
        try {
          const loaded = await operations.store.readAppTools(route.id);
          if (!loaded) return refuse(response);
          return sendJson(response, 200, buildToolsStatusPayload(loaded.app, loaded.pin, loaded.tools));
        } catch (error) {
          if (error instanceof ConnectionsStoreError) return sendJson(response, 503, { error: STORE_UNAVAILABLE });
          throw error;
        }
      }
      if (route.kind === 'callback') {
        if (!operations) return sendReturn(response, 'failed');
        const outcome = await operations.finishSignIn(route.host, principal, route.query);
        if (outcome === 'connected') {
          const app = await operations.store.byHost(route.host).catch(() => undefined);
          if (app) return sendReturn(response, 'connected', `/connections/app/${encodeURIComponent(app.id)}/tools`);
        }
        return sendReturn(response, outcome);
      }
      if (route.kind === 'write' && route.action === 'sign-in')
        return startSignIn(response, data ?? {}, principal, operations);
      if (route.kind === 'write' && route.action === 'tool-label' && wantsJson(request.headers.accept)) {
        const body = data ?? {};
        only(body, ['id', 'tool', 'label', 'definitionHash']);
        const id = text(body, 'id');
        const tool = text(body, 'tool');
        const label = text(body, 'label');
        const definitionHash = text(body, 'definitionHash').trim();
        if (!EXACT_APP_ID.test(id) || !tool.trim() || !definitionHash || (label !== 'ask_first' && label !== 'just_do'))
          throw new InvalidSubmission();
        if (!operations) return sendJson(response, 503, { ok: false, error: STORE_UNAVAILABLE });
        try {
          const updated = await operations.setToolLabel(id, tool, label, { expectedHash: definitionHash });
          if (!updated) return sendJson(response, 409, { ok: false, error: CHANGED });
          return sendJson(response, 200, { ok: true, tool, label, definitionHash });
        } catch (error) {
          if (!(error instanceof ConnectionsStoreError)) throw error;
          const failure = storeFailure(error);
          return sendJson(response, failure.status, { ok: false, error: failure.message });
        }
      }
      // Before any write, so a page that cannot be drawn changes nothing.
      const shell = await readShell();
      const operatorDependencies = readOperatorDependencies();
      let result: WriteResult = {
        view: route.kind === 'view' ? route.view : { kind: 'list' },
        outcome: route.kind === 'view' && route.outcome ? LIST_OUTCOME_MESSAGES[route.outcome] : '',
        status: 200,
        saved: false,
      };
      if (route.kind === 'write' && route.action !== 'sign-in' && route.action !== 'held-decision' && data) {
        if (!operations) result = { ...result, outcome: STORE_UNAVAILABLE, status: 503 };
        else {
          try {
            result = await write(route.action, data, operations, operatorDependencies);
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
      const { view } = result;
      let listing: ConnectionsListing;
      let toolReview: ConnectionsPageState['toolReview'];
      if (view.kind === 'tools') {
        if (!operations) {
          listing = { listed: false, canChange: false, apps: [], operators: [] };
        } else {
          try {
            const loaded = await operations.store.readAppTools(view.id);
            listing = {
              listed: true,
              canChange: false,
              apps: loaded ? [loaded.app] : [],
              operators: [],
            };
            if (loaded) {
              toolReview = { ...(loaded.pin === undefined ? {} : { pin: loaded.pin }), tools: loaded.tools };
            }
          } catch (error) {
            if (!(error instanceof ConnectionsStoreError)) throw error;
            listing = { listed: false, canChange: false, apps: [], operators: [] };
          }
        }
      } else {
        listing = operations ? await operations.listing() : await readListing(undefined);
      }
      let status = result.status;
      if (route.kind === 'view' && (view.kind === 'connect' || view.kind === 'rename' || view.kind === 'tools')) {
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
                  // Main's restart after an operator disconnect is requested through the store.
                  operatorDisconnect: operations !== undefined && operatorDependencies.credentials !== undefined,
                  ...(result.retryServer === undefined ? {} : { retryServer: result.retryServer }),
                  ...(toolReview === undefined ? {} : { toolReview }),
                },
                shell,
                nonce,
              ),
      });
    };
    handle(response, serve);
  };
}
