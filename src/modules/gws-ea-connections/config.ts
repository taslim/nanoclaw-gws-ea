import { readEnvFile } from '../../env.js';

export const CONNECTIONS_ROOT_ENV = 'GWS_EA_CONNECTIONS_ROOT';
export const CATALOG_POLICY_FILE_ENV = 'GWS_EA_CATALOG_POLICY_FILE';

function setting(name: string): string | undefined {
  return process.env[name]?.trim() || readEnvFile([name])[name]?.trim() || undefined;
}

export function connectionsRoot(): string | undefined {
  return setting(CONNECTIONS_ROOT_ENV);
}

export function catalogPolicyFile(): string | undefined {
  return setting(CATALOG_POLICY_FILE_ENV);
}
