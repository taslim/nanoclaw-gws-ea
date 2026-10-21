import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, type Browser, type ConnectOverCDPTransport } from 'playwright-core';
import { afterEach, expect, it, vi } from 'vitest';

import { connectChromePipe } from './connection.js';
import { browserPaths } from './paths.js';
import * as authentication from './authentication-submit.js';

afterEach(() => vi.restoreAllMocks());

it('lets a client install listeners after a reply before delivering a coalesced context event', async () => {
  vi.spyOn(authentication, 'prepareAuthenticationIsolation').mockResolvedValue();
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdio: [null, null, null, outbound, inbound],
    kill: vi.fn(),
    exitCode: 0,
    signalCode: null,
  }) as unknown as ChildProcess;
  const seen: boolean[] = [];
  const browser = {
    contexts: () => [{}],
    newBrowserCDPSession: async () => ({ on: () => undefined, send: async () => undefined }),
    once: () => undefined,
    close: async () => undefined,
  } as unknown as Browser;
  vi.spyOn(chromium, 'connectOverCDP').mockImplementation(async (input) => {
    if (typeof input !== 'object' || !('send' in input) || !('close' in input))
      throw new Error('This client requires the owned pipe transport');
    const transport = input as ConnectOverCDPTransport;
    let reply!: () => void;
    let event!: () => void;
    let listenerInstalled = false;
    const initialized = new Promise<void>((resolve) => {
      reply = resolve;
    }).then(() => {
      listenerInstalled = true;
    });
    const received = new Promise<void>((resolve) => {
      event = resolve;
    });
    transport.onmessage = (message) => {
      if ('id' in message) reply();
      else {
        seen.push(listenerInstalled);
        event();
      }
    };
    // A pipe chunk may contain both the initialization response and the
    // execution context event whose listener that response installs.
    inbound.write('{"id":1,"result":{}}\0{"method":"Runtime.executionContextCreated","params":{}}\0');
    await Promise.all([initialized, received]);
    return browser;
  });
  const connected = await connectChromePipe(child, browserPaths(join(tmpdir(), 'browser-wire-fixture/policy.json')));
  try {
    expect(seen).toEqual([true]);
  } finally {
    await connected.close();
    inbound.destroy();
    outbound.destroy();
  }
});

it('waits for owned Chrome exit after a close reply and pipe loss without killing its profile flush', async () => {
  vi.spyOn(authentication, 'prepareAuthenticationIsolation').mockResolvedValue();
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdio: [null, null, null, outbound, inbound],
    kill: vi.fn(),
    exitCode: null,
    signalCode: null,
  });
  let transport: ConnectOverCDPTransport | undefined;
  const send = vi.fn(async () => undefined);
  const disconnect = vi.fn(async () => {
    transport?.close();
  });
  const browser = {
    contexts: () => [{}],
    newBrowserCDPSession: async () => ({ on: () => undefined, send }),
    once: () => undefined,
    close: disconnect,
  } as unknown as Browser;
  vi.spyOn(chromium, 'connectOverCDP').mockImplementation(async (input) => {
    if (typeof input !== 'object' || !('send' in input) || !('close' in input)) throw new Error('Owned pipe required');
    transport = input as ConnectOverCDPTransport;
    return browser;
  });
  const connected = await connectChromePipe(
    child as unknown as ChildProcess,
    browserPaths(join(tmpdir(), 'browser-graceful-fixture/policy.json')),
  );
  const closing = connected.close();
  await Promise.resolve();
  expect(send).toHaveBeenCalledWith('Browser.close');
  inbound.emit('error', new Error('Chrome closed its pipe before exiting'));
  expect(child.kill).not.toHaveBeenCalled();
  expect(disconnect).not.toHaveBeenCalled();
  Object.assign(child, { exitCode: 0 });
  child.emit('exit', 0, null);
  await closing;
  expect(child.kill).not.toHaveBeenCalled();
  expect(disconnect).toHaveBeenCalledOnce();
  await connected.close();
  expect(disconnect).toHaveBeenCalledOnce();
  inbound.destroy();
  outbound.destroy();
});

it('forces an unresponsive owned child to exit before waiting for the CDP client to disconnect', async () => {
  vi.spyOn(authentication, 'prepareAuthenticationIsolation').mockResolvedValue();
  vi.useFakeTimers();
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdio: [null, null, null, outbound, inbound],
    pid: 12345,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn((signal: NodeJS.Signals) => {
      child.signalCode = signal;
      child.emit('exit', null, signal);
      return true;
    }),
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  let transport: ConnectOverCDPTransport | undefined;
  const send = vi.fn((method: string) =>
    method === 'Browser.close' ? new Promise<never>(() => undefined) : Promise.resolve(undefined),
  );
  const disconnect = vi.fn(async () => {
    transport?.close();
    await exited;
  });
  const browser = {
    contexts: () => [{}],
    newBrowserCDPSession: async () => ({ on: () => undefined, send }),
    once: () => undefined,
    close: disconnect,
  } as unknown as Browser;
  vi.spyOn(chromium, 'connectOverCDP').mockImplementation(async (input) => {
    if (typeof input !== 'object' || !('send' in input) || !('close' in input)) throw new Error('Owned pipe required');
    transport = input as ConnectOverCDPTransport;
    return browser;
  });
  const connected = await connectChromePipe(
    child as unknown as ChildProcess,
    browserPaths(join(tmpdir(), 'browser-stalled-fixture/policy.json')),
  );
  const closing = connected.close();
  try {
    await vi.advanceTimersByTimeAsync(1_999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await closing;
    await connected.close();
    expect(child.kill).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  } finally {
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await closing;
    vi.useRealTimers();
    inbound.destroy();
    outbound.destroy();
  }
});
