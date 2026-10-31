import { randomBytes } from 'node:crypto';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { isRecord } from '../../gws-ea/validation.js';
import { isPrincipalWebIdentity, type WebIdentity } from '../gws-ea-web/access.js';
import { onePasswordWebsiteOrigin } from './authentication-signatures.js';
import { credentialAttempts, type CredentialAttempts } from './credential-attempts.js';
import {
  browserVault,
  BrowserLoginError,
  BrowserVaultError,
  type BrowserVault,
  type BrowserLoginDetails,
  type BrowserLoginChanges,
} from './onepassword.js';
import { renderLoginsPage, type LoginRow, type LoginsView } from './logins-page-view.js';

interface LoginsPageOptions {
  readonly hostname: string;
  readonly identity: WebIdentity;
  readonly vault?: BrowserVault;
  readonly credentials?: CredentialAttempts;
}
const MAX_BODY_BYTES = 16 * 1024;
class InvalidSubmission extends Error {}
function headers(nonce?: string): Readonly<Record<string, string>> {
  return {
    'cache-control': 'no-store',
    'content-type': nonce ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    'content-security-policy': `default-src 'none'; script-src ${nonce ? `'nonce-${nonce}'` : "'none'"}; style-src ${nonce ? `'nonce-${nonce}'` : "'none'"}; font-src data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-dns-prefetch-control': 'off',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  };
}
function refuse(response: ServerResponse): void {
  response.shouldKeepAlive = false;
  response.writeHead(404, headers());
  response.end();
}
function sameOriginJson(request: IncomingMessage, hostname: string): boolean {
  const site = request.headers['sec-fetch-site'];
  const length = request.headers['content-length'];
  return (
    (site === undefined ? request.headers.origin === `https://${hostname}` : site === 'same-origin') &&
    typeof request.headers['content-type'] === 'string' &&
    /^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers['content-type']) &&
    (length === undefined || (/^\d+$/u.test(length) && Number(length) <= MAX_BODY_BYTES))
  );
}
async function submission(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Stop at the byte cap without destroying the socket before its closed response is sent.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const value: unknown = chunk;
    if (!(value instanceof Uint8Array)) throw new InvalidSubmission();
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) throw new InvalidSubmission();
    chunks.push(Buffer.from(value));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch (_error) {
    throw new InvalidSubmission();
  }
  if (!isRecord(parsed)) throw new InvalidSubmission();
  return parsed;
}
function stringField(data: Record<string, unknown>, name: string): string {
  const value = data[name];
  if (typeof value !== 'string' || value.length === 0) throw new InvalidSubmission();
  return value;
}
function details(data: Record<string, unknown>): BrowserLoginDetails {
  const title = data.title;
  const password = data.password;
  if (typeof title !== 'string' || typeof password !== 'string') throw new InvalidSubmission();
  return { title, password, site: stringField(data, 'site'), username: stringField(data, 'username') };
}
function changedDetails(data: Record<string, unknown>): BrowserLoginChanges {
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
  if (error instanceof BrowserLoginError) {
    switch (error.reason) {
      case 'duplicate_login':
        return 'That site and username already have a login. Open that login to update it.';
      case 'invalid_site':
        return 'Enter a website such as netflix.com or an HTTPS URL without a username or password in the address.';
      case 'invalid_details':
        return 'Enter a username and an account label of at most 200 characters, without control characters.';
      case 'login_changed':
        return 'This login changed since you opened it. Reload the page to see the latest details before saving again.';
    }
  }
  if (error instanceof BrowserVaultError) {
    switch (error.reason) {
      case 'vault_not_set_up':
        return 'Logins are not set up yet. Ask your operator to finish setting up logins.';
      case 'rate_limited':
        return 'The login vault has reached its request limit. Try again later.';
      case 'no_item_for_site':
        return 'That login is no longer available. Return to saved logins and try again.';
      case 'origin_mismatch':
      case 'vault_unavailable':
        return 'The login vault is unavailable. Try again later.';
    }
  }
  return 'The login vault is unavailable. Try again later.';
}

/** The Access-verified principal is checked afresh before every read or write. */
export function createLoginsPageHandler(options: LoginsPageOptions): RequestListener {
  const vault = options.vault ?? browserVault;
  const credentials = options.credentials ?? credentialAttempts;
  return (request, response) => {
    const serve = async (): Promise<void> => {
      const route = request.url;
      const reading = request.method === 'GET' || request.method === 'HEAD';
      const writing =
        request.method === 'POST' && ['/logins/add', '/logins/update', '/logins/remove'].includes(route ?? '');
      let view: LoginsView = (reading ? readView(route) : undefined) ?? { kind: 'list' };
      if (request.headers.host !== options.hostname || (reading ? !readView(route) : !writing)) return refuse(response);
      if (!(await isPrincipalWebIdentity(await options.identity(request)))) return refuse(response);
      if (writing && !sameOriginJson(request, options.hostname)) return refuse(response);
      let outcome = '';
      let status = 200;
      let saved = false;
      if (writing) {
        const data = await submission(request);
        const keys = Object.keys(data).sort().join(',');
        try {
          if (route === '/logins/add') {
            view = { kind: 'add' };
            if (keys !== 'password,site,title,username') throw new InvalidSubmission();
            await vault.createLogin(details(data));
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
            await vault.updateLogin(handle, versionField(data), changedDetails(data));
            view = { kind: 'detail', handle };
            outcome = 'Login updated.';
          } else {
            if (keys !== 'handle,version') throw new InvalidSubmission();
            view = { kind: 'detail', handle: stringField(data, 'handle') };
            await vault.removeLogin(view.handle, versionField(data));
            view = { kind: 'list' };
            outcome =
              'Saved login removed. The browser may still be signed in. You can ask your assistant to sign out.';
          }
          saved = true;
        } catch (error) {
          if (error instanceof InvalidSubmission) throw error;
          outcome = failureMessage(error);
          if (error instanceof BrowserVaultError && error.reason === 'no_item_for_site') {
            status = 409;
            view = { kind: 'list' };
          } else status = error instanceof BrowserLoginError ? (error.reason === 'login_changed' ? 409 : 400) : 503;
        }
      }
      let available = true;
      const rows: LoginRow[] = [];
      /* eslint-disable no-catch-all/no-catch-all -- This page reports only constant outcomes, never SDK errors or credential values. */
      try {
        if (reading) await vault.refresh();
        const logins =
          view.kind === 'list'
            ? await vault.allLogins()
            : view.kind === 'add'
              ? []
              : [await vault.savedLogin(view.handle)];
        for (const login of logins) {
          const websites = login.websites
            .map((website) => onePasswordWebsiteOrigin(website.url))
            .filter((website): website is URL => Boolean(website));
          rows.push({
            handle: login.item_handle,
            site: websites[0]?.hostname ?? 'Other logins',
            website: websites[0]?.hostname ?? '',
            otherWebsites: websites.slice(1).map((website) => website.hostname),
            title: login.title,
            username: login.username ?? '',
            version: login.version,
            account: await credentials.accountForLogin(login),
          });
        }
      } catch (error) {
        if (
          error instanceof BrowserVaultError &&
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
      const nonce = randomBytes(24).toString('base64url');
      response.writeHead(status, {
        ...headers(nonce),
        'x-logins-location': viewLocation(view),
        ...(saved ? { 'x-logins-saved': 'true' } : {}),
      });
      response.end(
        request.method === 'HEAD'
          ? undefined
          : renderLoginsPage({ rows, view, outcome, available, error: status >= 400 && !saved }, nonce),
      );
    };
    void serve().catch((error: unknown) => {
      if (response.headersSent) response.destroy();
      else if (error instanceof InvalidSubmission) refuse(response);
      else {
        response.writeHead(503, headers());
        response.end();
      }
    });
  };
}
