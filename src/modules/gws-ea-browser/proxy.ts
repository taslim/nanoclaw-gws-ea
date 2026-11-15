/** Chrome's independent egress boundary. DNS is checked once and the dial uses that IP. */
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';

import { RefusedDestination, resolveDestination, type Destination } from '../gws-ea-egress/resolve.js';

export interface PublicBrowserProxy {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

function withoutHopHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = { ...headers };
  const connection = headers.connection?.split(',').map((value) => value.trim().toLowerCase()) ?? [];
  for (const key of [
    ...connection,
    'connection',
    'proxy-connection',
    'proxy-authorization',
    'proxy-authenticate',
    'keep-alive',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ]) {
    delete result[key];
  }
  return result;
}

/** No authentication or credentials are added. It is never the credential gateway. */
export async function startPublicBrowserProxy(): Promise<PublicBrowserProxy> {
  const sockets = new Set<Duplex>();
  const track = <T extends Duplex>(socket: T): T => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const server = http.createServer((request, response) => {
    void (async () => {
      let target: URL;
      let endpoint: Destination;
      /* eslint-disable no-catch-all/no-catch-all -- hostile proxy input and DNS errors terminate this request only */
      try {
        // Only absolute-form requests: a relative path must never become a
        // request to the proxy's own listening host through a forged Host.
        if (!/^https?:\/\//i.test(request.url ?? '')) throw new RefusedDestination();
        target = new URL(request.url ?? '');
        if (target.protocol !== 'http:') throw new RefusedDestination();
        endpoint = await resolveDestination(target);
      } catch (_error) {
        response.writeHead(403);
        response.end('Destination refused');
        return;
      }
      /* eslint-enable no-catch-all/no-catch-all */
      if (request.destroyed || response.destroyed) return;
      const headers = withoutHopHeaders(request.headers);
      headers.host = target.host;
      const upstream = http.request({
        hostname: endpoint.address,
        family: endpoint.family,
        port: endpoint.port,
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers,
        agent: false,
        timeout: 15_000,
      });
      upstream.once('socket', track);
      upstream.on('response', (reply) => {
        response.writeHead(reply.statusCode ?? 502, withoutHopHeaders(reply.headers));
        reply.pipe(response);
      });
      upstream.on('timeout', () => upstream.destroy(new Error('Upstream timed out')));
      upstream.on('error', () => {
        if (!response.headersSent) response.writeHead(502);
        response.end('Upstream unavailable');
      });
      request.on('aborted', () => upstream.destroy());
      response.on('close', () => upstream.destroy());
      request.pipe(upstream);
    })();
  });
  server.on('connection', track);
  server.on('connect', (request, client, head) => {
    void (async () => {
      let endpoint: Destination;
      /* eslint-disable no-catch-all/no-catch-all -- each tunnel validates independent hostile authority and DNS */
      try {
        const authority = request.url ?? '';
        // Require a bare host:port authority, not credentials, path, query or fragment.
        const target = new URL(`https://${authority}`);
        if (!/^([^\s/?#@]+):\d+$/.test(authority) || target.pathname !== '/' || target.search || target.hash) {
          throw new RefusedDestination();
        }
        endpoint = await resolveDestination(target);
      } catch (_error) {
        client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      /* eslint-enable no-catch-all/no-catch-all */
      if (client.destroyed) return;
      const upstream = track(
        net.createConnection({ host: endpoint.address, port: endpoint.port, family: endpoint.family }),
      );
      upstream.setTimeout(15_000, () => upstream.destroy());
      upstream.once('connect', () => {
        upstream.setTimeout(0);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on('error', () => {
        if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      });
      upstream.on('close', (hadError) => {
        if (hadError || !upstream.readableEnded) client.destroy();
      });
      client.on('error', () => upstream.destroy());
      client.on('close', () => upstream.destroy());
    })();
  });
  // No HTTP upgrade path exists; a WebSocket may only traverse an already
  // validated CONNECT tunnel to a public destination.
  server.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Browser proxy has no listening address');
  let closing: Promise<void> | undefined;
  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
  };
}
