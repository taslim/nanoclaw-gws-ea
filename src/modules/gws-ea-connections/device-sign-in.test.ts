import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { ROOT } = vi.hoisted(() => ({ ROOT: `/tmp/connections-device-sign-in-${process.pid}` }));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
  GROUPS_DIR: `${ROOT}/groups`,
}));
const logged = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() }));
vi.mock('../../log.js', () => ({ log: logged }));

import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import type { Session } from '../../types.js';
import { mainSession, seedMain } from '../gws-ea-matters/testing/main-conversation.js';
import type { NoteForMain } from '../gws-ea-profile/main-note.js';
import '../gws-ea-profile/index.js';
import { catalogEntry } from './catalog.js';
import { CATALOG_POLICY_FILE_ENV, CONNECTIONS_ROOT_ENV } from './config.js';
import { cancelAllDeviceSignIns, cancelDeviceSignIn } from './device-sign-in.js';
import { recordHostCliReceipt } from './host-cli-receipt.js';
import { isHostCliEntry, type HostCliEntry } from './host-process.js';
import { ConnectionOperations } from './operations.js';
import { createConnectionsPageHandler } from './page.js';
import { createConnectionsRefresher, type RefusedApp } from './refresher.js';
import { createAppRelay, type AppRelay } from './relay.js';
import type { ConnectionApp, ConnectionsStore } from './store.js';
import type { FakeLinkControl, FakeLinkRecord } from './testing/fake-link-cli.js';
import type { FakeAppControl } from './testing/fake-stdio-app.js';
import { testConnectionsStore } from './testing/store.js';

const FAKE_LINK = path.join(import.meta.dirname, 'testing', 'fake-link-cli.ts');
const HOST = 'juno.example.test';
const PRINCIPAL = 'morgan@example.test';
const ADDRESS = 'https://app.link.com/device?code=juno-sentinel';
const PHRASE = 'maple-river-lantern';
const SENTINEL_TOKEN = 'sentinel-link-token-W4z8-long-enough';
const chromePath = process.env.GWS_EA_BROWSER_TEST_CHROME;
const savedEnv = { ...process.env };

let base: string;
let connections: string;
let workDir: string;
let policyFile: string;
let installDir: string;
let store: ConnectionsStore;
let session: Session;
let server: Server;
let port: number;
let notes: NoteForMain[];
let disconnected: { readonly appId: string; readonly logoutsBefore: number }[];
const relays: AppRelay[] = [];

function linkEntry(): HostCliEntry {
  const entry = catalogEntry('link');
  if (!entry || !isHostCliEntry(entry)) throw new Error('Link must be a host-run catalog entry');
  return entry;
}

function writePolicy(link: { readonly enabled: boolean; readonly version?: string }): void {
  const version = link.version ?? linkEntry().transport.version;
  fs.writeFileSync(
    policyFile,
    JSON.stringify({
      schemaVersion: 1,
      link: { enabled: link.enabled, versions: { [version]: { installationDir: installDir } } },
      shop: null,
    }),
    { mode: 0o600 },
  );
}

/** The pinned package's layout, its entry file running the fake CLI, with a receipt the host verifies. */
async function fakeInstall(): Promise<void> {
  const packageDir = path.join(installDir, 'node_modules', '@stripe', 'link-cli');
  fs.mkdirSync(path.join(packageDir, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name: '@stripe/link-cli', version: '1.6.0', type: 'module', bin: { 'link-cli': 'dist/cli.js' } }),
  );
  fs.writeFileSync(
    path.join(packageDir, 'dist', 'cli.js'),
    `import ${JSON.stringify(pathToFileURL(FAKE_LINK).href)};\n`,
  );
  const undiciDir = path.join(installDir, 'node_modules', 'undici');
  fs.mkdirSync(undiciDir, { recursive: true });
  fs.writeFileSync(path.join(undiciDir, 'package.json'), JSON.stringify({ name: 'undici', version: '7.30.2' }));
  fs.writeFileSync(path.join(undiciDir, 'index.js'), 'module.exports = {};\n');
  await recordHostCliReceipt(installDir, linkEntry().transport);
}

function control(value: FakeLinkControl & FakeAppControl): void {
  fs.writeFileSync(path.join(workDir, 'fake-link.json'), JSON.stringify(value));
  fs.writeFileSync(path.join(workDir, 'fake-app.json'), JSON.stringify(value));
}

function answer(value: 'approve' | 'deny'): void {
  fs.writeFileSync(path.join(workDir, 'fake-link-answer'), value);
}

function commands(): FakeLinkRecord[] {
  const file = path.join(workDir, 'fake-link.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeLinkRecord);
}

const ran = (command: string): FakeLinkRecord[] => commands().filter((entry) => entry.args[1] === command);
const authFile = (): string => path.join(workDir, 'auth.json');
const pendingFiles = (): string[] => fs.readdirSync(workDir).filter((name) => name.startsWith('auth.pending'));

function operations(): ConnectionOperations {
  return new ConnectionOperations({
    store,
    webHostname: HOST,
    clientDocumentsServed: () => true,
    applyMain: async () => false,
    onDisconnected: async (appId) => {
      disconnected.push({ appId, logoutsBefore: ran('logout').length });
    },
    writeNote: async (note) => {
      notes.push(note);
      return 'written';
    },
  });
}

interface Reply {
  readonly status: number;
  readonly body: string;
}

function request(route: string, method = 'GET', body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path: route,
        headers: {
          host: HOST,
          'cf-access-jwt-assertion': PRINCIPAL,
          ...(method === 'POST' ? { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } : {}),
        },
      },
      (incoming) => {
        let text = '';
        incoming.on('data', (chunk: Buffer) => {
          text += chunk.toString();
        });
        incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, body: text }));
      },
    );
    outgoing.on('error', reject);
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const connectLink = (): Promise<Reply> => request('/connections/catalog-connect', 'POST', { entry: 'link' });

async function linkApp(): Promise<ConnectionApp> {
  const app = (await store.apps()).find((candidate) => candidate.catalogId === 'link');
  if (!app) throw new Error('No Link app');
  return app;
}

async function signInStatus(app: ConnectionApp): Promise<Record<string, string>> {
  return JSON.parse((await request(`/connections/app/${app.id}/sign-in-status`)).body) as Record<string, string>;
}

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last value ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function connectedLink(): Promise<ConnectionApp> {
  control({ login: 'approve', verificationUrl: ADDRESS, phrase: PHRASE, token: SENTINEL_TOKEN });
  await connectLink();
  const app = await linkApp();
  await eventually(
    () => signInStatus(app),
    (status) => status.status === 'connected',
  );
  return linkApp();
}

beforeEach(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  base = fs.realpathSync(ROOT);
  connections = path.join(base, 'connections');
  workDir = path.join(connections, 'link');
  policyFile = path.join(base, 'catalog.json');
  installDir = path.join(base, 'install');
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(connections, 0o700);
  process.env[CONNECTIONS_ROOT_ENV] = connections;
  process.env[CATALOG_POLICY_FILE_ENV] = policyFile;
  await fakeInstall();
  writePolicy({ enabled: true });
  ({ store } = testConnectionsStore(connections));
  notes = [];
  disconnected = [];
  for (const level of Object.values(logged)) level.mockClear();
  await runMigrations(await initTestDb());
  await seedMain('UTC');
  session = await mainSession();
  await getDb().run(
    'INSERT INTO gws_ea_principal_addresses(email, added_at) VALUES (?, ?)',
    PRINCIPAL,
    new Date().toISOString(),
  );
  server = createServer(
    createConnectionsPageHandler({
      hostname: HOST,
      identity: async (incoming) => {
        const identity = incoming.headers['cf-access-jwt-assertion'];
        return typeof identity === 'string' ? identity : undefined;
      },
      operations: async () => operations(),
      operatorDependencies: () => ({ credentials: undefined, protectedHosts: async () => new Set([HOST]) }),
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server port');
  port = address.port;
});

afterEach(async () => {
  cancelAllDeviceSignIns();
  await Promise.all(relays.splice(0).map((relay) => relay.drain(500)));
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
  for (const key of [CONNECTIONS_ROOT_ENV, CATALOG_POLICY_FILE_ENV]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  // Let a killed fake CLI finish exiting before its directory goes.
  await new Promise((resolve) => setTimeout(resolve, 50));
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('connecting Link from the page', () => {
  it('shows the address and phrase, and connects with owner-only credentials once Link reports approval', async () => {
    control({ login: 'wait', verificationUrl: ADDRESS, phrase: PHRASE, token: SENTINEL_TOKEN });

    const started = await connectLink();
    const app = await linkApp();
    expect(started.status).toBe(200);
    expect(JSON.parse(started.body)).toEqual({ location: `/connections/app/${app.id}/connect` });
    const view = await request(`/connections/app/${app.id}/connect`);
    expect(view.body).toContain(`href="${ADDRESS}"`);
    expect(view.body).toContain(`<code id="device-phrase">${PHRASE}</code>`);
    expect(view.body).toContain('data-device-state="waiting"');
    expect(app.status).toBe('not_connected');

    answer('approve');
    await eventually(
      () => signInStatus(app),
      (status) => status.status === 'connected',
    );

    expect((await linkApp()).status).toBe('connected');
    expect(await store.currentGrant(app.id)).toMatchObject({ kind: 'none' });
    expect(fs.statSync(authFile()).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(authFile(), 'utf8')).toContain(SENTINEL_TOKEN);
    expect(pendingFiles()).toEqual([]);
  });

  it.skipIf(!chromePath)(
    'shows the new address and phrase in an open page once another tab has started a new sign-in',
    async () => {
      control({ login: 'wait', verificationUrl: ADDRESS, phrase: PHRASE });
      await connectLink();
      const app = await linkApp();
      const browser = await chromium.launch({ executablePath: chromePath, headless: true });
      try {
        const context = await browser.newContext();
        await context.route(`https://${HOST}/**`, async (route) => {
          const url = new URL(route.request().url());
          const reply = await request(`${url.pathname}${url.search}`);
          await route.fulfill({
            status: reply.status,
            contentType: url.pathname.endsWith('/sign-in-status') ? 'application/json' : 'text/html',
            body: reply.body,
          });
        });
        const page = await context.newPage();
        page.setDefaultTimeout(10_000);
        await page.goto(`https://${HOST}/connections/app/${app.id}/connect`);
        await expect.poll(() => page.locator('#device-phrase').textContent()).toBe(PHRASE);

        const nextAddress = 'https://app.link.com/device?code=remy-sentinel';
        const nextPhrase = 'cedar-harbor-violet';
        cancelDeviceSignIn(app.id);
        control({ login: 'wait', verificationUrl: nextAddress, phrase: nextPhrase });
        await connectLink();

        await expect.poll(() => page.locator('#device-phrase').textContent(), { timeout: 10_000 }).toBe(nextPhrase);
        expect(await page.locator('#device-address').getAttribute('href')).toBe(nextAddress);
        await context.close();
      } finally {
        await browser.close();
      }
    },
    30_000,
  );

  it('names the assistant, polls every five seconds, reads JSON lines and signs in against the pending file', async () => {
    await connectedLink();

    const [login] = ran('login');
    expect(login?.args).toEqual([
      'auth',
      'login',
      '--client-name',
      'Juno (GWS-EA)',
      '--interval',
      '5',
      '--timeout',
      '300',
      '--format',
      'jsonl',
    ]);
    expect(path.dirname(login?.authFile ?? '')).toBe(workDir);
    expect(path.basename(login?.authFile ?? '')).toMatch(/^auth\.pending.*\.json$/u);
    expect(login?.authFile).not.toBe(authFile());
    expect(login?.proxy).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
  });

  it('shows the same phrase on returning mid-login, and never starts a second login', async () => {
    control({ login: 'wait', verificationUrl: ADDRESS, phrase: PHRASE });
    await connectLink();
    const app = await linkApp();

    const again = await connectLink();
    const reloaded = await request(`/connections/app/${app.id}/connect`);

    expect(JSON.parse(again.body)).toEqual({ location: `/connections/app/${app.id}/connect` });
    expect(reloaded.body).toContain(`<code id="device-phrase">${PHRASE}</code>`);
    expect(await signInStatus(app)).toEqual({ status: 'waiting', verificationUrl: ADDRESS, phrase: PHRASE });
    expect(ran('login')).toHaveLength(1);
  });

  it.each([
    ['times out', 'timeout', 'The sign-in expired before it was approved.'],
    ['is declined', 'deny', 'The sign-in was declined.'],
    ['expires', 'expire', 'The sign-in expired before it was approved.'],
  ] as const)(
    'leaves no credentials or live grant when the login %s, and offers Try again',
    async (_case, login, message) => {
      control({ login, verificationUrl: ADDRESS, phrase: PHRASE, token: SENTINEL_TOKEN });
      await connectLink();
      const app = await linkApp();

      await eventually(
        () => signInStatus(app),
        (status) => status.status === 'ended',
      );
      const view = await request(`/connections/app/${app.id}/connect`);

      expect((await linkApp()).status).toBe('not_connected');
      expect(await store.currentGrant(app.id)).toBeUndefined();
      expect(fs.existsSync(authFile())).toBe(false);
      expect(pendingFiles()).toEqual([]);
      expect(view.body).toContain(message);
      expect(view.body).toContain('Try again');
      expect(view.body).toContain('<input type="hidden" name="entry" value="link">');
    },
  );

  it('counts a login that ends without reporting approval as approved only when the status check says so', async () => {
    control({ login: 'timeout', verificationUrl: ADDRESS, phrase: PHRASE });
    await connectLink();
    const app = await linkApp();
    await eventually(
      () => signInStatus(app),
      (status) => status.status === 'ended',
    );

    expect(ran('status')).toEqual([expect.objectContaining({ authFile: ran('login')[0]?.authFile })]);
    expect(await store.currentGrant(app.id)).toBeUndefined();
  });

  it('ends without a status check when the installed CLI changed while the login waited', async () => {
    control({ login: 'wait', verificationUrl: ADDRESS, phrase: PHRASE });
    await connectLink();
    const app = await linkApp();
    const cliFile = path.join(installDir, 'node_modules', '@stripe', 'link-cli', 'dist', 'cli.js');
    fs.appendFileSync(cliFile, '// changed after the receipt\n');

    answer('deny');
    const status = await eventually(
      () => signInStatus(app),
      (value) => value.status === 'ended',
    );

    expect(status).toEqual({ status: 'ended', reason: 'failed' });
    expect(ran('status')).toEqual([]);
    expect(pendingFiles()).toEqual([]);
    expect(await store.currentGrant(app.id)).toBeUndefined();
  });

  it.each([
    ['output it cannot read', 'garbled'],
    ['a first record without a phrase', 'no_phrase'],
  ] as const)('reports %s as an error with Try again, and stops the login', async (_case, login) => {
    control({ login, verificationUrl: ADDRESS, phrase: PHRASE });
    await connectLink();
    const app = await linkApp();

    const status = await eventually(
      () => signInStatus(app),
      (value) => value.status === 'ended',
    );
    const view = await request(`/connections/app/${app.id}/connect`);

    expect(status).toEqual({ status: 'ended', reason: 'failed' });
    expect(view.body).toContain('The sign-in couldn’t be read.');
    expect(view.body).toContain('Try again');
    expect(pendingFiles()).toEqual([]);
    const [login_] = ran('login');
    expect(() => process.kill(login_?.pid ?? 0, 0)).toThrow();
  });

  it('connects nothing when the operator stops offering Link before the principal approves', async () => {
    control({ login: 'wait', verificationUrl: ADDRESS, phrase: PHRASE, token: SENTINEL_TOKEN });
    await connectLink();
    const app = await linkApp();
    writePolicy({ enabled: false });

    answer('approve');
    const status = await eventually(
      () => signInStatus(app),
      (value) => value.status !== 'waiting',
    );
    const view = await request(`/connections/app/${app.id}/connect`);

    expect(status).toEqual({ status: 'ended', reason: 'not_offered' });
    expect(view.body).toContain('This app isn’t available right now.');
    expect((await linkApp()).status).toBe('not_connected');
    expect(await store.currentGrant(app.id)).toBeUndefined();
    expect(fs.existsSync(authFile())).toBe(false);
    expect(pendingFiles()).toEqual([]);
  });

  it('keeps a replacement sign-in’s pending file when the cancelled one finishes after it started', async () => {
    control({ login: 'wait', verificationUrl: ADDRESS, phrase: PHRASE, stopDelayMs: 500 });
    await connectLink();
    const app = await linkApp();
    cancelDeviceSignIn(app.id);
    control({ login: 'wait', verificationUrl: ADDRESS, phrase: 'cedar-harbor-violet', token: SENTINEL_TOKEN });
    await connectLink();
    const [cancelled, replacement] = ran('login');
    if (!cancelled || !replacement) throw new Error('Both logins should have started');
    expect(await signInStatus(app)).toMatchObject({ status: 'waiting', phrase: 'cedar-harbor-violet' });

    await eventually(
      async () => {
        try {
          process.kill(cancelled.pid, 0);
          return false;
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true;
          throw error;
        }
      },
      (exited) => exited,
    );
    // The cancelled sign-in cleans up once its proxy closes, after its CLI exits.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(fs.existsSync(replacement.authFile ?? '')).toBe(true);
    answer('approve');
    await eventually(
      () => signInStatus(app),
      (status) => status.status === 'connected',
    );
    expect(fs.readFileSync(authFile(), 'utf8')).toContain(SENTINEL_TOKEN);
  });

  it('starts a fresh login on Try again once the last one ended', async () => {
    control({ login: 'deny', verificationUrl: ADDRESS, phrase: PHRASE });
    await connectLink();
    const app = await linkApp();
    await eventually(
      () => signInStatus(app),
      (status) => status.status === 'ended',
    );

    control({ login: 'approve', verificationUrl: ADDRESS, phrase: PHRASE });
    await connectLink();
    await eventually(
      () => signInStatus(app),
      (status) => status.status === 'connected',
    );

    expect(ran('login')).toHaveLength(2);
  });

  it('keeps the token out of every page answer and log line', async () => {
    const app = await connectedLink();
    const pages = [
      await request('/connections'),
      await request(`/connections/app/${app.id}/connect`),
      await request(`/connections/app/${app.id}/sign-in-status`),
    ];
    const logs = JSON.stringify(Object.values(logged).flatMap((level) => level.mock.calls));

    for (const text of [...pages.map((page) => page.body), logs, JSON.stringify(notes)]) {
      expect(text).not.toContain(SENTINEL_TOKEN);
      expect(text).not.toContain(SENTINEL_TOKEN.slice(0, 20));
    }
  });
});

describe('disconnecting Link', () => {
  it('closes the app’s child, then signs out and deletes the credentials', async () => {
    const app = await connectedLink();

    const reply = await request('/connections/disconnect', 'POST', { id: app.id, version: String(app.version) });

    expect(reply.status).toBe(200);
    expect(reply.body).toContain('App disconnected.');
    expect((await linkApp()).status).toBe('not_connected');
    expect(disconnected.at(-1)).toEqual({ appId: app.id, logoutsBefore: 0 });
    expect(ran('logout')).toEqual([expect.objectContaining({ authFile: authFile() })]);
    expect(fs.existsSync(authFile())).toBe(false);
  });

  it('still deletes the credentials and reports disconnected when the sign-out fails', async () => {
    const app = await connectedLink();
    control({ logoutFails: true });

    const reply = await request('/connections/disconnect', 'POST', { id: app.id, version: String(app.version) });

    expect(reply.body).toContain('App disconnected.');
    expect(ran('logout')).toHaveLength(1);
    expect(fs.existsSync(authFile())).toBe(false);
    expect((await linkApp()).status).toBe('not_connected');
  });

  it('stops a login that is still waiting, so a later approval connects nothing', async () => {
    control({ login: 'wait', verificationUrl: ADDRESS, phrase: PHRASE });
    await connectLink();
    const app = await linkApp();

    await request('/connections/delete', 'POST', { id: app.id, version: String(app.version) });
    answer('approve');
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(await store.apps()).toEqual([]);
    expect(fs.existsSync(authFile())).toBe(false);
  });
});

describe('a relayed call Link cannot authenticate', () => {
  it('marks the grant refused and owes main a reconnect note', async () => {
    const app = await connectedLink();
    const refused: RefusedApp[] = [];
    const refresher = createConnectionsRefresher({
      store,
      apply: async () => false,
      onRefused: (entry) => {
        refused.push(entry);
      },
      clientDocumentsServed: () => true,
    });
    const relay = createAppRelay({
      store,
      refresher: () => refresher,
      onHoldCall: () => Promise.resolve({ status: 'held', text: 'held' }),
    });
    relays.push(relay);
    control({ notAuthenticated: true });
    const { tools } = await relay.pinApp(app.id);
    await store.applyToolLabels(
      app.id,
      tools.map((tool) => ({
        name: tool.name,
        definitionHash: tool.definitionHash,
        label: 'just_do' as const,
        source: 'principal' as const,
        reason: 'Allowed for this test',
      })),
    );
    const generation = (await store.currentGrant(app.id))?.generation;

    const outcome = await relay.callTool({
      serverKey: app.serverKey,
      toolName: 'spend-request_list',
      args: {},
      session,
      requestId: randomUUID(),
    });

    expect(outcome).toMatchObject({ status: 'completed', result: { isError: true } });
    expect((await linkApp()).status).toBe('needs_reconnecting');
    expect(refused).toEqual([{ appId: app.id, generation }]);
  });
});

describe('retiring Link', () => {
  it('disconnects a connected Link once the operator disables it, signs it out and notes main without waking it', async () => {
    const app = await connectedLink();
    writePolicy({ enabled: false });

    const reply = await operations().retireCatalogEntry('link');

    expect(reply).toEqual({ schemaVersion: 1, entry: 'link', retired: 1, remaining: 0 });
    expect((await linkApp()).status).toBe('not_connected');
    expect(ran('logout')).toHaveLength(1);
    expect(fs.existsSync(authFile())).toBe(false);
    expect(notes).toEqual([
      expect.objectContaining({ id: `connection-retired:${app.id}:${app.version}`, wake: false }),
    ]);
    expect(notes[0]?.text).toContain('turned Link off');
  });

  it('retires nothing when only the pinned version is missing from the policy', async () => {
    await connectedLink();
    writePolicy({ enabled: true, version: '0.0.1' });

    const reply = await operations().retireCatalogEntry('link');

    expect(reply).toEqual({ schemaVersion: 1, entry: 'link', retired: 0, remaining: 1 });
    expect((await linkApp()).status).toBe('connected');
    expect(fs.existsSync(authFile())).toBe(true);
    expect(notes).toEqual([]);
  });

  it('retires nothing while the policy cannot be read', async () => {
    await connectedLink();
    fs.writeFileSync(policyFile, '{ not json', { mode: 0o600 });

    const reply = await operations().retireCatalogEntry('link');

    expect(reply).toEqual({ schemaVersion: 1, entry: 'link', retired: 0, remaining: 1 });
    expect((await linkApp()).status).toBe('connected');
  });
});
