import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import '../gws-ea-profile/index.js';
import { recordWebAlias } from '../gws-ea-profile/testing/web-alias.js';
import { log } from '../../log.js';
import { CredentialAttempts } from './credential-attempts.js';
import { type CredentialAttempt, type CredentialAttemptPhase } from './credential-types.js';
import { browserRetiredCredentialsMigration } from './migration.js';
import { testLoginStore, TEST_INSTANCE_ID } from './testing/login-store.js';
import * as loginStoreModule from './login-store.js';
import { createLoginsPageHandler } from './logins-page.js';

const HOST = 'mira.example.com';
const PRINCIPAL = 'rowan@example.com';
const ALIAS = 'mira.web@example.com';
const SECRET = 'page-only-secret-7!';
const SITE = 'https://stream.example';
const postHeaders = { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
let directory: string;
let server: Server;
let port: number;
let fixture: ReturnType<typeof testLoginStore>;
let attempts: CredentialAttempts;
let bodyReads: number;
interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}
function request(
  route = '/logins',
  method = 'GET',
  headers: Readonly<Record<string, string>> = {},
  body?: string,
  headersOnly = false,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path: route,
        headers: { host: HOST, 'cf-access-jwt-assertion': PRINCIPAL, ...headers },
      },
      (res) => {
        let output = '';
        res.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: output });
          if (headersOnly) req.destroy();
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('Response waited for a refused body')));
    if (headersOnly) req.flushHeaders();
    else req.end(body);
  });
}

const post = (route: string, data: unknown): Promise<Reply> =>
  request(route, 'POST', postHeaders, JSON.stringify(data));
const login = (username = PRINCIPAL, site = SITE, title = 'Stream') =>
  fixture.store.create({ site, username, title, password: SECRET });
async function changing(
  phase: Exclude<CredentialAttemptPhase, 'rejected' | 'finalized'>,
): Promise<{ loginId: string; attempt: CredentialAttempt }> {
  const saved = await login(ALIAS);
  const result = await attempts.prepareRotation({
    jobId: 'system:a2a:main:stream',
    origin: SITE,
    username: ALIAS,
    itemHandle: saved.id,
  });
  if (result.status !== 'prepared') throw new Error(result.status);
  if (phase !== 'saved') {
    expect((await attempts.disclose(result.attempt.id, { jobId: result.attempt.job_id, origin: SITE })).status).toBe(
      'disclosed',
    );
    if (phase === 'awaiting_verification') await attempts.markAwaitingVerification(result.attempt.id);
    if (phase === 'unknown') await attempts.markUnknown(result.attempt.id);
  }
  return { loginId: saved.id, attempt: result.attempt };
}
beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'logins-page-')));
  fixture = testLoginStore(path.join(directory, 'browser'));
  vi.spyOn(loginStoreModule, 'getLoginStore').mockImplementation(async () => fixture.store);
  await runMigrations(await initTestDb());
  await browserRetiredCredentialsMigration.up(getDb());
  await recordWebAlias(ALIAS);
  await getDb().run(
    'INSERT INTO gws_ea_principal_addresses(email,added_at) VALUES(?,?)',
    PRINCIPAL,
    new Date().toISOString(),
  );
  attempts = new CredentialAttempts({ store: fixture.store });
  bodyReads = 0;
  const handler = createLoginsPageHandler({
    hostname: HOST,
    identity: async (incoming) => {
      const identity = incoming.headers['cf-access-jwt-assertion'];
      return typeof identity === 'string' && identity ? identity : undefined;
    },
    credentials: attempts,
  });
  server = createServer((incoming, response) => {
    const iterator = incoming.iterator.bind(incoming);
    incoming.iterator = (options) => {
      bodyReads += 1;
      return iterator(options);
    };
    handler(incoming, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server port');
  port = address.port;
});
afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it('closes wrong hosts and missing or non-principal identities before any store or body read, on every action', async () => {
  const refused: Readonly<Record<string, string>>[] = [
    { host: `${HOST}:443` },
    { 'cf-access-jwt-assertion': '' },
    { 'cf-access-jwt-assertion': 'reader@example.com' },
    { 'cf-access-jwt-assertion': 'principal+tag@example.com' },
  ];
  for (const route of ['/logins/add', '/logins/update', '/logins/remove']) {
    for (const headers of refused) {
      const response = await request(
        route,
        'POST',
        { ...postHeaders, ...headers, 'content-length': '80' },
        undefined,
        true,
      );
      expect(response.status).toBe(404);
      expect(response.body).toBe('');
      expect(response.headers['cache-control']).toBe('no-store');
    }
  }
  await getDb().run('DELETE FROM gws_ea_principal_addresses');
  expect((await request()).status).toBe(404);
  expect(bodyReads).toBe(0);
  expect(loginStoreModule.getLoginStore).not.toHaveBeenCalled();
  expect(await fixture.store.all()).toEqual([]);
  expect(fixture.keyReads()).toBe(0);
});

it('refuses cross-site, non-JSON and oversized submissions before reading their bodies', async () => {
  const refused: Readonly<Record<string, string>>[] = [
    { ...postHeaders, 'sec-fetch-site': 'cross-site', origin: `https://${HOST}` },
    { ...postHeaders, 'sec-fetch-site': 'same-site', origin: `https://${HOST}` },
    { 'content-type': 'application/json', origin: 'https://foreign.example.com' },
    { 'content-type': 'application/json' },
    { ...postHeaders, 'content-type': 'text/plain' },
    { ...postHeaders, 'content-length': '16385' },
  ];
  for (const route of ['/logins/add', '/logins/update', '/logins/remove']) {
    for (const headers of refused) {
      const response = await request(route, 'POST', { 'content-length': '80', ...headers }, undefined, true);
      expect(response.status).toBe(404);
      expect(response.body).toBe('');
    }
  }
  expect(bodyReads).toBe(0);
  expect(loginStoreModule.getLoginStore).not.toHaveBeenCalled();
  expect(await fixture.store.all()).toEqual([]);
  expect(fixture.keyReads()).toBe(0);
});

it('lists metadata and account owners without the key, escaping text and keeping passwords and URL paths private', async () => {
  await login(ALIAS, 'stream.example');
  await login('other@example.com', 'https://www.stream.example/login?private=hidden', 'Other');
  await login('<script>alert(1)</script>', 'https://shop.example', '<img src=x onerror=alert(2)>');
  await login('unproven_user', 'https://another.example', 'Non-email account');
  fixture.setUnavailable(true);
  const reads = fixture.keyReads();
  const response = await request();
  expect(response.status).toBe(200);
  expect(response.body).toContain('stream.example');
  expect(response.body).toContain('Assistant’s account');
  expect(response.body).toContain('Your account');
  expect(response.body).toContain('unproven_user');
  expect(response.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(response.body).toContain('&lt;img src=x onerror=alert(2)&gt;');
  expect(response.body).not.toMatch(/<script>alert|<img src=x|page-only-secret|private=hidden/u);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['content-security-policy']).toMatch(/default-src 'none'; script-src 'nonce-[\w-]+'/u);
  expect(response.headers['content-security-policy']).toContain(
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  expect(response.body).toContain('name="viewport"');
  expect(response.body).toContain('href="/logins/new"');
  expect(response.body).toContain('data-site-group');
  expect(response.body).not.toContain('data-login-action="update"');
  expect((await request('/logins', 'HEAD')).body).toBe('');
  expect(fixture.keyReads()).toBe(reads);
});

it.each(['stream.example', 'https://www.stream.example/login?next=profile'])(
  'adds %s and makes it available to the next errand',
  async (site) => {
    const output: string[] = [];
    for (const level of ['info', 'warn', 'error', 'debug'] as const)
      vi.spyOn(log, level).mockImplementation((message: string, data?: Record<string, unknown>) => {
        output.push(`${message} ${JSON.stringify(data ?? {})}`);
      });
    const response = await post('/logins/add', { site, title: '', username: PRINCIPAL, password: SECRET });
    expect(response.status).toBe(200);
    expect(response.body).toContain('Login added.');
    const [saved] = await fixture.store.forOrigin('https://stream.example');
    expect(saved).toMatchObject({
      username: PRINCIPAL,
      hostname: site.startsWith('https') ? 'www.stream.example' : 'stream.example',
    });
    expect(await fixture.store.secret(saved.id, 'password', 'https://stream.example')).toBe(SECRET);
    expect(response.body).not.toContain(SECRET);
    expect(output.join(' ')).not.toMatch(/rowan@|page-only-secret/u);
  },
);

it('rejects unsafe sites, malformed JSON and over-limit streamed bodies before saving', async () => {
  for (const site of [
    'http://stream.example',
    'ftp://stream.example',
    'https://name:secret@stream.example',
    'localhost',
    'https://com',
  ]) {
    const response = await post('/logins/add', { site, title: '', username: PRINCIPAL, password: SECRET });
    expect(response.status, site).toBe(400);
    expect(response.body).not.toContain(SECRET);
  }
  for (const body of ['{', 'null', '[]', JSON.stringify({ site: SITE, username: PRINCIPAL }), ' '.repeat(16385)])
    expect(
      (await request('/logins/add', 'POST', { ...postHeaders, 'transfer-encoding': 'chunked' }, body)).status,
    ).toBe(404);
  expect(await fixture.store.all()).toEqual([]);
});

it('keeps separate list, add, detail and edit views, and a blank replacement preserves the saved password', async () => {
  const saved = await login();
  const detail = `/logins/item/${saved.id}`;
  expect((await request('/logins/new')).body).toContain('name="title"');
  expect((await request(detail)).body).toContain(`${detail}/edit`);
  const edit = await request(`${detail}/edit`);
  expect(edit.body).toContain('Leave blank to keep the saved password.');
  expect(edit.body).not.toContain(SECRET);
  const response = await post('/logins/update', {
    handle: saved.id,
    version: '1',
    title: 'Business account',
    site: 'https://accounts.example.com/login',
    username: 'business@example.com',
    password: '',
  });
  expect(response.status).toBe(200);
  expect(response.body).toContain('Login updated.');
  expect(response.headers['x-logins-location']).toBe(detail);
  expect(await fixture.store.get(saved.id)).toMatchObject({
    title: 'Business account',
    hostname: 'accounts.example.com',
    username: 'business@example.com',
    version: 2,
  });
  expect(await fixture.store.forOrigin(SITE)).toEqual([]);
  expect(await fixture.store.secret(saved.id, 'password', 'https://accounts.example.com')).toBe(SECRET);
});

it('loads add and individual pages without reading a key or unrelated login metadata', async () => {
  const selected = await login();
  await login('other@example.com', 'https://notes.example', 'Other site');
  const all = vi.spyOn(fixture.store, 'all');
  const reads = fixture.keyReads();
  expect((await request('/logins/new')).status).toBe(200);
  const detail = await request(`/logins/item/${selected.id}`);
  expect(detail.status).toBe(200);
  expect(detail.body).toContain(PRINCIPAL);
  expect(detail.body).not.toContain('other@example.com');
  expect(all).not.toHaveBeenCalled();
  expect(fixture.keyReads()).toBe(reads);
  expect((await request('/logins/item/vault_00000000-0000-0000-0000-000000000000')).status).toBe(404);
});

it('refuses stale updates and removals without abandoning a current unsent password change', async () => {
  const saved = await login(ALIAS);
  const loginId = saved.id;
  await fixture.store.update(loginId, 1, { title: 'Newer title', password: '' });
  const prepared = await attempts.prepareRotation({
    jobId: 'system:a2a:main:stream',
    origin: SITE,
    username: ALIAS,
    itemHandle: loginId,
  });
  if (prepared.status !== 'prepared') throw new Error(prepared.status);
  const attempt = prepared.attempt;
  for (const action of ['update', 'remove']) {
    const response = await post(`/logins/${action}`, {
      handle: loginId,
      version: '1',
      ...(action === 'update' ? { title: 'Older title', password: '' } : {}),
    });
    expect(response.status).toBe(409);
    expect(response.body).toContain('This login changed');
  }
  expect(await fixture.store.get(loginId)).toMatchObject({ title: 'Newer title', version: 2 });
  expect((await attempts.get(attempt.id))?.phase).toBe('saved');
  expect(fixture.hasPending(attempt.id)).toBe(true);
});

it('refuses duplicate site and username edits without changing the existing login', async () => {
  await login();
  const other = await login('business@example.com', SITE, 'Business');
  const response = await post('/logins/update', {
    handle: other.id,
    version: '1',
    username: PRINCIPAL,
    password: 'replacement',
  });
  expect(response.status).toBe(400);
  expect(response.body).toContain('That site and username already have a login.');
  expect(await fixture.store.get(other.id)).toMatchObject({ username: 'business@example.com', version: 1 });
});

it.each(['exposed', 'awaiting_verification', 'unknown'] as const)(
  'refuses update and removal while a password change is %s',
  async (phase) => {
    const { loginId, attempt } = await changing(phase);
    for (const action of ['update', 'remove']) {
      const response = await post(`/logins/${action}`, {
        handle: loginId,
        version: '1',
        ...(action === 'update' ? { password: 'replacement' } : {}),
      });
      expect(response.status).toBe(409);
      expect(response.body).toContain('The assistant is changing this password. Try again after the change finishes.');
    }
    expect((await fixture.store.get(loginId)).version).toBe(1);
    expect((await attempts.get(attempt.id))?.phase).toBe(phase);
    expect(fixture.hasPending(attempt.id)).toBe(true);
  },
);

it.each(['update', 'remove'])(
  'lets a saved change give way to page %s without reading the pending password',
  async (action) => {
    const { loginId, attempt } = await changing('saved');
    const response = await post(`/logins/${action}`, {
      handle: loginId,
      version: '1',
      ...(action === 'update' ? { password: 'replacement' } : {}),
    });
    expect(response.status).toBe(200);
    expect(await attempts.get(attempt.id)).toMatchObject({
      phase: 'rejected',
      evidence_json: JSON.stringify({ reason: 'login_edited' }),
    });
    expect(fixture.hasPending(attempt.id)).toBe(false);
    if (action === 'update') expect(await fixture.store.secret(loginId, 'password', SITE)).toBe('replacement');
    else expect(await fixture.store.all()).toEqual([]);
  },
);

it.each(['add', 'update'] as const)('refuses a page %s that would collide with an exposed signup', async (action) => {
  const existing = action === 'update' ? await login(PRINCIPAL, 'https://notes.example') : undefined;
  const prepared = await attempts.prepareSignup({ jobId: 'signup-job', origin: SITE, username: ALIAS });
  if (prepared.status !== 'prepared') throw new Error(prepared.status);
  const disclosed = await attempts.disclose(prepared.attempt.id, { jobId: 'signup-job', origin: SITE });
  if (disclosed.status !== 'disclosed') throw new Error(disclosed.status);
  const response = await post(`/logins/${action}`, {
    ...(existing ? { handle: existing.id, version: '1' } : {}),
    site: SITE,
    username: ALIAS,
    title: 'Stream',
    password: 'page-replacement',
  });
  expect(response.status).toBe(409);
  expect(response.body).toContain('The assistant is changing this password.');
  expect(await fixture.store.forOrigin(SITE)).toEqual([]);
  if (existing) expect(await fixture.store.get(existing.id)).toEqual(existing);
  expect(await attempts.get(prepared.attempt.id)).toMatchObject({ phase: 'exposed' });
  await attempts.confirm(prepared.attempt.id, { signal: 'success_text' });
  const [created] = await fixture.store.forOrigin(SITE);
  expect(created).toBeDefined();
  expect(await fixture.store.secret(created!.id, 'password', SITE)).toBe(disclosed.credential.password);
  expect(fixture.hasPending(prepared.attempt.id)).toBe(false);
});

it.each(['add', 'update'] as const)('lets an undisclosed signup give way to a conflicting page %s', async (action) => {
  const existing = action === 'update' ? await login(PRINCIPAL, 'https://notes.example') : undefined;
  const prepared = await attempts.prepareSignup({ jobId: 'signup-job', origin: SITE, username: ALIAS });
  if (prepared.status !== 'prepared') throw new Error(prepared.status);
  const response = await post(`/logins/${action}`, {
    ...(existing ? { handle: existing.id, version: '1' } : {}),
    site: 'accounts.stream.example',
    username: ALIAS,
    title: 'Stream',
    password: 'page-replacement',
  });
  expect(response.status).toBe(200);
  expect(await attempts.get(prepared.attempt.id)).toMatchObject({
    phase: 'rejected',
    evidence_json: JSON.stringify({ reason: 'login_edited' }),
  });
  expect(fixture.hasPending(prepared.attempt.id)).toBe(false);
  const [saved] = await fixture.store.forOrigin(SITE);
  expect(saved).toMatchObject({ hostname: 'accounts.stream.example', username: ALIAS });
  expect(await fixture.store.secret(saved!.id, 'password', SITE)).toBe('page-replacement');
});

it('writes no new login when a conflicting signup wins disclosure during page give-way', async () => {
  const prepared = await attempts.prepareSignup({ jobId: 'signup-job', origin: SITE, username: ALIAS });
  if (prepared.status !== 'prepared') throw new Error(prepared.status);
  const create = fixture.store.create.bind(fixture.store);
  vi.spyOn(fixture.store, 'create').mockImplementationOnce(async (spec) => {
    await attempts.disclose(prepared.attempt.id, { jobId: 'signup-job', origin: SITE });
    return create(spec);
  });
  const response = await post('/logins/add', { site: SITE, username: ALIAS, title: '', password: SECRET });
  expect(response.status).toBe(409);
  expect(await fixture.store.forOrigin(SITE)).toEqual([]);
  expect(fixture.hasPending(prepared.attempt.id)).toBe(true);
});

it('writes nothing when giving way loses the compare-and-set to disclosure', async () => {
  const { loginId, attempt } = await changing('saved');
  const update = fixture.store.update.bind(fixture.store);
  vi.spyOn(fixture.store, 'update').mockImplementationOnce(async (...args) => {
    await attempts.disclose(attempt.id, { jobId: attempt.job_id, origin: SITE });
    return update(...args);
  });
  const response = await post('/logins/update', { handle: loginId, version: '1', password: 'replacement' });
  expect(response.status).toBe(409);
  expect(response.body).toContain('The assistant is changing this password.');
  expect(await fixture.store.secret(loginId, 'password', SITE)).toBe(SECRET);
  expect(fixture.hasPending(attempt.id)).toBe(true);
});

it('lists and removes with a missing key while saving shows one operator message without secrets', async () => {
  const saved = await login();
  let reads = 0;
  fixture.store = new loginStoreModule.LoginStore({
    browserRoot: path.join(directory, 'browser'),
    instanceId: TEST_INSTANCE_ID,
    runCommand: async () => {
      reads++;
      return { exitCode: 44, stdout: '', stderr: '' };
    },
  });
  expect((await request()).body).toContain(PRINCIPAL);
  expect(reads).toBe(0);
  for (const action of ['add', 'update']) {
    const response = await post(
      `/logins/${action}`,
      action === 'add'
        ? { site: 'notes.example', title: '', username: PRINCIPAL, password: SECRET }
        : { handle: saved.id, version: '1', password: 'replacement' },
    );
    expect(response.status).toBe(503);
    expect(response.body.match(/Saved passwords can&#39;t be read right now\. Ask your operator\./gu)).toHaveLength(1);
    expect(response.body).not.toMatch(/page-only-secret|replacement/u);
  }
  const removed = await post('/logins/remove', { handle: saved.id, version: '1' });
  expect(removed.status).toBe(200);
  expect(removed.body).toContain('Saved login removed. The browser may still be signed in.');
  expect(await fixture.store.all()).toEqual([]);
});

it('rejects missing handles and preserves the store version check if a login changes before the write', async () => {
  expect((await post('/logins/remove', { handle: 'vault_unlisted', version: '1' })).status).toBe(409);
  const saved = await login();
  const update = fixture.store.update.bind(fixture.store);
  vi.spyOn(fixture.store, 'update').mockImplementationOnce(async (...args) => {
    await update(saved.id, 1, { title: 'Concurrent title', password: '' });
    return update(...args);
  });
  const response = await post('/logins/update', { handle: saved.id, version: '1', password: 'replacement' });
  expect(response.status).toBe(409);
  expect(await fixture.store.get(saved.id)).toMatchObject({ title: 'Concurrent title', version: 2 });
  expect(await fixture.store.secret(saved.id, 'password', SITE)).toBe(SECRET);
});

it('keeps the successful save outcome if reading the displayed list fails', async () => {
  vi.spyOn(fixture.store, 'all').mockRejectedValueOnce(new Error(SECRET));
  const response = await post('/logins/add', { site: SITE, title: 'Personal', username: PRINCIPAL, password: SECRET });
  expect(response.status).toBe(503);
  expect(response.headers['x-logins-saved']).toBe('true');
  expect(response.headers['x-logins-location']).toBe('/logins');
  expect(response.body).toContain('Login added. Saved passwords can&#39;t be read right now. Ask your operator.');
  expect(response.body).not.toContain(SECRET);
  expect(await fixture.store.all()).toHaveLength(1);
});

it('accepts an exact Origin fallback without Sec-Fetch-Site and closes unknown routes', async () => {
  expect(
    (
      await request(
        '/logins/add',
        'POST',
        { origin: `https://${HOST}`, 'content-type': 'application/json' },
        JSON.stringify({ site: SITE, title: '', username: PRINCIPAL, password: SECRET }),
      )
    ).status,
  ).toBe(200);
  for (const [route, method] of [
    ['/logins/add?x=1', 'POST'],
    ['/logins?x=1', 'GET'],
    ['/logins/add', 'GET'],
    ['/logins', 'POST'],
  ])
    expect((await request(route, method, postHeaders)).status).toBe(404);
});

const chromePath = process.env.GWS_EA_BROWSER_TEST_CHROME;
it.skipIf(!chromePath).each([320, 390, 1200])(
  'keeps JSON submission, edit protection, removal confirmation and layout usable in Chrome at %ipx',
  async (width) => {
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    let releaseSave = (): void => undefined;
    try {
      const context = await browser.newContext({
        viewport: { width, height: width < 600 ? 568 : 900 },
        hasTouch: width < 600,
        isMobile: width < 600,
      });
      const actions: Array<{ path: string; contentType: string | undefined }> = [];
      let holdSave = false;
      let saveStarted = (): void => undefined;
      const started = new Promise<void>((resolve) => {
        saveStarted = resolve;
      });
      const held = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      await context.route(`https://${HOST}/**`, async (route) => {
        const incoming = route.request();
        const pathname = new URL(incoming.url()).pathname;
        const incomingHeaders = await incoming.allHeaders();
        if (incoming.method() === 'POST' && pathname === '/logins/update' && holdSave) {
          holdSave = false;
          saveStarted();
          await held;
        }
        if (incoming.method() === 'POST')
          actions.push({ path: pathname, contentType: incomingHeaders['content-type'] });
        const reply = await request(pathname, incoming.method(), incomingHeaders, incoming.postData() ?? undefined);
        const outgoing: Record<string, string> = {};
        for (const [key, value] of Object.entries(reply.headers))
          if (typeof value === 'string' && !['connection', 'content-length', 'transfer-encoding'].includes(key))
            outgoing[key] = value;
        await route.fulfill({ status: reply.status, headers: outgoing, body: reply.body });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(7000);
      const layout = async (): Promise<void> => {
        expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
        expect(
          await page.evaluate<string[]>(
            `[...document.querySelectorAll('a.button,button,input:not([type=hidden]),a.back-link,[data-login-row]')].filter(element => { const r=element.getBoundingClientRect(); return r.width>0 && r.height>0 && (r.width<44 || r.height<44); }).map(element => element.textContent || element.getAttribute('name') || element.tagName)`,
          ),
        ).toEqual([]);
      };
      await page.goto(`https://${HOST}/logins`);
      await page.evaluate('document.fonts.ready');
      expect(
        await page.evaluate<boolean>(
          "[...document.fonts].some(font => font.family === 'Geist' && font.status === 'loaded')",
        ),
      ).toBe(true);
      await page.getByRole('link', { name: 'Add login', exact: true }).click();
      await page.getByRole('textbox', { name: 'Account label', exact: true }).fill('Personal');
      await page.getByLabel('Website', { exact: true }).fill('stream.example');
      await page.getByLabel('Username', { exact: true }).fill(PRINCIPAL);
      await page.getByLabel('Password', { exact: true }).fill(SECRET);
      await layout();
      expect(await page.evaluate<boolean>('document.activeElement.getBoundingClientRect().bottom <= innerHeight')).toBe(
        true,
      );
      await page.getByRole('button', { name: 'Add login', exact: true }).click();
      await page.getByText('Login added.', { exact: true }).waitFor();
      expect(actions).toEqual([{ path: '/logins/add', contentType: 'application/json' }]);
      expect(await page.locator('input[type=password]').count()).toBe(0);
      const [saved] = await fixture.store.all();
      expect(await fixture.store.secret(saved.id, 'password', SITE)).toBe(SECRET);
      await page.getByRole('searchbox', { name: 'Search logins' }).fill('missing site');
      expect(await page.getByText('No matching logins', { exact: true }).isVisible()).toBe(true);
      await page.getByRole('searchbox', { name: 'Search logins' }).fill('personal');
      expect(await page.locator('[data-login-row]:visible').count()).toBe(1);
      await page.locator('[data-login-row]').click();
      await page.getByRole('link', { name: 'Edit details', exact: true }).click();
      await page.getByRole('textbox', { name: 'Account label', exact: true }).fill('Unsaved change');
      page.once('dialog', async (confirmation) => {
        expect(confirmation.type()).toBe('beforeunload');
        await confirmation.dismiss();
      });
      await page.getByRole('link', { name: 'Cancel', exact: true }).click();
      expect(await page.getByRole('textbox', { name: 'Account label', exact: true }).inputValue()).toBe(
        'Unsaved change',
      );
      await page.getByRole('textbox', { name: 'Account label', exact: true }).fill('Personal');
      await page.emulateMedia({ colorScheme: 'dark' });
      await layout();
      await page.getByLabel('New saved password', { exact: true }).fill('browser-replacement-password');
      holdSave = true;
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await started;
      const savingPath = new URL(page.url()).pathname;
      await page.getByRole('link', { name: 'Cancel', exact: true }).click({ force: true });
      expect(new URL(page.url()).pathname).toBe(savingPath);
      releaseSave();
      await page.getByText('Login updated.', { exact: true }).waitFor();
      expect(actions[1]).toEqual({ path: '/logins/update', contentType: 'application/json' });
      expect(await fixture.store.secret(saved.id, 'password', SITE)).toBe('browser-replacement-password');
      await page.getByRole('button', { name: 'Remove login', exact: true }).first().click();
      const dialog = page.getByRole('dialog');
      expect(await dialog.textContent()).toContain(`stream.example (${PRINCIPAL})`);
      expect(await dialog.textContent()).toContain('The browser may still be signed in');
      await layout();
      expect(actions).toHaveLength(2);
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      expect(await fixture.store.all()).toHaveLength(1);
      await page.getByRole('button', { name: 'Remove login', exact: true }).first().click();
      await dialog.getByRole('button', { name: 'Remove login', exact: true }).click();
      await page.getByText('No saved logins yet.', { exact: true }).waitFor();
      expect(actions[2]).toEqual({ path: '/logins/remove', contentType: 'application/json' });
      expect(await fixture.store.all()).toEqual([]);
      expect(await page.content()).not.toMatch(/page-only-secret|browser-replacement-password/u);
      expect(
        await page.evaluate<{ local: number; session: number }>(
          '({local:localStorage.length,session:sessionStorage.length})',
        ),
      ).toEqual({ local: 0, session: 0 });
      const longUsername = 'long-account-name.'.repeat(8) + '@example.com';
      const longLabel = 'Family Team ' + 'A'.repeat(188);
      const long = await login(longUsername, 'https://accounts.long-subdomain.example.com', longLabel);
      await login(ALIAS, 'https://notes.example', 'Team workspace');
      await page.goto(`https://${HOST}/logins`);
      for (const next of [320, 390, 768, 1200]) {
        await page.setViewportSize({ width: next, height: 844 });
        await layout();
      }
      await page.setViewportSize({ width: 320, height: 568 });
      await page.locator('[data-login-row]').filter({ hasText: longUsername }).click();
      await layout();
      await page.getByRole('link', { name: 'Edit details', exact: true }).click();
      await layout();
      if (width === 320) {
        await fixture.store.update(long.id, 1, { title: 'Concurrent edit', password: '' });
        await page.getByLabel('New saved password', { exact: true }).fill('stale-replacement');
        await page.getByRole('button', { name: 'Save changes', exact: true }).click();
        await page.getByText(/This login changed since you opened it/u).waitFor();
        expect(await page.getByRole('button', { name: 'Save changes', exact: true }).isEnabled()).toBe(true);
        await page.reload();
        const update = fixture.store.update.bind(fixture.store);
        vi.spyOn(fixture.store, 'update').mockImplementationOnce(async (...parameters) => {
          await update(...parameters);
          throw new Error('Synthetic response loss');
        });
        await page.getByLabel('New saved password', { exact: true }).fill('saved-with-lost-response');
        await page.getByRole('button', { name: 'Save changes', exact: true }).click();
        await page.getByRole('link', { name: 'Reload page', exact: true }).waitFor();
        expect(await page.getByRole('button', { name: 'Save changes', exact: true }).isDisabled()).toBe(true);
        expect(await fixture.store.secret(long.id, 'password', 'https://accounts.long-subdomain.example.com')).toBe(
          'saved-with-lost-response',
        );
        expect(await page.content()).not.toContain('saved-with-lost-response');
        await page.reload();
        vi.spyOn(fixture.store, 'update').mockImplementationOnce(async (...parameters) => {
          const result = await update(...parameters);
          vi.spyOn(fixture.store, 'get').mockRejectedValueOnce(new Error('Synthetic display failure'));
          return result;
        });
        await page.getByLabel('New saved password', { exact: true }).fill('saved-before-display-failed');
        await page.getByRole('button', { name: 'Save changes', exact: true }).click();
        await page.getByRole('heading', { name: 'Logins unavailable', exact: true }).waitFor();
        expect(await page.locator('#outcome').textContent()).toContain('Login updated.');
        expect(await page.getByRole('button', { name: 'Save changes', exact: true }).count()).toBe(0);
        expect(await fixture.store.secret(long.id, 'password', 'https://accounts.long-subdomain.example.com')).toBe(
          'saved-before-display-failed',
        );
        expect(await page.content()).not.toContain('saved-before-display-failed');
      }
      await context.close();
    } finally {
      releaseSave();
      await browser.close();
    }
  },
  30_000,
);
