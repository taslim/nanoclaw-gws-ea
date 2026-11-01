import { getLoginStore, loginStoreAvailability, LoginStoreError, type LoginStoreAvailability } from './login-store.js';
import type { BrowserRuntime } from './runtime.js';

/** Host-only listener facts never include endpoints, browser IDs, page text or credentials. */
export async function browserHealth(
  state: ReturnType<BrowserRuntime['state']>,
): Promise<
  { schemaVersion: 1; credentialAttempts: number | null; loginStore: LoginStoreAvailability } & ReturnType<
    BrowserRuntime['state']
  >
> {
  let credentialAttempts: number | null = null;
  let loginStore: LoginStoreAvailability;
  try {
    const store = await getLoginStore();
    credentialAttempts = await store.unresolvedAttemptCount();
    loginStore = await loginStoreAvailability(store);
  } catch (error) {
    if (!(error instanceof LoginStoreError)) throw error;
    loginStore = { available: false, reason: 'keychain_unavailable' };
  }
  return { schemaVersion: 1, ...state, credentialAttempts, loginStore };
}
