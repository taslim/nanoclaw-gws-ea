import { createServer, request as httpRequest, type Server, type RequestListener } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { createWebHandler } from './server.js';

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});
async function fixture() {
  const feature = vi.fn<RequestListener>((_request, response) => {
    response.writeHead(200, { 'cache-control': 'no-store' }).end('artifact');
  });
  server = createServer(createWebHandler('aya.example.com', feature));
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  return {
    feature,
    request: (route: string, method = 'GET', host = 'aya.example.com') =>
      new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>(
        (resolve, reject) => {
          const req = httpRequest(
            { hostname: '127.0.0.1', port: address.port, method, path: route, headers: { host } },
            (res) => {
              let body = '';
              res.on('data', (chunk: Buffer) => {
                body += chunk.toString();
              });
              res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
            },
          );
          req.on('error', reject);
          req.end();
        },
      ),
  };
}
it('keeps root, unrelated and encoded mounts outside the feature boundary with closed response headers', async () => {
  const { feature, request } = await fixture();
  for (const route of ['/', '/artifact', '/artifacts', '/artifactsx', '/other', '/%61rtifacts/id', '//artifacts/id']) {
    const response = await request(route);
    expect(response.status, route).toBe(404);
    expect(response.body).toBe('');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
  }
  expect(feature).not.toHaveBeenCalled();
});
it('requires the exact Host and GET or HEAD before dispatching the fixed mount', async () => {
  const { feature, request } = await fixture();
  for (const host of ['juno.example.com', 'aya.example.com:443', 'aya.example.com.', 'AYA.example.com'])
    expect((await request('/artifacts/id', 'GET', host)).status).toBe(404);
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS'])
    expect((await request('/artifacts/id', method)).status).toBe(405);
  expect(feature).not.toHaveBeenCalled();
  expect((await request('/artifacts/id')).body).toBe('artifact');
  expect((await request('/artifacts/id', 'HEAD')).body).toBe('');
  expect(feature).toHaveBeenCalledTimes(2);
});
