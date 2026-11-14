import { readEnvFile } from '../../env.js';

export const CONNECTIONS_ROOT_ENV = 'GWS_EA_CONNECTIONS_ROOT';

export function connectionsRoot(): string | undefined {
  return (
    process.env[CONNECTIONS_ROOT_ENV]?.trim() ||
    readEnvFile([CONNECTIONS_ROOT_ENV])[CONNECTIONS_ROOT_ENV]?.trim() ||
    undefined
  );
}
