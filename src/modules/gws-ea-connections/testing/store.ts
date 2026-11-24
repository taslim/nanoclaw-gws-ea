import path from 'node:path';
import Database from 'better-sqlite3';
import type { SanitizedCommand, SanitizedCommandOutcomeRunner } from '../../../gws-ea/process.js';
import { ConnectionsStore } from '../store.js';

export const TEST_INSTANCE_ID = 'c4f1d2a8-5b3e-4e7a-9a61-0d2f8b7c6e15';

export interface TestKeychain {
  /** The hex key Keychain holds, if any. */
  key: string | undefined;
  unavailable: boolean;
  readonly calls: SanitizedCommand[];
}

/** Real encrypted SQLite with an in-memory Keychain; never accesses the Mac's Keychain. */
export function testConnectionsStore(connectionsRoot: string): {
  readonly store: ConnectionsStore;
  readonly keychain: TestKeychain;
  readonly raw: <T>(read: (db: Database.Database) => T, options?: { readonly writable?: boolean }) => T;
} {
  const keychain: TestKeychain = { key: undefined, unavailable: false, calls: [] };
  const runCommand: SanitizedCommandOutcomeRunner = async (command) => {
    keychain.calls.push(command);
    if (keychain.unavailable) return { exitCode: 36, stdout: '', stderr: '' };
    if (command.args[0] === '-i') {
      keychain.key = command.input?.match(/-w ([a-f0-9]{64})/u)?.[1];
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (command.args[0] === 'delete-generic-password') {
      keychain.key = undefined;
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return keychain.key
      ? { exitCode: 0, stdout: `${keychain.key}\n`, stderr: '' }
      : { exitCode: 44, stdout: '', stderr: '' };
  };
  return {
    store: new ConnectionsStore({ connectionsRoot, instanceId: TEST_INSTANCE_ID, runCommand }),
    keychain,
    raw: (read, options) => {
      const db = new Database(path.join(connectionsRoot, 'apps.db'), { readonly: options?.writable !== true });
      try {
        return read(db);
      } finally {
        db.close();
      }
    },
  };
}
