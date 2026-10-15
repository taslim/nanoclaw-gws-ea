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
    newBrowserCDPSession: async () => ({ send: async () => undefined }),
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
