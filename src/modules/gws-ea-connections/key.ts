import type { SanitizedCommandOutcomeRunner } from '../../gws-ea/process.js';
import { KeychainKey } from '../gws-ea-vault/key.js';

export const CONNECTIONS_KEY_SERVICE = 'gws-ea.connections';

export interface ConnectionsKeyOptions {
  readonly instanceId: string;
  readonly runCommand?: SanitizedCommandOutcomeRunner;
}

/** The connections store's own Keychain item, so it is created and removed apart from saved logins'. */
export class ConnectionsKey extends KeychainKey {
  constructor(options: ConnectionsKeyOptions) {
    super({ ...options, service: CONNECTIONS_KEY_SERVICE });
  }
}
