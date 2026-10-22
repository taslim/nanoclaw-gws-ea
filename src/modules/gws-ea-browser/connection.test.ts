import { EventEmitter, once } from 'node:events';
import net from 'node:net';
import type { ChildProcess, ExecFileException } from 'node:child_process';
import http, { type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connectChrome } from './connection.js';
import { stopChrome } from './chrome.js';
import { browserPaths } from './paths.js';
import * as authentication from './authentication-submit.js';
import * as documents from './document-gate.js';

const { lsof } = vi.hoisted(() => ({ lsof: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: lsof,
}));

const paths = browserPaths(join(tmpdir(), 'browser-connection-fixture/policy.json'));
const port = 45679;
const pid = 12345;
const endpoint = `ws://127.0.0.1:${port}/devtools/browser/fixture-browser`;
let discovery: { status: number; body: string };
let requests: RequestOptions[];

function childFixture() {
  const child = Object.assign(new EventEmitter(), {
    pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn((signal: NodeJS.Signals) => {
      child.signalCode = signal;
      child.emit('exit', null, signal);
      return true;
    }),
  });
  return { child, owned: { child: child as unknown as ChildProcess, debuggerPort: port } };
}

function browserFixture() {
  const send = vi.fn(async (_method: string, _params?: unknown): Promise<unknown> => undefined);
  const disconnect = vi.fn(async () => undefined);
  const context = {} as BrowserContext;
  const browser = {
    contexts: () => [context],
    newBrowserCDPSession: async () => ({ send }),
    close: disconnect,
  } as unknown as Browser;
  return { browser, send, disconnect };
}

function listen(output = `p${pid}\nf12\nn127.0.0.1:${port}\n`, error: ExecFileException | null = null, stderr = '') {
  lsof.mockImplementation(
    (
      _command: string,
      args: string[],
      _options: unknown,
      callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
    ) => {
      const fields = args.find((arg) => arg.startsWith('-F'))?.slice(2);
      callback(error, fields?.includes('f') ? output : output.replace(/^f[^\n]*\n/gm, ''), stderr);
    },
  );
}

beforeEach(() => {
  lsof.mockReset();
  listen();
  discovery = { status: 200, body: JSON.stringify({ webSocketDebuggerUrl: endpoint }) };
  requests = [];
  vi.spyOn(authentication, 'prepareAuthenticationIsolation').mockResolvedValue();
  vi.spyOn(documents, 'documentGate').mockResolvedValue({ register: () => () => undefined });
  vi.spyOn(http, 'get').mockImplementation(((
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => {
    requests.push(options);
    const request = new EventEmitter();
    const response = Object.assign(new PassThrough(), { statusCode: discovery.status });
    queueMicrotask(() => {
      callback(response as unknown as IncomingMessage);
      response.end(discovery.body);
    });
    return request as ClientRequest;
  }) as typeof http.get);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('owned loopback Chrome attachment', () => {
  it('verifies ownership before local discovery and again before native attachment, retaining native defaults', async () => {
    const { child, owned } = childFixture();
    const { browser, send } = browserFixture();
    const attach = vi.spyOn(chromium, 'connectOverCDP').mockResolvedValue(browser);
    const connection = await connectChrome(owned, paths);
    expect(requests).toMatchObject([{ hostname: '127.0.0.1', port, path: '/json/version' }]);
    expect(lsof).toHaveBeenCalledTimes(2);
    expect(lsof.mock.calls[0]?.slice(0, 2)).toEqual([
      'lsof',
      ['-w', '-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpfn'],
    ]);
    expect(attach).toHaveBeenCalledExactlyOnceWith(endpoint, { isLocal: true, artifactsDir: paths.artifactsDir });
    expect(connection.debuggerPort).toBe(port);
    expect(send).toHaveBeenCalledWith('Browser.setPermission', {
      permission: { name: 'notifications' },
      setting: 'denied',
    });
    child.exitCode = 0;
    await connection.close();
  });

  it.each([
    ['foreign pid', `p${pid + 1}\nf12\nn127.0.0.1:${port}\n`],
    ['wildcard', `p${pid}\nf12\nn*:${port}\n`],
    ['second foreign listener', `p${pid}\nf12\nn127.0.0.1:${port}\np${pid + 1}\nf13\nn127.0.0.1:${port}\n`],
    ['IPv6 loopback', `p${pid}\nf12\nn[::1]:${port}\n`],
    ['malformed', `p${pid}\nf12\n`],
    ['incomplete second process', `p${pid}\nf12\nn127.0.0.1:${port}\np${pid + 1}\n`],
  ])('refuses %s before discovery and retires only its own child', async (_name, output) => {
    listen(output);
    const { child, owned } = childFixture();
    const attach = vi.spyOn(chromium, 'connectOverCDP');
    await expect(connectChrome(owned, paths)).rejects.toThrow('Chrome connection unavailable');
    expect(requests).toEqual([]);
    expect(attach).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  });

  it.skipIf(!process.env.GWS_EA_BROWSER_TEST_CHROME)(
    'refuses a real foreign listener and leaves that listener alive',
    async () => {
      const native = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      lsof.mockImplementation(native.execFile);
      const foreign = net.createServer((socket) => socket.end());
      await new Promise<void>((resolve, reject) => {
        foreign.once('error', reject);
        foreign.listen(0, '127.0.0.1', resolve);
      });
      const address = foreign.address();
      if (!address || typeof address === 'string') throw new Error('Foreign fixture listener unavailable');
      const child = native.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      try {
        await once(child, 'spawn');
        await expect(connectChrome({ child, debuggerPort: address.port }, paths)).rejects.toThrow(
          'Chrome connection unavailable',
        );
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
        await new Promise<void>((resolve, reject) => {
          const socket = net.connect(address.port, '127.0.0.1');
          socket.once('error', reject);
          socket.once('connect', () => {
            socket.destroy();
            resolve();
          });
        });
        expect(requests).toEqual([]);
      } finally {
        await stopChrome(child);
        await new Promise<void>((resolve, reject) => foreign.close((error) => (error ? reject(error) : resolve())));
      }
    },
  );

  it.each([
    ['missing tool', '', Object.assign(new Error('tool failed: sensitive endpoint'), { code: 'ENOENT' }), ''],
    [
      'failed selection',
      `p${pid}\nf12\nn127.0.0.1:${port}\n`,
      Object.assign(new Error('tool failed'), { code: 2 }),
      '',
    ],
    ['unexpected diagnostic', `p${pid}\nf12\nn127.0.0.1:${port}\n`, null, 'sensitive endpoint'],
  ])('refuses %s without exposing ownership-tool diagnostics', async (_name, output, error, stderr) => {
    listen(output, error, stderr);
    const { owned } = childFixture();
    const failure = await connectChrome(owned, paths).catch((error: unknown) => error);
    expect(failure).toEqual(new Error('Chrome connection unavailable'));
    expect(failure).not.toHaveProperty('cause');
    expect(requests).toEqual([]);
  });

  it('polls only an empty successful ownership selection while the child remains live', async () => {
    const { child, owned } = childFixture();
    const { browser } = browserFixture();
    vi.spyOn(chromium, 'connectOverCDP').mockResolvedValue(browser);
    lsof.mockImplementationOnce(
      (_command, _args, _options, callback: (error: ExecFileException, stdout: string, stderr: string) => void) => {
        callback(Object.assign(new Error('no listeners'), { code: 1 }), '', '');
      },
    );
    const connection = await connectChrome(owned, paths);
    expect(lsof).toHaveBeenCalledTimes(3);
    child.exitCode = 0;
    await connection.close();
  });

  it.each([
    ['redirect', 302, JSON.stringify({ webSocketDebuggerUrl: endpoint })],
    ['invalid JSON', 200, '{'],
    ['missing endpoint', 200, '{}'],
    ['oversized body', 200, 'x'.repeat(65_537)],
    ['foreign host', 200, JSON.stringify({ webSocketDebuggerUrl: endpoint.replace('127.0.0.1', 'localhost') })],
    ['normalized address', 200, JSON.stringify({ webSocketDebuggerUrl: endpoint.replace('127.0.0.1', '2130706433') })],
    ['different port', 200, JSON.stringify({ webSocketDebuggerUrl: endpoint.replace(String(port), String(port + 1)) })],
    ['credentials', 200, JSON.stringify({ webSocketDebuggerUrl: endpoint.replace('ws://', 'ws://user@') })],
    ['query', 200, JSON.stringify({ webSocketDebuggerUrl: `${endpoint}?token=secret` })],
    ['fragment', 200, JSON.stringify({ webSocketDebuggerUrl: `${endpoint}#secret` })],
    ['page target', 200, JSON.stringify({ webSocketDebuggerUrl: endpoint.replace('/browser/', '/page/') })],
  ])('refuses %s discovery without attaching or following a redirect', async (_name, status, body) => {
    discovery = { status, body };
    const { owned } = childFixture();
    const attach = vi.spyOn(chromium, 'connectOverCDP');
    await expect(connectChrome(owned, paths)).rejects.toThrow('Chrome connection unavailable');
    expect(attach).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });

  it('rechecks every listener after discovery instead of attaching to a replaced endpoint', async () => {
    const { owned } = childFixture();
    const attach = vi.spyOn(chromium, 'connectOverCDP');
    lsof.mockImplementationOnce(
      (_command, _args, _options, callback: (error: null, stdout: string, stderr: string) => void) => {
        callback(null, `p${pid}\nf12\nn127.0.0.1:${port}\n`, '');
        listen(`p${pid + 1}\nf12\nn127.0.0.1:${port}\n`);
      },
    );
    await expect(connectChrome(owned, paths)).rejects.toThrow('Chrome connection unavailable');
    expect(attach).not.toHaveBeenCalled();
  });

  it('rejects early child exit without querying or attaching', async () => {
    const { child, owned } = childFixture();
    child.exitCode = 1;
    const attach = vi.spyOn(chromium, 'connectOverCDP');
    await expect(connectChrome(owned, paths)).rejects.toThrow('Chrome connection unavailable');
    expect(lsof).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('retires a timed-out attach and disposes its late result without installing policy', async () => {
    const { child, owned } = childFixture();
    const { browser, disconnect } = browserFixture();
    let resolveAttach!: (browser: Browser) => void;
    let entered!: () => void;
    const attaching = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(chromium, 'connectOverCDP').mockImplementation(() => {
      entered();
      return new Promise<Browser>((resolve) => {
        resolveAttach = resolve;
      });
    });
    const controller = new AbortController();
    const pending = connectChrome(owned, paths, controller.signal);
    const rejection = expect(pending).rejects.toThrow('Chrome connection unavailable');
    await attaching;
    controller.abort();
    await rejection;
    expect(child.kill).toHaveBeenCalledOnce();
    resolveAttach(browser);
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
    expect(authentication.prepareAuthenticationIsolation).not.toHaveBeenCalled();
  });

  it('retires the process before disposing a client when policy setup stalls', async () => {
    const { child, owned } = childFixture();
    const { browser, disconnect } = browserFixture();
    let finishPolicy!: () => void;
    let entered!: () => void;
    const settingUp = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(authentication, 'prepareAuthenticationIsolation').mockImplementation(() => {
      entered();
      return new Promise<void>((resolve) => {
        finishPolicy = resolve;
      });
    });
    disconnect.mockImplementation(() => new Promise<never>(() => undefined));
    vi.spyOn(chromium, 'connectOverCDP').mockResolvedValue(browser);
    const controller = new AbortController();
    const pending = connectChrome(owned, paths, controller.signal);
    const rejection = expect(pending).rejects.toThrow('Chrome connection unavailable');
    await settingUp;
    controller.abort();
    await rejection;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.signalCode).toBe('SIGTERM');
    expect(disconnect).toHaveBeenCalledOnce();
    finishPolicy();
    await Promise.resolve();
    expect(documents.documentGate).not.toHaveBeenCalled();
  });
});

it('waits for owned Chrome exit after a close reply without interrupting its profile flush', async () => {
  const { child, owned } = childFixture();
  const { browser, send, disconnect } = browserFixture();
  vi.spyOn(chromium, 'connectOverCDP').mockResolvedValue(browser);
  const connection = await connectChrome(owned, paths);
  const closing = connection.close();
  await Promise.resolve();
  expect(send).toHaveBeenCalledWith('Browser.close');
  expect(child.kill).not.toHaveBeenCalled();
  expect(disconnect).not.toHaveBeenCalled();
  child.exitCode = 0;
  child.emit('exit', 0, null);
  await closing;
  expect(child.kill).not.toHaveBeenCalled();
  expect(disconnect).toHaveBeenCalledOnce();
  await connection.close();
  expect(disconnect).toHaveBeenCalledOnce();
});

it('forces an unresponsive child to exit even when close reply and client disposal never settle', async () => {
  const { child, owned } = childFixture();
  const { browser, send, disconnect } = browserFixture();
  send.mockImplementation((method) =>
    method === 'Browser.close' ? new Promise<never>(() => undefined) : Promise.resolve(undefined),
  );
  disconnect.mockImplementation(() => new Promise<never>(() => undefined));
  vi.spyOn(chromium, 'connectOverCDP').mockResolvedValue(browser);
  const connection = await connectChrome(owned, paths);
  vi.useFakeTimers();
  const closing = connection.close();
  await vi.advanceTimersByTimeAsync(1_999);
  expect(child.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await closing;
  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  expect(disconnect).toHaveBeenCalledOnce();
  await connection.close();
  expect(child.kill).toHaveBeenCalledOnce();
});
