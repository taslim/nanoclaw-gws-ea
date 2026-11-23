import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';

/** Marks a POST whose change was saved, so the client trusts it even when redisplaying the page then failed. */
export const PAGE_SAVED_HEADER = 'x-page-saved';
/** The address of the view a POST answered with; the client puts it in the location bar. */
export const PAGE_LOCATION_HEADER = 'x-page-location';

export function pageNonce(): string {
  return randomBytes(24).toString('base64url');
}

/** Without a nonce the response may run no script or style at all. */
export function pageHeaders(nonce?: string): Readonly<Record<string, string>> {
  return {
    'cache-control': 'no-store',
    'content-type': nonce ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    'content-security-policy': `default-src 'none'; script-src ${nonce ? `'nonce-${nonce}'` : "'none'"}; style-src ${nonce ? `'nonce-${nonce}'` : "'none'"}; font-src data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-dns-prefetch-control': 'off',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  };
}

/** One empty not-found for every refusal, so a refusal reveals nothing about why. */
export function refuse(response: ServerResponse): void {
  response.shouldKeepAlive = false;
  response.writeHead(404, pageHeaders());
  response.end();
}

export function sendUnavailable(response: ServerResponse): void {
  response.writeHead(503, pageHeaders());
  response.end();
}

export function sendJson(response: ServerResponse, status: number, data: Readonly<Record<string, string>>): void {
  response.writeHead(status, { ...pageHeaders(), 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

// The length is explicit so a HEAD answer carries the same headers as its GET.
export function sendPublicJson(
  response: ServerResponse,
  document: Readonly<Record<string, unknown>>,
  options: { readonly head: boolean; readonly maxAgeSeconds: number },
): void {
  const body = JSON.stringify(document);
  response.writeHead(200, {
    ...pageHeaders(),
    'cache-control': `public, max-age=${options.maxAgeSeconds}`,
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  response.end(options.head ? undefined : body);
}

export interface PageResponse {
  readonly status: number;
  readonly nonce: string;
  /** Undefined answers a HEAD request. */
  readonly body: string | undefined;
  readonly location?: string;
  readonly saved?: boolean;
}

export function sendPage(response: ServerResponse, page: PageResponse): void {
  response.writeHead(page.status, {
    ...pageHeaders(page.nonce),
    ...(page.location ? { [PAGE_LOCATION_HEADER]: page.location } : {}),
    ...(page.saved ? { [PAGE_SAVED_HEADER]: 'true' } : {}),
  });
  response.end(page.body);
}
