import {
  escapeHtml,
  icon,
  renderBackLink,
  renderBadge,
  renderCopyButton,
  renderEmptyState,
  renderMenu,
  renderPageHeading,
  renderPrincipalPage,
  type BadgeTone,
  type Shell,
} from '../gws-ea-web/kit/index.js';
import { hostOf } from './admit.js';
import type { OperatorServer } from './apply.js';
import type { ConnectionsListing } from './operations.js';
import { operatorServerHost } from './operator.js';
import { CONNECTIONS_PAGE_SCRIPT } from './page-client.js';
import { NAME_MAX, type AppStatus, type ConnectionApp } from './store.js';

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
  /** The operator server whose disconnect just stopped part way, and the host the principal confirmed for it. */
  readonly retryServer?: { readonly key: string; readonly host: string };
}

const STATUS_LABELS = {
  connected: 'Connected',
  needs_reconnecting: 'Needs reconnecting',
  not_connected: 'Not connected',
} satisfies Record<AppStatus, string>;

const STATUS_TONES = {
  connected: 'success',
  needs_reconnecting: 'warning',
  not_connected: 'neutral',
} satisfies Record<AppStatus, BadgeTone>;

const UNAVAILABLE = 'Apps can’t be added or connected right now. Ask your operator.';

function appUrl(app: Pick<ConnectionApp, 'id'>, action: 'connect' | 'rename'): string {
  return `/connections/app/${encodeURIComponent(app.id)}/${action}`;
}

const BACK = renderBackLink('/connections', 'Connections');

function addLink(): string {
  return `<a class="button button-primary" href="/connections/new" data-navigation>${icon('plus')}<span class="button-label">Add app</span></a>`;
}

function hiddenApp(app: ConnectionApp): string {
  return `<input type="hidden" name="id" value="${escapeHtml(app.id)}"><input type="hidden" name="version" value="${app.version}">`;
}

function statusBadge(status: AppStatus): string {
  return renderBadge(STATUS_LABELS[status], STATUS_TONES[status]);
}

function notice(text: string): string {
  return `<p class="notice">${icon('shield')}<span>${text}</span></p>`;
}

function menuForm(action: string, app: ConnectionApp, label: string, pending: string, confirm?: string): string {
  return `<form method="post" action="${action}" data-send${confirm ? ` ${confirm}` : ''}>${hiddenApp(app)}<button type="submit" role="menuitem" tabindex="-1" data-pending-label="${pending}"${confirm ? ' data-danger' : ''}>${label}</button></form>`;
}

/** Delete also forgets client details the principal may have registered elsewhere, so it asks; Disconnect is undone by Connect. */
function deleteConfirmation(app: ConnectionApp): string {
  return `data-confirm-title="${escapeHtml(`Delete ${app.name}?`)}" data-confirm-action="Delete app" data-confirm-message="Your assistant will stop using it, and its sign-in and any client details you entered will be forgotten. You can add it again later."`;
}

function appMenu(app: ConnectionApp, index: number): string {
  const items = [
    `<a role="menuitem" tabindex="-1" href="${escapeHtml(appUrl(app, 'rename'))}" data-navigation>Rename</a>`,
    ...(app.status === 'not_connected'
      ? []
      : [menuForm('/connections/disconnect', app, 'Disconnect', 'Disconnecting…')]),
    menuForm('/connections/delete', app, 'Delete', 'Deleting…', deleteConfirmation(app)),
  ];
  return renderMenu(`app-menu-${index}`, `More for ${app.name}`, items, app.name);
}

function appRow(app: ConnectionApp, index: number, canChange: boolean): string {
  const connect =
    canChange && app.status !== 'connected'
      ? `<a class="button button-secondary row-button" href="${escapeHtml(appUrl(app, 'connect'))}" data-navigation>${app.status === 'needs_reconnecting' ? 'Reconnect' : 'Connect'}</a>`
      : '';
  return `<li class="row app-row"><span class="row-main"><span class="row-title">${escapeHtml(app.name)}</span><span class="row-sub">${escapeHtml(app.host)}</span></span>${statusBadge(app.status)}${connect}${appMenu(app, index)}</li>`;
}

/** The page names the host it showed, and the host disconnects only if main's entry still points there. */
function hiddenServer(server: OperatorServer): string {
  return `<input type="hidden" name="key" value="${escapeHtml(server.key)}"><input type="hidden" name="host" value="${escapeHtml(operatorServerHost(server) ?? '')}">`;
}

/** Names the server and its host only; which gateway credentials go is never shown. */
function operatorConfirmation(server: OperatorServer): string {
  const host = operatorServerHost(server);
  const access = host ? `, and its saved access to ${host} will be deleted` : '';
  return `data-confirm-title="${escapeHtml(`Disconnect ${server.key}?`)}" data-confirm-action="Disconnect" data-confirm-message="${escapeHtml(`Your assistant will stop using it${access}. Your operator can add it back.`)}"`;
}

function operatorAction(server: OperatorServer, index: number, state: ConnectionsPageState): string {
  if (!state.operatorDisconnect) return '<span class="row-note">Can’t disconnect</span>';
  // The principal already confirmed this disconnect, so trying again does not ask a second time, unless the entry
  // now points at a host other than the one they confirmed.
  if (state.retryServer?.key === server.key && state.retryServer.host === (operatorServerHost(server) ?? ''))
    return `<form method="post" action="/connections/disconnect-operator" data-send>${hiddenServer(server)}<button class="button button-secondary row-button" type="submit" data-pending-label="Disconnecting…">Try again</button></form>`;
  return renderMenu(
    `operator-menu-${index}`,
    `More for ${server.key}`,
    [
      `<form method="post" action="/connections/disconnect-operator" data-send ${operatorConfirmation(server)}>${hiddenServer(server)}<button type="submit" role="menuitem" tabindex="-1" data-pending-label="Disconnecting…" data-danger>Disconnect</button></form>`,
    ],
    server.key,
  );
}

/** Only the host is shown: an operator's address can carry a credential in its query. */
function operatorRow(server: OperatorServer, index: number, state: ConnectionsPageState): string {
  const host = operatorServerHost(server);
  return `<li class="row app-row"><span class="row-main"><span class="row-title">${escapeHtml(server.key)}</span>${host ? `<span class="row-sub">${escapeHtml(host)}</span>` : ''}</span>${statusBadge('connected')}${operatorAction(server, index, state)}</li>`;
}

function section(id: string, title: string | undefined, rows: readonly string[]): string {
  const heading = title ? `<h2 class="section-title" id="${id}">${title}</h2>` : '';
  return `<section class="section"${title ? ` aria-labelledby="${id}"` : ' aria-label="Your apps"'}>${heading}<ul class="list">${rows.join('')}</ul></section>`;
}

function appList(state: ConnectionsPageState): string {
  const { apps, operators, canChange } = state.listing;
  const unavailable = canChange ? '' : notice(UNAVAILABLE);
  if (apps.length === 0 && operators.length === 0)
    return `${renderPageHeading('Connections')}${unavailable}${renderEmptyState('No apps yet', 'apps', canChange ? addLink() : '')}`;
  // Your own apps need no label of their own unless your operator's are listed beside them.
  return `${renderPageHeading('Connections', '', canChange ? addLink() : '')}${unavailable}${
    apps.length
      ? section(
          'added-heading',
          operators.length ? 'Your apps' : undefined,
          apps.map((app, index) => appRow(app, index, canChange)),
        )
      : ''
  }${
    operators.length
      ? section(
          'operator-heading',
          'Added by your operator',
          operators.map((server, index) => operatorRow(server, index, state)),
        )
      : ''
  }`;
}

function actions(label: string, pending: string): string {
  return `<div class="form-actions"><button class="button button-primary" type="submit" data-pending-label="${pending}">${escapeHtml(label)}</button><a class="button button-secondary" href="/connections" data-navigation>Cancel</a></div>`;
}

function addForm(state: ConnectionsPageState): string {
  const heading = `${BACK}${renderPageHeading('Add app')}`;
  if (!state.listing.canChange) return `${heading}${notice(UNAVAILABLE)}`;
  return `${heading}<form method="post" action="/connections/add" data-send><div class="field"><label for="url">Server address</label><input id="url" name="url" type="url" inputmode="url" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="https://example.com/mcp" required></div><div class="field"><label for="name">Name <span class="optional" aria-hidden="true">Optional</span></label><input id="name" name="name" type="text" maxlength="${NAME_MAX}" autocomplete="off" value="${escapeHtml(state.addName ?? '')}" placeholder="Uses the app’s own name"></div>${actions('Add app', 'Checking…')}</form>`;
}

function trustNotice(app: ConnectionApp): string {
  return notice(
    `<strong>Connect only apps you trust.</strong> Your operator hasn’t reviewed ${escapeHtml(app.host)}, and your assistant will send it information to use its tools.`,
  );
}

/** A server can reject a client on its own page without ever returning, so the entered details stay changeable. */
function changeClientForm(app: ConnectionApp): string {
  return `<form class="change-client" method="post" action="/connections/change-client" data-send>${hiddenApp(app)}<button class="button button-quiet" type="submit" data-pending-label="Removing…">Change client details</button></form>`;
}

function connectForm(app: ConnectionApp, state: ConnectionsPageState): string {
  const signInHost = (app.issuer === null ? undefined : hostOf(app.issuer)) ?? app.host;
  const signIn = `Continue to ${signInHost}`;
  switch (app.auth) {
    case 'none':
      return `<form method="post" action="/connections/connect" data-send>${hiddenApp(app)}${trustNotice(app)}${actions('Connect', 'Connecting…')}</form>`;
    case 'token':
      return `<form method="post" action="/connections/connect" data-send>${hiddenApp(app)}<div class="field"><label for="token">Access token</label><input id="token" name="token" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" required></div>${trustNotice(app)}${actions('Connect', 'Checking…')}</form>`;
    case 'oauth':
      if (app.hasClient)
        return `<form method="post" action="/connections/sign-in" data-sign-in>${hiddenApp(app)}${trustNotice(app)}${actions(signIn, 'Opening sign-in…')}</form>${app.clientEntered ? changeClientForm(app) : ''}`;
      return `<form method="post" action="/connections/sign-in" data-sign-in>${hiddenApp(app)}<ol class="steps"><li><h2>Register this redirect URI with ${escapeHtml(signInHost)}</h2><div class="redirect"><code id="redirect-uri">${escapeHtml(state.redirectUri(app))}</code>${renderCopyButton('redirect-uri', 'Copy redirect URI')}</div></li><li><h2>Enter the client details it gives you</h2><div class="field"><label for="client-id">Client ID</label><input id="client-id" name="clientId" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" required></div><div class="field"><label for="client-secret">Client secret <span class="optional" aria-hidden="true">Optional</span></label><input id="client-secret" name="clientSecret" type="password" autocomplete="off" autocapitalize="none" spellcheck="false"></div></li></ol>${trustNotice(app)}${actions(signIn, 'Opening sign-in…')}</form>`;
  }
}

function appMissing(): string {
  return `${BACK}${renderEmptyState('This app is no longer here', 'apps', '<a class="button button-secondary" href="/connections" data-navigation>See all apps</a>')}`;
}

function connectView(app: ConnectionApp, state: ConnectionsPageState): string {
  const heading = `${BACK}${renderPageHeading(`Connect ${app.name}`, `<span>${escapeHtml(app.host)}</span>${statusBadge(app.status)}`)}`;
  if (app.status === 'connected') return `${heading}${notice('This app is connected.')}`;
  if (!state.listing.canChange) return `${heading}${notice(UNAVAILABLE)}`;
  return `${heading}${connectForm(app, state)}`;
}

function renameView(app: ConnectionApp): string {
  return `${BACK}${renderPageHeading('Rename app', `<span>${escapeHtml(app.host)}</span>`)}<form method="post" action="/connections/rename" data-send data-track-changes>${hiddenApp(app)}<div class="field"><label for="name">Name</label><input id="name" name="name" type="text" maxlength="${NAME_MAX}" autocomplete="off" required value="${escapeHtml(app.name)}"></div><div class="form-actions"><button class="button button-primary" type="submit">Save name</button><a class="button button-secondary" href="/connections" data-navigation>Cancel</a></div></form>`;
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
.row-button { padding-inline: 14px; font-size: 13px; }
.steps { margin: 0; padding: 0; list-style: none; counter-reset: step; }
.steps > li { position: relative; padding-left: 36px; counter-increment: step; }
.steps > li + li { margin-top: 28px; }
.steps > li::before { content: counter(step); position: absolute; left: 0; top: -1px; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: var(--accent-soft); color: var(--accent-text); font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.steps h2 { margin-bottom: 12px; font-size: 14px; font-weight: 500; overflow-wrap: anywhere; }
.redirect { display: flex; align-items: center; gap: 8px; padding: 4px 4px 4px 14px; border-radius: 12px; background: var(--fill); }
.redirect code { flex: 1; min-width: 0; padding-block: 8px; font: 13px/1.5 ui-monospace, "SF Mono", monospace; }
.redirect .button { background: var(--surface); box-shadow: 0 0 0 1px var(--line); }
.change-client { margin-top: 12px; }
.change-client .button { margin-left: -16px; }
@media (max-width: 719px) {
  .app-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 6px 4px; align-items: center; }
  .app-row > .row-main { padding-right: 4px; }
  .app-row > .row-main { grid-column: 1; grid-row: 1; }
  .app-row > .badge { grid-column: 1; grid-row: 2; justify-self: start; }
  .app-row > .row-button, .app-row > form { grid-column: 2; grid-row: 1 / span 2; }
  .app-row > .menu, .app-row > .row-note { grid-column: 3; grid-row: 1 / span 2; }
  .steps h2 { font-size: 15px; }
  .change-client .button { margin: 0; width: 100%; }
  .redirect { flex-direction: column; align-items: stretch; padding: 4px; }
  .redirect code { padding-inline: 10px; }
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
      noscript: 'Turn on JavaScript to add, connect or change an app.',
      style: STYLE,
      script: CONNECTIONS_PAGE_SCRIPT,
    },
    nonce,
  );
}
