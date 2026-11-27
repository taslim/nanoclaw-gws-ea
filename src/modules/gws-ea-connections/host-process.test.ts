import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { ROOT } = vi.hoisted(() => ({ ROOT: `/tmp/connections-host-process-${process.pid}` }));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
  GROUPS_DIR: `${ROOT}/groups`,
}));
const logged = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() }));
vi.mock('../../log.js', () => ({ log: logged }));
/** Lets a test wrap each proxy the host starts; every other test gets the proxy unchanged. */
const proxyFront = vi.hoisted(() => ({
  wrap: undefined as undefined | ((proxy: PublicBrowserProxy) => Promise<PublicBrowserProxy>),
}));
vi.mock('../gws-ea-browser/proxy.js', async (original) => {
  const actual = await original<typeof import('../gws-ea-browser/proxy.js')>();
  return {
    ...actual,
    startPublicBrowserProxy: async (): Promise<PublicBrowserProxy> => {
      const proxy = await actual.startPublicBrowserProxy();
      return proxyFront.wrap ? proxyFront.wrap(proxy) : proxy;
    },
  };
});

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import type { Session } from '../../types.js';
import { startPublicBrowserProxy, type PublicBrowserProxy } from '../gws-ea-browser/proxy.js';
import { mainSession, seedMain } from '../gws-ea-matters/testing/main-conversation.js';
import '../gws-ea-profile/index.js';
import { catalogEntry } from './catalog.js';
import { CATALOG_POLICY_FILE_ENV, CONNECTIONS_ROOT_ENV } from './config.js';
import { HOST_CLI_RECEIPT_FILE, recordHostCliReceipt, verifyHostCliReceipt } from './host-cli-receipt.js';
import {
  hostCliEnvironment,
  HostCliUnavailableError,
  HostProcessTransport,
  isHostCliEntry,
  resolveHostCliLaunch,
  type HostCliEntry,
} from './host-process.js';
import { createAppRelay, RELAY_MAX_BODY_BYTES, type AppRelay, type RelayCallOutcome } from './relay.js';
import type { ConnectionApp, ConnectionsStore } from './store.js';
import type { FakeAppControl, FakeAppRecord } from './testing/fake-stdio-app.js';
import { testConnectionsStore } from './testing/store.js';

const FAKE_APP = path.join(import.meta.dirname, 'testing', 'fake-stdio-app.ts');
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, 'testing', 'link-1.6.0-tools.json'), 'utf8'),
) as { readonly tools: readonly { readonly name: string; readonly inputSchema: Record<string, unknown> }[] };
const WITHHELD = [
  'auth_login',
  'auth_logout',
  'auth_status',
  'auth_upgrade',
  'demo',
  'onboard',
  'payment-methods_add',
  'serve',
];
const SENTINEL_ONECLI = 'http://sentinel-onecli.invalid:10254';
const SENTINEL_PROVIDER_KEY = 'sentinel-provider-key-Q7r2';
const SENTINEL_STDERR = 'sentinel-child-stderr-Z3v8';

function linkEntry(): HostCliEntry {
  const entry = catalogEntry('link');
  if (!entry || !isHostCliEntry(entry)) throw new Error('Link must be a host-run catalog entry');
  return entry;
}

const CHILD_ENV_KEYS = [
  'HOME',
  'LANG',
  'LINK_AUTH_FILE',
  'LINK_HTTP_PROXY',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NODE_USE_ENV_PROXY',
  'PATH',
  // The SDK's fixed defaults.
  'LOGNAME',
  'SHELL',
  'TERM',
  'USER',
  // macOS gives every process its text-encoding hint.
  '__CF_USER_TEXT_ENCODING',
];
const savedEnv = { ...process.env };

// Receipts accept only canonical paths, and the temporary directory may sit behind a link.
let BASE: string;
let CONNECTIONS: string;
let WORK_DIR: string;
let POLICY_FILE: string;

let store: ConnectionsStore;
let session: Session;
const relays: AppRelay[] = [];

function writePolicy(installationDir: string): void {
  fs.writeFileSync(
    POLICY_FILE,
    JSON.stringify({
      schemaVersion: 1,
      link: { enabled: true, versions: { [linkEntry().transport.version]: { installationDir } } },
      shop: null,
    }),
    { mode: 0o600 },
  );
}

/** A package laid out the way a frozen-lockfile install lays out the pinned CLI, running the fake app. */
async function fakeInstall(): Promise<{ readonly dir: string; readonly entryFile: string }> {
  const dir = path.join(BASE, 'install');
  const packageDir = path.join(dir, 'node_modules', '@stripe', 'link-cli');
  fs.mkdirSync(path.join(packageDir, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name: '@stripe/link-cli', version: '1.6.0', type: 'module', bin: { 'link-cli': 'dist/cli.js' } }),
  );
  const entryFile = path.join(packageDir, 'dist', 'cli.js');
  fs.writeFileSync(entryFile, `import ${JSON.stringify(pathToFileURL(FAKE_APP).href)};\n`);
  const undiciDir = path.join(dir, 'node_modules', 'undici');
  fs.mkdirSync(undiciDir, { recursive: true });
  fs.writeFileSync(path.join(undiciDir, 'package.json'), JSON.stringify({ name: 'undici', version: '7.30.2' }));
  fs.writeFileSync(path.join(undiciDir, 'index.js'), 'module.exports = {};\n');
  await recordHostCliReceipt(dir, linkEntry().transport);
  return { dir, entryFile };
}

function control(value: FakeAppControl): void {
  fs.mkdirSync(WORK_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(WORK_DIR, 'fake-app.json'), JSON.stringify(value));
}

function records(): FakeAppRecord[] {
  const file = path.join(WORK_DIR, 'fake-app.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeAppRecord);
}

function starts(): Extract<FakeAppRecord, { kind: 'start' }>[] {
  return records().filter((entry): entry is Extract<FakeAppRecord, { kind: 'start' }> => entry.kind === 'start');
}

function innerCalls(): { readonly meta: string; readonly arguments: unknown }[] {
  return records()
    .filter((entry): entry is Extract<FakeAppRecord, { kind: 'call' }> => entry.kind === 'call')
    .filter((entry) => entry.meta === 'call_read_tool' || entry.meta === 'call_write_tool')
    .map(({ meta, arguments: args }) => ({ meta, arguments: args }));
}

function relayWith(options: { readonly timeoutMs?: number; readonly hostProcessIdleMs?: number } = {}): AppRelay {
  const relay = createAppRelay({
    store,
    ...options,
    onHoldCall: () => Promise.resolve({ status: 'held', text: 'held' }),
  });
  relays.push(relay);
  return relay;
}

async function connectLink(): Promise<ConnectionApp> {
  const created = await store.create({ name: 'Link', transport: 'host_cli', catalogId: 'link' });
  const { app } = await store.connect(created.id, created.version, { kind: 'none' });
  return app;
}

async function pinAndAllow(relay: AppRelay, app: ConnectionApp): Promise<void> {
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
}

function call(
  relay: AppRelay,
  app: ConnectionApp,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<RelayCallOutcome> {
  return relay.callTool({ serverKey: app.serverKey, toolName, args, session, requestId: randomUUID() });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** Asks the proxy to tunnel to a loopback port; a public-only proxy refuses. */
function tunnelAnswer(proxyUrl: string): Promise<string> {
  const { port } = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: Number(port) });
    socket.once('connect', () => socket.write('CONNECT 127.0.0.1:9 HTTP/1.1\r\nHost: 127.0.0.1:9\r\n\r\n'));
    socket.once('data', (data) => {
      resolve(data.toString('utf8').split('\r\n')[0] ?? '');
      socket.destroy();
    });
    socket.once('error', reject);
  });
}

async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeEach(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  BASE = fs.realpathSync(ROOT);
  CONNECTIONS = path.join(BASE, 'connections');
  WORK_DIR = path.join(CONNECTIONS, 'link');
  POLICY_FILE = path.join(BASE, 'catalog.json');
  process.env[CONNECTIONS_ROOT_ENV] = CONNECTIONS;
  process.env[CATALOG_POLICY_FILE_ENV] = POLICY_FILE;
  process.env.ONECLI_URL = SENTINEL_ONECLI;
  process.env.ANTHROPIC_API_KEY = SENTINEL_PROVIDER_KEY;
  ({ store } = testConnectionsStore(CONNECTIONS));
  await runMigrations(await initTestDb());
  await seedMain('UTC');
  session = await mainSession();
});

afterEach(async () => {
  proxyFront.wrap = undefined;
  await Promise.all(relays.splice(0).map((relay) => relay.drain(500)));
  await closeDb();
  for (const key of [CONNECTIONS_ROOT_ENV, CATALOG_POLICY_FILE_ENV, 'ONECLI_URL', 'ANTHROPIC_API_KEY']) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('host-run app receipts', () => {
  it('records the bin entry, its digest and where undici resolves, and accepts the unchanged install', async () => {
    const { dir, entryFile } = await fakeInstall();

    const receipt = JSON.parse(fs.readFileSync(path.join(dir, HOST_CLI_RECEIPT_FILE), 'utf8')) as Record<
      string,
      unknown
    >;

    expect(receipt).toEqual({
      schemaVersion: 1,
      package: '@stripe/link-cli',
      version: '1.6.0',
      entryFile,
      sha256: createHash('sha256').update(fs.readFileSync(entryFile)).digest('hex'),
      undici: path.join(dir, 'node_modules', 'undici', 'index.js'),
    });
    await expect(verifyHostCliReceipt(dir, linkEntry().transport)).resolves.toEqual({ entryFile });
  });
});

describe('host-run apps through the relay', () => {
  it("pins the meta-tool app's inner commands with their recorded schemas, without withheld commands", async () => {
    const { dir } = await fakeInstall();
    writePolicy(dir);
    const app = await connectLink();

    const { tools } = await relayWith().pinApp(app.id);

    const expected = RECORDED.tools.map((tool) => tool.name).filter((name) => !WITHHELD.includes(name));
    expect(tools.map((tool) => tool.name).sort()).toEqual([...expected].sort());
    expect(tools.find((tool) => tool.name === 'ucp_checkout_complete')?.definition.inputSchema).toEqual(
      RECORDED.tools.find((tool) => tool.name === 'ucp_checkout_complete')?.inputSchema,
    );
  });

  it('offers no argument the host refuses, and only a shared payment token as the credential type', async () => {
    const { dir } = await fakeInstall();
    writePolicy(dir);
    const app = await connectLink();

    const { tools } = await relayWith().pinApp(app.id);

    const refused = ['approve', 'approvalDetail', 'useApprovalPolicy', 'outputFile', 'force', 'include'];
    for (const { name, definition } of tools) {
      const properties = Object.keys((definition.inputSchema.properties ?? {}) as Record<string, unknown>);
      const required = (definition.inputSchema.required ?? []) as string[];
      expect({ name, offered: properties.filter((key) => refused.includes(key)) }).toEqual({ name, offered: [] });
      expect(required.every((key) => properties.includes(key))).toBe(true);
    }
    const create = tools.find((tool) => tool.name === 'spend-request_create')?.definition.inputSchema;
    expect(create?.properties).toMatchObject({
      credentialType: { type: 'string', enum: ['shared_payment_token'] },
      amount: { type: 'integer' },
    });
    expect((create?.properties as Record<string, Record<string, unknown>>).credentialType).not.toHaveProperty(
      'default',
    );
    expect(create?.required).toContain('credentialType');
  });

  it('tells main on each tool Link approves itself to mention it once and not ask again, and never names the placeholder host', async () => {
    const { dir } = await fakeInstall();
    writePolicy(dir);
    const app = await connectLink();
    const relay = relayWith();
    await pinAndAllow(relay, app);

    const listed = await relay.listToolsForSession(app.serverKey);

    const description = (name: string): string | undefined =>
      listed.tools.find((tool) => tool.name === name)?.description;
    expect(description('spend-request_create')).toContain(
      'Link asks the principal to approve this itself; tell them once what is waiting',
    );
    expect(description('spend-request_list')).not.toContain('asks the principal to approve this itself');
    expect(JSON.stringify(listed)).not.toContain('host-cli.invalid');
  });

  it('sends an allowed spend request to Link and nothing for a call with a refused argument', async () => {
    const { dir } = await fakeInstall();
    writePolicy(dir);
    const app = await connectLink();
    const relay = relayWith();
    await pinAndAllow(relay, app);
    const allowed = { credentialType: 'shared_payment_token', amount: 1200, context: 'Lunch for Juno Hale' };

    const refused = await call(relay, app, 'spend-request_retrieve', { id: 'lsrq_123', include: ['card'] });
    const created = await call(relay, app, 'spend-request_create', allowed);

    expect(refused).toMatchObject({ status: 'unsent', reason: 'refused_argument' });
    expect(created.status).toBe('completed');
    expect(innerCalls()).toEqual([
      { meta: 'call_write_tool', arguments: { name: 'spend-request_create', arguments: allowed } },
    ]);
  });

  it('sends a command without readOnlyHint through call_write_tool and a read-only one through call_read_tool', async () => {
    const { dir } = await fakeInstall();
    writePolicy(dir);
    control({ readOnly: ['spend-request_list'] });
    const app = await connectLink();
    const relay = relayWith();
    await pinAndAllow(relay, app);

    const created = await call(relay, app, 'spend-request_create', {
      credentialType: 'shared_payment_token',
      amount: 1200,
      context: 'Lunch for Juno Hale',
    });
    const listed = await call(relay, app, 'spend-request_list', { includeHistory: false });

    expect(created).toMatchObject({
      status: 'completed',
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              tool: 'spend-request_create',
              arguments: { credentialType: 'shared_payment_token', amount: 1200, context: 'Lunch for Juno Hale' },
            }),
          },
        ],
      },
    });
    expect(listed.status).toBe('completed');
    expect(innerCalls()).toEqual([
      {
        meta: 'call_write_tool',
        arguments: {
          name: 'spend-request_create',
          arguments: { credentialType: 'shared_payment_token', amount: 1200, context: 'Lunch for Juno Hale' },
        },
      },
      { meta: 'call_read_tool', arguments: { name: 'spend-request_list', arguments: { includeHistory: false } } },
    ]);
  });

  it('gives the child only its own directory, auth file and public-only proxy, and no host secret', async () => {
    const { dir } = await fakeInstall();
    writePolicy(dir);
    control({});
    const app = await connectLink();

    await relayWith().pinApp(app.id);

    const [start] = starts();
    if (!start) throw new Error('The app never started');
    expect(start.cwd).toBe(WORK_DIR);
    expect(start.env.HOME).toBe(WORK_DIR);
    expect(start.env.LINK_AUTH_FILE).toBe(path.join(WORK_DIR, 'auth.json'));
    expect(start.env.LINK_HTTP_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(start.env.HTTPS_PROXY).toBe(start.env.LINK_HTTP_PROXY);
    expect(start.env.HTTP_PROXY).toBe(start.env.LINK_HTTP_PROXY);
    expect(start.env.NODE_USE_ENV_PROXY).toBe('1');
    expect(start.env.NO_PROXY).toBeUndefined();
    expect(Object.keys(start.env).filter((key) => !CHILD_ENV_KEYS.includes(key))).toEqual([]);
    expect(JSON.stringify(start.env)).not.toContain(SENTINEL_PROVIDER_KEY);
    expect(JSON.stringify(start.env)).not.toContain(SENTINEL_ONECLI);
    expect(await tunnelAnswer(start.env.LINK_HTTP_PROXY ?? '')).toBe('HTTP/1.1 403 Forbidden');
  });

  it('discards the child stderr, so nothing it prints reaches a log', async () => {
    const { dir } = await fakeInstall();
    writePolicy(dir);
    control({ stderrText: SENTINEL_STDERR });
    const app = await connectLink();

    await relayWith().pinApp(app.id);

    expect(starts()[0]?.stderrIsNull).toBe(true);
    expect(JSON.stringify(Object.values(logged).map((fn) => fn.mock.calls))).not.toContain(SENTINEL_STDERR);
  });

  it('settles a call the child never answers as unknown after the timeout, and closes that child', async () => {
    const { dir } = await fakeInstall();
    writePolicy(dir);
    control({ hang: ['balances_list'] });
    const app = await connectLink();
    const relay = relayWith({ timeoutMs: 1_000 });
    await pinAndAllow(relay, app);

    const outcome = await call(relay, app, 'balances_list', { source: 'wallet' });

    expect(outcome.status).toBe('unknown');
    const pid = starts()[0]?.pid ?? 0;
    await eventually(() => !alive(pid));
  });

  it('settles an answer over 4 MiB as too large', async () => {
    const { dir } = await fakeInstall();
    writePolicy(dir);
    control({ largeResult: 'transactions_list', largeResultBytes: RELAY_MAX_BODY_BYTES + 1024 });
    const app = await connectLink();
    const relay = relayWith();
    await pinAndAllow(relay, app);

    const outcome = await call(relay, app, 'transactions_list', { source: 'wallet' });

    expect(outcome.status).toBe('too_large');
  });

  it('closes an idle child and its proxy, and spawns a fresh one for the next call', async () => {
    const { dir } = await fakeInstall();
    writePolicy(dir);
    control({});
    const app = await connectLink();
    const relay = relayWith({ hostProcessIdleMs: 300 });
    await pinAndAllow(relay, app);
    const [first] = starts();
    if (!first) throw new Error('The app never started');
    const proxyPort = Number(new URL(first.env.LINK_HTTP_PROXY ?? '').port);

    await eventually(async () => !alive(first.pid) && !(await accepts(proxyPort)));
    const outcome = await call(relay, app, 'user-info_retrieve');

    expect(outcome.status).toBe('completed');
    const pids = starts().map((start) => start.pid);
    expect(pids).toHaveLength(2);
    expect(pids[1]).not.toBe(first.pid);
  });

  it('closes the child and its proxy when the relay drains at shutdown', async () => {
    const { dir } = await fakeInstall();
    writePolicy(dir);
    control({});
    const app = await connectLink();
    const relay = relayWith();
    await relay.pinApp(app.id);
    const [start] = starts();
    if (!start) throw new Error('The app never started');

    await relay.drain(500);

    expect(alive(start.pid)).toBe(false);
    expect(await accepts(Number(new URL(start.env.LINK_HTTP_PROXY ?? '').port))).toBe(false);
  });

  it('finishes an explicit close only after the proxy is closed and the close is reported', async () => {
    const { dir } = await fakeInstall();
    writePolicy(dir);
    control({});
    // A proxy that takes a moment to close, so the child's exit is still cleaning up when the explicit close arrives.
    proxyFront.wrap = (proxy) =>
      Promise.resolve({
        ...proxy,
        close: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          await proxy.close();
        },
      });
    const transport = new HostProcessTransport(await resolveHostCliLaunch(linkEntry()));
    let reported = 0;
    transport.onclose = () => {
      reported += 1;
    };
    await transport.start();
    await eventually(() => starts().length === 1);
    const [start] = starts();
    if (!start) throw new Error('The app never started');
    const proxyPort = Number(new URL(start.env.LINK_HTTP_PROXY ?? '').port);

    await transport.close();

    expect(reported).toBe(1);
    expect(alive(start.pid)).toBe(false);
    expect(await accepts(proxyPort)).toBe(false);
  });

  it.each([
    [
      'a changed entry file',
      (dir: string) => fs.appendFileSync(path.join(dir, 'node_modules/@stripe/link-cli/dist/cli.js'), '\n'),
    ],
    ['a missing undici', (dir: string) => fs.rmSync(path.join(dir, 'node_modules/undici'), { recursive: true })],
  ])('refuses to spawn after %s and settles the call unsent, writing nothing to a child', async (_case, tamper) => {
    const { dir } = await fakeInstall();
    writePolicy(dir);
    control({});
    const app = await connectLink();
    const relay = relayWith();
    await pinAndAllow(relay, app);
    await relay.closeApp(app.id);
    const before = records().length;

    tamper(dir);
    const outcome = await call(relay, app, 'user-info_retrieve');

    expect(outcome).toMatchObject({ status: 'unsent', reason: 'app_unavailable' });
    expect(records()).toHaveLength(before);
    await expect(relay.pinApp(app.id)).rejects.toEqual(new HostCliUnavailableError('invalid_install'));
  });

  it('refuses to spawn on a host Node that ignores NODE_USE_ENV_PROXY, so no request can go direct', async () => {
    const { dir } = await fakeInstall();
    writePolicy(dir);
    control({});
    const app = await connectLink();
    const relay = relayWith();
    await pinAndAllow(relay, app);
    await relay.closeApp(app.id);
    const before = records().length;
    const actual = process.versions.node;

    Object.defineProperty(process.versions, 'node', { value: '23.11.1' });
    try {
      const outcome = await call(relay, app, 'user-info_retrieve');

      expect(outcome).toMatchObject({ status: 'unsent', reason: 'app_unavailable' });
      expect(records()).toHaveLength(before);
      await expect(relay.pinApp(app.id)).rejects.toEqual(new HostCliUnavailableError('unsupported_runtime'));
    } finally {
      Object.defineProperty(process.versions, 'node', { value: actual });
    }
  });
});

/**
 * Against the real pinned CLI, installed from the committed lockfile with
 * `pnpm install --frozen-lockfile --ignore-scripts --prod`; point GWS_EA_LINK_CLI_TEST_INSTALL at that directory.
 * No sign-in: the auth file holds placeholder tokens and every destination is a loopback listener.
 */
const linkInstall = process.env.GWS_EA_LINK_CLI_TEST_INSTALL;

describe.skipIf(!linkInstall)('the real pinned Link CLI', { timeout: 60_000 }, () => {
  const run = promisify(execFile);

  interface Listener {
    readonly url: string;
    readonly authority: string;
    readonly hits: string[];
    /** TCP connections accepted, whether or not any bytes arrived. */
    connections(): number;
    close(): Promise<void>;
  }

  async function listener(): Promise<Listener> {
    const hits: string[] = [];
    let accepted = 0;
    const server = net.createServer((socket) => {
      accepted += 1;
      socket.once('data', (data) => hits.push(data.toString('utf8').split('\r\n')[0] ?? ''));
      socket.end(
        'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      authority: `127.0.0.1:${port}`,
      hits,
      connections: () => accepted,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  interface ProxyExchange {
    readonly method: string;
    readonly target: string;
    readonly status: number;
  }

  /**
   * Sits in front of a real public-only proxy and records each request it forwards with the proxy's answer, so a test
   * can tell the proxy's refusal from a failure that never reached the network.
   */
  async function recordingFront(proxy: PublicBrowserProxy, exchanges: ProxyExchange[]): Promise<PublicBrowserProxy> {
    const sockets = new Set<net.Socket>();
    const track = (socket: net.Socket): void => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    };
    const server = http.createServer((request, response) => {
      const forwarded = http.request({
        host: '127.0.0.1',
        port: proxy.port,
        method: request.method,
        path: request.url,
        headers: request.headers,
      });
      forwarded.on('response', (reply) => {
        exchanges.push({ method: request.method ?? '', target: request.url ?? '', status: reply.statusCode ?? 0 });
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      });
      forwarded.on('error', () => response.destroy());
      request.pipe(forwarded);
    });
    server.on('connection', track);
    server.on('connect', (request: http.IncomingMessage, client: net.Socket, head: Buffer) => {
      const target = request.url ?? '';
      const forwarded = http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: target });
      forwarded.on('connect', (reply: http.IncomingMessage, upstream: net.Socket, upstreamHead: Buffer) => {
        track(upstream);
        exchanges.push({ method: 'CONNECT', target, status: reply.statusCode ?? 0 });
        if (reply.statusCode !== 200) {
          client.end(`HTTP/1.1 ${reply.statusCode ?? 502} ${reply.statusMessage ?? ''}\r\nConnection: close\r\n\r\n`);
          upstream.destroy();
          return;
        }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (upstreamHead.length) client.write(upstreamHead);
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
      });
      forwarded.on('error', () => client.destroy());
      forwarded.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    return {
      port,
      url: `http://127.0.0.1:${port}`,
      async close() {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          for (const socket of sockets) socket.destroy();
        });
        await proxy.close();
      },
    };
  }

  function recordProxies(): ProxyExchange[] {
    const exchanges: ProxyExchange[] = [];
    proxyFront.wrap = (proxy) => recordingFront(proxy, exchanges);
    return exchanges;
  }

  function authFile(home: string, expiresAt: number): string {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const file = path.join(home, 'auth.json');
    const auth = {
      access_token: 'placeholder-access',
      refresh_token: 'placeholder-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
      expires_at: expiresAt,
    };
    fs.writeFileSync(file, JSON.stringify({ auth, pendingDeviceAuth: null }), { mode: 0o600 });
    return file;
  }

  async function verifiedEntry(): Promise<string> {
    if (!linkInstall) throw new Error('Set GWS_EA_LINK_CLI_TEST_INSTALL to the frozen-lockfile install.');
    await recordHostCliReceipt(linkInstall, linkEntry().transport);
    return (await verifyHostCliReceipt(linkInstall, linkEntry().transport)).entryFile;
  }

  it('pins the recorded listing and sends mpp_pay through the proxy, which refuses a loopback target', async () => {
    await verifiedEntry();
    writePolicy(linkInstall ?? '');
    authFile(WORK_DIR, Date.now() + 3_600_000);
    const exchanges = recordProxies();
    const target = await listener();
    try {
      const app = await connectLink();
      const relay = relayWith();
      await pinAndAllow(relay, app);
      const pinned = (await store.readAppTools(app.id))?.tools ?? [];
      expect(pinned.map((tool) => tool.name).sort()).toEqual(
        RECORDED.tools
          .map((tool) => tool.name)
          .filter((name) => !WITHHELD.includes(name))
          .sort(),
      );

      // The host takes only https addresses for mpp_pay; a direct dial would still reach the listener with a TLS hello.
      const outcome = await call(relay, app, 'mpp_pay', {
        url: `${target.url.replace(/^http:/u, 'https:')}/pay`,
        header: [],
        test: false,
      });

      expect(outcome).toMatchObject({ status: 'completed', result: { isError: true } });
      expect(exchanges).toContainEqual({ method: 'CONNECT', target: target.authority, status: 403 });
      expect(target.connections()).toBe(0);
    } finally {
      await target.close();
    }
  });

  it('sends an expired-token refresh through the proxy, which refuses it before the sign-in server', async () => {
    const entryFile = await verifiedEntry();
    const exchanges = recordProxies();
    const proxy = await startPublicBrowserProxy();
    const signIn = await listener();
    try {
      const home = path.join(BASE, 'refresh');
      const file = authFile(home, Date.now() - 120_000);
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [entryFile, '--mcp'],
        cwd: home,
        env: {
          ...hostCliEnvironment({ workDir: home, authFile: file, proxyUrl: proxy.url }),
          LINK_AUTH_BASE_URL: signIn.url,
          LINK_API_BASE_URL: signIn.url,
        },
        stderr: 'ignore',
      });
      const client = new Client({ name: 'egress-check', version: '1.0.0' });
      let result: Awaited<ReturnType<Client['callTool']>>;
      try {
        await client.connect(transport);
        result = await client.callTool({
          name: 'call_write_tool',
          arguments: { name: 'user-info_retrieve', arguments: {} },
        });
      } finally {
        await client.close();
      }

      // Node's env proxy tunnels plain-http requests too, so the refresh reaches the proxy as a CONNECT.
      expect(result).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: `Request failed: POST ${signIn.url}/device/token` }],
      });
      expect(exchanges).toContainEqual({ method: 'CONNECT', target: signIn.authority, status: 403 });
      expect(signIn.connections()).toBe(0);
    } finally {
      await signIn.close();
      await proxy.close();
    }
  });

  it("sends the sign-in status check's registry lookup through the proxy", async () => {
    const entryFile = await verifiedEntry();
    const proxy = await startPublicBrowserProxy();
    const registry = await listener();
    const home = path.join(BASE, 'status');
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const status = (env: Record<string, string>) =>
      run(process.execPath, [entryFile, 'auth', 'status', '--format', 'json'], {
        cwd: home,
        env: { ...env, npm_config_registry: `${registry.url}/` },
      });
    try {
      const environment = hostCliEnvironment({
        workDir: home,
        authFile: path.join(home, 'auth.json'),
        proxyUrl: proxy.url,
      });
      const { PATH, HOME, LANG, LINK_AUTH_FILE } = environment;
      await status({ PATH, HOME, LANG, LINK_AUTH_FILE });
      expect(registry.hits).toHaveLength(1);

      const answered = await status(environment);

      expect(JSON.parse(answered.stdout)).toMatchObject([{ authenticated: false }]);
      expect(registry.hits).toHaveLength(1);
    } finally {
      await registry.close();
      await proxy.close();
    }
  });
});
