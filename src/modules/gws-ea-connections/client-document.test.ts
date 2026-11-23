import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import '../gws-ea-profile/index.js';
import { createWebHandler } from '../gws-ea-web/server.js';
import { createClientDocumentHandler } from './client-document.js';
import { clientDocumentsWebMount } from './connections-mount.js';
import { ConnectionsStoreError, type ConnectionApp, type ConnectionsStore } from './store.js';
import { testConnectionsStore, type TestKeychain } from './testing/store.js';

const HOST = 'juno.example.test';
const LEDGERLY = 'https://app.ledgerly.example.test/mcp';
const UNKNOWN_ID = '6f1c2a3b-4d5e-4f60-8a71-9b0c1d2e3f40';

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

let directory: string;
let store: ConnectionsStore;
let keychain: TestKeychain;
let openStore: () => Promise<ConnectionsStore>;
let server: Server;
let port: number;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'connections-client-document-'));
  ({ store, keychain } = testConnectionsStore(path.join(directory, 'connections')));
  openStore = async () => store;
  await runMigrations(await initTestDb());
  await getDb().run("UPDATE gws_ea_profile SET assistant_first_name = 'Juno' WHERE singleton = 1");
  const listener = createClientDocumentHandler({ hostname: HOST, openStore: () => openStore() });
  server = createServer(
    createWebHandler(HOST, [{ mount: clientDocumentsWebMount, listener }], async () => {
      throw new Error('A public document never consults the principal gate');
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  port = address.port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function fetchPath(
  target: string,
  options: { readonly method?: string; readonly headers?: Readonly<Record<string, string>> } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: target,
        method: options.method ?? 'GET',
        headers: { host: HOST, ...options.headers },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () =>
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

function withoutDate(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const { date: _date, ...rest } = headers;
  return rest;
}

async function oauthApp(): Promise<ConnectionApp> {
  return store.create({ name: 'Ledgerly', url: LEDGERLY, auth: 'oauth', issuer: 'https://auth.example.test/' });
}

const documentPath = (app: Pick<ConnectionApp, 'id'>): string => `/oauth-client/${app.id}`;

it("serves an OAuth app's client document naming the assistant and the app's own callback", async () => {
  const app = await oauthApp();
  const reply = await fetchPath(documentPath(app));
  expect(reply.status).toBe(200);
  expect(reply.headers['content-type']).toBe('application/json');
  expect(reply.headers['cache-control']).toBe('public, max-age=3600');
  expect(reply.headers['x-content-type-options']).toBe('nosniff');
  expect(reply.headers.location).toBeUndefined();
  expect(JSON.parse(reply.body)).toEqual({
    client_id: `https://${HOST}/oauth-client/${app.id}`,
    client_name: 'Juno',
    redirect_uris: [`https://${HOST}/connections/callback/app.ledgerly.example.test`],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    token_endpoint_auth_methods_supported: ['none'],
    application_type: 'web',
  });
});

it('answers HEAD with the same headers and no body', async () => {
  const app = await oauthApp();
  const get = await fetchPath(documentPath(app));
  const head = await fetchPath(documentPath(app), { method: 'HEAD' });
  expect(head.status).toBe(200);
  expect(head.body).toBe('');
  expect(withoutDate(head.headers)).toEqual(withoutDate(get.headers));
});

it('answers one empty not-found for anything but an existing OAuth app', async () => {
  const token = await store.create({ name: 'Notes', url: 'https://notes.example.test/mcp', auth: 'token' });
  const open = await store.create({ name: 'Recipes', url: 'https://recipes.example.test/mcp', auth: 'none' });
  const oauth = await oauthApp();
  const replies = await Promise.all(
    [
      `/oauth-client/${UNKNOWN_ID}`,
      documentPath(token),
      documentPath(open),
      '/oauth-client/ledgerly',
      '/oauth-client/app.ledgerly.example.test',
      `/oauth-client/${oauth.id.toUpperCase()}`,
      `/oauth-client/${oauth.id}/extra`,
      '/oauth-client',
    ].map(async (target) => [target, await fetchPath(target)] as const),
  );
  for (const [target, reply] of replies) {
    expect(reply.status, target).toBe(404);
    expect(reply.body, target).toBe('');
    expect(withoutDate(reply.headers), target).toEqual(withoutDate(replies[0][1].headers));
  }
});

it('answers unavailable, never not-found, while the store cannot be read', async () => {
  const app = await oauthApp();
  await writeFile(path.join(directory, 'connections', 'apps.db'), 'not a database');
  const unreadable = await fetchPath(documentPath(app));
  expect(unreadable).toMatchObject({ status: 503, body: '' });

  openStore = async () => {
    throw new ConnectionsStoreError('store_unavailable');
  };
  expect(await fetchPath(documentPath(app))).toMatchObject({ status: 503, body: '' });
});

it("serves the document without unsealing the app's client", async () => {
  const app = await oauthApp();
  await store.setClient(app.id, app.version, {
    issuer: 'https://auth.example.test/',
    client: { clientId: 'juno-ledgerly-client', clientSecret: 'sentinel-client-secret-V7k2' },
    entered: true,
  });
  keychain.unavailable = true;
  const asked = keychain.calls.length;
  const reply = await fetchPath(documentPath(app));
  expect(reply.status).toBe(200);
  expect(reply.body).not.toContain('juno-ledgerly-client');
  expect(reply.body).not.toContain('sentinel-client-secret-V7k2');
  expect(keychain.calls).toHaveLength(asked);
});

it("keeps the document byte-identical across an app rename and changes only the client name with the assistant's", async () => {
  const app = await oauthApp();
  const before = await fetchPath(documentPath(app));
  await store.rename(app.id, app.version, 'Ledgerly Books');
  const renamedApp = await fetchPath(documentPath(app));
  expect(renamedApp.body).toBe(before.body);

  await getDb().run("UPDATE gws_ea_profile SET assistant_first_name = 'Remy' WHERE singleton = 1");
  const renamedAssistant = await fetchPath(documentPath(app));
  expect(JSON.parse(renamedAssistant.body)).toEqual({ ...JSON.parse(before.body), client_name: 'Remy' });
});

it('names no client until the assistant has a name, leaving the consent screen to show its address', async () => {
  const app = await oauthApp();
  await getDb().run(
    'UPDATE gws_ea_profile SET assistant_first_name = NULL, assistant_last_name = NULL WHERE singleton = 1',
  );
  const reply = await fetchPath(documentPath(app));
  expect(reply.status).toBe(200);
  expect(JSON.parse(reply.body)).not.toHaveProperty('client_name');
});

it('answers the same whatever the caller sends besides the address', async () => {
  const app = await oauthApp();
  const plain = await fetchPath(documentPath(app));
  for (const variant of [
    fetchPath(documentPath(app), { headers: { 'user-agent': 'AuthServer/2.1 (+https://auth.example.test)' } }),
    fetchPath(`${documentPath(app)}?client_id=https://evil.example.test/&redirect_uri=https://evil.example.test/cb`),
    fetchPath(documentPath(app), { headers: { cookie: 'CF_Authorization=forged; session=1' } }),
    fetchPath(documentPath(app), {
      headers: { 'x-forwarded-host': 'evil.example.test', 'cf-access-jwt-assertion': 'forged' },
    }),
  ]) {
    const reply = await variant;
    expect(reply.status).toBe(200);
    expect(reply.body).toBe(plain.body);
    expect(withoutDate(reply.headers)).toEqual(withoutDate(plain.headers));
  }
});
