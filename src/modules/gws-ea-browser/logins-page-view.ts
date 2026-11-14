import { escapeHtml, icon, renderPrincipalPage, type Shell } from '../gws-ea-web/kit/index.js';
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

function accountBadge(account: LoginRow['account']): string {
  return `<span class="badge${account === 'assistant' ? ' badge-assistant' : ''}">${account === 'assistant' ? 'Assistant’s account' : 'Your account'}</span>`;
}

function backLink(href = '/logins', label = 'All logins'): string {
  return `<a class="back-link" href="${escapeHtml(href)}" data-navigation>${icon('back')}${label}</a>`;
}

function hiddenItem(row: LoginRow): string {
  return `<input type="hidden" name="handle" value="${escapeHtml(row.handle)}"><input type="hidden" name="version" value="${row.version}">`;
}

function pageHeading(title: string, metadata = '', action = ''): string {
  return `<div class="page-heading"><div><h1>${escapeHtml(title)}</h1>${metadata ? `<div class="page-metadata">${metadata}</div>` : ''}</div>${action}</div>`;
}

function emptyState(title: string, action = ''): string {
  return `<section class="empty-state"><span class="empty-icon">${icon('lock')}</span><h2>${title}</h2>${action}</section>`;
}

function addLink(): string {
  return `<a class="button button-primary" href="/logins/new" data-navigation>${icon('plus')}Add login</a>`;
}

function loginList(rows: readonly LoginRow[]): string {
  const groups = new Map<string, LoginRow[]>();
  for (const row of rows) {
    const group = groups.get(row.site) ?? [];
    group.push(row);
    groups.set(row.site, group);
  }
  const sites = [...groups].sort(([left], [right]) => left.localeCompare(right));
  const heading = pageHeading('Logins', '', rows.length ? addLink() : '');
  if (rows.length === 0) return `${heading}${emptyState('No saved logins yet.', addLink())}`;
  return `${heading}<div class="list-tools"><div class="search-field">${icon('search')}<label class="sr-only" for="login-search">Search logins</label><input id="login-search" type="search" placeholder="Search logins…" autocomplete="off" spellcheck="false"></div><p class="list-summary" id="search-count" role="status" aria-live="polite">${rows.length} ${rows.length === 1 ? 'login' : 'logins'}</p></div><div class="site-groups">${sites
    .map(
      ([site, group], index) =>
        `<section class="site-group" data-site-group aria-labelledby="site-${index}"><div class="site-heading"><span class="site-mark" aria-hidden="true">${escapeHtml((site[0] ?? '•').toLocaleUpperCase())}</span><h2 id="site-${index}">${escapeHtml(site)}</h2><span class="site-count">${group.length}</span></div><div class="login-list">${group
          .sort((left, right) => left.title.localeCompare(right.title) || left.username.localeCompare(right.username))
          .map(
            (row) =>
              `<a class="login-row" data-login-row data-search="${escapeHtml(`${row.site} ${row.title} ${row.username}`.toLocaleLowerCase())}" href="${escapeHtml(itemUrl(row))}" data-navigation><span class="login-identity"><span class="login-title">${escapeHtml(row.title || row.site)}</span><span class="login-username">${escapeHtml(row.username || 'No username saved')}</span></span>${accountBadge(row.account)}${icon('arrow', 'row-arrow')}</a>`,
          )
          .join('')}</div></section>`,
    )
    .join(
      '',
    )}</div><section class="empty-state search-empty" id="search-empty" hidden><span class="empty-icon">${icon('search')}</span><h2>No matching logins</h2></section>`;
}

function loginDetail(row: LoginRow): string {
  const edit = `<a class="button button-primary" href="${escapeHtml(itemUrl(row))}/edit" data-navigation>${icon('edit')}Edit details</a>`;
  return `${backLink()}${pageHeading(row.title || row.site, accountBadge(row.account), edit)}<section class="panel"><dl class="details-list"><div class="detail-row"><dt>Website</dt><dd>${escapeHtml(row.site)}</dd></div><div class="detail-row"><dt>Username</dt><dd>${escapeHtml(row.username || 'No username saved')}</dd></div><div class="detail-row"><dt>Password</dt><dd class="password-detail"><span id="password-concealed" class="concealed-status">${icon('lock')}Not shown</span><code id="password-value" hidden></code><button class="button button-secondary" id="show-password" type="button" data-handle="${escapeHtml(row.handle)}" data-version="${row.version}" aria-controls="password-value" aria-expanded="false">Show password</button><p class="field-hint" id="password-reveal-hint" hidden>Hides after 30 seconds or when you leave this page.</p></dd></div></dl></section><section class="remove-section" aria-labelledby="remove-section-heading"><h2 class="sr-only" id="remove-section-heading">Remove this login</h2><form method="post" action="/logins/remove" data-send data-confirm-title="Remove login?" data-confirm-action="Remove login" data-confirm-message="${escapeHtml(`Remove the saved login for ${row.site} (${row.username})? This does not delete the account on the website. The browser may still be signed in. You can ask your assistant to sign out.`)}">${hiddenItem(row)}<button class="button button-danger" type="submit" data-pending-label="Removing…">Remove login</button></form></section>`;
}

function loginForm(row?: LoginRow): string {
  const editing = row !== undefined;
  const destination = row ? itemUrl(row) : '/logins';
  // An edit sends only the details that changed, so it never rewrites a field it did not touch.
  const unchanged = editing ? ' data-omit-unchanged' : '';
  return `${backLink(destination, editing ? 'Login details' : 'All logins')}${pageHeading(editing ? 'Edit login' : 'Add login')}<section class="panel form-panel"><form method="post" action="/logins/${editing ? 'update' : 'add'}" data-send data-track-changes>${row ? hiddenItem(row) : ''}<div class="field"><label for="title">Account label <span class="optional" aria-hidden="true">Optional</span></label><input id="title" name="title" type="text" maxlength="200" autocomplete="off"${unchanged} value="${escapeHtml(row?.title ?? '')}" placeholder="Personal"></div><div class="field"><label for="site">Website</label><input id="site" name="site" type="text" inputmode="url" autocomplete="url" autocapitalize="none" spellcheck="false"${unchanged} value="${escapeHtml(row?.site ?? '')}" placeholder="example.com"${editing ? '' : ' required'}></div><div class="field"><label for="username">Username</label><input id="username" name="username" type="text" maxlength="320" autocomplete="username" autocapitalize="none" spellcheck="false"${unchanged} value="${escapeHtml(row?.username ?? '')}"${editing ? '' : ' required'}></div><div class="field password-field"><label for="password">${editing ? 'New saved password' : 'Password'}</label><input id="password" name="password" type="password" autocomplete="new-password"${editing ? ' aria-describedby="password-hint password-scope"' : ' required'}>${editing ? '<p class="field-hint" id="password-hint">Leave blank to keep the saved password.</p><p class="field-hint password-scope" id="password-scope">This won’t change the password on the website.</p>' : ''}</div><div class="form-actions"><button class="button button-primary" type="submit">${editing ? 'Save changes' : 'Add login'}</button><a class="button button-secondary" href="${escapeHtml(destination)}" data-navigation>Cancel</a></div></form></section>`;
}

function pageContent(state: LoginsPageState): string {
  if (!state.available)
    return `${backLink()}${pageHeading('Logins unavailable')}<section class="empty-state"><span class="empty-icon">${icon('lock')}</span><a class="button button-secondary" href="/logins" data-navigation>Try again</a></section>`;
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
        return `${backLink()}${pageHeading('Login unavailable')}<a class="button button-secondary" href="/logins" data-navigation>View saved logins</a>`;
      return state.view.kind === 'edit' ? loginForm(row) : loginDetail(row);
    }
  }
}

const STYLE = `
.list-tools { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-bottom: 32px; }
.search-field { position: relative; width: 320px; max-width: 100%; }
.search-field > .icon { position: absolute; left: 13px; top: 14px; color: var(--muted); width: 16px; height: 16px; pointer-events: none; }
input[type="search"] { padding-left: 39px; font-size: 14px; }
.list-summary { font-size: 12px; color: var(--muted); text-align: right; white-space: nowrap; }
.site-group { margin-bottom: 28px; }
.site-heading { display: flex; align-items: center; gap: 9px; margin-bottom: 10px; padding-inline: 2px; }
.site-heading h2 { min-width: 0; font-size: 13px; font-weight: 500; letter-spacing: -.005em; overflow-wrap: anywhere; }
.site-mark { display: grid; place-items: center; flex-shrink: 0; width: 24px; height: 24px; background: var(--subtle); border-radius: 6px; color: var(--muted); font-size: 10px; font-weight: 500; }
.site-count { margin-left: auto; padding-right: 2px; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.login-list { overflow: hidden; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; }
.login-row { display: flex; align-items: center; gap: 20px; padding: 17px 20px; min-height: 76px; transition: background-color .15s; }
.login-row + .login-row { border-top: 1px solid var(--line); }
.login-row:hover { background: var(--hover); }
.login-row:focus-visible { outline-offset: -3px; }
.login-identity { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
.login-title { font-size: 15px; font-weight: 500; line-height: 1.4; letter-spacing: -.015em; overflow-wrap: anywhere; }
.login-username { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.badge { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; font-weight: 400; line-height: 1.4; white-space: nowrap; }
.badge-assistant::before { content: ""; width: 4px; height: 4px; flex-shrink: 0; border-radius: 50%; background: var(--accent); }
.page-metadata .badge { font-size: 12px; }
.row-arrow { width: 15px; height: 15px; color: var(--muted); }
.details-list { margin: 0; padding: 4px 24px; }
.detail-row { display: grid; grid-template-columns: 140px minmax(0, 1fr); align-items: baseline; gap: 24px; padding-block: 24px; }
.detail-row + .detail-row { border-top: 1px solid var(--line); }
dt { font-size: 12px; font-weight: 400; color: var(--muted); }
dd { margin: 0; font-size: 15px; font-weight: 500; letter-spacing: -.01em; overflow-wrap: anywhere; }
.concealed-status { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; font-weight: 400; letter-spacing: 0; }
.password-detail { display: grid; gap: 12px; min-width: 0; }
.password-detail .button { justify-self: start; }
#password-value { white-space: pre-wrap; overflow-wrap: anywhere; font: 14px/1.6 ui-monospace, monospace; font-weight: 400; user-select: text; }
.concealed-status .icon { width: 14px; height: 14px; }
.remove-section { display: flex; justify-content: flex-end; border-top: 1px solid var(--line); margin-top: 28px; padding-top: 16px; }
.remove-section .button { padding-inline: 10px; margin-right: -10px; }
.password-scope { margin-top: 2px; }
.search-empty { padding-block: 48px; }
@media (max-width: 600px) {
  main[data-view="detail"] .page-heading { flex-direction: column; gap: 20px; }
  main[data-view="detail"] .page-heading > div { width: 100%; }
  main[data-view="detail"] .page-heading > .button { margin-top: 0; }
  main[data-view="detail"] h1 { font-size: clamp(24px, 7vw, 28px); }
  .list-tools { gap: 12px; margin-bottom: 28px; }
  .search-field { flex: 1; width: auto; }
  input[type="search"] { font-size: 16px; }
  .list-summary { font-size: 11px; }
  .site-group { margin-bottom: 24px; }
  .login-row { display: grid; grid-template-columns: minmax(0, 1fr) 14px; gap: 8px 16px; padding: 16px; }
  .login-identity { grid-column: 1; grid-row: 1; }
  .login-title { font-size: 14px; }
  .login-title, .login-username { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
  .login-username { font-size: 12px; }
  .login-row > .badge { grid-column: 1; grid-row: 2; }
  .row-arrow { grid-column: 2; grid-row: 1 / span 2; }
  .details-list { padding-inline: 20px; }
  .detail-row { grid-template-columns: 1fr; gap: 8px; padding-block: 20px; }
  .remove-section { margin-top: 24px; padding-top: 12px; }
}
`;

/** Render only host-approved display metadata; this module has no credential-value input. */
export function renderLoginsPage(state: LoginsPageState, shell: Shell, nonce: string): string {
  const titles = {
    add: 'Add login',
    edit: 'Edit login',
    detail: 'Login details',
    list: 'Saved logins',
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
      noscript: 'JavaScript is needed to show a password, save or remove a login.',
      style: STYLE,
      script: LOGINS_PAGE_SCRIPT,
    },
    nonce,
  );
}
