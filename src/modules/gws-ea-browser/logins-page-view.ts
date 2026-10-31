import { LOGINS_PAGE_SCRIPT } from './logins-page-client.js';
import { LOGINS_FONT_FACE } from './logins-font.generated.js';

export interface LoginRow {
  readonly handle: string;
  readonly site: string;
  readonly website: string;
  readonly otherWebsites: readonly string[];
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

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character,
  );
}

const ICON_PATHS = {
  lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  arrow: '<path d="m9 6 6 6-6 6"/>',
  back: '<path d="M19 12H5m6-6-6 6 6 6"/>',
  edit: '<path d="m15 5 4 4M4 20l4-1 12-12a2.8 2.8 0 0 0-4-4L4 15v5Z"/>',
} as const;

function icon(name: keyof typeof ICON_PATHS, className = ''): string {
  return `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
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
  return `${backLink()}${pageHeading(row.title || row.site, accountBadge(row.account), edit)}<section class="panel"><dl class="details-list"><div class="detail-row"><dt>Website</dt><dd>${escapeHtml(row.website || 'No website saved')}</dd></div>${row.otherWebsites.length ? `<div class="detail-row"><dt>Also used on</dt><dd>${row.otherWebsites.map(escapeHtml).join(', ')}</dd></div>` : ''}<div class="detail-row"><dt>Username</dt><dd>${escapeHtml(row.username || 'No username saved')}</dd></div><div class="detail-row"><dt>Password</dt><dd class="concealed-status">${icon('lock')}Not shown</dd></div></dl></section><section class="remove-section" aria-labelledby="remove-section-heading"><h2 class="sr-only" id="remove-section-heading">Remove this login</h2><form method="post" action="/logins/remove" data-login-action="remove" data-site="${escapeHtml(row.site)}" data-username="${escapeHtml(row.username)}">${hiddenItem(row)}<button class="button button-danger" type="submit">Remove login</button></form></section>`;
}

function loginForm(row?: LoginRow): string {
  const editing = row !== undefined;
  const destination = row ? itemUrl(row) : '/logins';
  return `${backLink(destination, editing ? 'Login details' : 'All logins')}${pageHeading(editing ? 'Edit login' : 'Add login')}<section class="panel form-panel"><form method="post" action="/logins/${editing ? 'update' : 'add'}" data-login-action="${editing ? 'update' : 'add'}" data-track-changes>${row ? hiddenItem(row) : ''}<div class="field"><label for="title">Account label <span class="optional" aria-hidden="true">Optional</span></label><input id="title" name="title" type="text" maxlength="200" autocomplete="off" value="${escapeHtml(row?.title ?? '')}" placeholder="Personal"></div><div class="field"><label for="site">Website</label><input id="site" name="site" type="text" inputmode="url" autocomplete="url"${row?.otherWebsites.length ? ' aria-describedby="site-hint"' : ''} autocapitalize="none" spellcheck="false" value="${escapeHtml(row?.website ?? '')}" placeholder="example.com"${editing ? '' : ' required'}>${row?.otherWebsites.length ? '<p class="field-hint" id="site-hint">Other saved websites stay unchanged.</p>' : ''}</div><div class="field"><label for="username">Username</label><input id="username" name="username" type="text" maxlength="320" autocomplete="username" autocapitalize="none" spellcheck="false" value="${escapeHtml(row?.username ?? '')}"${editing ? '' : ' required'}></div><div class="field password-field"><label for="password">${editing ? 'New saved password' : 'Password'}</label><input id="password" name="password" type="password" autocomplete="new-password"${editing ? ' aria-describedby="password-hint password-scope"' : ' required'}>${editing ? '<p class="field-hint" id="password-hint">Leave blank to keep the saved password.</p><p class="field-hint password-scope" id="password-scope">This won’t change the password on the website.</p>' : ''}</div><div class="form-actions"><button class="button button-primary" type="submit">${editing ? 'Save changes' : 'Add login'}</button><a class="button button-secondary" href="${escapeHtml(destination)}" data-navigation>Cancel</a></div></form></section>`;
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
${LOGINS_FONT_FACE}
:root {
  color-scheme: light dark;
  --bg: #fafafa;
  --panel: #fff;
  --subtle: #f2f2f4;
  --hover: #f8f7fc;
  --text: #252529;
  --muted: #6b6b73;
  --line: #e5e5e9;
  --accent: #7c3aed;
  --accent-hover: #6d28d9;
  --accent-ink: #fff;
  --danger: #b42318;
  --danger-bg: #fff1f0;
  --success: #17633e;
  --success-bg: #f0faf4;
  --danger-ink: #fff;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1a1a1a;
    --panel: #222225;
    --subtle: #2b2b30;
    --hover: #29262f;
    --text: #eeeef0;
    --muted: #aaaab3;
    --line: #36363c;
    --accent: #c4b5fd;
    --accent-hover: #d0c4ff;
    --accent-ink: #241342;
    --danger: #fda29b;
    --danger-bg: #352422;
    --success: #9ee3bb;
    --success-bg: #1f3027;
    --danger-ink: #2b1411;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.5 "Geist", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; text-decoration: none; }
button, input { font: inherit; }
button, a, input { -webkit-tap-highlight-color: transparent; }
button, a { touch-action: manipulation; }
button { cursor: pointer; }
button:disabled, a[aria-disabled="true"] { opacity: .6; cursor: wait; }
[hidden] { display: none !important; }
main {
  width: min(720px, calc(100% - 48px));
  margin-inline: auto;
  padding-block: 72px;
  outline: none;
}
main[data-view="add"], main[data-view="edit"] {
  width: min(560px, calc(100% - 48px));
}
h1, h2, p { margin: 0; }
h1 {
  font-size: 32px;
  font-weight: 600;
  line-height: 1.15;
  letter-spacing: -.035em;
  overflow-wrap: anywhere;
}
h2 { font-size: 15px; font-weight: 600; line-height: 1.4; }
.icon { width: 18px; height: 18px; flex-shrink: 0; vertical-align: middle; }
.page-heading {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 24px;
  margin-bottom: 32px;
}
.page-heading > div { min-width: 0; }
.page-heading > .button { flex-shrink: 0; margin-top: -3px; }
.page-metadata { margin-top: 12px; }
.button {
  min-height: 44px;
  padding: 10px 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px solid transparent;
  border-radius: 9px;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
  white-space: nowrap;
  transition: background-color .15s, border-color .15s;
}
.button .icon { width: 16px; height: 16px; }
.button-primary { background: var(--accent); color: var(--accent-ink); box-shadow: 0 1px 2px rgb(0 0 0/.04); }
.button-primary:hover { background: var(--accent-hover); }
.button-secondary { background: var(--panel); border-color: var(--line); color: var(--text); }
.button-secondary:hover { background: var(--subtle); }
.button-danger { background: transparent; color: var(--danger); }
.button-danger:hover { background: var(--danger-bg); }
.back-link {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  margin: -20px 0 24px;
  color: var(--muted);
  font-size: 13px;
}
.back-link .icon { width: 15px; height: 15px; }
.back-link:hover { color: var(--text); }
.list-tools { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-bottom: 32px; }
.search-field { position: relative; width: 320px; max-width: 100%; }
.search-field > .icon { position: absolute; left: 13px; top: 14px; color: var(--muted); width: 16px; height: 16px; pointer-events: none; }
input {
  width: 100%;
  min-width: 0;
  min-height: 46px;
  padding: 11px 12px;
  background: var(--panel);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: 16px;
  line-height: 1.4;
  transition: border-color .15s;
}
input::placeholder { color: var(--muted); opacity: .8; }
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
.login-identity { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
.login-title { font-size: 15px; font-weight: 500; line-height: 1.4; letter-spacing: -.015em; overflow-wrap: anywhere; }
.login-username { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.badge { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; font-weight: 400; line-height: 1.4; white-space: nowrap; }
.badge-assistant::before { content: ""; width: 4px; height: 4px; flex-shrink: 0; border-radius: 50%; background: var(--accent); }
.page-metadata .badge { font-size: 12px; }
.row-arrow { width: 15px; height: 15px; color: var(--muted); }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
.details-list { margin: 0; padding: 4px 24px; }
.detail-row { display: grid; grid-template-columns: 140px minmax(0, 1fr); align-items: baseline; gap: 24px; padding-block: 24px; }
.detail-row + .detail-row { border-top: 1px solid var(--line); }
dt { font-size: 12px; font-weight: 400; color: var(--muted); }
dd { margin: 0; font-size: 15px; font-weight: 500; letter-spacing: -.01em; overflow-wrap: anywhere; }
.concealed-status { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; font-weight: 400; letter-spacing: 0; }
.concealed-status .icon { width: 14px; height: 14px; }
.remove-section { display: flex; justify-content: flex-end; border-top: 1px solid var(--line); margin-top: 28px; padding-top: 16px; }
.remove-section .button { padding-inline: 10px; margin-right: -10px; }
.form-panel { max-width: 620px; }
.form-panel form { padding: 28px; }
.field + .field { margin-top: 24px; }
.field label { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; font-size: 13px; font-weight: 500; }
.optional { color: var(--muted); font-size: 11px; font-weight: 400; }
.field-hint { display: block; margin-top: 8px; color: var(--muted); font-size: 12px; font-weight: 400; line-height: 1.5; overflow-wrap: anywhere; }
.password-scope { margin-top: 2px; }
.form-actions { display: flex; align-items: center; flex-direction: row-reverse; gap: 10px; margin-top: 32px; padding-top: 24px; border-top: 1px solid var(--line); }
#outcome { margin: 0 0 24px; padding: 12px 16px; border: 1px solid var(--line); border-radius: 9px; color: var(--success); background: var(--success-bg); font-size: 13px; overflow-wrap: anywhere; }
#outcome[data-error="true"] { color: var(--danger); background: var(--danger-bg); }
#outcome:empty { display: none; }
.empty-state { display: flex; flex-direction: column; align-items: center; gap: 20px; padding: 72px 24px; text-align: center; border: 1px dashed var(--line); border-radius: 12px; }
.empty-state h2 { font-size: 15px; font-weight: 500; }
.empty-icon { width: 44px; height: 44px; display: grid; place-items: center; border-radius: 12px; background: var(--subtle); color: var(--muted); }
.empty-icon .icon { width: 20px; height: 20px; }
.search-empty { padding-block: 48px; }
dialog { width: min(420px, calc(100% - 32px)); max-height: calc(100svh - 48px); overflow: auto; overscroll-behavior: contain; background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 16px; padding: 28px; box-shadow: 0 24px 80px rgb(0 0 0/.18); }
dialog::backdrop { background: rgb(0 0 0/.42); backdrop-filter: blur(3px); }
dialog h2 { font-size: 20px; letter-spacing: -.025em; }
dialog p { margin-top: 12px; font-size: 13px; color: var(--muted); line-height: 1.6; overflow-wrap: anywhere; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 28px; }
.dialog-actions .button-danger { background: var(--danger); color: var(--danger-ink); }
.dialog-actions .button-danger:hover { filter: brightness(.95); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.login-row:focus-visible { outline-offset: -3px; }
input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (max-width: 600px) {
  main, main[data-view="add"], main[data-view="edit"] { width: calc(100% - 40px); padding-block: 36px; }
  h1 { font-size: 28px; }
  .page-heading { gap: 16px; margin-bottom: 28px; }
  .page-heading > .button { padding-inline: 12px; margin-top: -5px; }
  main[data-view="detail"] .page-heading { flex-direction: column; gap: 20px; }
  main[data-view="detail"] .page-heading > div { width: 100%; }
  main[data-view="detail"] .page-heading > .button { margin-top: 0; }
  main[data-view="detail"] h1 { font-size: clamp(24px, 7vw, 28px); }
  .back-link { margin: -12px 0 20px; }
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
  .form-panel form { padding: 24px 20px; }
  .form-actions { flex-direction: row-reverse; gap: 8px; }
  .form-actions .button { flex: 1; }
  .remove-section { margin-top: 24px; padding-top: 12px; }
  .empty-state { padding: 56px 20px; }
  dialog { padding: 24px; }
  .dialog-actions .button { flex: 1; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; scroll-behavior: auto !important; }
}
`;

/** Render only host-approved display metadata; this module has no credential-value input. */
export function renderLoginsPage(state: LoginsPageState, nonce: string): string {
  const titles = {
    add: 'Add login',
    edit: 'Edit login',
    detail: 'Login details',
    list: 'Saved logins',
  } satisfies Record<LoginsView['kind'], string>;
  const title = titles[state.view.kind];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title} · Saved logins</title><style nonce="${escapeHtml(nonce)}">${STYLE}</style></head><body><main tabindex="-1" data-view="${state.view.kind}"><p id="outcome" role="${state.error ? 'alert' : 'status'}" tabindex="-1" data-error="${state.error}"${state.outcome ? '' : ' hidden'}>${escapeHtml(state.outcome)}</p>${pageContent(state)}<noscript><p class="field-hint">JavaScript is needed to save or remove a login.</p></noscript></main><dialog id="remove-dialog" aria-labelledby="remove-heading" aria-describedby="remove-description"><h2 id="remove-heading">Remove login?</h2><p id="remove-description"></p><div class="dialog-actions"><button class="button button-secondary" type="button" id="cancel-remove">Cancel</button><button class="button button-danger" type="button" id="confirm-remove">Remove login</button></div></dialog><script nonce="${escapeHtml(nonce)}">${LOGINS_PAGE_SCRIPT}</script></body></html>`;
}
