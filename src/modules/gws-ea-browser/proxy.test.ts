import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { startPublicBrowserProxy, type PublicBrowserProxy } from './proxy.js';

const dnsBoundary = vi.hoisted(() => ({
  lookup:
    vi.fn<
      (hostname: string, options: { all: true; verbatim: true }) => Promise<{ address: string; family: number }[]>
    >(),
}));
vi.mock('node:dns/promises', async () => {
  const actual = await vi.importActual<typeof import('node:dns/promises')>('node:dns/promises');
  return { ...actual, default: { ...actual, lookup: dnsBoundary.lookup } };
});

const proxies: PublicBrowserProxy[] = [];
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  vi.restoreAllMocks();
  dnsBoundary.lookup.mockReset();
});

async function proxy(): Promise<PublicBrowserProxy> {
  const value = await startPublicBrowserProxy();
  proxies.push(value);
  return value;
}

async function get(port: number, url: string, agent?: http.Agent): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: url, agent }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    request.on('error', reject);
    request.end();
  });
}

async function tunnel(port: number, target: string): Promise<string> {
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  let response = '';
  for await (const chunk of socket) response += String(chunk);
  return response;
}

describe('public-only browser proxy', () => {
  const literals = ['127.0.0.1', '[::1]', '2130706433', '8.8.8.8', '[2001:4860:4860::8888]'];
  it.each(literals)('refuses literal %s in CONNECT and absolute HTTP without DNS', async (host) => {
    const lookup = dnsBoundary.lookup;
    const running = await proxy();
    expect(await tunnel(running.port, `${host}:443`)).toMatch(/^HTTP\/1\.1 403/);
    expect(await get(running.port, `http://${host}/`)).toBe(403);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    '127.0.0.1',
    '10.0.0.4',
    '172.18.0.1',
    '192.168.1.2',
    '100.64.0.1',
    'fc00::1',
    'fe80::1',
    '::192.168.1.2',
    '169.254.169.254',
    '192.168.65.254',
    '::ffff:8.8.8.8',
    '2002:0808:0808::1',
    '2001:0000::1',
  ])('refuses DNS resolving to %s on both protocols', async (address) => {
    dnsBoundary.lookup.mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }]);
    const running = await proxy();
    expect(await tunnel(running.port, 'public.example:443')).toMatch(/^HTTP\/1\.1 403/);
    expect(await get(running.port, 'http://public.example/')).toBe(403);
  });

  it('refuses a mixed public/private DNS answer and forbidden ports', async () => {
    const lookup = dnsBoundary.lookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]);
    const running = await proxy();
    expect(await tunnel(running.port, 'mixed.example:443')).toMatch(/^HTTP\/1\.1 403/);
    expect(await get(running.port, 'http://mixed.example/')).toBe(403);
    lookup.mockClear();
    expect(await tunnel(running.port, 'public.example:8443')).toMatch(/^HTTP\/1\.1 403/);
    expect(await get(running.port, 'http://public.example:8080/')).toBe(403);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('revalidates every request on the same keep-alive connection', async () => {
    const lookup = dnsBoundary.lookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    const running = await proxy();
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      expect(await get(running.port, 'http://first.example/', agent)).toBe(403);
      expect(await get(running.port, 'http://second.example/', agent)).toBe(403);
      expect(lookup.mock.calls.map(([host]) => host)).toEqual(['first.example', 'second.example']);
      expect(Object.values(agent.freeSockets).flat()).toHaveLength(1);
    } finally {
      agent.destroy();
    }
  });

  it('connects to the validated public IP without looking the name up again', async () => {
    const local = net.createServer((socket) => socket.on('data', () => socket.end('target-reached')));
    local.listen(0, '127.0.0.1');
    await once(local, 'listening');
    const address = local.address();
    if (address === null || typeof address === 'string') throw new Error('Missing test listener');
    const lookup = dnsBoundary.lookup
      .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const dial = vi.spyOn(net, 'createConnection').mockImplementation(() => net.connect(address.port, '127.0.0.1'));
    try {
      const running = await proxy();
      const socket = net.connect(running.port, '127.0.0.1');
      await once(socket, 'connect');
      socket.write('CONNECT public.example:443 HTTP/1.1\r\nHost: public.example:443\r\n\r\n');
      let reply = '';
      let sent = false;
      for await (const chunk of socket) {
        reply += String(chunk);
        if (!sent && reply.includes('200 Connection Established')) {
          sent = true;
          socket.write('probe');
        }
      }
      expect(reply).toContain('target-reached');
      expect(dial).toHaveBeenCalledWith(expect.objectContaining({ host: '8.8.8.8', port: 443, family: 4 }));
      expect(lookup).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) => local.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
