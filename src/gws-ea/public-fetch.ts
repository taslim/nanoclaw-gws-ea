/**
 * Reach a public URL the way the internet does. Its hostname is looked up
 * with public DNS resolvers directly, not through this machine's resolver,
 * which may be a VPN, a corporate DNS, or a cache still holding a lookup made
 * before the record existed. The connection keeps the real hostname, so
 * HTTPS certificate checks and routing are unchanged. When public DNS cannot
 * be reached at all, this machine's resolver answers instead; a name public
 * DNS says does not exist stays unresolved.
 */
import { lookup as systemLookup, Resolver } from 'node:dns';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';

import { errorCode } from '../community-portal/errors.js';

const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8'];
const RESOLVER_TIMEOUT_MS = 3_000;
/** Public DNS answered: the name has no address. */
const NO_ADDRESS = new Set(['ENOTFOUND', 'ENODATA']);

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/** Addresses for a hostname from public DNS; undefined when public DNS could not be reached. */
export type PublicResolve = (hostname: string) => Promise<readonly ResolvedAddress[] | undefined>;

/**
 * What public DNS said, from its A and AAAA answers: the addresses it gave,
 * none when it answered that the name has no address, or undefined when it
 * could not be reached.
 */
export function publicAnswer(
  answers: readonly PromiseSettledResult<readonly ResolvedAddress[]>[],
): readonly ResolvedAddress[] | undefined {
  const addresses = answers.flatMap((answer) => (answer.status === 'fulfilled' ? answer.value : []));
  if (addresses.length > 0) return addresses;
  const unanswered = answers.some(
    (answer) => answer.status === 'rejected' && !NO_ADDRESS.has(errorCode(answer.reason, '')),
  );
  return unanswered ? undefined : [];
}

const resolvePublicly: PublicResolve = async (hostname) => {
  const resolver = new Resolver({ timeout: RESOLVER_TIMEOUT_MS, tries: 1 });
  resolver.setServers(PUBLIC_RESOLVERS);
  const query = (family: 4 | 6) =>
    new Promise<readonly ResolvedAddress[]>((resolve, reject) => {
      const done = (error: Error | null, addresses: string[]) =>
        error ? reject(error) : resolve(addresses.map((address) => ({ address, family })));
      if (family === 4) resolver.resolve4(hostname, done);
      else resolver.resolve6(hostname, done);
    });
  return publicAnswer(await Promise.allSettled([query(4), query(6)]));
};

function notFound(hostname: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND', hostname });
}

function publicLookup(resolve: PublicResolve): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        if (addresses === undefined) {
          systemLookup(hostname, options, callback);
          return;
        }
        const usable = addresses.filter((entry) => !options.family || entry.family === options.family);
        const [first] = usable;
        if (!first) {
          callback(notFound(hostname), '', 4);
          return;
        }
        if (options.all) {
          callback(null, [...usable]);
          return;
        }
        callback(null, first.address, first.family);
      },
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), '', 4),
    );
  };
}

function responseHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const entry of Array.isArray(value) ? value : [value]) result.append(name, entry);
  }
  return result;
}

/**
 * A fetch for probing public endpoints: status and headers only (the body is
 * discarded), no redirects followed, and failures shaped as `fetch` shapes
 * them, a `TypeError` whose cause carries the network error's code.
 */
export function createPublicFetch(resolve: PublicResolve = resolvePublicly): typeof fetch {
  const lookup = publicLookup(resolve);
  return async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const body = typeof init.body === 'string' ? init.body : undefined;
    const signal = init.signal ?? undefined;
    return new Promise<Response>((resolve, reject) => {
      const outgoing = request(
        url,
        {
          method: init.method ?? 'GET',
          headers: Object.fromEntries(new Headers(init.headers).entries()),
          lookup,
          ...(signal ? { signal } : {}),
        },
        (incoming) => {
          incoming.resume();
          const status = incoming.statusCode ?? 0;
          // A status `Response` cannot carry is not a usable answer.
          if (status < 200 || status > 599) {
            reject(new TypeError('fetch failed', { cause: new Error(`HTTP status ${status}`) }));
            return;
          }
          resolve(new Response(null, { status, headers: responseHeaders(incoming.headers) }));
        },
      );
      outgoing.once('error', (error) => {
        reject(signal?.aborted ? signal.reason : new TypeError('fetch failed', { cause: error }));
      });
      outgoing.end(body);
    });
  };
}

/** The shared public probe. */
export const publicFetch = createPublicFetch();
