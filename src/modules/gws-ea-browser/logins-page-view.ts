import {
  escapeHtml,
  icon,
  renderBackLink,
  renderBadge,
  renderEmptyState,
  renderPageHeading,
  renderPrincipalPage,
  type Shell,
} from '../gws-ea-web/kit/index.js';
import { LOGINS_PAGE_SCRIPT } from './logins-page-client.js';

export interface LoginRow {
  readonly handle: string;
  readonly site: string;
  readonly title: string;
  readonly username: string;
  readonly account: 'assistant' | 'principal';
  readonly version: number;
}

export type LoginsView =
  | { readonly kind: 'list' }
  | { readonly kind: 'add' }
  | { readonly kind: 'detail' | 'edit'; readonly handle: string };

export interface LoginsPageState {
  readonly view: LoginsView;
  readonly rows: readonly LoginRow[];
  readonly outcome: string;
  readonly error: boolean;
  readonly available: boolean;
}

function itemUrl(row: LoginRow): string {
  return `/logins/item/${encodeURIComponent(row.handle)}`;
}

const ACCOUNT_LABELS = { assistant: 'Assistant’s account', principal: 'Your account' } as const;

function hiddenItem(row: LoginRow): string {
  return `<input type="hidden" name="handle" value="${escapeHtml(row.handle)}"><input type="hidden" name="version" value="${row.version}">`;
}

function addLink(): string {
  return `<a class="button button-primary" href="/logins/new" data-navigation>${icon('plus')}<span class="button-label">Add login</span></a>`;
}

function loginRow(row: LoginRow): string {
  // The principal's own account is the usual case, so only the assistant's is marked in the list.
  const owner = row.account === 'assistant' ? renderBadge(ACCOUNT_LABELS.assistant, 'accent', false) : '';
  return `<a class="row" data-login-row data-search="${escapeHtml(`${row.site} ${row.title} ${row.username}`.toLocaleLowerCase())}" href="${escapeHtml(itemUrl(row))}" data-navigation><span class="row-main"><span class="row-title">${escapeHtml(row.title || row.site)}</span><span class="row-sub">${escapeHtml(row.username || 'No username')}</span></span>${owner}${icon('arrow', 'row-chevron')}</a>`;
}

function loginList(rows: readonly LoginRow[]): string {
  const groups = new Map<string, LoginRow[]>();
  for (const row of rows) {
    const group = groups.get(row.site) ?? [];
    group.push(row);
    groups.set(row.site, group);
  }
  const sites = [...groups].sort(([left], [right]) => left.localeCompare(right));
  const heading = renderPageHeading('Logins', '', rows.length ? addLink() : '');
  if (rows.length === 0) return `${heading}${renderEmptyState('No saved logins yet', 'lock', addLink())}`;
  return `${heading}<div class="list-tools"><div class="search-field">${icon('search')}<label class="sr-only" for="login-search">Search logins</label><input id="login-search" type="search" placeholder="Search" autocomplete="off" spellcheck="false"></div><p class="list-summary" id="search-count" role="status" aria-live="polite"></p></div>${sites
    .map(
      ([site, group], index) =>
        `<section class="section site-group" data-site-group aria-labelledby="site-${index}"><h2 class="section-title site-heading" id="site-${index}"><span class="site-mark" aria-hidden="true">${escapeHtml((site[0] ?? '•').toLocaleUpperCase())}</span>${escapeHtml(site)}</h2><div class="list">${group
          .sort((left, right) => left.title.localeCompare(right.title) || left.username.localeCompare(right.username))
          .map(loginRow)
          .join('')}</div></section>`,
    )
    .join('')}${renderEmptyState('No matching logins', 'search', '', 'search-empty', 'search-empty')}`;
}

function loginDetail(row: LoginRow): string {
  const owner = renderBadge(ACCOUNT_LABELS[row.account], row.account === 'assistant' ? 'accent' : 'neutral', false);
  const edit = `<a class="button button-secondary" href="${escapeHtml(itemUrl(row))}/edit" data-navigation>${icon('edit')}<span class="button-label">Edit</span></a>`;
  return `${renderBackLink('/logins', 'Logins')}${renderPageHeading(row.title || row.site, owner, edit)}<dl class="list details"><div class="detail"><dt>Website</dt><dd>${escapeHtml(row.site)}</dd></div><div class="detail"><dt>Username</dt><dd>${escapeHtml(row.username || 'No username')}</dd></div><div class="detail detail-password"><dt>Password</dt><dd><span id="password-concealed" class="concealed"><span aria-hidden="true">••••••••••</span><span class="sr-only">Hidden</span></span><code id="password-value" hidden></code><button class="button button-secondary" id="show-password" type="button" data-handle="${escapeHtml(row.handle)}" data-version="${row.version}" aria-controls="password-value" aria-expanded="false">Show password</button><p class="field-hint" id="password-reveal-hint" hidden>Hides after 30 seconds.</p></dd></div></dl><form class="remove" method="post" action="/logins/remove" data-send data-confirm-title="Remove this login?" data-confirm-action="Remove login" data-confirm-message="${escapeHtml(`Your assistant will no longer sign in to ${row.site} as ${row.username || 'this account'}. Your account on the site stays as it is, and your assistant’s browser may stay signed in until you ask it to sign out.`)}">${hiddenItem(row)}<button class="button button-danger" type="submit" data-pending-label="Removing…">Remove login</button></form>`;
}

function loginForm(row?: LoginRow): string {
  const editing = row !== undefined;
  const destination = row ? itemUrl(row) : '/logins';
  // An edit sends only the details that changed, so it never rewrites a field it did not touch.
  const unchanged = editing ? ' data-omit-unchanged' : '';
  const back = row ? renderBackLink(destination, row.title || row.site) : renderBackLink('/logins', 'Logins');
  return `${back}${renderPageHeading(editing ? 'Edit login' : 'Add login')}<form method="post" action="/logins/${editing ? 'update' : 'add'}" data-send data-track-changes>${row ? hiddenItem(row) : ''}<div class="field"><label for="site">Website</label><input id="site" name="site" type="text" inputmode="url" autocomplete="url" autocapitalize="none" spellcheck="false"${unchanged} value="${escapeHtml(row?.site ?? '')}" placeholder="example.com"${editing ? '' : ' required'}></div><div class="field"><label for="username">Username</label><input id="username" name="username" type="text" maxlength="320" autocomplete="username" autocapitalize="none" spellcheck="false"${unchanged} value="${escapeHtml(row?.username ?? '')}"${editing ? '' : ' required'}></div><div class="field"><label for="password">${editing ? 'New password' : 'Password'}</label><input id="password" name="password" type="password" autocomplete="new-password"${editing ? ' aria-describedby="password-hint" placeholder="Unchanged"' : ' required'}>${editing ? '<p class="field-hint" id="password-hint">Changes only what your assistant saved, not the password on the website.</p>' : ''}</div><div class="field"><label for="title">Label <span class="optional" aria-hidden="true">Optional</span></label><input id="title" name="title" type="text" maxlength="200" autocomplete="off"${unchanged} value="${escapeHtml(row?.title ?? '')}" placeholder="Personal, Work…"></div><div class="form-actions"><button class="button button-primary" type="submit">${editing ? 'Save changes' : 'Add login'}</button><a class="button button-secondary" href="${escapeHtml(destination)}" data-navigation>Cancel</a></div></form>`;
}

function pageContent(state: LoginsPageState): string {
  if (!state.available)
    return `${renderPageHeading('Logins')}${renderEmptyState('Saved logins can’t be opened right now', 'lock', '<a class="button button-secondary" href="/logins" data-navigation>Try again</a>')}`;
  switch (state.view.kind) {
    case 'list':
      return loginList(state.rows);
    case 'add':
      return loginForm();
    case 'detail':
    case 'edit': {
      const handle = state.view.handle;
      const row = state.rows.find((entry) => entry.handle === handle);
      if (!row)
        return `${renderBackLink('/logins', 'Logins')}${renderEmptyState('This login is no longer saved', 'lock', '<a class="button button-secondary" href="/logins" data-navigation>See all logins</a>')}`;
      return state.view.kind === 'edit' ? loginForm(row) : loginDetail(row);
    }
  }
}

const STYLE = `
.list-tools { display: flex; align-items: center; gap: 16px; margin-bottom: 8px; }
.search-field { position: relative; flex: 1; max-width: 320px; }
.search-field > .icon { position: absolute; left: 14px; top: 14px; width: 16px; height: 16px; color: var(--faint); pointer-events: none; }
input[type="search"] { padding-left: 40px; }
.list-summary:empty { display: none; }
.list-summary { margin-left: auto; color: var(--muted); font-size: 13px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.site-heading { display: flex; align-items: center; gap: 8px; color: var(--text); }
.site-mark { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 6px; background: var(--fill-strong); color: var(--muted); font-size: 11px; font-weight: 600; }
.site-group + .search-empty { margin-top: 32px; }
.details { margin: 0; padding: 4px 18px; }
.detail { display: grid; grid-template-columns: 120px minmax(0, 1fr); align-items: center; gap: 16px; min-height: 60px; padding-block: 12px; }
.detail + .detail { border-top: 1px solid var(--line); }
dt { color: var(--muted); font-size: 13px; }
dd { margin: 0; font-size: 14px; font-weight: 500; overflow-wrap: anywhere; }
.detail-password dd { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
.concealed { flex: 1; color: var(--muted); letter-spacing: .12em; }
#password-value { flex: 1; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 500 14px/1.5 ui-monospace, "SF Mono", monospace; user-select: text; }
#password-reveal-hint { flex-basis: 100%; margin: 0; font-weight: 400; }
.remove { margin-top: 16px; }
.remove .button { margin-left: -16px; }
@media (max-width: 719px) {
  /* The owner tag shares the title's line, so the username keeps its own. */
  a.row[data-login-row] { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; grid-template-areas: "title owner chevron" "sub sub chevron"; gap: 2px 8px; align-items: center; }
  a.row[data-login-row] > .row-main { display: contents; }
  a.row[data-login-row] .row-title { grid-area: title; }
  a.row[data-login-row] .row-sub { grid-area: sub; }
  a.row[data-login-row] > .badge { grid-area: owner; height: 20px; padding: 0 8px; font-size: 11px; }
  a.row[data-login-row] > .row-chevron { grid-area: chevron; }
  .site-group + .site-group { margin-top: 24px; }
  .list-tools { margin-bottom: 4px; }
  .search-field { max-width: none; }
  input[type="search"] { min-height: 44px; border-radius: 12px; }
  .site-heading { padding-inline: 16px; }
  .details { padding: 2px 16px; border-radius: 18px; }
  .detail { grid-template-columns: 1fr; gap: 2px; min-height: 64px; }
  dd { font-size: 16px; }
  .remove { margin-top: 24px; }
  .remove .button { width: 100%; margin: 0; min-height: 52px; border-radius: 14px; background: var(--danger-soft); font-size: 16px; }
}
`;

/** Render only host-approved display metadata; this module has no credential-value input. */
export function renderLoginsPage(state: LoginsPageState, shell: Shell, nonce: string): string {
  const titles = {
    add: 'Add login',
    edit: 'Edit login',
    detail: 'Login details',
    list: 'Logins',
  } satisfies Record<LoginsView['kind'], string>;
  return renderPrincipalPage(
    {
      shell,
      page: '/logins',
      title: titles[state.view.kind],
      view: state.view.kind,
      narrow: state.view.kind === 'add' || state.view.kind === 'edit',
      outcome: state.outcome,
      error: state.error,
      content: pageContent(state),
      noscript: 'Turn on JavaScript to show a password or to save or remove a login.',
      style: STYLE,
      script: LOGINS_PAGE_SCRIPT,
    },
    nonce,
  );
}
