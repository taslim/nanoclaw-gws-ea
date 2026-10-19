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
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS logout_proof (singleton INTEGER PRIMARY KEY CHECK(singleton=1), account TEXT NOT NULL)',
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
            if (this.authenticated) this.db.exec('DELETE FROM logout_proof');
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
    this.db.transaction(() => {
      if (this.authenticated) this.db.exec('DELETE FROM logout_proof');
      this.write('credentials', 'current', this.state.creds);
    })();
  }

  loggedOut(account: string): boolean {
    return this.loggedOutAccount() === account;
  }
  loggedOutAccount(): string | undefined {
    if (this.authenticated) return undefined;
    return this.db.prepare<[], { account: string }>('SELECT account FROM logout_proof WHERE singleton=1').get()
      ?.account;
  }
  get authenticated(): boolean {
    return this.state.creds.registered || this.state.creds.account !== undefined;
  }
  clear(reason: { readonly kind: 'discarded' } | { readonly kind: 'logged-out'; readonly account: string }): void {
    if (reason.kind === 'logged-out' && !/^\d+@s\.whatsapp\.net$/u.test(reason.account))
      throw new Error('A native WhatsApp logout needs its authenticated phone account');
    this.db.transaction(() => {
      this.db.exec('DELETE FROM auth; DELETE FROM logout_proof');
      if (reason.kind === 'logged-out') this.db.prepare('INSERT INTO logout_proof VALUES(1,?)').run(reason.account);
    })();
    this.state.creds = initAuthCreds();
  }
  close(): void {
    this.db.close();
  }
}
