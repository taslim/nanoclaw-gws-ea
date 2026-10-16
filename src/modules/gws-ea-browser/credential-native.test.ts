/**
 * Real Chrome pipe, background windows and TLS origins for authorized signup
 * and password changes; all traffic terminates in this fixture, and 1Password
 * is the SDK fake. Generated passwords are read back only from that fake.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CDPSession, Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@1password/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@1password/sdk')>()),
  createClient: sdk.create,
}));

import { closeDb, getDb, initSqliteTestDb } from '../../db/connection.js';
import { prepareAuthenticationIsolation } from './authentication-submit.js';
import { prepareChromeProfile, spawnChrome } from './chrome.js';
import { connectChromePipe, type ChromeConnection } from './connection.js';
import { CredentialAttempts, type CredentialAttempt } from './credential-attempts.js';
import { executeCredentialForm } from './credential-operations.js';
import { executeBrowserBatch } from './executor.js';
import './merchant-signatures.js';
import { browserCredentialAttemptsMigration, browserSiteLeasesMigration } from './migration.js';
import { observePage, type BrowserRef } from './observe.js';
import { BrowserVault } from './onepassword.js';
import { FakeOnePassword, writeVaultFixture } from './onepassword-fixture.js';
import { browserPaths } from './paths.js';
import type { BrowserExecutionContext } from './queue.js';

const chromePath = process.env.GWS_EA_BROWSER_TEST_CHROME;
const JOB = 'system:a2a:main:native-credential-job';
const SITE = 'https://accounts.shop.example';
const USERNAME = 'morgan.ellery@example.com';

const field = (label: string, name: string, type: string, autocomplete: string): string =>
  `<label>${label} <input type="${type}" name="${name}" autocomplete="${autocomplete}"></label>`;
const signupFields = `${field('Email', 'email', 'email', 'email')}${field('Password', 'password', 'password', 'new-password')}${field('Confirm password', 'password_confirmation', 'password', 'new-password')}`;
const nativeForm = (action: string, button = 'Create account', extra = ''): string =>
  `<h1>Join</h1><form method="post" action="${action}">${signupFields}${extra}<button type="submit">${button}</button></form><p>Password must be at least 12 characters.</p>`;
/** A React-like controlled form: state changes only on input events whose value its own tracker has not seen. */
const controlled = (submit: string): string => `<div id="result"></div><script>
  const state = {};
  const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  const go = document.getElementById('go');
  for (const input of document.querySelectorAll('input')) {
    let tracked = '';
    Object.defineProperty(input, 'value', { configurable: true,
      get() { return proto.get.call(this); }, set(value) { tracked = value; proto.set.call(this, value); } });
    input.addEventListener('input', () => {
      window.credentialCallback && window.credentialCallback();
      const current = proto.get.call(input);
      if (current === tracked) return;
      tracked = current;
      state[input.name] = current;
      setTimeout(() => { go.disabled = !(state.email && state.password); go.setAttribute('aria-disabled', String(go.disabled)); }, 150);
    });
  }
  const send = () => fetch('/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state) })
    .then((response) => response.text()).then((html) => { document.getElementById('result').innerHTML = html; });
  ${submit}
</script>`;
const PAGES: Record<string, string> = {
  '/native-signup': nativeForm('/signup'),
  '/js-signup': `<h1>Join</h1><form id="join">${signupFields}<button id="go" type="submit" disabled>Create account</button></form>${controlled(
    "document.getElementById('join').addEventListener('submit', (event) => { event.preventDefault(); send(); });",
  )}`,
  '/no-form-signup': `<h1>Join</h1><div>${field('Email', 'email', 'email', 'email')}${field('Password', 'password', 'password', 'new-password')}<div role="button" tabindex="0" id="go">Create account</div></div>${controlled(
    "go.addEventListener('click', () => { if (go.getAttribute('aria-disabled') !== 'true') send(); });",
  )}`,
  '/multi-step': `<h1>Join</h1><form method="post" action="/signup/email">${field('Email', 'email', 'email', 'username')}<button type="submit">Continue</button></form>`,
  '/masking': `<h1>Join</h1><form id="join">${signupFields}<button id="go" type="submit">Create account</button></form><input name="notes" aria-label="Notes"><div id="echo"></div>${controlled(
    `document.querySelector('[name=password]').addEventListener('input', (event) => {
      event.target.type = 'text';
      document.getElementById('echo').textContent = 'You typed ' + event.target.value;
      document.querySelector('[name=notes]').value = event.target.value;
    });
    document.getElementById('join').addEventListener('submit', (event) => { event.preventDefault(); send(); });`,
  )}`,
  '/prefilled': `<h1>Join</h1><label>Confirm password <input type="text" name="confirm_password" value="page-chosen-secret-value"></label>`,
  '/change': `<h1>Security</h1><form method="post" action="/account/change-password">${field('Current password', 'current_password', 'password', 'current-password')}${field('New password', 'new_password', 'password', 'new-password')}${field('Confirm new password', 'confirm_password', 'password', 'new-password')}<button type="submit">Change password</button></form>`,
  '/change-shown-account': `<h1>Security</h1><form method="post" action="/account/change-password"><label>Account <input type="email" name="email" autocomplete="username" value="${USERNAME}" readonly></label>${field('Current password', 'current_password', 'password', 'current-password')}${field('New password', 'new_password', 'password', 'new-password')}${field('Confirm new password', 'confirm_password', 'password', 'new-password')}<button type="submit">Change password</button></form>`,
  '/change-with-email': `<h1>Security</h1><form method="post" action="/account/change-password">${field('Current password', 'current_password', 'password', 'current-password')}${field('New password', 'new_password', 'password', 'new-password')}${field('Recovery email', 'recovery_email', 'email', 'email')}<button type="submit">Change password</button></form>`,
  '/change-email': `<h1>Security</h1><form method="post" action="/account/change-password">${field('Current password', 'current_password', 'password', 'current-password')}${field('New password', 'new_password', 'password', 'new-password')}<button type="submit">Update email</button></form>`,
  '/offsite-action': nativeForm('https://collector.example/signup'),
  '/http-action': nativeForm('http://accounts.shop.example/signup'),
  '/checkout-action': nativeForm('/checkout/subscribe'),
  '/trial': nativeForm('/signup', 'Start free trial'),
  '/order-total': `${nativeForm('/signup')}<p>Order total $10.00 due today, charged to your Visa card ending 4242.</p>`,
  '/ambiguous': nativeForm('/signup', 'Go'),
  '/get-signup': nativeForm('/signup').replace('method="post"', 'method="get"'),
};

describe.skipIf(!chromePath)('native authorized signup and password change', () => {
  let root: string;
  let proxy: HttpServer;
  let server: HttpsServer;
  let connection: ChromeConnection;
  let page: Page;
  let certificateSession: CDPSession;
  let fake: FakeOnePassword;
  let attempts: CredentialAttempts;
  let vault: BrowserVault;
  let remaining = 20_000;
  const sockets = new Set<Socket>();
  const posts: Array<{ host: string; path: string; body: string }> = [];
  const addresses: string[] = [];
  const responses = new Map<string, string>();
  let accountPassword: string | undefined;
  let callbackPhases: Array<string | undefined>;

  beforeAll(async () => {
    if (!chromePath) throw new Error('Native Chrome path required');
    root = await realpath(await mkdtemp(join(tmpdir(), 'browser-credential-native-')));
    execFileSync(
      '/usr/bin/openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(root, 'key.pem'),
        '-out',
        join(root, 'cert.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=accounts.shop.example',
      ],
      { stdio: 'ignore' },
    );
    server = createHttpsServer(
      { key: await readFile(join(root, 'key.pem')), cert: await readFile(join(root, 'cert.pem')) },
      (request, response) => {
        const host = request.headers.host ?? '';
        const path = new URL(request.url ?? '/', `https://${host}`).pathname;
        const html = (body: string): void => {
          response.writeHead(200, { 'content-type': 'text/html' }).end(body);
        };
        if (request.method !== 'POST') {
          addresses.push(`${host}${request.url ?? ''}`);
          if (host === 'parent.example')
            html(
              `<input id="untrusted" aria-label="Untrusted"><iframe src="${SITE}${path === '/get' ? '/get-signup' : '/native-signup'}"></iframe><script>document.querySelector('input').addEventListener('input', e => { document.body.dataset.captured = e.target.value; });addEventListener('message', e => { if (e.data === 'steal-focus') { document.querySelector('input').focus(); document.body.dataset.stolen = 'yes'; } });</script>`,
            );
          else html(PAGES[path] ?? '<h1>Not found</h1>');
          return;
        }
        let body = '';
        request.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        request.on('end', () => {
          posts.push({ host, path, body });
          if (path === '/signup/email')
            html(
              `<h1>Choose a password</h1><form method="post" action="/signup/password">${field('Password', 'password', 'password', 'new-password')}${field('Confirm password', 'confirm', 'password', 'new-password')}<button type="submit">Create account</button></form>`,
            );
          else if (path === '/account/change-password') {
            const form = new URLSearchParams(body);
            if (form.get('current_password') !== accountPassword)
              html(`<p>Current password is incorrect.</p>${PAGES['/change']}`);
            else {
              accountPassword = form.get('new_password') ?? undefined;
              html('<h1>Your password has been changed.</h1>');
            }
          } else html(responses.get(path) ?? '<h1>Account created</h1><a href="/logout">Sign out</a>');
        });
      },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TLS fixture did not bind');
    proxy = createHttpServer((_request, response) => {
      response.writeHead(403).end();
    });
    proxy.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    proxy.on('connect', (request, socket, head) => {
      if (!['accounts.shop.example:443', 'parent.example:443', 'collector.example:443'].includes(request.url ?? '')) {
        socket.destroy();
        return;
      }
      const upstream = connect(address.port, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      sockets.add(upstream);
      upstream.once('close', () => sockets.delete(upstream));
      socket.on('error', () => upstream.destroy());
      upstream.on('error', () => socket.destroy());
      socket.once('close', () => upstream.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxyAddress = proxy.address();
    if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('Proxy fixture did not bind');
    const paths = browserPaths(join(root, 'browser', 'policy.json'));
    await prepareChromeProfile(paths);
    connection = await connectChromePipe(
      spawnChrome({ chromePath, paths, proxyUrl: `http://127.0.0.1:${proxyAddress.port}` }),
      paths,
    );
    await prepareAuthenticationIsolation(connection.context);
  }, 30_000);

  beforeEach(async () => {
    const db = await initSqliteTestDb();
    await browserSiteLeasesMigration.up(db);
    await browserCredentialAttemptsMigration.up(db);
    const directory = await realpath(await mkdtemp(join(root, 'vault-')));
    vault = new BrowserVault(await writeVaultFixture(directory));
    fake = new FakeOnePassword();
    sdk.create.mockReset();
    sdk.create.mockImplementation(async () => fake.client());
    attempts = new CredentialAttempts({ db: getDb(), vault, automaticPromotion: false });
    posts.length = 0;
    addresses.length = 0;
    responses.clear();
    accountPassword = undefined;
    remaining = 20_000;
    callbackPhases = [];
    const appeared = connection.context.waitForEvent('page');
    await connection.session.send('Target.createTarget', { url: 'about:blank', newWindow: true, background: true });
    page = await appeared;
    certificateSession = await connection.context.newCDPSession(page);
    await certificateSession.send('Security.setIgnoreCertificateErrors', { ignore: true });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await certificateSession?.detach();
    await page?.close();
    await closeDb();
  });
  afterAll(async () => {
    await connection?.close();
    for (const socket of sockets) socket.destroy();
    server?.closeAllConnections();
    proxy?.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => server?.close(() => resolve())),
      new Promise<void>((resolve) => proxy?.close(() => resolve())),
    ]);
    if (root) await rm(root, { recursive: true, force: true });
  });

  function context(): BrowserExecutionContext {
    return {
      page: async () => page,
      assertActive: async () => undefined,
      runtime: { closeJob: async () => page.close() },
      job: { id: JOB },
      request: { id: 'native-credential-request' },
      store: { db: getDb() },
      signal: new AbortController().signal,
      remaining: () => remaining,
      wakeWaiters: async () => undefined,
    } as unknown as BrowserExecutionContext;
  }

  /** The current observation's refs for these accessible names, as the browser agent would read them. */
  async function refs(names: Record<string, string>): Promise<Record<string, BrowserRef>> {
    const { snapshot, generation } = await observePage(page);
    return Object.fromEntries(
      Object.entries(names).map(([key, name]) => {
        const line = snapshot
          .split('\n')
          .find((candidate) => candidate.includes(`"${name}"`) && candidate.includes('[ref='));
        const ref = line?.match(/\[ref=([a-z0-9]+)\]/u)?.[1];
        if (!ref) throw new Error(`No ref for ${name} in:\n${snapshot}`);
        return [key, { ref, generation }];
      }),
    );
  }

  async function signupAuthority(): Promise<CredentialAttempt> {
    const prepared = await attempts.prepareSignup({ jobId: JOB, origin: SITE, username: USERNAME });
    if (prepared.status !== 'prepared') throw new Error(prepared.status);
    return prepared.attempt;
  }

  const fill = (authority: CredentialAttempt, fields: Record<string, BrowserRef>) =>
    executeCredentialForm(context(), { authority: authority.id, ...fields }, { attempts });

  /** The generated password the vault holds for an attempt: the only place the test may read it. */
  async function candidatePassword(id: string): Promise<string> {
    const attempt = await attempts.get(id);
    const password = attempt?.candidate_item_id ? fake.value(attempt.candidate_item_id, 'password') : undefined;
    if (!password) throw new Error('no candidate');
    return password;
  }

  async function signUp(path: string, names: Record<string, string>) {
    await page.goto(`${SITE}${path}`);
    const authority = await signupAuthority();
    const result = await fill(authority, await refs(names));
    return { authority, result, password: await candidatePassword(authority.id).catch(() => undefined) };
  }

  const SIGNUP = {
    username: 'Email',
    new_password: 'Password',
    confirmation: 'Confirm password',
    activate: 'Create account',
  };

  describe('signing up', () => {
    it('saves first, then fills one candidate into a native form and submits it natively', async () => {
      const { authority, result, password } = await signUp('/native-signup', SIGNUP);
      expect(result).toEqual({ status: 'account_created', vault: 'saved' });
      expect(posts).toEqual([
        {
          host: 'accounts.shop.example',
          path: '/signup',
          body: new URLSearchParams({
            email: USERNAME,
            password: password!,
            password_confirmation: password!,
          }).toString(),
        },
      ]);
      const finalized = await attempts.get(authority.id);
      expect(finalized).toMatchObject({ phase: 'finalized', owned_item_id: finalized?.candidate_item_id });
      expect(JSON.stringify(result)).not.toContain(password);
      expect(JSON.stringify(finalized)).not.toContain(password);
    }, 30_000);

    it('drives a controlled JS form through its own input callbacks, recording exposure before the first one', async () => {
      await page.exposeFunction('credentialCallback', async () => {
        const [attempt] = await attempts.unresolved();
        callbackPhases.push(attempt?.phase);
      });
      const { result, password } = await signUp('/js-signup', SIGNUP);
      expect(result).toEqual({ status: 'account_created', vault: 'saved' });
      expect(posts).toEqual([
        {
          host: 'accounts.shop.example',
          path: '/api/signup',
          body: JSON.stringify({ email: USERNAME, password, password_confirmation: password }),
        },
      ]);
      expect(callbackPhases.length).toBeGreaterThan(0);
      expect(callbackPhases.every((phase) => phase === 'exposed' || phase === 'awaiting_verification')).toBe(true);
    }, 30_000);

    it('activates a no-form JS control by its own node', async () => {
      const { result, password } = await signUp('/no-form-signup', {
        username: 'Email',
        new_password: 'Password',
        activate: 'Create account',
      });
      expect(result).toEqual({ status: 'account_created', vault: 'saved' });
      expect(posts).toEqual([
        { host: 'accounts.shop.example', path: '/api/signup', body: JSON.stringify({ email: USERNAME, password }) },
      ]);
    }, 30_000);

    it('completes a multi-step signup with fresh refs per step and one candidate disclosed once', async () => {
      await page.goto(`${SITE}/multi-step`);
      const authority = await signupAuthority();
      expect(await fill(authority, await refs({ username: 'Email', activate: 'Continue' }))).toEqual({
        status: 'continued',
      });
      // Nothing was generated or disclosed for the username step.
      expect(await attempts.get(authority.id)).toMatchObject({ phase: 'preparing', candidate_item_id: null });
      expect(fake.calls).not.toContain('create');
      expect(
        await fill(
          authority,
          await refs({ new_password: 'Password', confirmation: 'Confirm password', activate: 'Create account' }),
        ),
      ).toEqual({ status: 'account_created', vault: 'saved' });
      const password = await candidatePassword(authority.id);
      expect(posts.map((post) => [post.path, post.body])).toEqual([
        ['/signup/email', new URLSearchParams({ email: USERNAME }).toString()],
        ['/signup/password', new URLSearchParams({ password, confirm: password }).toString()],
      ]);
      expect(fake.calls.filter((call) => call === 'create')).toHaveLength(1);
    }, 30_000);
  });

  describe('changing a password', () => {
    /** A Login the host saved through a finished signup, and the site holding its password. */
    async function ownedAccount(): Promise<{ itemId: string; handle: string }> {
      const signup = await signupAuthority();
      await attempts.save(signup.id);
      await attempts.disclose(signup.id, { jobId: JOB, origin: SITE });
      await attempts.markAwaitingVerification(signup.id);
      await attempts.markConfirmed(signup.id, { signal: 'fixture' });
      const finalized = await attempts.finalize(signup.id);
      if (finalized.status !== 'finalized' || !finalized.attempt.owned_item_id) throw new Error('not owned');
      const itemId = finalized.attempt.owned_item_id;
      accountPassword = fake.value(itemId, 'password');
      const found = await attempts.ownedHandle(SITE, USERNAME);
      if (found.status !== 'found') throw new Error(found.status);
      return { itemId, handle: found.itemHandle };
    }
    async function changeAuthority(handle: string): Promise<CredentialAttempt> {
      const prepared = await attempts.prepareRotation({ jobId: JOB, origin: SITE, itemHandle: handle });
      if (prepared.status !== 'prepared') throw new Error(prepared.status);
      return prepared.attempt;
    }
    const CHANGE = {
      current_password: 'Current password',
      new_password: 'New password',
      confirmation: 'Confirm new password',
      activate: 'Change password',
    };

    it('fills current, new and confirmation from one saved candidate and keeps both credentials while promotion is off', async () => {
      const { itemId, handle } = await ownedAccount();
      const original = accountPassword;
      const authority = await changeAuthority(handle);
      await page.goto(`${SITE}/change`);
      const result = await fill(authority, await refs(CHANGE));
      expect(result).toEqual({ status: 'password_changed', vault: 'both_kept' });
      const next = await candidatePassword(authority.id);
      expect(posts).toEqual([
        {
          host: 'accounts.shop.example',
          path: '/account/change-password',
          body: new URLSearchParams({
            current_password: original!,
            new_password: next,
            confirm_password: next,
          }).toString(),
        },
      ]);
      expect(accountPassword).toBe(next);
      // AE4: both credentials stay in 1Password; neither reaches a tool result.
      expect(fake.value(itemId, 'password')).toBe(original);
      expect(await attempts.get(authority.id)).toMatchObject({
        phase: 'conflict',
        conflict_reason: 'promotion_disabled',
      });
      for (const value of [original!, next]) expect(JSON.stringify(result)).not.toContain(value);
    }, 30_000);

    it('accepts a change form that only displays the account read-only, and never writes to it', async () => {
      const { handle } = await ownedAccount();
      const authority = await changeAuthority(handle);
      await page.goto(`${SITE}/change-shown-account`);
      expect(await fill(authority, await refs(CHANGE))).toEqual({ status: 'password_changed', vault: 'both_kept' });
      const next = await candidatePassword(authority.id);
      expect(new URLSearchParams(posts[0]?.body).get('email')).toBe(USERNAME);
      expect(accountPassword).toBe(next);
    }, 30_000);

    it('covers AE7 at the page: a Login edited after delegation is refused before any insertion', async () => {
      const { itemId, handle } = await ownedAccount();
      const authority = await changeAuthority(handle);
      fake.edit(itemId, (item) => ({
        ...item,
        fields: item.fields.map((entry) =>
          entry.id === 'username' ? { ...entry, value: 'remy.vance@example.com' } : entry,
        ),
      }));
      await page.goto(`${SITE}/change`);
      expect(await fill(authority, await refs(CHANGE))).toEqual({ status: 'not_owned' });
      expect(posts).toEqual([]);
      expect(await attempts.get(authority.id)).toMatchObject({ phase: 'rejected', exposed_at: null });
      expect(await page.locator('input[name=current_password]').inputValue()).toBe('');
    }, 30_000);

    it('reports a rejected current password as rejected, never as a change', async () => {
      const { handle } = await ownedAccount();
      const authority = await changeAuthority(handle);
      accountPassword = 'the-site-holds-something-else';
      await page.goto(`${SITE}/change`);
      expect(await fill(authority, await refs(CHANGE))).toEqual({ status: 'current_password_rejected' });
      expect(await attempts.get(authority.id)).toMatchObject({ phase: 'rejected' });
    }, 30_000);

    for (const [path, names] of [
      [
        '/change-with-email',
        { current_password: 'Current password', new_password: 'New password', activate: 'Change password' },
      ],
      [
        '/change-email',
        { current_password: 'Current password', new_password: 'New password', activate: 'Update email' },
      ],
    ] as const)
      it(`refuses ${path}: sign-in email and other security changes stay refused on an assistant-owned account`, async () => {
        const { handle } = await ownedAccount();
        const authority = await changeAuthority(handle);
        await page.goto(`${SITE}${path}`);
        expect(await fill(authority, await refs(names))).toEqual({ status: 'refused', reason: 'account_security' });
        expect(posts).toEqual([]);
        expect(await attempts.get(authority.id)).toMatchObject({ phase: 'preparing', exposed_at: null });
      }, 30_000);
  });

  describe('refusing before disclosure', () => {
    const unexposed = async (authority: CredentialAttempt): Promise<void> => {
      expect(posts).toEqual([]);
      expect(await attempts.get(authority.id)).toMatchObject({ exposed_at: null });
    };

    for (const [path, reason] of [
      ['/offsite-action', 'unsupported_form'],
      ['/http-action', 'blocked_address'],
      ['/checkout-action', 'purchase_control'],
      ['/trial', 'purchase_control'],
      ['/order-total', 'unsupported_control'],
      ['/ambiguous', 'unsupported_control'],
    ] as const)
      it(`refuses ${path} as ${reason}`, async () => {
        await page.goto(`${SITE}${path}`);
        const authority = await signupAuthority();
        const activate = path === '/trial' ? 'Start free trial' : path === '/ambiguous' ? 'Go' : 'Create account';
        expect(await fill(authority, await refs({ ...SIGNUP, activate }))).toEqual({ status: 'refused', reason });
        await unexposed(authority);
        expect(fake.calls).not.toContain('create');
      }, 30_000);

    it('refuses a signup whose account field is left unbound, since the Login would name another account', async () => {
      await page.goto(`${SITE}/native-signup`);
      const authority = await signupAuthority();
      const { username: _unbound, ...withoutUsername } = SIGNUP;
      expect(await fill(authority, await refs(withoutUsername))).toEqual({
        status: 'refused',
        reason: 'unsupported_form',
      });
      await unexposed(authority);
      expect(fake.calls).not.toContain('create');
    }, 30_000);

    it('refuses a form on another site, even with an authority for this one', async () => {
      await page.goto('https://collector.example/native-signup');
      const authority = await signupAuthority();
      expect(await fill(authority, await refs(SIGNUP))).toEqual({ status: 'refused', reason: 'origin_mismatch' });
      await unexposed(authority);
    }, 30_000);

    it('refuses a form whose node was replaced while the candidate was being saved', async () => {
      await page.goto(`${SITE}/native-signup`);
      const authority = await signupAuthority();
      const chosen = await refs(SIGNUP);
      fake.afterCreate = async () => {
        await page.evaluate(`(() => {
          const form = document.querySelector('form');
          const replacement = form.cloneNode(true);
          form.replaceWith(replacement);
        })()`);
      };
      expect(await fill(authority, chosen)).toEqual({ status: 'refused', reason: 'form_changed' });
      await unexposed(authority);
      expect(await attempts.get(authority.id)).toMatchObject({ phase: 'saved' });
    }, 30_000);

    it('never lets a cross-origin parent take a value when it steals focus at the insertion boundary', async () => {
      await page.goto('https://parent.example/');
      const frame = page.frames().find((candidate) => candidate.url() === `${SITE}/native-signup`);
      if (!frame) throw new Error('Authentication frame missing');
      await page.locator('#untrusted').focus();
      const authority = await signupAuthority();
      const chosen = await refs(SIGNUP);
      fake.afterCreate = async () => {
        await frame.evaluate("parent.postMessage('steal-focus', 'https://parent.example')");
        await page.locator('body[data-stolen="yes"]').waitFor();
      };
      expect(await fill(authority, chosen)).toEqual({ status: 'account_created', vault: 'saved' });
      expect(await page.locator('body').getAttribute('data-captured')).toBeNull();
      expect(posts.map((post) => post.host)).toEqual(['accounts.shop.example']);
    }, 30_000);
  });

  describe('never sending a credential in an address', () => {
    for (const where of ['the page', 'an out-of-process frame'] as const)
      it(`stops a native GET submission in ${where}`, async () => {
        await page.goto(where === 'the page' ? `${SITE}/get-signup` : 'https://parent.example/get');
        const authority = await signupAuthority();
        remaining = 5_000;
        const password = await (async () => {
          expect(await fill(authority, await refs(SIGNUP))).toEqual({ status: 'outcome_unknown' });
          return candidatePassword(authority.id);
        })();
        expect(addresses.filter((address) => address.includes('/signup?'))).toEqual([]);
        expect(addresses.some((address) => address.includes(encodeURIComponent(password)))).toBe(false);
        expect(await attempts.get(authority.id)).toMatchObject({ phase: 'unknown' });
      }, 30_000);
  });

  describe('website outcomes', () => {
    for (const [response, status, phase] of [
      ['<p>An account with this email already exists.</p>', 'account_exists', 'rejected'],
      [`<p>Password is too weak.</p>${PAGES['/native-signup']}`, 'password_rejected', 'rejected'],
      ['<p>Check your email to verify your account.</p>', 'verification_requested', 'awaiting_verification'],
      ['<h1>Thanks!</h1>', 'outcome_unknown', 'unknown'],
    ] as const)
      it(`keeps ${status} as ${phase}`, async () => {
        responses.set('/signup', response);
        remaining = 6_000;
        const { authority, result } = await signUp('/native-signup', SIGNUP);
        expect(result).toEqual({ status });
        expect(await attempts.get(authority.id)).toMatchObject({ phase });
        // A repeat reports the recorded outcome and never needs the page again, let alone submits it.
        expect(await fill(authority, SETTLED_REFS)).toEqual(
          status === 'outcome_unknown' || status === 'verification_requested'
            ? { status }
            : { status: 'refused', reason: 'no_authority' },
        );
        expect(posts).toHaveLength(1);
      }, 30_000);
  });

  describe('keeping values out of every agent surface', () => {
    it('redacts old toggled, copied and cleared values and refuses screenshots of the tainted document', async () => {
      responses.set('/api/signup', '<p>Check your email to verify your account.</p>');
      const { result, password } = await signUp('/masking', SIGNUP);
      expect(result).toEqual({ status: 'verification_requested' });
      if (!password) throw new Error('no candidate');
      expect(await page.locator('[name=password]').getAttribute('type')).toBe('text');
      // Every input holding the value is cleared; the echoed text stays only in the page.
      expect(await page.locator('[name=notes]').inputValue()).toBe('');
      expect(await page.locator('#echo').textContent()).toContain(password);
      const observation = await observePage(page);
      expect(JSON.stringify(observation)).not.toContain(password);
      const shot = await executeBrowserBatch(context(), { actions: [{ kind: 'screenshot' }] }, { record: false });
      expect(shot).toMatchObject({ status: 'stopped', reason: 'secret_field' });
      expect(JSON.stringify(shot)).not.toContain(password);
    }, 30_000);

    it('treats a page-filled text-type confirmation field as secret', async () => {
      await page.goto(`${SITE}/prefilled`);
      expect(JSON.stringify(await observePage(page))).not.toContain('page-chosen-secret-value');
      const shot = await executeBrowserBatch(context(), { actions: [{ kind: 'screenshot' }] }, { record: false });
      expect(shot).toMatchObject({ status: 'stopped', reason: 'secret_field' });
    }, 30_000);

    it('keeps generic typing, keys and clicks out of the credential scope', async () => {
      await page.goto(`${SITE}/masking`);
      await page.evaluate("document.querySelector('[name=password_confirmation]').type = 'text'");
      // Each action stops its batch and its observation renews the refs, so every step reads fresh ones.
      const batch = async (action: (chosen: Record<string, BrowserRef>) => Record<string, unknown>) => {
        const chosen = await refs({
          password: 'Password',
          confirmation: 'Confirm password',
          email: 'Email',
          activate: 'Create account',
        });
        return (await executeBrowserBatch(context(), { actions: [action(chosen)] }, { record: false })).actions;
      };
      const stopped = (reason: string) => [{ index: 0, status: 'stopped', reason }];
      expect(
        await batch(({ confirmation }) => ({ kind: 'type', ...confirmation, text: 'model-chosen-password' })),
      ).toEqual(stopped('secret_field'));
      expect(
        await batch(({ password }) => ({
          kind: 'form_input',
          fields: [{ ...password, value: 'model-chosen-password' }],
        })),
      ).toEqual(stopped('secret_field'));
      expect(await batch(({ password }) => ({ kind: 'key', ...password, key: 'Enter' }))).toEqual(
        stopped('secret_field'),
      );
      expect(await batch(({ activate }) => ({ kind: 'click', ...activate }))).toEqual(stopped('unsupported_merchant'));
      expect(await batch(({ email }) => ({ kind: 'key', ...email, key: 'Enter' }))).toEqual(
        stopped('unsupported_merchant'),
      );
      expect(posts).toEqual([]);
    }, 30_000);
  });
});

/** Refs that resolve to nothing: a repeat on a settled attempt must not need the page at all. */
const SETTLED_REFS: Record<string, BrowserRef> = {
  username: { ref: 'e1', generation: 1 },
  new_password: { ref: 'e2', generation: 1 },
  confirmation: { ref: 'e3', generation: 1 },
  activate: { ref: 'e4', generation: 1 },
};
