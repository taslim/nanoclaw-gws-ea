import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import {
  AutofillBehavior,
  ItemCategory,
  ItemFieldType,
  RateLimitExceededError,
  type Client,
  type Item,
} from '@1password/sdk';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import '../gws-ea-profile/index.js';
import { recordWebAlias } from '../gws-ea-profile/testing/web-alias.js';
import { log } from '../../log.js';
import { CredentialAttempts } from './credential-attempts.js';
import { browserCredentialAttemptsMigration } from './migration.js';
import { BrowserVault } from './onepassword.js';
import {
  FakeOnePassword,
  FIXTURE_TOKEN,
  FIXTURE_VAULT_ID,
  writeVaultFixture,
  type VaultFixtureFiles,
} from './onepassword-fixture.js';
import { writePrivateFile } from './paths.js';
import { createLoginsPageHandler } from './logins-page.js';

const sdk = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@1password/sdk', async (original) => ({
  ...(await original<typeof import('@1password/sdk')>()),
  createClient: sdk.create,
}));

const HOST = 'aya.example.com';
const PRINCIPAL = 'principal@example.com';
let directory: string;
let server: Server;
let port: number;
let fake: FakeOnePassword;
let vault: BrowserVault;
let vaultFiles: VaultFixtureFiles;
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
const postHeaders = { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
const ALIAS = 'aya.web@example.com';
const SECRET = 'page-only-secret-7!';
function login(username = PRINCIPAL, websites = ['https://netflix.com'], title = 'Netflix'): Item {
  return fake.store({
    category: ItemCategory.Login,
    vaultId: FIXTURE_VAULT_ID,
    title,
    fields: [
      { id: 'username', title: 'username', fieldType: ItemFieldType.Text, value: username },
      { id: 'password', title: 'password', fieldType: ItemFieldType.Concealed, value: SECRET },
    ],
    websites: websites.map((url) => ({ url, label: '', autofillBehavior: AutofillBehavior.AnywhereOnWebsite })),
  });
}
const post = (route: string, data: unknown): Promise<Reply> =>
  request(route, 'POST', postHeaders, JSON.stringify(data));
function latch(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}
async function handleFor(item: Item): Promise<string> {
  await request();
  const listed = await vault.allLogins();
  const selected = listed.find((row) => row.title === item.title);
  if (!selected) throw new Error('Login was not listed');
  return selected.item_handle;
}
beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'logins-page-')));
  fake = new FakeOnePassword();
  sdk.create.mockReset().mockImplementation(async () => fake.client());
  vaultFiles = await writeVaultFixture(directory);
  vault = new BrowserVault(vaultFiles);
  await runMigrations(await initTestDb());
  await browserCredentialAttemptsMigration.up(getDb());
  await recordWebAlias(ALIAS);
  await getDb().run(
    'INSERT INTO gws_ea_principal_addresses(email,added_at) VALUES(?,?)',
    PRINCIPAL,
    new Date().toISOString(),
  );
  bodyReads = 0;
  const handler = createLoginsPageHandler({
    hostname: HOST,
    identity: async (incoming) => {
      const identity = incoming.headers['cf-access-jwt-assertion'];
      return typeof identity === 'string' && identity ? identity : undefined;
    },
    vault,
    credentials: new CredentialAttempts({ db: getDb(), vault }),
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

it('closes wrong hosts and missing or non-principal identities before any vault or body read, on every action', async () => {
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
  expect(fake.calls).toEqual([]);
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
  expect(fake.calls).toEqual([]);
});

it('lists every ordinary Login with its owner, escaping text and never rendering credential values or raw website URLs', async () => {
  login(ALIAS, ['netflix.com']);
  login('other@example.com', ['https://www.netflix.com/login?private=hidden'], 'Other');
  login('<script>alert(1)</script>', [], '<img src=x onerror=alert(2)>');
  login(ALIAS, [], 'Alias without website');
  login('unproven_user', ['https://shop.example'], 'Non-email account');
  login('unused', ['https://user:website-secret@shop.example/path?private=hidden'], 'Unusable website');
  const candidate = login('pending@example.com', [], 'Pending candidate');
  fake.edit(candidate.id, (item) => ({ ...item, tags: ['gws-ea-pending/operation'] }));
  const archived = login('archived@example.com', [], 'Archived');
  fake.archived.add(archived.id);
  fake.store({ category: ItemCategory.Password, vaultId: FIXTURE_VAULT_ID, title: 'Plain password' });
  const response = await request();
  expect(response.status).toBe(200);
  expect(response.body).toContain('netflix.com');
  expect(response.body).toContain('www.netflix.com');
  expect(response.body).toContain('Assistant’s account');
  expect(response.body).toContain('Your account');
  expect(response.body).toContain('Alias without website');
  expect(response.body).toContain('unproven_user');
  expect(response.body).toContain('Unusable website');
  expect(response.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(response.body).toContain('&lt;img src=x onerror=alert(2)&gt;');
  expect(response.body).not.toMatch(
    /<script>alert|<img src=x|page-only-secret|website-secret|private=hidden|Pending candidate|Archived|Plain password/u,
  );
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
});

it.each([
  ['netflix.com', 'https://netflix.com'],
  ['https://www.netflix.com/login?next=profile', 'https://www.netflix.com'],
])('adds %s directly to the bound vault and the next fill uses it', async (site, expectedSite) => {
  const output: string[] = [];
  for (const level of ['info', 'warn', 'error', 'debug'] as const)
    vi.spyOn(log, level).mockImplementation((message: string, data?: Record<string, unknown>) => {
      output.push(`${message} ${JSON.stringify(data ?? {})}`);
    });
  const response = await post('/logins/add', { site, title: '', username: PRINCIPAL, password: SECRET });
  expect(response.status).toBe(200);
  expect(response.body).toContain('Login added.');
  expect(response.body).toContain(PRINCIPAL);
  expect(fake.items.size).toBe(1);
  const [item] = [...fake.items.values()];
  expect(item).toMatchObject({
    category: ItemCategory.Login,
    vaultId: FIXTURE_VAULT_ID,
    title: new URL(expectedSite).hostname,
    websites: [{ url: expectedSite, autofillBehavior: AutofillBehavior.AnywhereOnWebsite }],
    tags: [],
  });
  expect(fake.value(item.id, 'username')).toBe(PRINCIPAL);
  expect(fake.value(item.id, 'password')).toBe(SECRET);
  const [choice] = await vault.itemsForOrigin(expectedSite);
  expect(await vault.resolve(choice.item_handle, 'password', expectedSite)).toBe(SECRET);
  expect((await request()).body).toContain(PRINCIPAL);
  expect(response.body).not.toContain(SECRET);
  expect(output.join('\n')).not.toContain(PRINCIPAL);
  expect(output.join('\n')).not.toContain(SECRET);
});

it('rejects unsafe sites, malformed JSON and an over-limit streamed body without writing', async () => {
  for (const site of [
    'http://netflix.com',
    'ftp://netflix.com',
    'https://name:secret@netflix.com',
    'localhost',
    'https://com',
  ]) {
    const response = await post('/logins/add', { site, title: '', username: PRINCIPAL, password: SECRET });
    expect(response.status, site).toBe(400);
    expect(response.body).not.toContain(SECRET);
  }
  for (const body of [
    '{',
    'null',
    '[]',
    JSON.stringify({ site: 'netflix.com', username: PRINCIPAL }),
    ' '.repeat(16385),
  ]) {
    const response = await request('/logins/add', 'POST', { ...postHeaders, 'transfer-encoding': 'chunked' }, body);
    expect(response.status).toBe(404);
  }
  expect(fake.calls).not.toContain('create');
  expect(fake.items.size).toBe(0);
});

it('refreshes from the completed write when a concurrent GET had already captured an older listing', async () => {
  const client = fake.client() as Client;
  const creating = latch();
  const allowCreate = latch();
  const listing = latch();
  const allowListing = latch();
  let holdNextList = false;
  const create = client.items.create.bind(client.items);
  client.items.create = async (params) => {
    creating.release();
    await allowCreate.promise;
    return create(params);
  };
  const list = client.items.list.bind(client.items);
  client.items.list = async (vaultId, filter) => {
    const snapshot = await list(vaultId, filter);
    if (holdNextList) {
      holdNextList = false;
      listing.release();
      await allowListing.promise;
    }
    return snapshot;
  };
  sdk.create.mockResolvedValue(client);
  const allLogins = vi.spyOn(vault, 'allLogins');
  const write = post('/logins/add', { site: 'netflix.com', title: '', username: PRINCIPAL, password: SECRET });
  await creating.promise;
  holdNextList = true;
  const read = request();
  await listing.promise;
  allowCreate.release();
  await vi.waitFor(() => expect(allLogins).toHaveBeenCalledTimes(2));
  allowListing.release();
  const [saved, refreshed] = await Promise.all([write, read]);
  expect(fake.items.size).toBe(1);
  expect(saved.body.includes(PRINCIPAL)).toBe(true);
  expect(refreshed.body.includes(PRINCIPAL)).toBe(true);
});

it('lets the principal update a principal-owned saved password, preserves fresh unrelated edits and serves the next fill', async () => {
  const item = login(PRINCIPAL);
  const handle = await handleFor(item);
  fake.edit(item.id, (saved) => ({
    ...saved,
    title: 'Fresh title',
    notes: 'Keep my notes',
    tags: ['personal'],
    websites: [
      { url: 'https://netflix.com:8443/login', label: 'Primary', autofillBehavior: AutofillBehavior.ExactDomain },
      { url: 'https://help.netflix.com', label: 'Support', autofillBehavior: AutofillBehavior.ExactDomain },
    ],
    fields: [
      ...saved.fields,
      { id: 'custom', title: 'Custom', fieldType: ItemFieldType.Concealed, value: 'keep-custom-value' },
    ],
  }));
  const response = await post('/logins/update', {
    handle,
    version: '2',
    title: 'Fresh title',
    site: 'netflix.com',
    username: PRINCIPAL,
    password: 'replacement-password',
  });
  expect(response.status).toBe(200);
  expect(response.body).toContain('Login updated.');
  expect(response.body).not.toMatch(/replacement-password|page-only-secret/u);
  expect(fake.items.get(item.id)).toMatchObject({
    title: 'Fresh title',
    notes: 'Keep my notes',
    tags: ['personal'],
    version: 3,
    websites: [
      { url: 'https://netflix.com:8443/login', label: 'Primary', autofillBehavior: AutofillBehavior.ExactDomain },
      { url: 'https://help.netflix.com', label: 'Support', autofillBehavior: AutofillBehavior.ExactDomain },
    ],
  });
  expect(fake.value(item.id, 'custom')).toBe('keep-custom-value');
  expect(fake.value(item.id, 'password')).toBe('replacement-password');
  expect(await vault.resolve(handle, 'password', 'https://netflix.com:8443')).toBe('replacement-password');
});

it('opens separate list, add, detail and edit views and saves the label, site and username without replacing a blank password', async () => {
  const item = login(PRINCIPAL);
  const handle = await handleFor(item);
  const detail = `/logins/item/${handle}`;
  expect((await request('/logins/new')).body).toContain('name="title"');
  expect((await request(detail)).body).toContain(`${detail}/edit`);
  const edit = await request(`${detail}/edit`);
  expect(edit.body).toContain('Leave blank to keep the saved password.');
  expect(edit.body).not.toContain(SECRET);
  const saved = await post('/logins/update', {
    handle,
    version: '1',
    title: 'Business account',
    site: 'https://accounts.example.com/login',
    username: 'business@example.com',
    password: '',
  });
  expect(saved.status).toBe(200);
  expect(saved.body).toContain('Login updated.');
  expect(fake.items.get(item.id)).toMatchObject({
    title: 'Business account',
    websites: [{ url: 'https://accounts.example.com' }],
  });
  expect(fake.value(item.id, 'username')).toBe('business@example.com');
  expect(fake.value(item.id, 'password')).toBe(SECRET);
  expect(await vault.itemsForOrigin('https://netflix.com')).toEqual([]);
  const [choice] = await vault.itemsForOrigin('https://accounts.example.com');
  expect(choice.title).toBe('Business account');
  expect(await vault.resolve(choice.item_handle, 'password', 'https://accounts.example.com')).toBe(SECRET);
});

it('loads add and individual login pages without reading unrelated credentials', async () => {
  login(PRINCIPAL);
  login('other@example.com', ['https://linear.app'], 'Other site');
  const [choice] = await vault.itemsForOrigin('https://netflix.com');
  expect((await request('/logins/new')).status).toBe(200);
  expect(fake.calls.filter((call) => call === 'get')).toHaveLength(0);
  const detail = await request(`/logins/item/${choice.item_handle}`);
  expect(detail.status).toBe(200);
  expect(detail.body).toContain(PRINCIPAL);
  expect(detail.body).not.toContain('other@example.com');
  expect(fake.calls.filter((call) => call === 'get')).toHaveLength(1);
});

it('refuses a stale edit form rather than overwriting newer saved details', async () => {
  const item = login();
  const handle = await handleFor(item);
  fake.edit(item.id, (saved) => ({ ...saved, title: 'Newer title' }));
  const response = await post('/logins/update', {
    handle,
    version: '1',
    title: 'Older title',
    site: 'netflix.com',
    username: PRINCIPAL,
    password: '',
  });
  expect(response.status).toBe(409);
  expect(response.body).toContain('This login changed');
  expect(fake.items.get(item.id)?.title).toBe('Newer title');
  expect(fake.calls).not.toContain('put');
  expect((await post('/logins/remove', { handle, version: '1' })).status).toBe(409);
  expect(fake.items.has(item.id)).toBe(true);
});

it('keeps account labels distinct for the assistant and refuses an edit that duplicates another site and username', async () => {
  await post('/logins/add', { title: 'Personal', site: 'netflix.com', username: PRINCIPAL, password: SECRET });
  await post('/logins/add', {
    title: 'Business',
    site: 'netflix.com',
    username: 'business@example.com',
    password: SECRET,
  });
  const choices = await vault.itemsForOrigin('https://netflix.com');
  expect(choices.map((choice) => choice.title).sort()).toEqual(['Business', 'Personal']);
  const business = choices.find((choice) => choice.title === 'Business')!;
  const response = await post('/logins/update', {
    handle: business.item_handle,
    version: '1',
    title: 'Overwrite',
    site: 'netflix.com',
    username: PRINCIPAL,
    password: 'replacement',
  });
  expect(response.status).toBe(400);
  expect(response.body).toContain('That site and username already have a login.');
  expect((await vault.allLogins()).find((choice) => choice.item_handle === business.item_handle)).toMatchObject({
    title: 'Business',
    username: 'business@example.com',
    version: 1,
  });
  expect(fake.calls).not.toContain('put');
});

it('retains only unchanged-version metadata across page refreshes and invalidates a changed login after a write', async () => {
  const item = login(PRINCIPAL);
  login(ALIAS, [], 'Assistant without website');
  await request();
  const before = fake.calls.filter((call) => call === 'get').length;
  await request();
  expect(fake.calls.filter((call) => call === 'get')).toHaveLength(before);
  fake.edit(item.id, (saved) => ({
    ...saved,
    fields: saved.fields.map((field) => (field.id === 'username' ? { ...field, value: ALIAS } : field)),
  }));
  const refreshed = await request();
  expect(refreshed.body).not.toContain(PRINCIPAL);
  expect(fake.calls.filter((call) => call === 'get')).toHaveLength(before + 1);
  const listed = await vault.allLogins();
  expect(Object.keys(listed[0]).sort()).toEqual(['item_handle', 'title', 'username', 'version', 'websites']);
  const selected = listed.find((row) => row.title === item.title)!;
  expect(selected.username).toBe(ALIAS);
  await post('/logins/update', {
    handle: selected.item_handle,
    version: '2',
    title: 'Netflix',
    site: 'netflix.com',
    username: ALIAS,
    password: 'cache-test-password',
  });
  // One fresh whole-item read for the edit and one fresh metadata read afterwards; the other Login stays cached.
  expect(fake.calls.filter((call) => call === 'get')).toHaveLength(before + 3);
  expect(JSON.stringify(await vault.allLogins())).not.toMatch(/cache-test-password|page-only-secret/u);
});

it('leaves an item untouched when an optimistic password save races a fresh edit', async () => {
  const item = login();
  const handle = await handleFor(item);
  fake.beforePut = () => fake.edit(item.id, (saved) => ({ ...saved, notes: 'Concurrent edit' }));
  const response = await post('/logins/update', {
    handle,
    version: '1',
    title: 'Netflix',
    site: 'netflix.com',
    username: PRINCIPAL,
    password: 'replacement-password',
  });
  expect(response.status).toBe(503);
  expect(fake.value(item.id, 'password')).toBe(SECRET);
  expect(fake.items.get(item.id)?.notes).toBe('Concurrent edit');
  expect(response.body).not.toContain('replacement-password');
});

it('queues removal behind an edit and checks its version after the edit finishes', async () => {
  const item = login();
  const client = fake.client() as Client;
  const saving = latch();
  const allowSave = latch();
  const put = client.items.put.bind(client.items);
  client.items.put = async (params) => {
    saving.release();
    await allowSave.promise;
    return put(params);
  };
  sdk.create.mockResolvedValue(client);
  const handle = await handleFor(item);
  const read = vi.spyOn(vault, 'readItem');
  const update = vault.updateLogin(handle, 1, { password: 'queued-replacement' });
  await saving.promise;
  const remove = vault.removeLogin(handle, 1);
  const settled = Promise.allSettled([update, remove]);
  try {
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    allowSave.release();
    await settled;
  }
  expect(await settled).toEqual([
    { status: 'fulfilled', value: undefined },
    { status: 'rejected', reason: expect.objectContaining({ reason: 'login_changed' }) },
  ]);
  expect(fake.items.has(item.id)).toBe(true);
  expect(fake.value(item.id, 'password')).toBe('queued-replacement');
  expect(fake.calls).not.toContain('delete');
});

it('refuses unlisted and deleted logins on password updates and removals without writing', async () => {
  const item = login();
  const handle = await handleFor(item);
  fake.items.delete(item.id);
  for (const selected of ['vault_unlisted', handle]) {
    for (const action of ['update', 'remove']) {
      const response = await post(`/logins/${action}`, {
        handle: selected,
        version: '1',
        ...(action === 'update'
          ? { title: 'Netflix', site: 'netflix.com', username: PRINCIPAL, password: SECRET }
          : {}),
      });
      expect(response.status).toBe(selected === 'vault_unlisted' ? 409 : 503);
      expect(response.body).toMatch(/That login is no longer available\.|The login vault is unavailable\./u);
      if (selected === 'vault_unlisted') {
        expect(response.body.match(/That login is no longer available\./gu)).toHaveLength(1);
        expect(response.body).not.toContain('Logins unavailable');
      }
    }
  }
  expect(fake.calls).not.toContain('put');
  expect(fake.calls).not.toContain('delete');
});

it('removes a principal-owned login and invalidates both its display and future fills', async () => {
  const item = login();
  const handle = await handleFor(item);
  const response = await post('/logins/remove', { handle, version: '1' });
  expect(response.status).toBe(200);
  expect(response.body).toContain('Saved login removed. The browser may still be signed in.');
  expect(response.body).not.toContain(PRINCIPAL);
  expect(fake.items.has(item.id)).toBe(false);
  expect(await vault.itemsForOrigin('https://netflix.com')).toEqual([]);
  await expect(vault.resolve(handle, 'password', 'https://netflix.com')).rejects.toMatchObject({
    reason: 'no_item_for_site',
  });
});

it('lets the principal update and remove an ordinary Login with no website or built-in password yet', async () => {
  const item = fake.store({
    category: ItemCategory.Login,
    vaultId: FIXTURE_VAULT_ID,
    title: 'Login without a website',
  });
  const handle = await handleFor(item);
  expect(
    (
      await post('/logins/update', {
        handle,
        version: '1',
        password: SECRET,
      })
    ).status,
  ).toBe(200);
  expect(fake.value(item.id, 'password')).toBe(SECRET);
  expect(fake.value(item.id, 'username')).toBeUndefined();
  expect(fake.items.get(item.id)?.websites).toEqual([]);
  expect((await post('/logins/remove', { handle, version: '2' })).status).toBe(200);
  expect(fake.items.has(item.id)).toBe(false);
});

it('accepts an exact Origin fallback when Sec-Fetch-Site is absent and rejects unknown routes', async () => {
  const response = await request(
    '/logins/add',
    'POST',
    { origin: `https://${HOST}`, 'content-type': 'application/json' },
    JSON.stringify({ site: 'netflix.com', title: '', username: PRINCIPAL, password: SECRET }),
  );
  expect(response.status).toBe(200);
  for (const [route, method] of [
    ['/logins/add?x=1', 'POST'],
    ['/logins?x=1', 'GET'],
    ['/logins/add', 'GET'],
    ['/logins', 'POST'],
  ])
    expect((await request(route, method, postHeaders)).status).toBe(404);
});

it('shows setup, outage and rate-limit outcomes without leaking provider error material or writing while held', async () => {
  await rm(vaultFiles.tokenFile);
  expect((await request()).body).toContain('Logins are not set up yet.');
  await writePrivateFile(vaultFiles.tokenFile, FIXTURE_TOKEN);
  fake.failNext('list', new Error(SECRET));
  const unavailable = await request();
  expect(unavailable.status).toBe(503);
  expect(unavailable.body).toContain('The login vault is unavailable.');
  expect(unavailable.body).not.toContain(SECRET);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001);
  fake.failNext('list', new RateLimitExceededError(SECRET));
  const limited = await request();
  expect(limited.body).toContain('The login vault has reached its request limit. Try again later.');
  const before = [...fake.calls];
  for (const action of ['add', 'update', 'remove']) {
    const response = await post(
      `/logins/${action}`,
      action === 'add'
        ? { site: 'netflix.com', title: '', username: PRINCIPAL, password: SECRET }
        : {
            handle: 'vault_unlisted',
            version: '1',
            ...(action === 'update' ? { title: '', site: 'netflix.com', username: PRINCIPAL, password: SECRET } : {}),
          },
    );
    expect(response.status).toBe(503);
    expect(response.body).toContain('Try again later.');
    expect(response.body).not.toContain(SECRET);
  }
  expect(fake.calls).toEqual(before);
});

it('preserves a successful save outcome if refreshing the displayed list is rate-limited', async () => {
  fake.afterCreate = async () => {
    fake.failNext('list', new RateLimitExceededError(SECRET));
  };
  const response = await post('/logins/add', { site: 'netflix.com', title: '', username: PRINCIPAL, password: SECRET });
  expect(response.status).toBe(503);
  expect(response.body).toContain('Login added. The login vault has reached its request limit. Try again later.');
  expect(fake.items.size).toBe(1);
  expect(response.body).not.toContain(SECRET);
});

const chromePath = process.env.GWS_EA_BROWSER_TEST_CHROME;
it.skipIf(!chromePath).each([320, 390, 1200])(
  'submits JSON in native Chrome at %ipx, protects edits and confirms removal once',
  async (initialWidth) => {
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const saveStarted = latch();
    const allowSave = latch();
    let holdSave = false;
    try {
      const context = await browser.newContext({
        viewport: { width: initialWidth, height: initialWidth < 600 ? 568 : 900 },
        hasTouch: initialWidth < 600,
        isMobile: initialWidth < 600,
      });
      const actions: { path: string; contentType: string | undefined }[] = [];
      await context.route(`https://${HOST}/**`, async (route) => {
        const incoming = route.request();
        const pathname = new URL(incoming.url()).pathname;
        const incomingHeaders = await incoming.allHeaders();
        if (incoming.method() === 'POST' && pathname === '/logins/update' && holdSave) {
          holdSave = false;
          saveStarted.release();
          await allowSave.promise;
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
      const assertLayout = async (): Promise<void> => {
        const layout = await page.evaluate<{ fits: boolean; smallTargets: string[] }>(`({
          fits: document.documentElement.scrollWidth <= innerWidth,
          smallTargets: [...document.querySelectorAll('a.button, button, input:not([type=hidden]), a.back-link, [data-login-row]')]
            .filter(element => { const rect=element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44); })
            .map(element => element.textContent || element.getAttribute('name') || element.tagName)
        })`);
        expect(layout.fits).toBe(true);
        expect(layout.smallTargets).toEqual([]);
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
      await page.getByLabel('Website', { exact: true }).fill('netflix.com');
      await page.getByLabel('Username', { exact: true }).fill(PRINCIPAL);
      await page.getByLabel('Password', { exact: true }).fill(SECRET);
      await assertLayout();
      expect(await page.evaluate<boolean>('document.activeElement.getBoundingClientRect().bottom <= innerHeight')).toBe(
        true,
      );
      await page.getByRole('button', { name: 'Add login', exact: true }).click();
      await page.getByText('Login added.', { exact: true }).waitFor();
      expect(fake.items.size).toBe(1);
      expect(actions).toEqual([{ path: '/logins/add', contentType: 'application/json' }]);
      expect(await page.locator('input[type=password]').count()).toBe(0);
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
      expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
      await page.locator('body').screenshot({ path: '/tmp/professional-logins-edit.png', animations: 'disabled' });
      await page.setViewportSize({ width: Math.min(initialWidth, 390), height: 568 });
      await page.emulateMedia({ colorScheme: 'dark' });
      expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
      await page.locator('body').screenshot({
        path: '/tmp/professional-logins-edit-mobile.png',
        animations: 'disabled',
      });
      await assertLayout();
      await page.getByLabel('New saved password', { exact: true }).fill('browser-replacement-password');
      holdSave = true;
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await saveStarted.promise;
      const savingPath = new URL(page.url()).pathname;
      await page.getByRole('link', { name: 'Cancel', exact: true }).click({ force: true });
      expect(new URL(page.url()).pathname).toBe(savingPath);
      allowSave.release();
      await page.getByText('Login updated.', { exact: true }).waitFor();
      await page.locator('body').screenshot({
        path: '/tmp/professional-logins-detail-mobile.png',
        animations: 'disabled',
      });
      const [item] = [...fake.items.values()];
      expect(fake.value(item.id, 'password')).toBe('browser-replacement-password');
      expect(actions[1]).toEqual({ path: '/logins/update', contentType: 'application/json' });
      const handle = (await vault.allLogins())[0].item_handle;
      expect(await vault.resolve(handle, 'password', 'https://netflix.com')).toBe('browser-replacement-password');
      await page.getByRole('button', { name: 'Remove login', exact: true }).first().click();
      const dialog = page.getByRole('dialog');
      expect(await dialog.isVisible()).toBe(true);
      await assertLayout();
      expect(await dialog.textContent()).toContain(`netflix.com (${PRINCIPAL})`);
      expect(await dialog.textContent()).toContain('The browser may still be signed in');
      expect(actions).toHaveLength(2);
      expect(fake.items.has(item.id)).toBe(true);
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      expect(actions).toHaveLength(2);
      await page.getByRole('button', { name: 'Remove login', exact: true }).first().click();
      await dialog.getByRole('button', { name: 'Remove login', exact: true }).click();
      await page.getByText('No saved logins yet.', { exact: true }).waitFor();
      expect(actions[2]).toEqual({ path: '/logins/remove', contentType: 'application/json' });
      expect(fake.items.size).toBe(0);
      expect(await page.content()).not.toMatch(/page-only-secret|browser-replacement-password/u);
      expect(
        await page.evaluate<{ local: number; session: number }>(
          '({local: localStorage.length, session: sessionStorage.length})',
        ),
      ).toEqual({
        local: 0,
        session: 0,
      });
      login(PRINCIPAL, ['https://netflix.com'], 'Personal');
      login(ALIAS, ['https://netflix.com'], 'Family');
      login(ALIAS, ['https://linear.app'], 'Team workspace');
      login(PRINCIPAL, ['https://notion.so'], 'Personal workspace');
      login(PRINCIPAL, ['https://airbnb.com'], 'Travel');
      await page.goto(`https://${HOST}/logins`);
      expect(await page.locator('[data-site-group]').count()).toBe(4);
      expect(await page.locator('[data-login-row]').count()).toBe(5);
      await page.emulateMedia({ colorScheme: 'light' });
      await page.setViewportSize({ width: 1200, height: 900 });
      await page.locator('body').screenshot({ path: '/tmp/professional-logins-desktop.png', animations: 'disabled' });
      for (const width of [320, 360, 375, 390, 414, 768, 1200]) {
        await page.setViewportSize({ width, height: 844 });
        expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('body').screenshot({ path: '/tmp/professional-logins-mobile.png', animations: 'disabled' });
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.locator('body').screenshot({ path: '/tmp/professional-logins-dark.png', animations: 'disabled' });
      await page.locator('[data-login-row]').first().click();
      await page.emulateMedia({ colorScheme: 'light' });
      await page.setViewportSize({ width: 1200, height: 900 });
      await page.locator('body').screenshot({ path: '/tmp/professional-logins-detail.png', animations: 'disabled' });
      await page.getByRole('link', { name: 'All logins', exact: true }).click();
      await page.getByRole('link', { name: 'Add login', exact: true }).click();
      await page.locator('body').screenshot({ path: '/tmp/professional-logins-add.png', animations: 'disabled' });
      const longLabel = 'Family\nTeam ' + 'A'.repeat(220);
      const longUsername = 'long-account-name.'.repeat(8) + '@example.com';
      const imported = login(longUsername, ['https://accounts.long-subdomain.example.com'], longLabel);
      await page.goto(`https://${HOST}/logins`);
      await page.setViewportSize({ width: 320, height: 568 });
      await assertLayout();
      const longRow = page.locator('[data-login-row]').filter({ hasText: longUsername });
      expect((await longRow.boundingBox())!.height).toBeLessThanOrEqual(160);
      await longRow.click();
      await assertLayout();
      expect((await page.getByRole('heading', { level: 1 }).boundingBox())!.height).toBeLessThanOrEqual(480);
      await page
        .locator('body')
        .screenshot({ path: '/tmp/professional-logins-small-detail.png', animations: 'disabled' });
      await page.getByRole('link', { name: 'Edit details', exact: true }).click();
      await assertLayout();
      await page.getByLabel('New saved password', { exact: true }).focus();
      expect(await page.evaluate<boolean>('document.activeElement.getBoundingClientRect().bottom <= innerHeight')).toBe(
        true,
      );
      await page
        .locator('body')
        .screenshot({ path: '/tmp/professional-logins-small-edit.png', animations: 'disabled' });
      await page.getByLabel('New saved password', { exact: true }).fill('imported-login-replacement');
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await page.getByText('Login updated.', { exact: true }).waitFor();
      expect(fake.items.get(imported.id)?.title).toBe(longLabel);
      expect(fake.value(imported.id, 'password')).toBe('imported-login-replacement');
      expect((await vault.itemsForOrigin('https://accounts.long-subdomain.example.com'))[0].title).toBe(
        longLabel.replace(/\p{Cc}/gu, ' ').slice(0, 200),
      );
      await page.getByRole('button', { name: 'Remove login', exact: true }).click();
      await assertLayout();
      await page.screenshot({ path: '/tmp/professional-logins-small-dialog.png', animations: 'disabled' });
      await page.setViewportSize({ width: 568, height: 320 });
      const dialogBounds = await page.getByRole('dialog').boundingBox();
      expect(dialogBounds).not.toBeNull();
      expect(dialogBounds!.y).toBeGreaterThanOrEqual(0);
      expect(dialogBounds!.y + dialogBounds!.height).toBeLessThanOrEqual(320);
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      if (initialWidth === 320) {
        await page.setViewportSize({ width: 320, height: 568 });
        await page.getByRole('link', { name: 'Edit details', exact: true }).click();
        fake.edit(imported.id, (saved) => ({ ...saved, notes: 'Concurrent edit' }));
        await page.getByLabel('New saved password', { exact: true }).fill('stale-replacement');
        await page.getByRole('button', { name: 'Save changes', exact: true }).click();
        await page.getByText(/This login changed since you opened it/u).waitFor();
        expect(await page.getByRole('button', { name: 'Save changes', exact: true }).isEnabled()).toBe(true);
        await page.reload();
        fake.failNext('put', new Error(SECRET), true);
        await page.getByLabel('New saved password', { exact: true }).fill('saved-but-response-lost');
        await page.getByRole('button', { name: 'Save changes', exact: true }).click();
        await page.getByRole('link', { name: 'Reload page', exact: true }).waitFor();
        expect(await page.getByRole('button', { name: 'Save changes', exact: true }).isDisabled()).toBe(true);
        expect(fake.value(imported.id, 'password')).toBe('saved-but-response-lost');
        await page.reload();
        fake.beforePut = () => fake.failNext('get', new RateLimitExceededError(SECRET));
        await page.getByLabel('New saved password', { exact: true }).fill('saved-before-refresh-limit');
        await page.getByRole('button', { name: 'Save changes', exact: true }).click();
        await page.getByRole('heading', { name: 'Logins unavailable', exact: true }).waitFor();
        expect(await page.locator('#outcome').textContent()).toContain('Login updated.');
        expect(await page.getByRole('button', { name: 'Save changes', exact: true }).count()).toBe(0);
        expect(fake.value(imported.id, 'password')).toBe('saved-before-refresh-limit');
        expect(await page.content()).not.toMatch(
          /saved-but-response-lost|saved-before-refresh-limit|page-only-secret/u,
        );
      }
      await context.close();
    } finally {
      allowSave.release();
      await browser.close();
    }
  },
  30_000,
);
