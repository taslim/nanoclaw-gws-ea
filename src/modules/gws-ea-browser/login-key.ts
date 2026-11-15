import type { SanitizedCommandOutcomeRunner } from '../../gws-ea/process.js';
import { KeychainKey } from '../gws-ea-vault/key.js';

export interface LoginKeyOptions {
  readonly instanceId: string;
  readonly runCommand?: SanitizedCommandOutcomeRunner;
}

/** The saved-login store's own Keychain item; existing stores depend on this service name. */
export class LoginKey extends KeychainKey {
  constructor(options: LoginKeyOptions) {
    super({ ...options, service: 'gws-ea.saved-logins' });
  }
}
