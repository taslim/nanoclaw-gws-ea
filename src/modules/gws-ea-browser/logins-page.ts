import { randomBytes } from 'node:crypto';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { hasControlCharacters, isRecord } from '../../gws-ea/validation.js';
import { isPrincipalWebIdentity, type WebIdentity } from '../gws-ea-web/access.js';
import { onePasswordWebsiteOrigin } from './authentication-signatures.js';
import { credentialAttempts, type CredentialAttempts } from './credential-attempts.js';
import { browserVault, BrowserLoginError, BrowserVaultError, type BrowserVault } from './onepassword.js';

interface LoginsPageOptions {
  readonly hostname: string;
  readonly identity: WebIdentity;
  readonly vault?: BrowserVault;
  readonly credentials?: CredentialAttempts;
}
interface LoginRow {
  readonly handle: string;
  readonly site: string;
  readonly username: string;
  readonly account: 'assistant' | 'principal';
}
const MAX_BODY_BYTES = 16 * 1024;
class InvalidSubmission extends Error {}
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character,
  );
}
function headers(nonce?: string): Readonly<Record<string, string>> {
  return {
    'cache-control': 'no-store',
    'content-type': nonce ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    'content-security-policy': `default-src 'none'; script-src ${nonce ? `'nonce-${nonce}'` : "'none'"}; style-src ${nonce ? `'nonce-${nonce}'` : "'none'"}; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`,
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
function failureMessage(error: unknown): string {
  if (error instanceof BrowserLoginError) {
    return error.reason === 'duplicate_login'
      ? 'That site and username already have a login. Update its saved password below instead.'
      : 'Enter a website such as netflix.com or an HTTPS URL without a username or password in the address.';
  }
  if (error instanceof BrowserVaultError) {
    switch (error.reason) {
      case 'vault_not_set_up':
        return 'Logins are not set up yet. Ask your operator to finish setting up logins.';
      case 'rate_limited':
        return 'The login vault has reached its request limit. Try again later.';
      case 'no_item_for_site':
        return 'That login is no longer available. Refresh the page and try again.';
      case 'origin_mismatch':
      case 'vault_unavailable':
        return 'The login vault is unavailable. Try again later.';
    }
  }
  return 'The login vault is unavailable. Try again later.';
}
const STYLE = `:root{color-scheme:light dark;--bg:light-dark(#fbfaf8,#161514);--panel:light-dark(#fff,#201f1c);--text:light-dark(#1d1c1a,#edebe7);--muted:light-dark(#57544e,#aaa7a0);--line:light-dark(#e4e1db,#302e2b);--accent:light-dark(#1f5fbf,#80aaff)}*{box-sizing:border-box}body{margin:0;font:16px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--text)}main{max-width:42rem;margin:auto;padding:24px 16px 56px}h1{font-size:1.6rem}h2{font-size:1.15rem;margin-top:0;overflow-wrap:anywhere}p{overflow-wrap:anywhere}.muted{color:var(--muted)}section,article{background:var(--panel);padding:20px;border:1px solid var(--line);border-radius:12px;margin:20px 0}label{display:block;margin:12px 0 4px}input,button{font:inherit;border:1px solid var(--line);border-radius:6px;padding:10px 12px}input{width:100%;min-width:0;color:var(--text);background:var(--bg)}button{min-height:44px;cursor:pointer;background:var(--panel);color:var(--accent);margin-top:12px}button:disabled{opacity:.65;cursor:wait}form{margin:12px 0}summary{cursor:pointer;color:var(--accent);padding:8px 0}a{color:var(--accent)}:focus-visible{outline:2px solid var(--accent);outline-offset:3px}#outcome:empty{display:none}#outcome{border-left:3px solid var(--accent);padding:12px}dialog{max-width:min(36rem,calc(100% - 32px));background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:12px;padding:24px}dialog::backdrop{background:rgb(0 0 0/.45)}.actions{display:flex;gap:12px;flex-wrap:wrap}`;
const SCRIPT = `(()=>{'use strict';
const dialog=document.querySelector('dialog');let pending;
function message(text){const outcome=document.getElementById('outcome');outcome.textContent=text;outcome.focus();}
async function send(form){const data=Object.fromEntries(new FormData(form));form.querySelectorAll('input[type=password]').forEach(input=>{input.value='';});document.querySelectorAll('button').forEach(button=>{button.disabled=true;});let body=JSON.stringify(data);delete data.password;
try{const operation=fetch(form.action,{method:'POST',headers:{'Content-Type':'application/json'},body,credentials:'same-origin',cache:'no-store'});body='';const response=await operation;if(!response.ok&&response.status===404){message('This request could not be accepted. Refresh the page and try again.');return;}const html=await response.text();const page=new DOMParser().parseFromString(html,'text/html');const next=page.querySelector('main');if(!next){message('The login vault is unavailable. Try again later.');return;}document.querySelector('main').replaceWith(next);location.hash='outcome';document.getElementById('outcome').focus();}
catch{message('The request could not be confirmed. Refresh the page before trying again.');}
finally{body='';document.querySelectorAll('button').forEach(button=>{button.disabled=false;});}}
document.addEventListener('submit',event=>{const form=event.target;if(!(form instanceof HTMLFormElement)||!form.dataset.loginAction)return;event.preventDefault();if(form.dataset.loginAction==='remove'){pending=form;document.getElementById('remove-description').textContent='Remove the saved login for '+form.dataset.site+' ('+form.dataset.username+')? The browser may still be signed in to this site. You can ask your assistant to sign out.';dialog.showModal();document.getElementById('cancel-remove').focus();return;}void send(form);});
document.getElementById('cancel-remove').addEventListener('click',()=>{pending=undefined;dialog.close();});dialog.addEventListener('cancel',()=>{pending=undefined;});document.getElementById('confirm-remove').addEventListener('click',()=>{const form=pending;pending=undefined;dialog.close();if(form)void send(form);});
})();`;

function render(rows: readonly LoginRow[], outcome: string, available: boolean, nonce: string): string {
  const content = rows
    .map((row, index) => {
      const site = escapeHtml(row.site);
      const username = escapeHtml(row.username);
      const handle = escapeHtml(row.handle);
      return `<article><h2>${site}</h2><p>${username}<br><span class="muted">${row.account === 'assistant' ? 'Assistant’s account' : 'Your account'}</span></p><details><summary>Update saved password</summary><form method="post" action="/logins/update" data-login-action="update"><input type="hidden" name="handle" value="${handle}"><label for="password-${index}">New saved password</label><input id="password-${index}" name="password" type="password" autocomplete="new-password" required><button type="submit">Save password</button></form></details><form method="post" action="/logins/remove" data-login-action="remove" data-site="${site}" data-username="${username}"><input type="hidden" name="handle" value="${handle}"><button type="submit">Remove login</button></form></article>`;
    })
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Saved logins</title><style nonce="${nonce}">${STYLE}</style></head><body><main><h1>Saved logins</h1><p>Your assistant can use these logins. Passwords are saved in its vault and are never shown here. Updating a saved password does not change it on the website.</p><p id="outcome" role="status" tabindex="-1">${escapeHtml(outcome)}</p>${available ? `${content || '<p>No saved logins yet.</p>'}<section><h2>Add a login</h2><form method="post" action="/logins/add" data-login-action="add"><label for="site">Website</label><input id="site" name="site" type="text" inputmode="url" autocomplete="url" placeholder="netflix.com" required><label for="username">Username</label><input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password" required><button type="submit">Add login</button></form></section>` : ''}<noscript><p>JavaScript is needed to save or remove a login. Enable it and reload this page.</p></noscript></main><dialog aria-labelledby="remove-heading" aria-describedby="remove-description"><h2 id="remove-heading">Remove login?</h2><p id="remove-description"></p><div class="actions"><button type="button" id="cancel-remove">Cancel</button><button type="button" id="confirm-remove">Remove login</button></div></dialog><script nonce="${nonce}">${SCRIPT}</script></body></html>`;
}

/** The Access-verified principal is checked afresh before every read or write. */
export function createLoginsPageHandler(options: LoginsPageOptions): RequestListener {
  const vault = options.vault ?? browserVault;
  const credentials = options.credentials ?? credentialAttempts;
  return (request, response) => {
    const serve = async (): Promise<void> => {
      const route = request.url;
      const reading = (request.method === 'GET' || request.method === 'HEAD') && route === '/logins';
      const writing =
        request.method === 'POST' && ['/logins/add', '/logins/update', '/logins/remove'].includes(route ?? '');
      if (request.headers.host !== options.hostname || (!reading && !writing)) return refuse(response);
      if (!(await isPrincipalWebIdentity(await options.identity(request)))) return refuse(response);
      if (writing && !sameOriginJson(request, options.hostname)) return refuse(response);
      let outcome = '';
      let status = 200;
      if (writing) {
        const data = await submission(request);
        const keys = Object.keys(data).sort().join(',');
        try {
          if (route === '/logins/add') {
            if (keys !== 'password,site,username') throw new InvalidSubmission();
            const username = stringField(data, 'username');
            if (hasControlCharacters(username)) throw new InvalidSubmission();
            await vault.createLogin(stringField(data, 'site'), username, stringField(data, 'password'));
            outcome = 'Login added.';
          } else if (route === '/logins/update') {
            if (keys !== 'handle,password') throw new InvalidSubmission();
            await vault.setLoginPassword(stringField(data, 'handle'), stringField(data, 'password'));
            outcome = 'Saved password updated.';
          } else {
            if (keys !== 'handle') throw new InvalidSubmission();
            await vault.removeLogin(stringField(data, 'handle'));
            outcome =
              'Saved login removed. The browser may still be signed in. You can ask your assistant to sign out.';
          }
        } catch (error) {
          if (error instanceof InvalidSubmission) throw error;
          outcome = failureMessage(error);
          status = error instanceof BrowserLoginError ? 400 : 503;
        } finally {
          delete data.password;
        }
      }
      let available = true;
      const rows: LoginRow[] = [];
      /* eslint-disable no-catch-all/no-catch-all -- This page reports only constant outcomes, never SDK errors or credential values. */
      try {
        if (reading) await vault.refresh();
        for (const login of await vault.allLogins()) {
          const site = login.websites.map((website) => onePasswordWebsiteOrigin(website.url)?.hostname).find(Boolean);
          rows.push({
            handle: login.item_handle,
            site: site ?? (login.title || 'Login without a website'),
            username: login.username ?? 'No username saved',
            account: await credentials.accountForLogin(login),
          });
        }
      } catch (error) {
        available = false;
        status = 503;
        rows.length = 0;
        outcome = outcome ? `${outcome} ${failureMessage(error)}` : failureMessage(error);
      }
      /* eslint-enable no-catch-all/no-catch-all */
      const nonce = randomBytes(24).toString('base64url');
      response.writeHead(status, headers(nonce));
      response.end(request.method === 'HEAD' ? undefined : render(rows, outcome, available, nonce));
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
