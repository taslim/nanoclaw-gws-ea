import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import Database from 'better-sqlite3';

import { privateDatabaseFile } from './paths.js';

export class WhatsAppAuthStore {
  private readonly db: Database.Database;
  readonly state: AuthenticationState;

  constructor(directory: string) {
    this.db = new Database(privateDatabaseFile(directory, 'auth.sqlite'));
    this.db.pragma('journal_mode = DELETE');
    this.db.pragma('synchronous = FULL');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS auth (category TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(category,id))',
    );
    this.state = {
      creds: this.read<AuthenticationCreds>('credentials', 'current') ?? initAuthCreds(),
      keys: {
        get: <T extends keyof SignalDataTypeMap>(type: T, ids: string[]): { [id: string]: SignalDataTypeMap[T] } => {
          const result: { [id: string]: SignalDataTypeMap[T] } = {};
          for (const id of ids) {
            const stored = this.read<SignalDataTypeMap[T]>(type, id);
            if (stored !== undefined)
              result[id] =
                type === 'app-state-sync-key'
                  ? (proto.Message.AppStateSyncKeyData.fromObject(
                      stored as Record<string, unknown>,
                    ) as unknown as SignalDataTypeMap[T])
                  : stored;
          }
          return result;
        },
        set: (data): void => {
          this.db.transaction(() => {
            for (const [category, values] of Object.entries(data)) {
              for (const [id, value] of Object.entries(values)) {
                if (value === null || value === undefined)
                  this.db.prepare('DELETE FROM auth WHERE category=? AND id=?').run(category, id);
                else this.write(category, id, value);
              }
            }
          })();
        },
      },
    };
  }

  private read<T>(category: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM auth WHERE category=? AND id=?').get(category, id) as
      | { value: string }
      | undefined;
    return row === undefined ? undefined : (JSON.parse(row.value, BufferJSON.reviver) as T);
  }

  private write(category: string, id: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO auth(category,id,value) VALUES(?,?,?) ON CONFLICT(category,id) DO UPDATE SET value=excluded.value',
      )
      .run(category, id, JSON.stringify(value, BufferJSON.replacer));
  }

  saveCreds(update: Partial<AuthenticationCreds> = {}): void {
    Object.assign(this.state.creds, update);
    this.db.transaction(() => this.write('credentials', 'current', this.state.creds))();
  }

  clear(): void {
    this.db.transaction(() => this.db.exec('DELETE FROM auth'))();
    this.state.creds = initAuthCreds();
  }
  close(): void {
    this.db.close();
  }
}
