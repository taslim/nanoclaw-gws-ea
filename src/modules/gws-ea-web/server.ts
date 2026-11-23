import type {
  IncomingMessage,
  OutgoingHttpHeader,
  OutgoingHttpHeaders,
  RequestListener,
  ServerResponse,
} from 'node:http';
import { log } from '../../log.js';
import { isPrincipalWebIdentity, type WebIdentity } from './access.js';
import { mountCovers, normalizeWebPathname, type ArtifactReadersMount, type WebMount } from './mounts.js';

export interface WebRoute {
  readonly mount: WebMount;
  readonly listener: RequestListener;
}
export type PrincipalGate = (request: IncomingMessage) => Promise<boolean>;

export function principalGate(identity: WebIdentity): PrincipalGate {
  return async (request) => isPrincipalWebIdentity(await identity(request));
}

function finish(response: ServerResponse, status: number): void {
  response.shouldKeepAlive = false;
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

function headerValues(value: OutgoingHttpHeader | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function policies(
  response: ServerResponse,
  written: string | OutgoingHttpHeaders | OutgoingHttpHeader[] | undefined,
): string[] {
  const values = headerValues(response.getHeader('content-security-policy'));
  if (Array.isArray(written)) {
    for (let index = 0; index + 1 < written.length; index += 2)
      if (String(written[index]).toLowerCase() === 'content-security-policy')
        values.push(...headerValues(written[index + 1]));
  } else if (written && typeof written === 'object') {
    for (const [name, value] of Object.entries(written))
      if (name.toLowerCase() === 'content-security-policy') values.push(...headerValues(value));
  }
  return values;
}

/** CSP splits on ASCII whitespace only, so a directive joined by any other space is not the directive it looks like. */
const CSP_WHITESPACE = /[\t\n\f\r ]+/u;

/**
 * The host's same-origin JSON checks rely on authored content never sharing the host's origin. Every policy must
 * carry the sandbox: a writeHead header replaces one set earlier, so only a sandbox in each one survives whichever
 * Node sends.
 */
function sandboxedOpaque(csp: readonly string[]): boolean {
  const policies = csp.flatMap((value) => value.split(','));
  return (
    policies.length > 0 &&
    policies.every((policy) => {
      // A repeated directive is ignored, so the first sandbox is the one the browser applies.
      const sandbox = policy
        .split(';')
        .map((directive) => directive.toLowerCase().split(CSP_WHITESPACE).filter(Boolean))
        .find(([name]) => name === 'sandbox');
      return sandbox !== undefined && !sandbox.includes('allow-same-origin');
    })
  );
}

/**
 * An authored-content response without an opaque-origin sandbox is dropped before any byte is sent, whatever its
 * status: a browser runs an error document's scripts too.
 */
function requireSandbox(response: ServerResponse, mount: ArtifactReadersMount): void {
  const writeHead = response.writeHead.bind(response);
  response.writeHead = ((
    statusCode: number,
    reason?: string | OutgoingHttpHeaders | OutgoingHttpHeader[],
    headers?: OutgoingHttpHeaders | OutgoingHttpHeader[],
  ) => {
    if (response.destroyed) return response;
    const written = typeof reason === 'string' ? headers : reason;
    if (!sandboxedOpaque(policies(response, written))) {
      log.error('Web mount sent authored content without an opaque-origin sandbox', { mount: mount.name });
      response.destroy();
      return response;
    }
    return typeof reason === 'string' ? writeHead(statusCode, reason, headers) : writeHead(statusCode, reason);
  }) as ServerResponse['writeHead'];
}

/**
 * The hostname serves only registered mounts. A principal mount is reached only after the principal is
 * verified for this request, so its handler never sees anyone else; a public mount never consults identity.
 */
export function createWebHandler(
  hostname: string,
  routes: readonly WebRoute[],
  principal: PrincipalGate,
): RequestListener {
  return (request, response) => {
    if (request.headers.host !== hostname) return finish(response, 404);
    const pathname = normalizeWebPathname(request.url);
    const route = pathname === undefined ? undefined : routes.find(({ mount }) => mountCovers(mount.path, pathname));
    if (!pathname || !route) return finish(response, 404);
    const { mount, listener } = route;
    const allowed = mount.methods.some((method) => method === request.method);
    switch (mount.audience) {
      case 'public':
        if (!allowed) return finish(response, 405);
        return listener(request, response);
      case 'artifact-readers':
        if (!allowed) return finish(response, 405);
        if (mount.authoredContent(pathname)) requireSandbox(response, mount);
        return listener(request, response);
      case 'principal':
        void principal(request)
          .catch((_error: unknown) => false)
          .then((verified) => {
            if (!verified) finish(response, 404);
            else if (!allowed) finish(response, 405);
            else listener(request, response);
          })
          .catch((_error: unknown) => {
            if (response.headersSent) response.destroy();
            else finish(response, 404);
          });
        return;
      default: {
        const unhandled: never = mount;
        throw new Error(`Unknown web mount audience ${String(unhandled)}`);
      }
    }
  };
}
