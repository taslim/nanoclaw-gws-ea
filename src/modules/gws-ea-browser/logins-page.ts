import type { RequestListener } from 'node:http';
import type { WebIdentity } from '../gws-ea-web/access.js';
import {
  handle,
  InvalidSubmission,
  isPrincipalRequest,
  pageNonce,
  readShell,
  readSubmission,
  refuse,
  sameOriginJson,
  sendJson,
  sendPage,
} from '../gws-ea-web/kit/index.js';
import { credentialAttempts, type CredentialAttempts } from './credential-attempts.js';
import {
  getLoginStore,
  LoginDetailsError,
  LoginStoreError,
  type LoginStore,
  type LoginDetails,
  type LoginChanges,
} from './login-store.js';
import { renderLoginsPage, type LoginRow, type LoginsView } from './logins-page-view.js';

interface LoginsPageOptions {
  readonly hostname: string;
  readonly identity: WebIdentity;
  readonly store?: LoginStore;
  readonly credentials?: CredentialAttempts;
}
function stringField(data: Record<string, unknown>, name: string): string {
  const value = data[name];
  if (typeof value !== 'string' || value.length === 0) throw new InvalidSubmission();
  return value;
}
function details(data: Record<string, unknown>): LoginDetails {
  const title = data.title;
  const password = data.password;
  if (typeof title !== 'string' || typeof password !== 'string') throw new InvalidSubmission();
  return { title, password, site: stringField(data, 'site'), username: stringField(data, 'username') };
}
function changedDetails(data: Record<string, unknown>): LoginChanges {
  const optional = (name: string): string | undefined => {
    const value = data[name];
    if (value !== undefined && typeof value !== 'string') throw new InvalidSubmission();
    return value;
  };
  if (typeof data.password !== 'string') throw new InvalidSubmission();
  return { title: optional('title'), site: optional('site'), username: optional('username'), password: data.password };
}
function versionField(data: Record<string, unknown>): number {
  const raw = stringField(data, 'version');
  const version = Number(raw);
  if (!/^[1-9]\d*$/u.test(raw) || !Number.isSafeInteger(version)) throw new InvalidSubmission();
  return version;
}
function readView(route: string | undefined): LoginsView | undefined {
  if (route === '/logins') return { kind: 'list' };
  if (route === '/logins/new') return { kind: 'add' };
  const match = /^\/logins\/item\/(vault_[a-f0-9-]{36})(\/edit)?$/u.exec(route ?? '');
  return match ? { kind: match[2] ? 'edit' : 'detail', handle: match[1] } : undefined;
}
function viewLocation(view: LoginsView): string {
  switch (view.kind) {
    case 'list':
      return '/logins';
    case 'add':
      return '/logins/new';
    case 'detail':
      return `/logins/item/${view.handle}`;
    case 'edit':
      return `/logins/item/${view.handle}/edit`;
  }
}
function failureMessage(error: unknown): string {
  if (error instanceof LoginDetailsError) {
    switch (error.reason) {
      case 'login_busy':
        return 'Your assistant is changing this password. Try again once it’s done.';
      case 'duplicate_login':
        return 'There’s already a login for this site and username. Open it to make changes.';
      case 'invalid_site':
        return 'Enter a website like example.com, without a username or password in it.';
      case 'invalid_details':
        return 'Enter a username and password, and keep the label to 200 characters.';
      case 'login_changed':
        return 'This login changed after you opened it. Reload to see the latest details, then save again.';
    }
  }
  if (error instanceof LoginStoreError && error.reason === 'no_item_for_site')
    return 'This login is no longer saved. Go back to your logins and try again.';
  return 'Saved logins can’t be opened right now. Ask your operator.';
}

function failureStatus(error: unknown): number {
  if (error instanceof LoginStoreError && error.reason === 'no_item_for_site') return 409;
  if (error instanceof LoginDetailsError)
    return error.reason === 'login_changed' || error.reason === 'login_busy' ? 409 : 400;
  return 503;
}
/** The Access-verified principal is checked afresh before every read or write. */
export function createLoginsPageHandler(options: LoginsPageOptions): RequestListener {
  const credentials = options.credentials ?? credentialAttempts;
  return (request, response) => {
    const serve = async (): Promise<void> => {
      const route = request.url;
      const reading = request.method === 'GET' || request.method === 'HEAD';
      const writing =
        request.method === 'POST' &&
        ['/logins/add', '/logins/update', '/logins/remove', '/logins/reveal'].includes(route ?? '');
      let view: LoginsView = (reading ? readView(route) : undefined) ?? { kind: 'list' };
      if (reading ? !readView(route) : !writing) return refuse(response);
      if (!(await isPrincipalRequest(request, options.hostname, options.identity))) return refuse(response);
      if (writing && !sameOriginJson(request, options.hostname)) return refuse(response);
      const store = options.store ?? (await getLoginStore());
      const data = writing ? await readSubmission(request) : undefined;
      if (data && route === '/logins/reveal') {
        const keys = Object.keys(data).sort().join(',');
        if (keys !== 'handle,version') throw new InvalidSubmission();
        const handle = stringField(data, 'handle');
        const version = versionField(data);
        /* eslint-disable no-catch-all/no-catch-all -- The reveal response reports only constant failures and never credential-bearing errors. */
        try {
          const password = await store.revealPassword(handle, version);
          if (!(await isPrincipalRequest(request, options.hostname, options.identity))) return refuse(response);
          sendJson(response, 200, { password });
        } catch (error) {
          sendJson(response, failureStatus(error), { error: failureMessage(error) });
        }
        /* eslint-enable no-catch-all/no-catch-all */
        return;
      }
      // Before any write, so a page that cannot be drawn changes nothing.
      const shell = await readShell();
      let outcome = '';
      let status = 200;
      let saved = false;
      if (data) {
        const keys = Object.keys(data).sort().join(',');
        try {
          if (route === '/logins/add') {
            view = { kind: 'add' };
            if (keys !== 'password,site,title,username') throw new InvalidSubmission();
            const spec = details(data);
            await store.create(spec);
            view = { kind: 'list' };
            outcome = 'Login added.';
          } else if (route === '/logins/update') {
            if (
              Object.keys(data).some(
                (key) => !['handle', 'password', 'site', 'title', 'username', 'version'].includes(key),
              )
            )
              throw new InvalidSubmission();
            const handle = stringField(data, 'handle');
            view = { kind: 'edit', handle };
            const version = versionField(data);
            const changes = changedDetails(data);
            await store.update(handle, version, changes);
            view = { kind: 'detail', handle };
            outcome = 'Changes saved.';
          } else {
            if (keys !== 'handle,version') throw new InvalidSubmission();
            view = { kind: 'detail', handle: stringField(data, 'handle') };
            const version = versionField(data);
            await store.remove(view.handle, version);
            view = { kind: 'list' };
            outcome = 'Login removed. If your assistant’s browser is still signed in, ask your assistant to sign out.';
          }
          saved = true;
        } catch (error) {
          if (error instanceof InvalidSubmission) throw error;
          outcome = failureMessage(error);
          if (error instanceof LoginStoreError && error.reason === 'no_item_for_site') {
            status = 409;
            view = { kind: 'list' };
          } else status = failureStatus(error);
        }
      }
      let available = true;
      const rows: LoginRow[] = [];
      /* eslint-disable no-catch-all/no-catch-all -- This page reports only constant outcomes, never store errors or credential values. */
      try {
        const logins =
          view.kind === 'list' ? await store.all() : view.kind === 'add' ? [] : [await store.get(view.handle)];
        for (const login of logins) {
          rows.push({
            handle: login.id,
            site: login.hostname,
            title: login.title,
            username: login.username,
            version: login.version,
            account: await credentials.accountForLogin(login),
          });
        }
      } catch (error) {
        if (
          error instanceof LoginStoreError &&
          error.reason === 'no_item_for_site' &&
          reading &&
          (view.kind === 'detail' || view.kind === 'edit')
        ) {
          status = 404;
        } else {
          available = false;
          status = 503;
          rows.length = 0;
          outcome = outcome ? `${outcome} ${failureMessage(error)}` : failureMessage(error);
        }
      }
      /* eslint-enable no-catch-all/no-catch-all */
      if (
        reading &&
        available &&
        (view.kind === 'detail' || view.kind === 'edit') &&
        !rows.some((row) => row.handle === view.handle)
      )
        status = 404;
      const nonce = pageNonce();
      sendPage(response, {
        status,
        nonce,
        location: viewLocation(view),
        saved,
        body:
          request.method === 'HEAD'
            ? undefined
            : renderLoginsPage({ rows, view, outcome, available, error: status >= 400 && !saved }, shell, nonce),
      });
    };
    handle(response, serve);
  };
}
