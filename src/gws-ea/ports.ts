import { createServer, type Server } from 'node:net';

import { GwsEaError, type AllocatedPorts } from './types.js';

export type AllocatedPortName = keyof AllocatedPorts;

export interface LoopbackPortLease {
  release(names?: readonly AllocatedPortName[]): Promise<void>;
}

export interface HeldLoopbackPorts extends LoopbackPortLease {
  readonly ports: AllocatedPorts;
}

interface PortRequest {
  readonly name: AllocatedPortName;
  readonly port: number;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function closeServers(servers: ReadonlyMap<AllocatedPortName, Server>): Promise<void> {
  const results = await Promise.allSettled([...servers.values()].map(closeServer));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) throw failure.reason;
}

async function listenLoopback(server: Server, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new GwsEaError('port_allocation_failed', 'Could not allocate a loopback port');
  }
  return address.port;
}

async function holdPorts(
  requests: readonly PortRequest[],
  portError: (request: PortRequest, error: unknown) => Error,
): Promise<ReadonlyMap<AllocatedPortName, Server>> {
  const servers = new Map(requests.map((request) => [request.name, createServer()]));
  const results = await Promise.allSettled(
    requests.map(async (request) => {
      const server = servers.get(request.name);
      if (!server) throw new GwsEaError('port_allocation_failed', 'Could not create a loopback port lease');
      try {
        return await listenLoopback(server, request.port);
      } catch (error) {
        throw portError(request, error);
      }
    }),
  );
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (!failure) return servers;
  await closeServers(servers).catch(() => undefined);
  throw failure.reason;
}

function createLease(servers: ReadonlyMap<AllocatedPortName, Server>): LoopbackPortLease {
  return {
    release: async (names = [...servers.keys()]) => {
      const selected = new Map<AllocatedPortName, Server>();
      for (const name of names) {
        const server = servers.get(name);
        if (server) selected.set(name, server);
      }
      await closeServers(selected);
    },
  };
}

/** Allocate and retain three new loopback ports until their runtimes are ready to bind. */
export async function holdLoopbackPorts(): Promise<HeldLoopbackPorts> {
  const names = ['nanoclaw_webhook', 'onecli_app', 'onecli_gateway'] as const;
  const requests = names.map((name) => ({ name, port: 0 }));
  const servers = await holdPorts(
    requests,
    () => new GwsEaError('port_allocation_failed', 'Could not allocate the required loopback ports'),
  );
  const port = (name: AllocatedPortName): number => {
    const address = servers.get(name)?.address();
    if (!address || typeof address === 'string') {
      throw new GwsEaError('port_allocation_failed', 'Could not inspect an allocated loopback port');
    }
    return address.port;
  };
  return {
    ...createLease(servers),
    ports: {
      nanoclaw_webhook: port('nanoclaw_webhook'),
      onecli_app: port('onecli_app'),
      onecli_gateway: port('onecli_gateway'),
    },
  };
}

/** Reclaim an instance's immutable ports before retrying an absent runtime. */
export async function holdReservedLoopbackPorts(
  instanceId: string,
  ports: AllocatedPorts,
  names: readonly AllocatedPortName[],
): Promise<LoopbackPortLease> {
  const requests = names.map((name) => ({ name, port: ports[name] }));
  const servers = await holdPorts(
    requests,
    (request) =>
      new GwsEaError(
        'port_claim_lost',
        `Reserved ${request.name} coordinate 127.0.0.1:${request.port} is unavailable. ` +
          `Stop the process using it, then resume with: gws-ea resume --id ${instanceId}`,
      ),
  );
  return createLease(servers);
}
