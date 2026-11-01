import { createDecipheriv } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { SanitizedCommandOutcomeRunner } from '../../../gws-ea/process.js';
import { LoginStore } from '../login-store.js';

export const TEST_INSTANCE_ID = 'b910edf1-4a37-47db-b3ec-415e79e792dc';
/** Real encrypted SQLite with a fixed host-command result; never accesses the Mac's Keychain. */
export function testLoginStore(browserRoot: string): {
  store: LoginStore;
  setUnavailable: (value: boolean) => void;
  keyReads: () => number;
  hasPending: (id: string) => boolean;
  pendingIds: () => string[];
  attemptPassword: (id: string) => string;
} {
  let unavailable = false;
  let reads = 0;
  const runCommand: SanitizedCommandOutcomeRunner = async () => {
    reads++;
    return { exitCode: unavailable ? 36 : 0, stdout: unavailable ? '' : '3d'.repeat(32), stderr: '' };
  };
  const raw = <T>(read: (db: Database.Database) => T): T => {
    const db = new Database(path.join(browserRoot, 'logins.db'), { readonly: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  };
  return {
    hasPending: (id) =>
      raw((db) => Boolean(db.prepare('SELECT 1 FROM attempts WHERE id = ? AND password IS NOT NULL').get(id))),
    pendingIds: () =>
      raw((db) =>
        db
          .prepare<[], { id: string }>('SELECT id FROM attempts WHERE password IS NOT NULL ORDER BY id')
          .all()
          .map(({ id }) => id),
      ),
    attemptPassword: (id) =>
      raw((db) => {
        const row = db
          .prepare<[string], { password: Buffer | null }>('SELECT password FROM attempts WHERE id = ?')
          .get(id);
        if (!row?.password) throw new Error('Fixture has no pending password');
        const blob = row.password;
        const decipher = createDecipheriv('aes-256-gcm', Buffer.from('3d'.repeat(32), 'hex'), blob.subarray(0, 12));
        decipher.setAAD(Buffer.from(`gws-ea-logins:v1|${TEST_INSTANCE_ID}`));
        decipher.setAuthTag(blob.subarray(12, 28));
        return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString();
      }),
    store: new LoginStore({ browserRoot, instanceId: TEST_INSTANCE_ID, runCommand }),
    setUnavailable: (value) => {
      unavailable = value;
    },
    keyReads: () => reads,
  };
}
