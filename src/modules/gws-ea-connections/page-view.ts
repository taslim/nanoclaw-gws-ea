import {
  escapeHtml,
  icon,
  renderCopyButton,
  renderMenu,
  renderPrincipalPage,
  type Shell,
} from '../gws-ea-web/kit/index.js';
import type { OperatorServer } from './apply.js';
import type { ConnectionsListing } from './operations.js';
import { operatorServerHost } from './operator.js';
import { CONNECTIONS_PAGE_SCRIPT } from './page-client.js';
import type { AppStatus, ConnectionApp } from './store.js';

export type ConnectionsView =
  | { readonly kind: 'list' }
  | { readonly kind: 'add' }
  | { readonly kind: 'connect' | 'rename'; readonly id: string };

export interface ConnectionsPageState {
  readonly view: ConnectionsView;
  readonly listing: ConnectionsListing;
  readonly outcome: string;
  readonly error: boolean;
  /** The name a refused add is redisplayed with; the address never is, since it may carry a credential. */
  readonly addName?: string;
  readonly redirectUri: (app: ConnectionApp) => string;
  /** The gateway can find and remove an operator server's credentials, so Disconnect is offered. */
  readonly operatorDisconnect: boolean;
  /** The operator server whose disconnect just stopped part way, offered again as Retry. */
  readonly retryServer?: string;
}

const STATUS_LABELS = {
  connected: 'Connected',
  needs_reconnecting: 'Needs reconnecting',
  not_connected: 'Not connected',
} satisfies Record<AppStatus, string>;

const UNAVAILABLE = 'Apps can’t be added or connected right now. Ask your operator.';

function appUrl(app: Pick<ConnectionApp, 'id'>, action: 'connect' | 'rename'): string {
  return `/connections/app/${encodeURIComponent(app.id)}/${action}`;
}

function hostOf(url: string | null): string | undefined {
  return url === null ? undefined : (URL.parse(url)?.hostname ?? undefined);
}

function pageHeading(title: string, metadata = '', action = ''): string {
  return `<div class="page-heading"><div><h1>${escapeHtml(title)}</h1>${metadata ? `<p class="page-metadata">${metadata}</p>` : ''}</div>${action}</div>`;
}

function backLink(): string {
  return `<a class="back-link" href="/connections" data-navigation>${icon('back')}All apps</a>`;
}

function addLink(): string {
  return `<a class="button button-primary" href="/connections/new" data-navigation>${icon('plus')}Add app</a>`;
}

function hiddenApp(app: ConnectionApp): string {
  return `<input type="hidden" name="id" value="${escapeHtml(app.id)}"><input type="hidden" name="version" value="${app.version}">`;
}

function statusBadge(status: AppStatus): string {
  return `<span class="status status-${status.replace('_', '-')}">${STATUS_LABELS[status]}</span>`;
}

function menuForm(action: string, app: ConnectionApp, label: string, pending: string, danger = false): string {
  return `<form method="post" action="${action}" data-send>${hiddenApp(app)}<button type="submit" role="menuitem" tabindex="-1" data-pending-label="${pending}"${danger ? ' data-danger' : ''}>${label}</button></form>`;
}

function appMenu(app: ConnectionApp, index: number, canChange: boolean): string {
  const items = [
    ...(canChange && app.status !== 'connected'
      ? [`<a role="menuitem" tabindex="-1" href="${escapeHtml(appUrl(app, 'connect'))}" data-navigation>Connect</a>`]
      : []),
    `<a role="menuitem" tabindex="-1" href="${escapeHtml(appUrl(app, 'rename'))}" data-navigation>Rename</a>`,
    ...(app.status === 'not_connected'
      ? []
      : [menuForm('/connections/disconnect', app, 'Disconnect', 'Disconnecting…')]),
    menuForm('/connections/delete', app, 'Delete', 'Deleting…', true),
  ];
  return renderMenu(`app-menu-${index}`, `Actions for ${app.name}`, items);
}

function appRow(app: ConnectionApp, index: number, canChange: boolean): string {
  return `<li class="app-row"><span class="app-identity"><span class="app-name">${escapeHtml(app.name)}</span><span class="app-host">${escapeHtml(app.host)}</span></span>${statusBadge(app.status)}${appMenu(app, index, canChange)}</li>`;
}

/** The page names the host it showed, and the host disconnects only if main's entry still points there. */
function hiddenServer(server: OperatorServer): string {
  return `<input type="hidden" name="key" value="${escapeHtml(server.key)}"><input type="hidden" name="host" value="${escapeHtml(operatorServerHost(server) ?? '')}">`;
}

/** Names the server and its host only; which gateway credentials go is never shown. */
function operatorConfirmation(server: OperatorServer): string {
  const host = operatorServerHost(server);
  const access = host ? ` and deletes its saved access to ${host}` : '';
  return `data-confirm-title="${escapeHtml(`Disconnect ${server.key}?`)}" data-confirm-action="Disconnect" data-confirm-message="${escapeHtml(`This removes it from your assistant${access}. Your operator can add it back.`)}"`;
}

function operatorAction(server: OperatorServer, index: number, state: ConnectionsPageState): string {
  if (!state.operatorDisconnect) return '<span class="row-note">Disconnect unavailable</span>';
  // The principal already confirmed this disconnect, so trying again does not ask a second time.
  if (state.retryServer === server.key)
    return `<form class="row-action" method="post" action="/connections/disconnect-operator" data-send>${hiddenServer(server)}<button class="button button-secondary" type="submit" data-pending-label="Disconnecting…">Retry</button></form>`;
  return renderMenu(`operator-menu-${index}`, `Actions for ${server.key}`, [
    `<form method="post" action="/connections/disconnect-operator" data-send ${operatorConfirmation(server)}>${hiddenServer(server)}<button type="submit" role="menuitem" tabindex="-1" data-pending-label="Disconnecting…" data-danger>Disconnect</button></form>`,
  ]);
}

/** Only the host is shown: an operator's address can carry a credential in its query. */
function operatorRow(server: OperatorServer, index: number, state: ConnectionsPageState): string {
  const host = operatorServerHost(server);
  return `<li class="app-row"><span class="app-identity"><span class="app-name">${escapeHtml(server.key)}</span>${host ? `<span class="app-host">${escapeHtml(host)}</span>` : ''}</span>${statusBadge('connected')}${operatorAction(server, index, state)}</li>`;
}

function section(id: string, title: string, rows: readonly string[]): string {
  return `<section class="app-section" aria-labelledby="${id}"><h2 id="${id}">${title}</h2><ul class="app-list">${rows.join('')}</ul></section>`;
}

function appList(state: ConnectionsPageState): string {
  const { apps, operators, canChange } = state.listing;
  const notice = canChange ? '' : `<p class="notice">${UNAVAILABLE}</p>`;
  if (apps.length === 0 && operators.length === 0)
    return `${pageHeading('Connections')}${notice}<section class="empty-state"><span class="empty-icon">${icon('plus')}</span><h2>No apps yet.</h2><p class="empty-copy">Connect the apps you use so your assistant can work with them. Add an app by its address.</p>${canChange ? addLink() : ''}</section>`;
  return `${pageHeading('Connections', '', canChange ? addLink() : '')}${notice}${
    apps.length
      ? section(
          'added-heading',
          'Added by you',
          apps.map((app, index) => appRow(app, index, canChange)),
        )
      : ''
  }${
    operators.length
      ? section(
          'operator-heading',
          'From your operator',
          operators.map((server, index) => operatorRow(server, index, state)),
        )
      : ''
  }`;
}

function addForm(state: ConnectionsPageState): string {
  const heading = `${backLink()}${pageHeading('Add app')}`;
  if (!state.listing.canChange) return `${heading}<p class="notice">${UNAVAILABLE}</p>`;
  return `${heading}<section class="panel form-panel"><form method="post" action="/connections/add" data-send><div class="field"><label for="url">Address</label><input id="url" name="url" type="url" inputmode="url" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="https://example.com/mcp" required aria-describedby="url-hint"><p class="field-hint" id="url-hint">The app’s MCP server address. Leave out any token or key; you can enter one when you connect.</p></div><div class="field"><label for="name">Name <span class="optional" aria-hidden="true">Optional</span></label><input id="name" name="name" type="text" maxlength="100" autocomplete="off" value="${escapeHtml(state.addName ?? '')}" aria-describedby="name-hint"><p class="field-hint" id="name-hint">Leave blank to use the name the app gives itself.</p></div><div class="form-actions"><button class="button button-primary" type="submit" data-pending-label="Checking…">Add app</button><a class="button button-secondary" href="/connections" data-navigation>Cancel</a></div></form></section>`;
}

function trustNotice(app: ConnectionApp): string {
  return `<p class="trust-notice">Your operator hasn’t reviewed ${escapeHtml(app.host)}. Once it’s connected, your assistant will send it information to use its tools. Connect only apps you trust.</p>`;
}

function connectForm(app: ConnectionApp, state: ConnectionsPageState): string {
  const signInHost = hostOf(app.issuer) ?? app.host;
  const submit = (label: string, pending: string) =>
    `<div class="form-actions"><button class="button button-primary" type="submit" data-pending-label="${pending}">${label}</button><a class="button button-secondary" href="/connections" data-navigation>Cancel</a></div>`;
  switch (app.auth) {
    case 'none':
      return `<p class="sign-in">${escapeHtml(app.host)} doesn’t ask you to sign in.</p><form method="post" action="/connections/connect" data-send>${hiddenApp(app)}${submit('Connect', 'Connecting…')}</form>`;
    case 'token':
      return `<form method="post" action="/connections/connect" data-send>${hiddenApp(app)}<div class="field"><label for="token">Access token</label><input id="token" name="token" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" required aria-describedby="token-hint"><p class="field-hint" id="token-hint">A token ${escapeHtml(app.host)} issued for your account. Your assistant checks it once and never shows it again.</p></div>${submit('Connect', 'Checking…')}</form>`;
    case 'oauth':
      if (app.hasClient)
        return `<p class="sign-in">You’ll sign in on ${escapeHtml(signInHost)}.</p><form method="post" action="/connections/sign-in" data-sign-in>${hiddenApp(app)}${submit('Continue to sign in', 'Opening sign-in…')}</form>`;
      return `<p class="sign-in">${escapeHtml(signInHost)} needs a client registered for your assistant. Register this redirect URI with it, then enter the client details it gives you. You’ll sign in on ${escapeHtml(signInHost)}.</p><div class="redirect"><code id="redirect-uri">${escapeHtml(state.redirectUri(app))}</code>${renderCopyButton('redirect-uri', 'Copy redirect URI')}</div><form method="post" action="/connections/sign-in" data-sign-in>${hiddenApp(app)}<div class="field"><label for="client-id">Client ID</label><input id="client-id" name="clientId" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" required></div><div class="field"><label for="client-secret">Client secret <span class="optional" aria-hidden="true">Optional</span></label><input id="client-secret" name="clientSecret" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="client-secret-hint"><p class="field-hint" id="client-secret-hint">Leave blank if ${escapeHtml(signInHost)} gave you no secret.</p></div>${submit('Continue to sign in', 'Opening sign-in…')}</form>`;
  }
}

function appMissing(): string {
  return `${backLink()}${pageHeading('App unavailable')}<a class="button button-secondary" href="/connections" data-navigation>View your apps</a>`;
}

function connectView(app: ConnectionApp, state: ConnectionsPageState): string {
  const heading = `${backLink()}${pageHeading(`Connect ${app.name}`, `${escapeHtml(app.host)} · ${statusBadge(app.status)}`)}`;
  if (app.status === 'connected') return `${heading}<p class="notice">This app is connected.</p>`;
  if (!state.listing.canChange) return `${heading}<p class="notice">${UNAVAILABLE}</p>`;
  return `${heading}<section class="panel form-panel"><div class="connect-body">${trustNotice(app)}${connectForm(app, state)}</div></section>`;
}

function renameView(app: ConnectionApp): string {
  return `${backLink()}${pageHeading('Rename app', escapeHtml(app.host))}<section class="panel form-panel"><form method="post" action="/connections/rename" data-send data-track-changes>${hiddenApp(app)}<div class="field"><label for="name">Name</label><input id="name" name="name" type="text" maxlength="100" autocomplete="off" required value="${escapeHtml(app.name)}" aria-describedby="rename-hint"><p class="field-hint" id="rename-hint">Only the name changes; your assistant keeps the app’s tools.</p></div><div class="form-actions"><button class="button button-primary" type="submit">Save name</button><a class="button button-secondary" href="/connections" data-navigation>Cancel</a></div></form></section>`;
}

function pageContent(state: ConnectionsPageState): string {
  const { view } = state;
  switch (view.kind) {
    case 'list':
      return appList(state);
    case 'add':
      return addForm(state);
    case 'connect':
    case 'rename': {
      const app = state.listing.apps.find((entry) => entry.id === view.id);
      if (!app) return appMissing();
      return view.kind === 'connect' ? connectView(app, state) : renameView(app);
    }
  }
}

const STYLE = `
.page-metadata { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.notice { margin-bottom: 24px; padding: 12px 16px; border: 1px solid var(--line); border-radius: 9px; background: var(--subtle); color: var(--muted); font-size: 13px; }
.app-section + .app-section { margin-top: 32px; }
.app-section h2 { margin-bottom: 10px; padding-inline: 2px; font-size: 13px; font-weight: 500; color: var(--muted); }
.app-list { margin: 0; padding: 0; list-style: none; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; }
.app-row { display: flex; align-items: center; gap: 16px; padding: 14px 16px 14px 20px; min-height: 76px; }
.app-row + .app-row { border-top: 1px solid var(--line); }
.app-identity { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
.app-name { font-size: 15px; font-weight: 500; line-height: 1.4; letter-spacing: -.015em; overflow-wrap: anywhere; }
.app-host { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.status { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; white-space: nowrap; }
.status::before { content: ""; width: 6px; height: 6px; flex-shrink: 0; border-radius: 50%; background: var(--line); }
.status-connected::before { background: var(--success); }
.status-needs-reconnecting { color: var(--danger); }
.status-needs-reconnecting::before { background: var(--danger); }
.row-note { color: var(--muted); font-size: 12px; white-space: nowrap; }
.empty-copy { max-width: 400px; color: var(--muted); font-size: 13px; }
.connect-body { padding: 28px 28px 0; }
.connect-body form { padding: 0 0 28px; }
.trust-notice { padding: 12px 16px; border-radius: 9px; background: var(--subtle); font-size: 13px; }
.sign-in { margin-block: 20px; font-size: 13px; color: var(--muted); }
.redirect { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; padding: 10px 10px 10px 14px; border: 1px solid var(--line); border-radius: 9px; }
.redirect code { flex: 1; min-width: 0; font: 13px/1.5 ui-monospace, monospace; }
.connect-body .field:first-of-type { margin-top: 0; }
@media (max-width: 600px) {
  .app-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; padding: 14px 12px 14px 16px; }
  .app-identity { grid-column: 1; grid-row: 1; }
  .app-row > .status { grid-column: 1; grid-row: 2; }
  .app-row > .menu, .app-row > .row-action, .app-row > .row-note { grid-column: 2; grid-row: 1 / span 2; }
  .connect-body { padding: 24px 20px 0; }
  .connect-body form { padding-bottom: 24px; }
  .redirect { flex-direction: column; align-items: stretch; }
}
`;

/** Renders app metadata only; nothing sealed and no address beyond an app's own is ever an input here. */
export function renderConnectionsPage(state: ConnectionsPageState, shell: Shell, nonce: string): string {
  const titles = {
    list: 'Connections',
    add: 'Add app',
    connect: 'Connect app',
    rename: 'Rename app',
  } satisfies Record<ConnectionsView['kind'], string>;
  return renderPrincipalPage(
    {
      shell,
      page: '/connections',
      title: titles[state.view.kind],
      view: state.view.kind,
      narrow: state.view.kind !== 'list',
      outcome: state.outcome,
      error: state.error,
      content: pageContent(state),
      noscript: 'JavaScript is needed to add, connect or change an app.',
      style: STYLE,
      script: CONNECTIONS_PAGE_SCRIPT,
    },
    nonce,
  );
}
