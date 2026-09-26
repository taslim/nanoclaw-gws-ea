import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createPublicFetch, publicAnswer, type PublicResolve } from './public-fetch.js';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

interface Seen {
  readonly method: string | undefined;
  readonly host: string | undefined;
  readonly body: string;
}

/** A local HTTP server; `answer` writes each response, and every request is recorded. */
async function server(answer: (request: IncomingMessage, response: ServerResponse) => void) {
  const seen: Seen[] = [];
  const listener = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    request.on('end', () => {
      seen.push({ method: request.method, host: request.headers.host, body });
      answer(request, response);
    });
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => listener.close(() => resolve())));
  return { port: (listener.address() as AddressInfo).port, seen };
}

/** Public DNS that knows one name. */
function publicDns(name: string, address = '127.0.0.1'): PublicResolve {
  return async (hostname) => (hostname === name ? [{ address, family: 4 }] : []);
}

describe('public fetch', () => {
  it('reaches a name through public DNS, keeping the real hostname, and follows no redirect', async () => {
    const { port, seen } = await server((request, response) => {
      if (request.url === '/moved') response.writeHead(302, { location: '/elsewhere' }).end();
      else response.writeHead(401, { 'x-nanoclaw-webhook-id': 'listener-id' }).end('refused');
    });
    const fetch = createPublicFetch(publicDns('callback.test'));

    const response = await fetch(`http://callback.test:${port}/webhook/gchat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('x-nanoclaw-webhook-id')).toBe('listener-id');
    expect(seen).toEqual([{ method: 'POST', host: `callback.test:${port}`, body: '{}' }]);

    const moved = await fetch(`http://callback.test:${port}/moved`);
    expect(moved.status).toBe(302);
    expect(seen).toHaveLength(2);
  });

  it('fails as fetch does: ENOTFOUND when public DNS has no address, a refused connection, TimeoutError when nothing answers', async () => {
    const fetch = createPublicFetch(publicDns('callback.test'));
    await expect(fetch('http://missing.test/webhook/gchat')).rejects.toMatchObject({
      name: 'TypeError',
      cause: { code: 'ENOTFOUND' },
    });

    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port: closedPort } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await expect(fetch(`http://callback.test:${closedPort}/webhook/gchat`)).rejects.toMatchObject({
      name: 'TypeError',
      cause: { code: 'ECONNREFUSED' },
    });

    const { port } = await server(() => undefined);
    await expect(
      fetch(`http://callback.test:${port}/webhook/gchat`, { signal: AbortSignal.timeout(50) }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it("uses this machine's resolver only when public DNS cannot be reached", async () => {
    const { port, seen } = await server((_request, response) => response.writeHead(204).end());
    const fetch = createPublicFetch(async () => undefined);

    await expect(fetch(`http://localhost:${port}/`)).resolves.toMatchObject({ status: 204 });
    expect(seen).toHaveLength(1);
  });

  it('reads public DNS answers: addresses, a name with none, or no answer at all', () => {
    const enodata = Object.assign(new Error('queryAaaa ENODATA'), { code: 'ENODATA' });
    const enotfound = Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' });
    const timeout = Object.assign(new Error('queryA ETIMEOUT'), { code: 'ETIMEOUT' });
    const v4 = [{ address: '104.21.30.26', family: 4 as const }];

    expect(
      publicAnswer([
        { status: 'fulfilled', value: v4 },
        { status: 'rejected', reason: enodata },
      ]),
    ).toEqual(v4);
    expect(
      publicAnswer([
        { status: 'rejected', reason: timeout },
        { status: 'fulfilled', value: v4 },
      ]),
    ).toEqual(v4);
    expect(
      publicAnswer([
        { status: 'rejected', reason: enotfound },
        { status: 'rejected', reason: enodata },
      ]),
    ).toEqual([]);
    expect(
      publicAnswer([
        { status: 'rejected', reason: timeout },
        { status: 'rejected', reason: enodata },
      ]),
    ).toBeUndefined();
  });
});
