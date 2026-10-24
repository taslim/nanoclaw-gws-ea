import { createHash } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createArtifactViewHandler, type ArtifactViewRoute } from './server.js';

const id = '12345678-1234-4321-8321-123456789abc';
const html = '<!doctype html><h1>Selected revision</h1>';
const sourceHash = createHash('sha256').update(html).digest('hex');
let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
});
async function fixture(selectedHash = sourceHash) {
  let authorized = true;
  const routes: ArtifactViewRoute[] = [];
  server = createServer(
    createArtifactViewHandler({
      hostname: 'artifact.test',
      pathPrefix: '/alex',
      resolve: async (_request, route) => {
        routes.push(route);
        return authorized ? { title: 'Revision title', html, sourceHash: selectedHash } : undefined;
      },
    }),
  );
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server port.');
  return {
    request: (path: string, method = 'GET', host = 'artifact.test') =>
      new Promise<Response>((resolve, reject) => {
        const request = httpRequest(
          { hostname: '127.0.0.1', port: address.port, path, method, headers: { host } },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () =>
              resolve(
                new Response(method === 'HEAD' ? null : Buffer.concat(chunks), {
                  status: response.statusCode,
                  headers: Object.fromEntries(
                    Object.entries(response.headers).flatMap(([name, value]) =>
                      value === undefined ? [] : [[name, Array.isArray(value) ? value.join(',') : value]],
                    ),
                  ),
                }),
              ),
            );
          },
        );
        request.on('error', reject);
        request.end();
      }),
    revoke: () => {
      authorized = false;
    },
    routes,
  };
}
describe('view-only artifact origin', () => {
  it('reauthorizes each selected wrapper and hash-pinned child, including HEAD and revocation', async () => {
    const { request, revoke, routes } = await fixture();
    for (const route of [`/alex/${id}`, `/alex/share/${id}`, `/alex/public/${id}`]) {
      const wrapper = await request(route);
      expect(wrapper.status).toBe(200);
      expect(wrapper.headers.get('cache-control')).toBe('no-store');
      expect(await wrapper.text()).toContain(`${route}/frame/${sourceHash}`);
      const child = await request(`${route}/frame/${sourceHash}`);
      expect(child.status).toBe(200);
      // A script-free revision runs no script at all, so no connection allowlist is needed (or sent).
      expect(child.headers.get('content-security-policy')).toContain("script-src 'none'");
      expect(child.headers.get('connection-allowlist')).toBeNull();
      const head = await request(route, 'HEAD');
      expect(head.status).toBe(200);
      expect(await head.text()).toBe('');
      expect(head.headers.get('cache-control')).toBe('no-store');
    }
    expect(routes.map((route) => route.audience)).toContain('share');
    expect((await request(`/alex/${id}/frame/${'a'.repeat(64)}`)).status).toBe(404);
    revoke();
    expect((await request(`/alex/${id}/frame/${sourceHash}`)).status).toBe(404);
  });
  it('rejects host, prefix, method, query, source/history and encoded aliases before resolving', async () => {
    const { request, routes } = await fixture();
    for (const route of [
      `/other/${id}`,
      `/alex/${id}?revision=1`,
      `/alex/${id}/source`,
      `/alex/${id}/history`,
      `/alex/%31${id.slice(1)}`,
      `/alex/${id}/frame/${sourceHash}/`,
    ]) {
      expect((await request(route)).status).toBe(404);
    }
    expect((await request(`/alex/${id}`, 'GET', 'other.test')).status).toBe(404);
    expect((await request(`/alex/${id}`, 'POST')).status).toBe(405);
    expect(routes).toHaveLength(0);
  });
  it('refuses corrupt content whose stored source hash no longer matches', async () => {
    const { request } = await fixture('f'.repeat(64));
    const response = await request(`/alex/${id}`);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('');
  });
});
