import { formatLocalTime } from '../../timezone.js';
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
  renderSwitch,
  type BadgeTone,
  type Shell,
} from '../gws-ea-web/kit/index.js';
import { hostOf } from './admit.js';
import type { OperatorServer } from './apply.js';
import { catalogEntryFor, type AvailableCatalogEntry, type CatalogEntry } from './catalog.js';
import type { DeviceSignInFailure, DeviceSignInView } from './device-sign-in.js';
import { escapeInvisibleChars, hasAnyInvisible } from './held-card.js';
import { type HeldAppCallPayload, type PendingHeldCallItem } from './held-calls.js';
import type { ConnectionsListing } from './operations.js';
import { operatorServerHost } from './operator.js';
import { CONNECTIONS_PAGE_SCRIPT } from './page-client.js';
import {
  NAME_MAX,
  toolLabelsHash,
  type AppPin,
  type AppStatus,
  type ConnectionApp,
  type PinnedAppTool,
} from './store.js';

export type ConnectionsView =
  | { readonly kind: 'list' }
  | { readonly kind: 'add' }
  | { readonly kind: 'connect' | 'rename' | 'tools'; readonly id: string }
  | { readonly kind: 'held'; readonly approvalId: string };

export interface HeldCallViewData {
  readonly approvalId: string;
  readonly payload: HeldAppCallPayload;
  readonly timezone: string;
  readonly resolution?: 'approved' | 'declined' | 'expired' | 'already_resolved';
}

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
  readonly toolReview?: { readonly pin?: AppPin; readonly tools: readonly PinnedAppTool[] };
  readonly heldCall?: HeldCallViewData;
  /** A host-run app's sign-in as it stands, for its Connect view. */
  readonly deviceSignIn?: DeviceSignInView;
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

const ACRONYMS: Readonly<Record<string, string>> = {
  api: 'API',
  cd: 'CD',
  ci: 'CI',
  csv: 'CSV',
  eta: 'ETA',
  graphql: 'GraphQL',
  html: 'HTML',
  http: 'HTTP',
  https: 'HTTPS',
  id: 'ID',
  ids: 'IDs',
  json: 'JSON',
  mcp: 'MCP',
  oauth: 'OAuth',
  otp: 'OTP',
  pdf: 'PDF',
  pr: 'PR',
  prs: 'PRs',
  rsvp: 'RSVP',
  sms: 'SMS',
  sql: 'SQL',
  uri: 'URI',
  url: 'URL',
  urls: 'URLs',
  xml: 'XML',
};

const BOILERPLATE_REASONS: ReadonlySet<string> = new Set([
  'Set to ask first',
  'Set to run without asking',
  'Kept as ask first per your earlier choice',
]);

const UNAVAILABLE = 'Apps can’t be added or connected right now. Ask your operator.';

/** Formats a raw MCP identifier like `confirm_checkout` or `getOrderStatus` into sentence-case words. */
export function humanizeToolName(name: string): string {
  const normalized = name.replace(/graphql/giu, 'Graphql');
  const rawSegments = normalized.split(/[^A-Za-z0-9]+/u).filter((segment) => segment.length > 0);
  const words: string[] = [];
  for (const segment of rawSegments) {
    const parts = segment
      .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
      .split(/\s+/u);
    for (const part of parts) {
      if (part.length > 0) words.push(part);
    }
  }
  if (words.length === 0) return name;
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      const acronym = ACRONYMS[lower];
      if (acronym) return acronym;
      if (index === 0) return `${lower.slice(0, 1).toUpperCase()}${lower.slice(1)}`;
      return lower;
    })
    .join(' ');
}

/** Safe, sharp plain-English description of a tool for the Connections UI; never shows toggle boilerplate. */
export function toolDescription(tool: PinnedAppTool): string {
  if (tool.label === null || tool.unsettled) return '';
  if (tool.summary && tool.summary.trim().length > 0) return tool.summary.trim();
  if (tool.reason && !BOILERPLATE_REASONS.has(tool.reason)) return tool.reason;
  return '';
}

export function sortToolsForDisplay(tools: readonly PinnedAppTool[]): readonly PinnedAppTool[] {
  return [...tools].sort((left, right) => {
    const leftAsk = left.label !== 'just_do' ? 0 : 1;
    const rightAsk = right.label !== 'just_do' ? 0 : 1;
    return leftAsk - rightAsk || left.name.localeCompare(right.name);
  });
}

/** A tool the app confirms itself still runs without the assistant's card, so its off state says where it asks. */
export function autoStateText(entry: CatalogEntry | undefined, toolName: string): string {
  return entry?.confirmedByApp.includes(toolName) ? `Asks in ${entry.name}` : 'Auto';
}

function appUrl(app: Pick<ConnectionApp, 'id'>, action: 'connect' | 'rename' | 'tools'): string {
  return `/connections/app/${encodeURIComponent(app.id)}/${action}`;
}

/** A not-connected catalog app is listed with its entry under Available, and is still the principal's to open. */
export function listedApp(
  listing: ConnectionsListing,
  id: string,
): { readonly app: ConnectionApp; readonly entry?: CatalogEntry } | undefined {
  const app = listing.apps.find((candidate) => candidate.id === id);
  if (app) {
    const entry = listing.catalogEntries?.[id];
    return entry ? { app, entry } : { app };
  }
  const available = listing.available?.find((candidate) => candidate.app?.id === id);
  return available?.app ? { app: available.app, entry: available.entry } : undefined;
}

const BACK = renderBackLink('/connections', 'Connections');

function addLink(): string {
  return `<a class="button button-primary" href="/connections/new" data-navigation>${icon('plus')}<span class="button-label">Add app</span></a>`;
}

function hiddenApp(app: ConnectionApp): string {
  return `<input type="hidden" name="id" value="${escapeHtml(app.id)}"><input type="hidden" name="version" value="${app.version}">`;
}

/** A host-run app's address is a placeholder no one can visit, so the page says where it runs instead. */
function shownHost(app: ConnectionApp): string {
  return app.transport === 'host_cli' ? 'Installed by your operator' : app.host;
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
  return `data-confirm-title="${escapeHtml(`Delete ${app.name}?`)}" data-confirm-action="Delete" data-confirm-message="Your assistant will lose access, and saved sign-in and client details will be removed. You can add it again anytime."`;
}

function appMenu(app: ConnectionApp, index: number, hasPin: boolean): string {
  const items = [
    ...(app.status === 'connected' || hasPin
      ? [
          `<a role="menuitem" tabindex="-1" href="${escapeHtml(appUrl(app, 'tools'))}" data-navigation>Tool approvals</a>`,
        ]
      : []),
    `<a role="menuitem" tabindex="-1" href="${escapeHtml(appUrl(app, 'rename'))}" data-navigation>Rename</a>`,
    ...(app.status === 'not_connected'
      ? []
      : [menuForm('/connections/disconnect', app, 'Disconnect', 'Disconnecting…')]),
    menuForm('/connections/delete', app, 'Delete', 'Deleting…', deleteConfirmation(app)),
  ];
  return renderMenu(`app-menu-${index}`, `More for ${app.name}`, items, app.name);
}

function appRow(
  app: ConnectionApp,
  index: number,
  canChange: boolean,
  pin: AppPin | undefined,
  tools: readonly PinnedAppTool[] | undefined,
): string {
  const hasUnsorted =
    app.status === 'connected' && (!pin || (tools ?? []).some((tool) => tool.label === null || tool.unsettled));
  const needsReview = app.status === 'connected' && pin?.needsReview === true;
  const primaryHref =
    app.status === 'connected'
      ? appUrl(app, 'tools')
      : canChange
        ? appUrl(app, 'connect')
        : pin !== undefined
          ? appUrl(app, 'tools')
          : undefined;
  const statusPill =
    app.status === 'connected'
      ? needsReview && !hasUnsorted
        ? renderBadge('Needs review', 'warning')
        : hasUnsorted && pin
          ? renderBadge('Checking…', 'neutral')
          : statusBadge('connected')
      : statusBadge(app.status);
  const desktopAction =
    canChange && app.status !== 'connected'
      ? `<a class="button button-secondary row-button app-row-action" href="${escapeHtml(appUrl(app, 'connect'))}" data-navigation>${app.status === 'needs_reconnecting' ? 'Reconnect' : 'Connect'}</a>`
      : needsReview && !hasUnsorted
        ? `<a class="button button-secondary row-button app-row-action" href="${escapeHtml(appUrl(app, 'tools'))}" data-navigation>Review</a>`
        : '';
  const inner = `<span class="row-main"><span class="row-title">${escapeHtml(app.name)}</span><span class="row-sub app-host">${escapeHtml(shownHost(app))}</span></span><span class="app-status">${statusPill}</span>${primaryHref ? icon('arrow', 'row-chevron app-chevron') : ''}`;
  const mainSlot = primaryHref
    ? `<a class="app-link" href="${escapeHtml(primaryHref)}" data-navigation>${inner}</a>`
    : `<div class="app-link app-link-static">${inner}</div>`;
  return `<li class="row app-row">${mainSlot}${desktopAction}${appMenu(app, index, pin !== undefined)}</li>`;
}

/** The page names the host it showed, and the host disconnects only if main's entry still points there. */
function hiddenServer(server: OperatorServer): string {
  return `<input type="hidden" name="key" value="${escapeHtml(server.key)}"><input type="hidden" name="host" value="${escapeHtml(operatorServerHost(server) ?? '')}">`;
}

/** Names the server and its host only; which gateway credentials go is never shown. */
function operatorConfirmation(server: OperatorServer): string {
  const host = operatorServerHost(server);
  const access = host ? ` and saved access to ${host} will be removed` : '';
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
  return `<li class="row app-row operator-row"><div class="app-link app-link-static"><span class="row-main"><span class="row-title">${escapeHtml(server.key)}</span><span class="row-sub">${host ? `<span class="app-host">${escapeHtml(host)}</span>` : ''}<span class="app-origin">Added by your operator</span></span></span><span class="app-status">${statusBadge('connected')}</span></div>${operatorAction(server, index, state)}</li>`;
}

/** Connecting starts the entry's sign-in at once, so its Connect posts like a sign-in rather than opening a view. */
function availableRow({ entry }: AvailableCatalogEntry, canChange: boolean): string {
  const needs = entry.requirements
    ? `<span class="row-sub catalog-needs">${escapeHtml(entry.requirements)}</span>`
    : '';
  const connect = canChange
    ? `<form method="post" action="/connections/catalog-connect" data-sign-in><input type="hidden" name="entry" value="${escapeHtml(entry.id)}"><button class="button button-secondary row-button" type="submit" aria-label="${escapeHtml(`Connect ${entry.name}`)}" data-pending-label="Opening…">Connect</button></form>`
    : '';
  return `<li class="row catalog-row"><span class="row-main"><span class="row-title">${escapeHtml(entry.name)}</span><span class="row-sub">${escapeHtml(entry.goodFor)}</span>${needs}</span>${connect}</li>`;
}

function addOwnRow(): string {
  return `<li class="row app-row"><a class="app-link add-own-link" href="/connections/new" data-navigation><span class="row-main"><span class="row-title">Add an app by its address</span></span>${icon('arrow', 'row-chevron app-chevron add-own-chevron')}</a></li>`;
}

function pendingApprovalRow(item: PendingHeldCallItem): string {
  const { payload, viewId } = item;
  const href = `/connections/held/${encodeURIComponent(viewId)}`;
  const title = humanizeToolName(payload.toolName);
  const summary = payload.summary?.trim();
  const subText = summary ? `${payload.appName} — ${summary}` : payload.appName;
  const inner = `<span class="row-main"><span class="row-title">${escapeHtml(title)}</span><span class="row-sub approval-sub"><span class="approval-dot" aria-hidden="true"></span><span class="approval-sub-text">${escapeHtml(subText)}</span></span></span><span class="app-status approval-status">${renderBadge('Pending', 'warning')}</span>${icon('arrow', 'row-chevron app-chevron')}`;
  return `<li class="row app-row approval-row"><a class="app-link approval-link" href="${escapeHtml(href)}" data-navigation>${inner}</a><a class="button button-secondary row-button app-row-action" href="${escapeHtml(href)}" data-navigation>Review</a></li>`;
}

interface ListSection {
  readonly id: string;
  readonly title: string;
  readonly rows: readonly string[];
}

function section({ id, title, rows }: ListSection, titled: boolean): string {
  const heading = titled ? `<h2 class="section-title" id="${id}">${title}</h2>` : '';
  return `<section class="section"${titled ? ` aria-labelledby="${id}"` : ` aria-label="${title}"`}>${heading}<ul class="list">${rows.join('')}</ul></section>`;
}

function appList(state: ConnectionsPageState): string {
  const { apps, operators, canChange } = state.listing;
  const pendingApprovals = state.listing.pendingApprovals ?? [];
  const available = state.listing.available ?? [];
  const unavailable = canChange ? '' : notice(UNAVAILABLE);
  if (apps.length === 0 && operators.length === 0 && pendingApprovals.length === 0 && available.length === 0)
    return `${renderPageHeading('Connections')}${unavailable}${renderEmptyState('No apps yet', 'apps', canChange ? addLink() : '')}`;
  const sections = [
    {
      id: 'pending-approvals-heading',
      title: 'Waiting for approval',
      rows: pendingApprovals.map((item) => pendingApprovalRow(item)),
    },
    {
      id: 'connected-heading',
      title: 'Connected',
      rows: [
        ...apps.map((app, index) =>
          appRow(app, index, canChange, state.listing.pins?.[app.id], state.listing.toolsByApp?.[app.id]),
        ),
        ...operators.map((server, index) => operatorRow(server, index, state)),
      ],
    },
    { id: 'available-heading', title: 'Available', rows: available.map((entry) => availableRow(entry, canChange)) },
    { id: 'add-own-heading', title: 'Add your own', rows: canChange ? [addOwnRow()] : [] },
  ].filter((candidate) => candidate.rows.length > 0);
  // A lone section needs no label of its own.
  const titled = sections.length > 1;
  return `${renderPageHeading('Connections')}${unavailable}${sections.map((candidate) => section(candidate, titled)).join('')}`;
}

function actions(label: string, pending: string): string {
  return `<div class="form-actions"><button class="button button-primary" type="submit" data-pending-label="${pending}">${escapeHtml(label)}</button><a class="button button-secondary form-cancel" href="/connections" data-navigation>Cancel</a></div>`;
}

function addForm(state: ConnectionsPageState): string {
  const heading = `${BACK}${renderPageHeading('Add app')}`;
  if (!state.listing.canChange) return `${heading}${notice(UNAVAILABLE)}`;
  return `${heading}<form method="post" action="/connections/add" data-send><div class="field"><label for="url">Server address</label><input id="url" name="url" type="url" inputmode="url" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="https://example.com/mcp" required></div><div class="field"><label for="name">Name <span class="optional" aria-hidden="true">Optional</span></label><input id="name" name="name" type="text" maxlength="${NAME_MAX}" autocomplete="off" value="${escapeHtml(state.addName ?? '')}" placeholder="App name"></div>${actions('Add app', 'Checking…')}</form>`;
}

function trustNotice(app: ConnectionApp, entry: CatalogEntry | undefined): string {
  if (entry)
    return notice(
      `<strong>Reviewed for GWS-EA.</strong> Your assistant shares data with ${escapeHtml(entry.name)} once it’s connected.`,
    );
  return notice(
    `<strong>Only connect apps you trust.</strong> Your operator hasn’t reviewed ${escapeHtml(app.host)}, and your assistant shares data with it.`,
  );
}

/** A server can reject a client on its own page without ever returning, so the entered details stay changeable. */
function changeClientForm(app: ConnectionApp): string {
  return `<form class="change-client" method="post" action="/connections/change-client" data-send>${hiddenApp(app)}<button class="button button-quiet" type="submit" data-pending-label="Removing…">Change client details</button></form>`;
}

function connectForm(app: ConnectionApp, entry: CatalogEntry | undefined, state: ConnectionsPageState): string {
  const signInHost = (app.issuer === null ? undefined : hostOf(app.issuer)) ?? app.host;
  const trust = trustNotice(app, entry);
  const signIn = `Continue to ${signInHost}`;
  switch (app.auth) {
    case 'none':
      return `<form method="post" action="/connections/connect" data-send>${hiddenApp(app)}${trust}${actions('Connect', 'Connecting…')}</form>`;
    case 'token':
      return `<form method="post" action="/connections/connect" data-send>${hiddenApp(app)}<div class="field"><label for="token">Access token</label><input id="token" name="token" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" required></div>${trust}${actions('Connect', 'Checking…')}</form>`;
    case 'oauth':
      if (app.hasClient)
        return `<form method="post" action="/connections/sign-in" data-sign-in>${hiddenApp(app)}${trust}${actions(signIn, 'Opening sign-in…')}</form>${app.clientEntered ? changeClientForm(app) : ''}`;
      return `<form method="post" action="/connections/sign-in" data-sign-in>${hiddenApp(app)}<ol class="steps"><li><h2>Register this redirect URI with ${escapeHtml(signInHost)}</h2><div class="redirect"><code id="redirect-uri">${escapeHtml(state.redirectUri(app))}</code>${renderCopyButton('redirect-uri', 'Copy redirect URI')}</div></li><li><h2>Enter client details</h2><div class="field"><label for="client-id">Client ID</label><input id="client-id" name="clientId" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" required></div><div class="field"><label for="client-secret">Client secret <span class="optional" aria-hidden="true">Optional</span></label><input id="client-secret" name="clientSecret" type="password" autocomplete="off" autocapitalize="none" spellcheck="false"></div></li></ol>${trust}${actions(signIn, 'Opening sign-in…')}</form>`;
  }
}

function appMissing(): string {
  return `${BACK}${renderEmptyState('App not found', 'apps', '<a class="button button-secondary" href="/connections" data-navigation>All apps</a>')}`;
}

const DEVICE_ENDED = {
  expired: 'The sign-in expired before it was approved.',
  refused: 'The sign-in was declined.',
  failed: 'The sign-in couldn’t be read.',
} satisfies Record<DeviceSignInFailure, string>;

function deviceStartForm(entry: CatalogEntry, label: string): string {
  return `<form method="post" action="/connections/catalog-connect" data-sign-in><input type="hidden" name="entry" value="${escapeHtml(entry.id)}">${actions(label, 'Starting…')}</form>`;
}

/**
 * The app's own sign-in: the principal opens its address and approves a phrase in the app while the page polls. It
 * never starts a second login while one waits; Try again starts one only after the last has ended.
 */
function deviceSignInPanel(app: ConnectionApp, entry: CatalogEntry, view: DeviceSignInView | undefined): string {
  const trust = trustNotice(app, entry);
  switch (view?.status) {
    case 'waiting':
      return `<div data-device-sign-in="${escapeHtml(app.id)}" data-device-state="waiting"><ol class="steps"><li><h2>Open ${escapeHtml(entry.name)}’s sign-in page</h2><div class="redirect"><a id="device-address" href="${escapeHtml(view.verificationUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(view.verificationUrl)}</a></div></li><li><h2>Approve this phrase in the ${escapeHtml(entry.name)} app</h2><div class="redirect"><code id="device-phrase">${escapeHtml(view.phrase)}</code>${renderCopyButton('device-phrase', 'Copy phrase')}</div></li></ol><p class="device-status" role="status">Waiting for your approval…</p></div>`;
    case 'ended':
      return `${notice(`${DEVICE_ENDED[view.reason]} Nothing changed.`)}${deviceStartForm(entry, 'Try again')}`;
    case 'idle':
    case 'connected':
    case undefined:
      return `${trust}${deviceStartForm(entry, `Continue to ${entry.name}`)}`;
  }
}

function connectView(app: ConnectionApp, entry: CatalogEntry | undefined, state: ConnectionsPageState): string {
  // Connecting already says it is not connected; only a lapsed connection is news.
  const status = app.status === 'needs_reconnecting' ? statusBadge(app.status) : '';
  const heading = `${BACK}${renderPageHeading(`Connect ${app.name}`, `<span>${escapeHtml(shownHost(app))}</span>${status}`)}`;
  if (app.status === 'connected') return `${heading}${notice('Already connected.')}`;
  if (!state.listing.canChange) return `${heading}${notice(UNAVAILABLE)}`;
  if (app.transport === 'host_cli' && entry) return `${heading}${deviceSignInPanel(app, entry, state.deviceSignIn)}`;
  return `${heading}${connectForm(app, entry, state)}`;
}

function renameView(app: ConnectionApp): string {
  return `${BACK}${renderPageHeading('Rename app', `<span>${escapeHtml(shownHost(app))}</span>`)}<form method="post" action="/connections/rename" data-send data-track-changes>${hiddenApp(app)}<div class="field"><label for="name">Name</label><input id="name" name="name" type="text" maxlength="${NAME_MAX}" autocomplete="off" required value="${escapeHtml(app.name)}"></div><div class="form-actions"><button class="button button-primary" type="submit">Save</button><a class="button button-secondary form-cancel" href="/connections" data-navigation>Cancel</a></div></form>`;
}

function toolRow(app: ConnectionApp, entry: CatalogEntry | undefined, tool: PinnedAppTool): string {
  const isChecking = tool.label === null || tool.unsettled;
  const isAskFirst = tool.label !== 'just_do';
  const nextLabel = isAskFirst ? 'just_do' : 'ask_first';
  const displayName = humanizeToolName(tool.name);
  const desc = toolDescription(tool);
  const autoText = autoStateText(entry, tool.name);
  const stateText = isChecking ? 'Checking…' : isAskFirst ? 'Ask first' : autoText;
  const descMarkup = isChecking
    ? '<span class="tool-desc tool-shimmer" data-tool-desc aria-hidden="true"></span>'
    : desc
      ? `<span class="tool-desc" data-tool-desc>${escapeHtml(desc)}</span>`
      : '<span class="tool-desc" data-tool-desc hidden></span>';
  return `<li class="row tool-row${isChecking ? ' is-checking' : ''}" data-tool-row="${escapeHtml(tool.name)}" data-tool-hash="${escapeHtml(tool.definitionHash)}" data-tool-state="${isChecking ? 'checking' : isAskFirst ? 'ask_first' : 'just_do'}" data-auto-text="${escapeHtml(autoText)}"><div class="tool-info"><div class="tool-head"><span class="tool-title">${escapeHtml(displayName)}</span><code class="tool-slug">${escapeHtml(tool.name)}</code></div>${descMarkup}</div><form class="tool-control" method="post" action="/connections/tool-label" data-tool-switch><input type="hidden" name="id" value="${escapeHtml(app.id)}"><input type="hidden" name="tool" value="${escapeHtml(tool.name)}"><input type="hidden" name="label" value="${nextLabel}"><input type="hidden" name="definitionHash" value="${escapeHtml(tool.definitionHash)}">${renderSwitch({ checked: isAskFirst, label: `Ask first for ${displayName} (${tool.name})`, stateText, name: tool.name })}</form></li>`;
}

function toolsSkeleton(): string {
  const item =
    '<li class="row tool-row is-checking skeleton-row" aria-hidden="true"><div class="tool-info"><span class="skeleton-bar skeleton-title"></span><span class="skeleton-bar skeleton-desc"></span></div><span class="skeleton-pill"></span></li>';
  return `<div class="tools-card"><div class="tools-card-head" aria-hidden="true"><span>Tool</span><span>Ask before running</span></div><ul class="list tools-list" data-tools-list aria-busy="true">${item.repeat(4)}</ul></div>`;
}

function reviewForm(
  app: ConnectionApp,
  pin: AppPin | undefined,
  labelsHash: string,
  className: string,
  show: boolean,
): string {
  return `<form class="${className}" method="post" action="/connections/review-tools" data-send data-review-form${show ? '' : ' hidden'}><input type="hidden" name="id" value="${escapeHtml(app.id)}"><input type="hidden" name="listHash" value="${escapeHtml(pin?.listHash ?? '')}" data-review-list-hash><input type="hidden" name="labelsHash" value="${escapeHtml(labelsHash)}" data-review-labels-hash><button class="button button-primary" type="submit" data-pending-label="Saving…">Confirm</button></form>`;
}

function toolsView(app: ConnectionApp, pin: AppPin | undefined, tools: readonly PinnedAppTool[]): string {
  const sorted = sortToolsForDisplay(tools);
  const entry = catalogEntryFor(app);
  const labelsHash = toolLabelsHash(sorted);
  const isConnected = app.status === 'connected';
  const hasUnsorted = isConnected && (!pin || sorted.some((tool) => tool.label === null || tool.unsettled));
  const showReview = Boolean(isConnected && pin && !hasUnsorted && pin.needsReview);
  const askCount = sorted.filter((tool) => tool.label === 'ask_first' && !tool.unsettled).length;
  const autoCount = sorted.filter((tool) => tool.label === 'just_do' && !tool.unsettled).length;
  const reviewBadge = !isConnected
    ? statusBadge(app.status)
    : hasUnsorted
      ? '<span class="badge badge-checking">Checking…</span>'
      : pin?.needsReview
        ? renderBadge('Needs review', 'warning')
        : renderBadge('Reviewed', 'success');
  const desktopTally =
    !pin || hasUnsorted ? '' : sorted.length === 0 ? 'No tools' : `${askCount} ask first · ${autoCount} auto`;
  const mobileTally = !pin || hasUnsorted ? '' : sorted.length === 0 ? '0 tools' : `${askCount} on · ${autoCount} off`;
  const metadata = `<span class="tools-host">${escapeHtml(shownHost(app))}</span><span class="tools-tally" data-tools-tally${desktopTally ? '' : ' hidden'}>${escapeHtml(desktopTally)}</span><span class="tools-badge-slot" data-tools-badge>${reviewBadge}</span>`;
  const heading = `${BACK}${renderPageHeading(app.name, metadata, reviewForm(app, pin, labelsHash, 'review-header-form', showReview))}`;
  const mobileStrip = `<div class="tools-mobile-strip"><span class="tools-mobile-label">Ask before running</span><span class="tools-mobile-tally" data-tools-mobile-tally${mobileTally ? '' : ' hidden'}>${escapeHtml(mobileTally)}</span></div>`;
  const disconnectedLabel = app.status === 'needs_reconnecting' ? 'Reconnect' : 'Connect';
  const disconnectedPrompt =
    app.status === 'needs_reconnecting'
      ? 'Reconnect this app to load its tools.'
      : 'Connect this app to load its tools.';
  const bodyMarkup = !pin
    ? isConnected
      ? toolsSkeleton()
      : `<div class="tools-empty" data-tools-empty><p>${disconnectedPrompt}</p><a class="button button-primary" href="${escapeHtml(appUrl(app, 'connect'))}" data-navigation>${disconnectedLabel}</a></div>`
    : sorted.length > 0
      ? `<div class="tools-card"><div class="tools-card-head" aria-hidden="true"><span>Tool</span><span>Ask before running</span></div><ul class="list tools-list" data-tools-list>${sorted.map((tool) => toolRow(app, entry, tool)).join('')}</ul></div>`
      : '<div class="tools-empty" data-tools-empty>No tools listed by this app.</div>';
  const mobileDock = reviewForm(app, pin, labelsHash, 'review-dock', showReview);
  return `<div class="tools-view" data-tools-app="${escapeHtml(app.id)}" data-tools-polling="${hasUnsorted ? 'true' : 'false'}" data-tools-list-hash="${escapeHtml(pin?.listHash ?? '')}">${heading}${mobileStrip}<section class="section tools-section" aria-label="App tools" data-tools-body>${bodyMarkup}</section>${mobileDock}</div>`;
}

/**
 * Losslessly indents a valid JSON object/array without parsing numbers through IEEE-754 (preserving 64-bit IDs
 * and exact decimal notation) and returns whether the decoded JSON tree contains any invisible characters.
 */
function formatLosslessJson(raw: string): { readonly text: string; readonly decodedHasInvisible: boolean } {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return { text: raw, decodedHasInvisible: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { text: raw, decodedHasInvisible: false };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { text: raw, decodedHasInvisible: false };
  }
  const decodedHasInvisible = hasAnyInvisible(parsed);
  let out = '';
  let indent = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!;
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '{' || ch === '[') {
      let look = i + 1;
      while (look < trimmed.length && /\s/u.test(trimmed[look]!)) look += 1;
      const closing = ch === '{' ? '}' : ']';
      if (trimmed[look] === closing) {
        out += `${ch}${closing}`;
        i = look;
      } else {
        indent += 1;
        out += `${ch}\n${'  '.repeat(indent)}`;
      }
      continue;
    }
    if (ch === '}' || ch === ']') {
      indent = Math.max(0, indent - 1);
      out += `\n${'  '.repeat(indent)}${ch}`;
      continue;
    }
    if (ch === ',') {
      out += `,\n${'  '.repeat(indent)}`;
      continue;
    }
    if (ch === ':') {
      out += ': ';
      continue;
    }
    out += ch;
  }
  return { text: out, decodedHasInvisible };
}

function heldDecisionForm(
  viewId: string,
  decision: 'approve' | 'reject',
  label: string,
  pendingLabel: string,
  styleClass: 'button-primary' | 'button-secondary',
): string {
  return `<form method="post" action="/connections/held-decision" data-send><input type="hidden" name="viewId" value="${escapeHtml(viewId)}"><input type="hidden" name="decision" value="${decision}"><button class="button ${styleClass}" type="submit" data-pending-label="${pendingLabel}">${label}</button></form>`;
}

function heldResolutionBadge(resolution: HeldCallViewData['resolution']): string {
  switch (resolution) {
    case undefined:
      return renderBadge('Waiting for approval', 'warning');
    case 'approved':
      return renderBadge('Approved', 'success');
    case 'declined':
      return renderBadge('Declined', 'neutral');
    case 'expired':
      return renderBadge('Expired', 'neutral');
    case 'already_resolved':
      return renderBadge('Already answered', 'neutral');
  }
}

function heldCallView(held: HeldCallViewData): string {
  const { payload, timezone, resolution } = held;
  const expiry = formatLocalTime(payload.expiresAt, timezone);
  const displayName = humanizeToolName(payload.toolName);
  const expiryMeta = resolution ? '' : `<span>Expires ${escapeHtml(expiry)}</span>`;
  const metadata = `<span>${escapeHtml(payload.appName)}</span><code class="held-tool-slug">${escapeHtml(payload.toolName)}</code><span>${escapeHtml(payload.appHost)}</span>${expiryMeta}${heldResolutionBadge(resolution)}`;
  const desktopActions = resolution
    ? ''
    : `<div class="held-actions-header">${heldDecisionForm(held.approvalId, 'reject', 'Decline', 'Declining…', 'button-secondary')}${heldDecisionForm(held.approvalId, 'approve', 'Approve', 'Approving…', 'button-primary')}</div>`;
  const heading = `${BACK}${renderPageHeading(displayName, metadata, desktopActions)}`;
  const rawArgsOut = escapeInvisibleChars(payload.canonicalArgs);
  const formattedArgs = rawArgsOut.hasInvisible ? undefined : formatLosslessJson(payload.canonicalArgs);
  const argsOut = formattedArgs ? escapeInvisibleChars(formattedArgs.text) : rawArgsOut;
  const rawContextOut = payload.appContext ? escapeInvisibleChars(payload.appContext.text) : undefined;
  const formattedContext =
    payload.appContext && rawContextOut && !rawContextOut.hasInvisible
      ? formatLosslessJson(payload.appContext.text)
      : undefined;
  const contextOut = formattedContext ? escapeInvisibleChars(formattedContext.text) : rawContextOut;
  const invisibleWarning =
    rawArgsOut.hasInvisible ||
    argsOut.hasInvisible ||
    formattedArgs?.decodedHasInvisible === true ||
    rawContextOut?.hasInvisible === true ||
    contextOut?.hasInvisible === true ||
    formattedContext?.decodedHasInvisible === true
      ? notice('<strong>Hidden characters detected.</strong> Shown as [U+...] below.')
      : '';
  const summarySection = `<section class="section"><h2 class="section-title">Summary</h2><p class="detail-box">${escapeHtml(payload.summary ?? 'No summary provided')}</p></section>`;
  const argsSection = `<section class="section"><div class="section-head"><h2 class="section-title">Arguments</h2>${renderCopyButton('held-args-code', 'Copy arguments')}</div><pre class="detail-code" id="held-args-code">${escapeHtml(argsOut.rendered)}</pre></section>`;
  const contextSection =
    payload.appContext && contextOut
      ? `<section class="section"><h2 class="section-title">From ${escapeHtml(payload.appName)} · ${escapeHtml(payload.appContext.toolName)}</h2><pre class="detail-code">${escapeHtml(contextOut.rendered)}</pre></section>`
      : '';
  const mobileDock = resolution
    ? ''
    : `<div class="held-dock">${heldDecisionForm(held.approvalId, 'reject', 'Decline', 'Declining…', 'button-secondary')}${heldDecisionForm(held.approvalId, 'approve', 'Approve', 'Approving…', 'button-primary')}</div>`;
  return `${heading}${invisibleWarning}${summarySection}${argsSection}${contextSection}${mobileDock}`;
}

function pageContent(state: ConnectionsPageState): string {
  const { view } = state;
  switch (view.kind) {
    case 'list':
      return appList(state);
    case 'add':
      return addForm(state);
    case 'connect':
    case 'rename':
    case 'tools': {
      const listed = listedApp(state.listing, view.id);
      if (!listed) return appMissing();
      const { app } = listed;
      if (view.kind === 'connect') return connectView(app, listed.entry, state);
      if (view.kind === 'rename') return renameView(app);
      return toolsView(app, state.toolReview?.pin, state.toolReview?.tools ?? []);
    }
    case 'held':
      if (!state.heldCall) return appMissing();
      return heldCallView(state.heldCall);
  }
}

const STYLE = `
/* Desktop-first workspace ergonomics (>=720px) */
@media (min-width: 720px) {
  main[data-view="held"] .page-heading { align-items: flex-start; }
}
.meta-dot { color: var(--line-strong); user-select: none; }
.row-button { padding-inline: 14px; font-size: 13px; min-height: 36px; border-radius: 10px; }

/* Connections list rows */
.app-row { gap: 8px; padding: 4px 8px 4px 4px; }
.approval-row { padding-right: 12px; }
.app-link { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0; min-height: 54px; padding: 10px 10px 10px 12px; border-radius: 10px; transition: background-color .15s var(--ease-out); }
.app-link-static { cursor: default; }
.app-status { flex-shrink: 0; display: inline-flex; align-items: center; }
.app-chevron { display: none; }
.app-host { font-variant-numeric: tabular-nums; }
.approval-sub { display: flex; align-items: center; gap: 6px; }
.approval-sub-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.approval-dot { display: none; width: 7px; height: 7px; border-radius: 50%; background: var(--warning); flex-shrink: 0; }
.operator-row .app-link { padding-right: 6px; }
.app-host + .app-origin::before { content: "·"; margin-inline: 6px; color: var(--line-strong); }
.catalog-row .row-sub { white-space: normal; overflow-wrap: break-word; }
.catalog-needs { font-size: 12.5px; }
.add-own-chevron { display: block; }
@media (hover: hover) and (pointer: fine) {
  a.app-link:hover { background: var(--fill); }
  .tool-row:hover { background: color-mix(in srgb, var(--fill) 65%, transparent); }
}

/* Tools view: desktop table-card surface */
.tools-view .page-heading { margin-bottom: 24px; }
.tools-view .page-metadata { gap: 8px 12px; }
.tools-tally { font-variant-numeric: tabular-nums; color: var(--muted); }
.tools-badge-slot { display: inline-flex; align-items: center; }
.badge-checking { background: var(--fill); color: var(--muted); }
.badge-checking::before { background: var(--accent); animation: pulse-soft 1.3s ease-in-out infinite; }
@media (prefers-color-scheme: dark) {
  .tool-control .switch[aria-checked="false"] .switch-track { background: #2c2c2e; box-shadow: inset 0 0 0 1px #3a3a3c; }
  .tool-control .switch[aria-checked="false"] .switch-thumb { background: #d4d4d8; }
}
.review-header-form { flex-shrink: 0; }
.review-dock { display: none; }
.tools-mobile-strip { display: none; }
.tools-section { margin-top: 0; }
.tools-card { background: var(--surface); border: 1px solid var(--line); border-radius: 16px; overflow: hidden; }
.tools-card-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 20px; background: color-mix(in srgb, var(--fill) 55%, var(--surface)); border-bottom: 1px solid var(--line); color: var(--muted); font-size: 12px; font-weight: 500; letter-spacing: .01em; }
.tools-list { border: 0; border-radius: 0; padding: 4px; background: transparent; }
.tool-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 20px; min-height: 64px; padding: 12px 12px 12px 16px; }
.tool-info { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.tool-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px 8px; min-width: 0; }
.tool-title { font-size: 14px; font-weight: 500; line-height: 1.4; letter-spacing: -.01em; color: var(--text); overflow-wrap: break-word; }
.tool-slug { padding: 1px 6px; border-radius: 6px; background: var(--fill); color: var(--faint); font: 400 11.5px/1.45 ui-monospace, "SF Mono", monospace; max-width: 100%; overflow-wrap: anywhere; }
.tool-desc { color: var(--muted); font-size: 13px; line-height: 1.45; overflow-wrap: break-word; }
.tool-control { flex-shrink: 0; }
.tool-control .switch { min-width: 112px; justify-content: flex-end; padding: 6px 4px 6px 8px; }
.tool-control .switch-state { font-size: 12.5px; font-variant-numeric: tabular-nums; }
.tool-row.is-checking .switch { opacity: .65; }
.tool-shimmer { display: block; width: min(210px, 62%); height: 12px; margin-top: 4px; border-radius: 6px; background: var(--fill-strong); animation: pulse-soft 1.4s ease-in-out infinite; }
.skeleton-row { pointer-events: none; }
.skeleton-bar { display: block; border-radius: 6px; background: var(--fill-strong); animation: pulse-soft 1.4s ease-in-out infinite; }
.skeleton-title { width: min(170px, 52%); height: 14px; }
.skeleton-desc { width: min(260px, 78%); height: 12px; margin-top: 6px; opacity: .7; }
.skeleton-pill { width: 42px; height: 24px; border-radius: 999px; background: var(--fill-strong); animation: pulse-soft 1.4s ease-in-out infinite; }
.tools-empty { padding: 28px 20px; border-radius: 16px; background: var(--fill); color: var(--muted); font-size: 14px; text-align: center; }
.tools-empty p { margin-bottom: 16px; }

/* Held call & setup forms */
.held-actions-header { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.held-dock { display: none; }
.section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.section-head .section-title { margin: 0; padding-inline: 0; }
.section-head .button { min-height: 36px; padding: 6px 12px; font-size: 13px; border-radius: 10px; }
.held-tool-slug { padding: 1px 6px; border-radius: 6px; background: var(--fill); color: var(--muted); font: 400 12px/1.4 ui-monospace, "SF Mono", monospace; }
.detail-box { margin: 0; padding: 14px 16px; border-radius: 14px; background: var(--surface); border: 1px solid var(--line); font-size: 14px; line-height: 1.55; overflow-wrap: anywhere; }
.detail-code { margin: 0; padding: 14px 16px; border-radius: 14px; background: var(--surface); border: 1px solid var(--line); font: 13px/1.55 ui-monospace, "SF Mono", monospace; white-space: pre-wrap; overflow-wrap: anywhere; max-width: 100%; overflow-x: auto; }
.steps { margin: 0; padding: 0; list-style: none; counter-reset: step; }
.steps > li { position: relative; padding-left: 36px; counter-increment: step; }
.steps > li + li { margin-top: 28px; }
.steps > li::before { content: counter(step); position: absolute; left: 0; top: -1px; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: var(--accent-soft); color: var(--accent-text); font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.steps h2 { margin-bottom: 12px; font-size: 14px; font-weight: 500; overflow-wrap: anywhere; }
.redirect { display: flex; align-items: center; gap: 8px; padding: 4px 4px 4px 14px; border-radius: 12px; background: var(--fill); }
.redirect code { flex: 1; min-width: 0; padding-block: 8px; font: 13px/1.5 ui-monospace, "SF Mono", monospace; }
.redirect .button { background: var(--surface); box-shadow: 0 0 0 1px var(--line); }
.change-client { margin-top: 12px; }
.redirect a { flex: 1; min-width: 0; padding-block: 8px; font: 13px/1.5 ui-monospace, "SF Mono", monospace; overflow-wrap: anywhere; color: var(--accent-text); }
.device-status { margin-top: 20px; color: var(--muted); font-size: 14px; }
.change-client .button { margin-left: -16px; }

@keyframes pulse-soft {
  0%, 100% { opacity: .42; }
  50% { opacity: .88; }
}
@media (prefers-reduced-motion: reduce) {
  .badge-checking::before, .tool-shimmer, .skeleton-bar, .skeleton-pill { animation: none; opacity: .7; }
}

/* Mobile-first native phone layout (<720px) */
@media (max-width: 719px) {
  body:has(.review-dock:not([hidden])),
  body:has(.held-dock) { padding-bottom: calc(88px + env(safe-area-inset-bottom)); }
  body:has(.review-dock:not([hidden])) .shell-nav,
  body:has(.held-dock) .shell-nav { display: none; }

  /* Connections list: full-row tappable native list with clean two-line rhythm */
  .app-row { gap: 0; padding: 2px 6px 2px 4px; min-height: 66px; }
  .approval-row { padding-right: 6px; }
  .app-row-action { display: none; }
  .app-link { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "title chevron" "status chevron"; gap: 2px 10px; align-items: center; padding: 10px 6px 10px 12px; min-height: 62px; }
  a.app-link:active { background: var(--fill); transition: none; }
  .app-link > .row-main { display: contents; }
  .app-link .row-title { grid-area: title; font-size: 16px; }
  .app-link .app-host { display: none; }
  .app-link > .app-status { grid-area: status; justify-self: start; }
  .approval-link { grid-template-areas: "title chevron" "sub chevron"; padding-right: 10px; }
  .approval-link .approval-sub { grid-area: sub; font-size: 13.5px; }
  .approval-link .approval-dot { display: inline-block; }
  .approval-link > .approval-status { display: none; }
  .app-link .badge { height: auto; padding: 0; background: none; font-size: 13.5px; font-weight: 400; }
  .app-link .badge::before { width: 7px; height: 7px; }
  .app-link .badge-success, .app-link .badge:not([class*="badge-"]) { color: var(--muted); }
  .app-link .badge-success::before { background: var(--success); }
  .app-chevron { display: block; grid-area: chevron; }
  .operator-row .app-link > .row-main > .row-sub { grid-area: status; }
  .operator-row .app-link > .app-status { display: none; }
  .app-origin::before { display: none; }
  .add-own-link { grid-template-areas: "title chevron"; }
  .catalog-needs { font-size: 13px; }
  .catalog-row .row-button { min-height: 44px; }

  /* Tools view: iOS Settings-inspired stacked card with generous full-width descriptions */
  .tools-view .page-heading { margin-bottom: 16px; }
  .tools-view .page-metadata { gap: 6px 10px; }
  .tools-tally, .review-header-form, .tools-card-head { display: none; }
  .tools-mobile-strip { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 0 16px 8px; font-size: 13px; }
  .tools-mobile-label { color: var(--muted); font-weight: 500; }
  .tools-mobile-tally { color: var(--faint); font-variant-numeric: tabular-nums; }
  .tools-card { border-radius: 18px; }
  .tools-list { padding: 2px; }
  .tool-row { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "head toggle" "desc desc"; align-items: center; gap: 2px 12px; min-height: 62px; padding: 14px 10px 14px 16px; }
  .tool-info { display: contents; }
  .tool-head { grid-area: head; }
  .tool-title { font-size: 16px; line-height: 1.3; }
  .tool-slug { display: none; }
  .tool-desc { grid-area: desc; font-size: 14px; line-height: 1.45; padding-right: 6px; }
  .tool-control { grid-area: toggle; }
  .tool-control .switch { min-width: 0; min-height: 44px; margin-block: -8px; padding: 6px 4px; gap: 0; }
  .tool-control .switch-state { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  .tool-control .switch-track { width: 48px; height: 28px; }
  .tool-control .switch-thumb { width: 24px; height: 24px; }
  .tool-control .switch[aria-checked="true"] .switch-thumb { transform: translateX(20px); }
  .skeleton-row { grid-template-areas: "head toggle" "desc desc"; }
  .skeleton-title { grid-area: head; width: 62%; height: 16px; }
  .skeleton-desc { grid-area: desc; width: 84%; height: 13px; margin-top: 6px; }
  .skeleton-pill { grid-area: toggle; width: 48px; height: 28px; }

  /* Mobile sticky confirmation & decision docks — shown only while action is needed */
  .held-actions-header { display: none; }
  .review-dock { display: block; position: fixed; left: 0; right: 0; bottom: 0; z-index: 16; padding: 14px 16px calc(12px + env(safe-area-inset-bottom)); background: color-mix(in srgb, var(--page) 88%, transparent); -webkit-backdrop-filter: saturate(1.8) blur(18px); backdrop-filter: saturate(1.8) blur(18px); box-shadow: 0 -1px 0 var(--line); }
  .review-dock .button { width: 100%; min-height: 52px; border-radius: 14px; font-size: 16px; }
  .held-dock { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; position: fixed; left: 0; right: 0; bottom: 0; z-index: 16; padding: 14px 16px calc(12px + env(safe-area-inset-bottom)); background: color-mix(in srgb, var(--page) 88%, transparent); -webkit-backdrop-filter: saturate(1.8) blur(18px); backdrop-filter: saturate(1.8) blur(18px); box-shadow: 0 -1px 0 var(--line); }
  .held-dock form { display: flex; }
  .held-dock .button { width: 100%; min-height: 52px; border-radius: 14px; font-size: 16px; }

  /* Native mobile forms: top-left Back link already acts as Cancel */
  .form-cancel { display: none; }
  .steps h2 { font-size: 15px; }
  .change-client .button { margin: 0; width: 100%; }
  .redirect { flex-direction: column; align-items: stretch; padding: 4px; }
  .redirect code { padding-inline: 10px; }
  .section-head { padding-inline: 16px; }
  .section-head .button { min-height: 44px; padding: 8px 14px; font-size: 14px; border-radius: 12px; }
}
@media (max-width: 719px) and (prefers-reduced-transparency: reduce) {
  .review-dock, .held-dock { background: var(--page); -webkit-backdrop-filter: none; backdrop-filter: none; }
}
`;

/** Renders app metadata only; nothing sealed and no address beyond an app's own is ever an input here. */
export function renderConnectionsPage(state: ConnectionsPageState, shell: Shell, nonce: string): string {
  const titles = {
    list: 'Connections',
    add: 'Add app',
    connect: 'Connect app',
    rename: 'Rename app',
    tools: 'Tool approvals',
    held: 'Pending approval',
  } satisfies Record<ConnectionsView['kind'], string>;
  return renderPrincipalPage(
    {
      shell,
      page: '/connections',
      title: titles[state.view.kind],
      view: state.view.kind,
      narrow: state.view.kind === 'add' || state.view.kind === 'connect' || state.view.kind === 'rename',
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
