import type { SanitizedCommandOutcomeRunner } from '../../../gws-ea/process.js';
import { LoginStore } from '../login-store.js';

export const TEST_INSTANCE_ID = 'b910edf1-4a37-47db-b3ec-415e79e792dc';
/** Real encrypted SQLite with a fixed host-command result; never accesses the Mac's Keychain. */
export function testLoginStore(browserRoot: string): {
  store: LoginStore;
  setUnavailable: (value: boolean) => void;
  keyReads: () => number;
} {
  let unavailable = false;
  let reads = 0;
  const runCommand: SanitizedCommandOutcomeRunner = async () => {
    reads++;
    return { exitCode: unavailable ? 36 : 0, stdout: unavailable ? '' : '3d'.repeat(32), stderr: '' };
  };
  return {
    store: new LoginStore({ browserRoot, instanceId: TEST_INSTANCE_ID, runCommand }),
    setUnavailable: (value) => {
      unavailable = value;
    },
    keyReads: () => reads,
  };
}
