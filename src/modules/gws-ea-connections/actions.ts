/**
 * Main's chat path to the principal's apps: `add_app` and `delete_app`, each held for the principal's approval and
 * carried out through the same operations as the Connections page. Credentials never travel this way: an app that
 * needs a sign-in, a token or client details is added Not connected, and main sends the Connections link.
 *
 * An address is admitted and probed before any card exists, so a refused one never reaches the principal; an
 * approved request is checked again when it runs, and runs once however often a restart replays it. Main changes
 * its MCP servers no other way: the policy here refuses its raw config commands and self-modification requests.
 */
import { ActionRefusal, forbidden, invalidArgs, requestIdOf, writeActionResponse } from '../../cli/delivery-action.js';
import type { ResponseFrame } from '../../cli/frame.js';
import { registerMcpServerPolicy } from '../../cli/guard.js';
import { getDb } from '../../db/connection.js';
import type { DeliveryGuardSpec, GuardedDeliveryHandler } from '../../delivery-guard.js';
import { reenterGuardedDeliveryAction, registerDeliveryAction } from '../../delivery.js';
import { DENY, HOLD, defineGuardedAction, type GuardDecision, type GuardInput } from '../../guard/index.js';
import { hasControlCharacters, isRecord } from '../../gws-ea/validation.js';
import { log } from '../../log.js';
import { clearOutbox, withExistingMailboxSession } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { registerApprovalHandler, requestApproval } from '../approvals/index.js';
import { quoted } from '../approvals/request-text.js';
import { principalApproverUserId, readMainAgentGroupId } from '../gws-ea-profile/db.js';
import { writeNoteForMain, type NoteForMain, type NoteForMainResult } from '../gws-ea-profile/main-note.js';
import { clientDocumentsServed } from '../gws-ea-web/index.js';
import { readWebPolicy } from '../gws-ea-web/policy.js';
import { admissionDependencies, admitAppUrl, hostOf, type AdmissionDependencies } from './admit.js';
import { APP_SERVER_PREFIX } from './apply.js';
import type { ConnectionOAuthOptions, SignInServer } from './oauth.js';
import { ConnectionOperations, type AddRefusal, type ConnectRefusal } from './operations.js';
import { probeApp, type SignInMethod } from './probe.js';
import {
  ConnectionsStoreError,
  getConnectionsStore,
  NAME_MAX,
  type ConnectionApp,
  type ConnectionsStore,
} from './store.js';

export const ADD_APP_ACTION = 'add_app';
export const DELETE_APP_ACTION = 'delete_app';

/** What apps are changed through, read fresh for every request. */
export interface AppActionContext {
  readonly store: ConnectionsStore;
  readonly operations: ConnectionOperations;
  readonly admission: AdmissionDependencies;
  readonly oauth: ConnectionOAuthOptions;
}

/** `operator_needed`: web is not set up, so there is no Connections page; `unavailable`: try again later. */
export type AppsUnavailable = 'operator_needed' | 'unavailable';

export interface AppActionDependencies {
  readonly context: () => Promise<AppActionContext | AppsUnavailable>;
  readonly writeNote?: (note: NoteForMain) => Promise<NoteForMainResult>;
}

const ADD_FIELDS: ReadonlySet<string> = new Set(['action', 'requestId', 'url', 'name']);
/** The approved request also carries the app's id, so it deletes exactly the app the principal saw. */
const DELETE_FIELDS: ReadonlySet<string> = new Set(['action', 'requestId', 'app', 'id']);

type AddAnswer = AddRefusal | AppsUnavailable;
type DeleteAnswer = AppsUnavailable | 'operator_server' | 'not_found';

const OPERATOR_NEEDED =
  'Web is not set up, so the principal has no Connections page. Tell them to ask their operator to finish setup.';

const ADD_REFUSED: Readonly<Record<AddAnswer, string>> = {
  invalid_url: 'That is not an address the host can use: it needs a plain https host name, with no port or fragment.',
  not_https: "An app's address must start with https.",
  credentials_in_url:
    "The address carries a query or sign-in details. Use the app's plain address; a token or client secret is entered only on the Connections page.",
  host_in_use:
    "Another app, one of the operator's servers or a saved credential already uses this host. The principal can disconnect that one on their Connections page first.",
  own_service: 'This host serves the assistant itself, so it cannot be an app.',
  unavailable: 'Apps cannot be added right now. Try again later.',
  unreachable: 'The server did not answer. Try again later.',
  unsupported: "The server's sign-in cannot be used, so it cannot be added.",
  client_unavailable: 'The assistant cannot sign in to this app right now, so it was not added. Try again later.',
  duplicate_name: 'Another app already has this name. Choose another.',
  invalid_name: `The name must be 1 to ${NAME_MAX} characters, with no control characters.`,
  operator_needed: OPERATOR_NEEDED,
};

const DELETE_REFUSED: Readonly<Record<DeleteAnswer, string>> = {
  operator_server:
    "That server is the operator's. The principal can disconnect it on their Connections page; it cannot be deleted from chat.",
  not_found: 'No app the principal added has this key. Check the app keys principal_page connections lists.',
  unavailable: 'Apps cannot be changed right now. Try again later.',
  operator_needed: OPERATOR_NEEDED,
};

const CONNECT_REFUSED: Readonly<Record<ConnectRefusal, string>> = {
  already_connected: 'it is already connected',
  wrong_method: 'it signs in another way',
  method_changed: 'the server now signs in differently',
  token_missing: 'it needs a token',
  token_refused: 'the server refused the token',
  invalid_client: 'the client details are not valid',
  needs_client: 'it needs client details',
  client_refused: 'the server refused the client',
  client_unavailable: 'the assistant cannot sign in to it right now',
  unreachable: 'the server did not answer',
  unsupported: "the server's sign-in cannot be used",
};

async function principalHold({ actor, grant }: GuardInput, what: string): Promise<GuardDecision> {
  if (actor.kind !== 'agent' || actor.agentGroupId !== (await readMainAgentGroupId()))
    return DENY(`Only main may ${what}.`);
  const principal = await principalApproverUserId();
  if (!principal) return DENY(`No verified principal can approve this, so main cannot ${what} now.`);
  // An approval from whoever was principal before stays theirs.
  if (grant && grant.approver_user_id !== principal) return DENY(`Only the current principal may let main ${what}.`);
  return HOLD(`The principal approves each request to ${what}.`, principal);
}

const coversExactRequest = (grant: PendingApproval, input: GuardInput): boolean =>
  grant.payload === JSON.stringify(input.payload);

export const addAppGuard = defineGuardedAction({
  action: 'gws_ea_connections.add_app',
  grantActionName: ADD_APP_ACTION,
  grantCoversRequest: coversExactRequest,
  decide: (input) => principalHold(input, 'add an app'),
});

export const deleteAppGuard = defineGuardedAction({
  action: 'gws_ea_connections.delete_app',
  grantActionName: DELETE_APP_ACTION,
  grantCoversRequest: coversExactRequest,
  decide: (input) => principalHold(input, 'delete an app'),
});

registerMcpServerPolicy('gws-ea-connections:main-apps', async ({ agentGroupId, serverName }) => {
  if (serverName?.startsWith(APP_SERVER_PREFIX))
    return `server names starting with ${APP_SERVER_PREFIX} belong to the principal's connected apps`;
  if (agentGroupId === (await readMainAgentGroupId()))
    return "main's MCP servers are the principal's apps: use add_app or delete_app, and the principal connects apps on their Connections page";
  return undefined;
});

interface AddRequest {
  readonly requestId: string;
  readonly url: string;
  readonly name: string;
}

interface DeleteRequest {
  readonly requestId: string;
  readonly app: string;
  readonly id?: string;
}

function fieldsOnly(content: Record<string, unknown>, allowed: ReadonlySet<string>, takes: string): void {
  if (Object.keys(content).some((key) => !allowed.has(key))) throw invalidArgs(`The request takes only ${takes}.`);
}

function appName(value: unknown): string {
  const name = typeof value === 'string' ? value.normalize('NFC').trim() : '';
  if (!name || name.length > NAME_MAX || hasControlCharacters(name)) throw invalidArgs(ADD_REFUSED.invalid_name);
  return name;
}

/** As the store compares names, so a name it would refuse is refused before the card. */
function nameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase();
}

function addRequest(content: Record<string, unknown>, requestId: string): AddRequest {
  fieldsOnly(content, ADD_FIELDS, 'url and name');
  if (typeof content.url !== 'string' || !content.url.trim()) throw invalidArgs('url is the app’s https address.');
  return { requestId, url: content.url.trim(), name: appName(content.name) };
}

function deleteRequest(content: Record<string, unknown>, requestId: string): DeleteRequest {
  fieldsOnly(content, DELETE_FIELDS, 'app');
  if (typeof content.app !== 'string' || !content.app.trim())
    throw invalidArgs('app is the key principal_page connections lists for the app.');
  if (content.id !== undefined && typeof content.id !== 'string') throw invalidArgs('The request takes only app.');
  return { requestId, app: content.app.trim(), ...(typeof content.id === 'string' ? { id: content.id } : {}) };
}

function refusal(requestId: string, error: ActionRefusal): ResponseFrame {
  return { id: requestId, ok: false, error: { code: error.code, message: error.message } };
}

/** The outbox is cleared only after the answer, as every answering action does. */
async function answer(session: Session, requestId: string, frame: ResponseFrame): Promise<void> {
  await writeActionResponse(session, requestId, frame);
  clearOutbox(session.agent_group_id, session.id, requestId);
}

/** A delivery replayed after a restart finds its first answer and asks nothing again. */
async function alreadyAnswered(session: Session, requestId: string): Promise<boolean> {
  return (
    (await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      mailbox.hasMessage(`action-resp-${requestId}`),
    )) === true
  );
}

async function heldAlready(session: Session, action: string, payload: Record<string, unknown>): Promise<boolean> {
  return (
    (await getDb().get<{ approval_id: string }>(
      'SELECT approval_id FROM pending_approvals WHERE action = ? AND session_id = ? AND payload = ?',
      action,
      session.id,
      JSON.stringify(payload),
    )) !== undefined
  );
}

function authorizationHost(signIn: SignInServer): string {
  return new URL(signIn.server.authorizationEndpoint).hostname;
}

function signInLine(method: SignInMethod): string {
  switch (method.kind) {
    case 'none':
      return 'It asks for no sign-in.';
    case 'token':
      return 'It signs in with a token you would enter on your Connections page.';
    case 'oauth':
      return `You would sign in at ${authorizationHost(method.signIn)}.`;
  }
}

function signInHost(method: SignInMethod): string {
  switch (method.kind) {
    case 'none':
      return 'none';
    case 'token':
      return 'token';
    case 'oauth':
      return authorizationHost(method.signIn);
  }
}

function payloadOf(approval: PendingApproval): Record<string, unknown> {
  const parsed: unknown = JSON.parse(approval.payload);
  return isRecord(parsed) ? parsed : {};
}

function hostText(url: unknown): string {
  return (typeof url === 'string' ? hostOf(url) : undefined) ?? 'an unreadable address';
}

function reasonSuffix(reason: string | undefined): string {
  return reason ? `, saying ${JSON.stringify(reason)}` : '';
}

registerApprovalHandler(ADD_APP_ACTION, reenterGuardedDeliveryAction(ADD_APP_ACTION), {
  restartSafe: true,
  rejectionNote: (approval, reason) =>
    `The principal declined adding the app at ${hostText(payloadOf(approval).url)}${reasonSuffix(reason)}. Nothing was added.`,
});
registerApprovalHandler(DELETE_APP_ACTION, reenterGuardedDeliveryAction(DELETE_APP_ACTION), {
  restartSafe: true,
  rejectionNote: (approval, reason) =>
    `The principal declined deleting the app ${String(payloadOf(approval).app)}${reasonSuffix(reason)}. It stays as it was.`,
});

function needsText(app: ConnectionApp): string {
  switch (app.auth) {
    case 'oauth':
      return app.hasClient
        ? 'they sign in to it there'
        : "they enter client details from the app's service there, then sign in";
    case 'token':
      return 'they enter a token for it there';
    case 'none':
      return 'they connect it there';
  }
}

async function defaultContext(): Promise<AppActionContext | AppsUnavailable> {
  const web = await readWebPolicy();
  if (web.status === 'disabled') return 'operator_needed';
  if (web.status !== 'enabled') return 'unavailable';
  let store: ConnectionsStore;
  try {
    store = await getConnectionsStore();
    if (!(await store.availability()).available) return 'unavailable';
  } catch (error) {
    if (error instanceof ConnectionsStoreError) return 'unavailable';
    throw error;
  }
  const webHostname = web.config.hostname;
  return {
    store,
    operations: new ConnectionOperations({ store, webHostname, clientDocumentsServed }),
    admission: admissionDependencies(store),
    oauth: { assistantHost: webHostname },
  };
}

export function createAppActions(dependencies: AppActionDependencies) {
  const writeNote = dependencies.writeNote ?? writeNoteForMain;

  /** Validation that answers the tool before any guard runs; an approved replay passes it the same way. */
  function precheck(parse: (content: Record<string, unknown>, requestId: string) => unknown) {
    return async (content: Record<string, unknown>, session: Session): Promise<boolean> => {
      const requestId = requestIdOf(content);
      if (requestId === undefined) {
        log.warn('App request without a request id: nothing to answer', { sessionId: session.id });
        return false;
      }
      try {
        parse(content, requestId);
        return true;
      } catch (error) {
        if (!(error instanceof ActionRefusal)) throw error;
        await answer(session, requestId, refusal(requestId, error));
        return false;
      }
    };
  }

  async function onDeny(content: Record<string, unknown>, session: Session, reason: string): Promise<void> {
    const requestId = requestIdOf(content);
    if (requestId !== undefined) await answer(session, requestId, refusal(requestId, forbidden(reason)));
  }

  async function hold(
    session: Session,
    request: { readonly requestId: string },
    action: string,
    payload: Record<string, unknown>,
    card: { readonly title: string; readonly question: string; readonly facts: Record<string, string> },
  ): Promise<void> {
    if (!(await heldAlready(session, action, payload))) {
      const approverUserId = await principalApproverUserId();
      const approvalId =
        approverUserId &&
        (await requestApproval({
          session,
          agentName: 'Assistant',
          action,
          payload,
          title: card.title,
          question: card.question,
          details: { facts: card.facts },
          approverUserId,
        }));
      if (!approvalId) {
        await answer(
          session,
          request.requestId,
          refusal(request.requestId, forbidden('The request could not reach the principal, so nothing changed.')),
        );
        return;
      }
    }
    await answer(session, request.requestId, {
      id: request.requestId,
      ok: true,
      data: { status: 'awaiting_principal' },
    });
  }

  /** Main reads how an approved request ended; a store that fails part way leaves it to check before asking again. */
  async function noteSettled(
    session: Session,
    requestId: string,
    note: {
      readonly kind: 'add' | 'delete';
      readonly settle: () => Promise<string>;
      readonly unfinished: string;
      readonly wake: boolean;
    },
  ): Promise<void> {
    let text: string;
    try {
      text = await note.settle();
    } catch (error) {
      if (!(error instanceof ConnectionsStoreError)) throw error;
      log.warn(`Approved app ${note.kind} did not finish`, { code: error.reason });
      text = note.unfinished;
    }
    await writeNote({
      id: `connection-${note.kind}:${session.id}:${requestId}`,
      timestamp: new Date().toISOString(),
      text,
      wake: note.wake,
    });
  }

  async function requestAddHold(content: Record<string, unknown>, session: Session): Promise<void> {
    const request = addRequest(content, requestIdOf(content) ?? '');
    if (await alreadyAnswered(session, request.requestId)) return;
    const refuse = (reason: AddAnswer) =>
      answer(session, request.requestId, refusal(request.requestId, forbidden(ADD_REFUSED[reason])));
    const context = await dependencies.context();
    if (typeof context === 'string') return refuse(context);
    if ((await context.store.apps()).some((app) => nameKey(app.name) === nameKey(request.name)))
      return refuse('duplicate_name');
    const admission = await admitAppUrl(request.url, context.admission);
    if (!admission.admitted) return refuse(admission.reason);
    const probe = await probeApp(admission.url, context.oauth);
    if (probe.status !== 'ok') return refuse(probe.status);
    const payload = { action: ADD_APP_ACTION, requestId: request.requestId, url: admission.url, name: request.name };
    await hold(session, request, ADD_APP_ACTION, payload, {
      title: 'Add this app?',
      question: [
        `I'd like to add an app at ${admission.host}.`,
        signInLine(probe.method),
        `The name I gave it: ${quoted(request.name, NAME_MAX)}`,
        "Your operator hasn't reviewed this server, and I'll send it information when I use it.",
      ].join('\n'),
      facts: { host: admission.host, sign_in: signInHost(probe.method), name: request.name },
    });
  }

  /** What main reads once an approved add has run: the app as it now stands, or why it was not added. */
  async function settleAdd(request: AddRequest): Promise<string> {
    const host = hostText(request.url);
    const approved = `The principal approved adding ${JSON.stringify(request.name)} at ${host}`;
    const context = await dependencies.context();
    if (typeof context === 'string') return `${approved}, but it could not be added: ${ADD_REFUSED[context]}`;
    // A replay after a restart finds the app its first run stored; so does an add the principal made meanwhile.
    let app = await context.store.byHost(host);
    if (app?.url !== request.url) {
      const added = await context.operations.add({ url: request.url, name: request.name });
      if (added.status === 'refused') return `${approved}, but it could not be added: ${ADD_REFUSED[added.reason]}`;
      app = added.app;
    }
    const listed = `${approved}. It is on their Connections page as ${JSON.stringify(app.name)}`;
    if (app.status === 'connected') return `${listed}, connected; its tools reach you by their next message.`;
    if (app.auth === 'none') {
      const connected = await context.operations.connect(app.id, app.version);
      if (connected.status === 'connected') return `${listed}, connected; its tools reach you by their next message.`;
      return `${listed}, not connected yet: ${CONNECT_REFUSED[connected.reason]}. Send them the Connections link from principal_page; ${needsText(app)}.`;
    }
    return `${listed}, not connected yet. Send them the Connections link from principal_page; ${needsText(app)}.`;
  }

  const applyAdd: GuardedDeliveryHandler = async (content, session) => {
    const request = addRequest(content, requestIdOf(content) ?? '');
    await noteSettled(session, request.requestId, {
      kind: 'add',
      settle: () => settleAdd(request),
      unfinished: `The principal approved adding ${JSON.stringify(request.name)} at ${hostText(request.url)}, but it could not be finished right now. Check principal_page connections before asking again.`,
      wake: true,
    });
  };

  async function requestDeleteHold(content: Record<string, unknown>, session: Session): Promise<void> {
    const request = deleteRequest(content, requestIdOf(content) ?? '');
    if (await alreadyAnswered(session, request.requestId)) return;
    const refuse = (reason: DeleteAnswer) =>
      answer(session, request.requestId, refusal(request.requestId, forbidden(DELETE_REFUSED[reason])));
    const context = await dependencies.context();
    if (typeof context === 'string') return refuse(context);
    const app = (await context.store.apps()).find(({ serverKey }) => serverKey === request.app);
    if (!app) {
      const { operators } = await context.operations.listing();
      return refuse(operators.some(({ key }) => key === request.app) ? 'operator_server' : 'not_found');
    }
    const payload = { action: DELETE_APP_ACTION, requestId: request.requestId, app: app.serverKey, id: app.id };
    await hold(session, request, DELETE_APP_ACTION, payload, {
      title: 'Delete this app?',
      question: [
        `I'd like to delete your app at ${app.host}, named ${quoted(app.name, NAME_MAX)}.`,
        'It would be disconnected and removed from your Connections page.',
      ].join('\n'),
      facts: { host: app.host, name: app.name },
    });
  }

  async function settleDelete(request: DeleteRequest): Promise<string> {
    const context = await dependencies.context();
    if (typeof context === 'string')
      return `The principal approved deleting the app ${request.app}, but it could not be deleted: ${DELETE_REFUSED[context]}`;
    const app = (await context.store.apps()).find(
      ({ id, serverKey }) => id === request.id && serverKey === request.app,
    );
    if (!app) return `The principal approved deleting the app ${request.app}; it was already gone.`;
    const approved = `The principal approved deleting ${JSON.stringify(app.name)} at ${app.host}`;
    await context.operations.remove(app.id, app.version);
    return `${approved}. It is deleted, and its tools leave you by their next message.`;
  }

  const applyDelete: GuardedDeliveryHandler = async (content, session) => {
    const request = deleteRequest(content, requestIdOf(content) ?? '');
    await noteSettled(session, request.requestId, {
      kind: 'delete',
      settle: () => settleDelete(request),
      unfinished: `The principal approved deleting the app ${request.app}, but it could not be finished right now. Check principal_page connections before asking again.`,
      wake: false,
    });
  };

  const addSpec: DeliveryGuardSpec = {
    guardAction: addAppGuard,
    precheck: precheck(addRequest),
    requestHold: requestAddHold,
    onDeny,
  };
  const deleteSpec: DeliveryGuardSpec = {
    guardAction: deleteAppGuard,
    precheck: precheck(deleteRequest),
    requestHold: requestDeleteHold,
    onDeny,
  };
  return {
    add: { handler: applyAdd, spec: addSpec },
    delete: { handler: applyDelete, spec: deleteSpec },
  };
}

/** Main's two app actions; their approvals resume through the registrations above. */
export function registerAppActions(dependencies: AppActionDependencies = { context: defaultContext }): void {
  const actions = createAppActions(dependencies);
  registerDeliveryAction(ADD_APP_ACTION, actions.add.handler, actions.add.spec);
  registerDeliveryAction(DELETE_APP_ACTION, actions.delete.handler, actions.delete.spec);
}
