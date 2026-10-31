import type { RequestListener, ServerResponse } from 'node:http';

export interface WebFeatures<T = RequestListener> {
  readonly artifacts: T;
  readonly logins: T;
}

function finish(response: ServerResponse, status: number): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  });
  response.end();
}

export const unavailableWebHandler: RequestListener = (_request, response) => {
  finish(response, 404);
};

/** The whole hostname serves exactly these two feature mounts. */
export function createWebHandler(hostname: string, features: WebFeatures): RequestListener {
  return (request, response) => {
    if (request.headers.host !== hostname || !request.url) return finish(response, 404);
    const pathname = request.url.split('?', 1)[0];
    const logins = pathname === '/logins' || pathname?.startsWith('/logins/') === true;
    const artifacts = pathname?.startsWith('/artifacts/') === true;
    if (!logins && !artifacts) return finish(response, 404);
    if (request.method !== 'GET' && request.method !== 'HEAD' && !(logins && request.method === 'POST'))
      return finish(response, 405);
    (logins ? features.logins : features.artifacts)(request, response);
  };
}
