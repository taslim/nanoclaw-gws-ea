import { createServer, type Server } from 'node:net';

import { buildToolEnvironment, runSanitizedCommand, type SanitizedCommandRunner } from './process.js';
import { GwsEaError, type AllocatedPorts } from './types.js';

export type AllocatedPortName = keyof AllocatedPorts;

/**
 * OneCLI's two loopback ports, held until the reservation that claims them is
 * written; from then on the registry's claims keep them unique among assistants.
 */
export interface HeldLoopbackPorts {
  readonly ports: AllocatedPorts;
  release(): Promise<void>;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function listenLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new GwsEaError('port_allocation_failed', 'Could not allocate a loopback port');
  }
  return address.port;
}

export async function holdLoopbackPorts(): Promise<HeldLoopbackPorts> {
  const servers = [createServer(), createServer()] as const;
  const release = async (): Promise<void> => {
    await Promise.all(servers.map(closeServer));
  };
  let ports: number[];
  try {
    ports = await Promise.all(servers.map(listenLoopback));
  } catch (error) {
    await release().catch(() => undefined);
    throw new GwsEaError('port_allocation_failed', 'Could not allocate the required loopback ports', { cause: error });
  }
  const [onecliApp, onecliGateway] = ports as [number, number];
  return { ports: { onecli_app: onecliApp, onecli_gateway: onecliGateway }, release };
}

export interface PortHolder {
  readonly pid: number;
  readonly command: string | undefined;
}

/** Undefined when nothing listens on `port`, or when `lsof` is missing or cannot say. */
export async function findPortHolder(
  port: number,
  run: SanitizedCommandRunner = runSanitizedCommand,
): Promise<PortHolder | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await run({
      command: 'lsof',
      args: ['-nP', '+c', '0', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'],
      cwd: '/',
      env: buildToolEnvironment(),
      timeoutMs: 10_000,
    }));
  } catch (error) {
    // lsof exits 1 when nothing listens; a missing lsof leaves the holder unnamed.
    if (error instanceof GwsEaError && ['command_failed', 'executable_not_found'].includes(error.code)) {
      return undefined;
    }
    throw error;
  }
  const fields = stdout.split('\n');
  const pid = Number(fields.find((field) => field.startsWith('p'))?.slice(1));
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return { pid, command: fields.find((field) => field.startsWith('c'))?.slice(1) || undefined };
}

export function portInUseError(label: string, port: number, holder: PortHolder, cause?: unknown): GwsEaError {
  const who = holder.command ? `${holder.command} (pid ${holder.pid})` : `pid ${holder.pid}`;
  return new GwsEaError(
    'port_in_use',
    `Another process, ${who}, holds this assistant's ${label} port 127.0.0.1:${port}. Stop it, then resume.`,
    {
      ...(cause === undefined ? {} : { cause }),
      details: { port, pid: holder.pid, ...(holder.command ? { command: holder.command } : {}) },
    },
  );
}
