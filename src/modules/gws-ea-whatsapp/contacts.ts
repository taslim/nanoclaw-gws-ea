/** Number-scoped first-contact authority, beside auth and never in a release snapshot. */
import { createHash } from 'node:crypto';

import type { BaileysEventMap } from '@whiskeysockets/baileys';
import Database from 'better-sqlite3';

import { OutboundRefusedError } from '../../delivery.js';
import { isRecord } from '../../gws-ea/validation.js';
import { log } from '../../log.js';
import { writeNoteForMain } from '../gws-ea-profile/main-note.js';
import { privateDatabaseFile } from './paths.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CAP = 5;
/** Only the admitted chat_reach_out host action may supply this receipt of the principal's own stored message. */
export interface WhatsAppOutreachRequest {
  readonly principalMessageId: string;
}
interface Refusal {
  at: string;
  expires_at: string;
  request_id: string | null;
}
interface Notice {
  id: string;
  at: string;
  text: string;
}
export function whatsappStatusCode(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  if (isRecord(error.output) && typeof error.output.statusCode === 'number') return error.output.statusCode;
  return typeof error.statusCode === 'number' ? error.statusCode : undefined;
}

export class WhatsAppContacts {
  private readonly db: Database.Database;
  constructor(
    directory: string,
    private readonly account: () => string,
    private readonly now: () => number,
  ) {
    this.db = new Database(privateDatabaseFile(directory, 'contacts.sqlite'));
    this.db.pragma('journal_mode = DELETE');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS replies(account TEXT NOT NULL,person TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(account,person));
      CREATE TABLE IF NOT EXISTS contacts(account TEXT NOT NULL,person TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(account,person));
      CREATE TABLE IF NOT EXISTS locks(account TEXT PRIMARY KEY,expires_at TEXT);
      CREATE TABLE IF NOT EXISTS refusals(account TEXT NOT NULL,person TEXT NOT NULL,at TEXT NOT NULL,expires_at TEXT NOT NULL,request_id TEXT,PRIMARY KEY(account,person));
      CREATE TABLE IF NOT EXISTS refused_operations(account TEXT NOT NULL,operation TEXT NOT NULL,PRIMARY KEY(account,operation));
      CREATE TABLE IF NOT EXISTS handoffs(account TEXT NOT NULL,message_id TEXT NOT NULL,person TEXT NOT NULL,operation TEXT NOT NULL,request_id TEXT,PRIMARY KEY(account,message_id));
      CREATE TABLE IF NOT EXISTS notices(id TEXT PRIMARY KEY,account TEXT NOT NULL,at TEXT NOT NULL,text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(account TEXT NOT NULL,id TEXT NOT NULL,result TEXT,PRIMARY KEY(account,id));
    `);
  }
  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }
  private notice(operation: string, reason: string, people: readonly string[]): void {
    const id = `whatsapp-contact-${createHash('sha256')
      .update(JSON.stringify([this.account(), operation, reason]))
      .digest('hex')}`;
    this.db
      .prepare('INSERT OR IGNORE INTO notices(id,account,at,text) VALUES(?,?,?,?)')
      .run(
        id,
        this.account(),
        this.timestamp(),
        `WhatsApp outreach stopped: ${reason}. People: ${people.map((person) => `whatsapp:${person}`).join(', ')}. Do not retry this message. Use email or tell the principal.`,
      );
  }
  async notify(): Promise<void> {
    const notices = this.db
      .prepare('SELECT id,at,text FROM notices WHERE account=? ORDER BY rowid')
      .all(this.account()) as Notice[];
    for (const notice of notices) {
      /* eslint-disable no-catch-all/no-catch-all -- the durable notice stays queued until main's normal note writer accepts it */
      try {
        const result = await writeNoteForMain({ id: notice.id, timestamp: notice.at, text: notice.text, wake: true });
        if (result === 'written' || result === 'already-written')
          this.db.prepare('DELETE FROM notices WHERE id=?').run(notice.id);
      } catch (error) {
        log.warn('WhatsApp first-contact notice remains pending', { id: notice.id, err: error });
      }
      /* eslint-enable no-catch-all/no-catch-all */
    }
  }
  received(person: string, at: number): void {
    this.db
      .prepare(
        'INSERT INTO replies(account,person,at) VALUES(?,?,?) ON CONFLICT(account,person) DO UPDATE SET at=excluded.at',
      )
      .run(this.account(), person, new Date(at).toISOString());
  }
  connection(update: BaileysEventMap['connection.update']): void {
    const lock = update.reachoutTimeLock;
    if (!lock || lock.isActive === undefined) return;
    if (!lock.isActive) this.db.prepare('DELETE FROM locks WHERE account=?').run(this.account());
    else {
      const end = lock.timeEnforcementEnds;
      this.db
        .prepare(
          'INSERT INTO locks(account,expires_at) VALUES(?,?) ON CONFLICT(account) DO UPDATE SET expires_at=excluded.expires_at',
        )
        .run(this.account(), end && Number.isFinite(end.getTime()) ? end.toISOString() : null);
    }
  }
  /** One IMMEDIATE transaction reserves all people before a group or DM can touch the socket. */
  async reserve(people: readonly string[], operation: string, request?: WhatsAppOutreachRequest): Promise<void> {
    const account = this.account();
    const unique = [...new Set(people)];
    const reason = this.db
      .transaction((): 'contact-refused' | 'contact-time-lock' | 'contact-cap' | undefined => {
        if (this.db.prepare('SELECT 1 FROM refused_operations WHERE account=? AND operation=?').get(account, operation))
          return 'contact-refused';
        const newPeople: string[] = [];
        for (const person of unique) {
          if (this.db.prepare('SELECT 1 FROM replies WHERE account=? AND person=?').get(account, person)) continue;
          const refusal = this.db
            .prepare('SELECT at,expires_at,request_id FROM refusals WHERE account=? AND person=?')
            .get(account, person) as Refusal | undefined;
          // Expiry alone never makes a queued follow-up eligible: only a fresh admitted principal request may try.
          if (
            refusal &&
            !(
              request &&
              request.principalMessageId !== refusal.request_id &&
              Date.parse(refusal.expires_at) <= this.now()
            )
          )
            return 'contact-refused';
          newPeople.push(person);
        }
        if (!newPeople.length) return undefined;
        const lock = this.db.prepare('SELECT expires_at FROM locks WHERE account=?').get(account) as
          | { expires_at: string | null }
          | undefined;
        if (lock && (lock.expires_at === null || Date.parse(lock.expires_at) > this.now())) return 'contact-time-lock';
        const since = new Date(this.now() - DAY_MS).toISOString();
        const count = this.db
          .prepare('SELECT count(*) AS count FROM contacts WHERE account=? AND at>?')
          .get(account, since) as { count: number };
        const additions = newPeople.filter(
          (person) =>
            !this.db
              .prepare('SELECT 1 FROM contacts WHERE account=? AND person=? AND at>?')
              .get(account, person, since),
        );
        if (count.count + additions.length > CAP) return 'contact-cap';
        for (const person of additions)
          this.db
            .prepare(
              'INSERT INTO contacts(account,person,at) VALUES(?,?,?) ON CONFLICT(account,person) DO UPDATE SET at=excluded.at',
            )
            .run(account, person, this.timestamp());
        return undefined;
      })
      .immediate();
    if (reason) {
      this.notice(operation, reason, unique);
      await this.notify();
      throw new OutboundRefusedError(
        `gws-ea-whatsapp:${reason}`,
        `WhatsApp first contact refused: ${reason}. Use email or tell the principal.`,
      );
    }
  }
  handoff(messageId: string, person: string, operation: string, request?: WhatsAppOutreachRequest): void {
    this.db
      .prepare('INSERT OR IGNORE INTO handoffs(account,message_id,person,operation,request_id) VALUES(?,?,?,?,?)')
      .run(this.account(), messageId, person, operation, request?.principalMessageId ?? null);
  }
  async stopped(
    operation: string,
    reason: 'add refused' | 'group creation unconfirmed' | 'participant add unconfirmed',
    people: readonly string[],
  ): Promise<void> {
    this.notice(operation, reason, people);
    await this.notify();
  }
  async refused(person: string, operation: string, requestId: string | null = null): Promise<void> {
    this.db
      .transaction(() => {
        if (
          this.db
            .prepare('SELECT 1 FROM refused_operations WHERE account=? AND operation=?')
            .get(this.account(), operation)
        )
          return;
        this.db
          .prepare('INSERT OR IGNORE INTO refused_operations(account,operation) VALUES(?,?)')
          .run(this.account(), operation);
        this.db
          .prepare(
            'INSERT INTO refusals(account,person,at,expires_at,request_id) VALUES(?,?,?,?,?) ON CONFLICT(account,person) DO UPDATE SET at=excluded.at,expires_at=excluded.expires_at,request_id=excluded.request_id',
          )
          .run(this.account(), person, this.timestamp(), new Date(this.now() + DAY_MS).toISOString(), requestId);
        this.notice(operation, 'WhatsApp error 463', [person]);
      })
      .immediate();
    await this.notify();
  }
  async retry(messageId: string): Promise<boolean> {
    const handed = this.db
      .prepare('SELECT person,operation,request_id FROM handoffs WHERE account=? AND message_id=?')
      .get(this.account(), messageId) as { person: string; operation: string; request_id: string | null } | undefined;
    if (!handed) return false;
    try {
      await this.reserve(
        [handed.person],
        handed.operation,
        handed.request_id ? { principalMessageId: handed.request_id } : undefined,
      );
      return true;
    } catch (error) {
      if (error instanceof OutboundRefusedError) return false;
      throw error;
    }
  }
  async updates(updates: BaileysEventMap['messages.update']): Promise<void> {
    for (const { key, update } of updates) {
      if (update.messageStubParameters?.[0] !== '463' || !key.id || key.fromMe !== true) continue;
      const handed = this.db
        .prepare('SELECT person,operation,request_id FROM handoffs WHERE account=? AND message_id=?')
        .get(this.account(), key.id) as { person: string; operation: string; request_id: string | null } | undefined;
      if (handed) await this.refused(handed.person, handed.operation, handed.request_id);
    }
  }
  /** Native group side effects have no idempotency key. Ambiguous attempts must never be reissued. */
  beginOperation(id: string): string | undefined {
    return this.db
      .transaction(() => {
        const previous = this.db
          .prepare('SELECT result FROM operations WHERE account=? AND id=?')
          .get(this.account(), id) as { result: string | null } | undefined;
        if (previous) {
          if (previous.result === null)
            throw new OutboundRefusedError(
              'gws-ea-whatsapp:outreach-unconfirmed',
              'The earlier WhatsApp group operation is unconfirmed; do not repeat it.',
            );
          return previous.result;
        }
        this.db.prepare('INSERT INTO operations(account,id) VALUES(?,?)').run(this.account(), id);
        return undefined;
      })
      .immediate();
  }
  finishOperation(id: string, result: string): void {
    this.db.prepare('UPDATE operations SET result=? WHERE account=? AND id=?').run(result, this.account(), id);
  }
  close(): void {
    this.db.close();
  }
}
