import type { RequestListener } from 'node:http';

/** Closed origin boundary: only the artifacts mount reaches the supplied feature handler. */
export function createWebHandler(hostname: string, artifacts: RequestListener): RequestListener {
  return (request, response) => {
    const finish = (status: number): void => {
      response.writeHead(status, {
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      });
      response.end();
    };
    if (request.headers.host !== hostname || !request.url) return finish(404);
    if (request.method !== 'GET' && request.method !== 'HEAD') return finish(405);
    if (!request.url.startsWith('/artifacts/')) return finish(404);
    artifacts(request, response);
  };
}
