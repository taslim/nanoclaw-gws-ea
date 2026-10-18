/** Durable inbox, trusted quote copies and row-keyed sends; all outside release snapshots. */
import { BufferJSON, proto, type WAMessage } from '@whiskeysockets/baileys';
import Database from 'better-sqlite3';

import { privateDatabaseFile } from './paths.js';

export interface IndexedMessage {
  readonly chat: string;
  readonly id: string;
  readonly sender: string;
  readonly fromMe: boolean;
  readonly forwarded: boolean;
  readonly text: string;
  readonly at: number;
  readonly routed: boolean;
}
interface MessageRow {
  chat: string;
  id: string;
  sender: string;
  from_me: number;
  forwarded: number;
  text: string;
  at: number;
  routed: number;
  raw: string | null;
}
export interface PendingSend {
  readonly rowId: string;
  readonly chat: string;
  readonly createdAt: number;
  readonly accepted: boolean;
  readonly messageId: string;
}
interface SendRow {
  row_id: string;
  chat: string;
  created_at: number;
  accepted: number;
  message_id: string;
}

export class WhatsAppIndex {
  private readonly db: Database.Database;
  constructor(directory: string) {
    this.db = new Database(privateDatabaseFile(directory, 'messages.sqlite'));
    this.db.pragma('journal_mode = DELETE');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS intake (chat TEXT NOT NULL,id TEXT NOT NULL,raw TEXT NOT NULL,PRIMARY KEY(chat,id));
      CREATE TABLE IF NOT EXISTS messages (
        chat TEXT NOT NULL,id TEXT NOT NULL,sender TEXT NOT NULL,from_me INTEGER NOT NULL,
        forwarded INTEGER NOT NULL,text TEXT NOT NULL,at INTEGER NOT NULL,routed INTEGER NOT NULL,raw TEXT,wire TEXT,
        PRIMARY KEY(chat,id)
      );
      CREATE TABLE IF NOT EXISTS pending_sends (
        row_id TEXT PRIMARY KEY,chat TEXT NOT NULL,created_at INTEGER NOT NULL,accepted INTEGER NOT NULL DEFAULT 0,message_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS requests (message_id TEXT PRIMARY KEY, chat TEXT NOT NULL, question_id TEXT NOT NULL, posted_at TEXT);
      CREATE TABLE IF NOT EXISTS aliases (phone TEXT PRIMARY KEY,lid TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS names (jid TEXT PRIMARY KEY,name TEXT NOT NULL);
    `);
  }

  message(chat: string, id: string): IndexedMessage | undefined {
    const row = this.db.prepare('SELECT * FROM messages WHERE chat=? AND id=?').get(chat, id) as MessageRow | undefined;
    return row === undefined
      ? undefined
      : {
          chat: row.chat,
          id: row.id,
          sender: row.sender,
          fromMe: row.from_me === 1,
          forwarded: row.forwarded === 1,
          text: row.text,
          at: row.at,
          routed: row.routed === 1,
        };
  }

  receive(message: IndexedMessage, raw: WAMessage): void {
    this.db
      .prepare(
        'INSERT INTO messages(chat,id,sender,from_me,forwarded,text,at,routed,raw) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(chat,id) DO NOTHING',
      )
      .run(
        message.chat,
        message.id,
        message.sender,
        Number(message.fromMe),
        Number(message.forwarded),
        message.text,
        message.at,
        0,
        JSON.stringify(raw, BufferJSON.replacer),
      );
  }
  intake(raw: WAMessage): void {
    if (!raw.key.remoteJid || !raw.key.id || raw.key.fromMe || !raw.message || raw.key.remoteJid.endsWith('@broadcast'))
      return;
    this.db
      .prepare('INSERT INTO intake(chat,id,raw) VALUES(?,?,?) ON CONFLICT(chat,id) DO NOTHING')
      .run(raw.key.remoteJid, raw.key.id, JSON.stringify(raw, BufferJSON.replacer));
  }
  finishIntake(rawChat: string, id: string): void {
    this.db.prepare('DELETE FROM intake WHERE chat=? AND id=?').run(rawChat, id);
  }
  routed(chat: string, id: string, rawChat = chat): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE messages SET routed=1,raw=NULL WHERE chat=? AND id=?').run(chat, id);
      this.finishIntake(rawChat, id);
    })();
  }
  unrouted(): WAMessage[] {
    const rows = this.db.prepare('SELECT raw FROM intake ORDER BY rowid').all() as { raw: string }[];
    return rows.map(({ raw }) => {
      const parsed = proto.WebMessageInfo.fromObject(JSON.parse(raw, BufferJSON.reviver) as Record<string, unknown>);
      if (!parsed.key) throw new Error('WhatsApp inbox record has no message key');
      return { ...parsed, key: parsed.key };
    });
  }
  wireMessage(chat: string, id: string): proto.IMessage | undefined {
    const row = this.db.prepare('SELECT wire,text FROM messages WHERE chat=? AND id=?').get(chat, id) as
      | { wire: string | null; text: string }
      | undefined;
    if (!row) return undefined;
    return row.wire
      ? proto.Message.fromObject(JSON.parse(row.wire, BufferJSON.reviver) as Record<string, unknown>)
      : { conversation: row.text };
  }
  edit(chat: string, id: string, text: string): void {
    this.db.prepare('UPDATE messages SET text=? WHERE chat=? AND id=?').run(text, chat, id);
  }
  sent(message: Omit<IndexedMessage, 'routed'>, wire?: proto.IMessage | null): void {
    this.db
      .prepare(
        'INSERT INTO messages(chat,id,sender,from_me,forwarded,text,at,routed,wire) VALUES(?,?,?,?,?,?,?,1,?) ON CONFLICT(chat,id) DO UPDATE SET sender=excluded.sender,text=excluded.text,from_me=1,routed=1,raw=NULL,wire=excluded.wire',
      )
      .run(
        message.chat,
        message.id,
        message.sender,
        1,
        Number(message.forwarded),
        message.text,
        message.at,
        wire ? JSON.stringify(wire, BufferJSON.replacer) : null,
      );
  }
  prune(now: number): void {
    this.db.prepare('DELETE FROM messages WHERE from_me=0 AND routed=1 AND at<?').run(now - 30 * 24 * 60 * 60 * 1000);
  }
  deleteChat(chat: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE chat=?').run(chat);
      this.db.prepare('DELETE FROM pending_sends WHERE chat=?').run(chat);
      this.db.prepare('DELETE FROM requests WHERE chat=?').run(chat);
      this.db.prepare('DELETE FROM intake WHERE chat=?').run(chat);
    })();
  }
  pending(rowId: string): PendingSend | undefined {
    const row = this.db.prepare('SELECT * FROM pending_sends WHERE row_id=?').get(rowId) as SendRow | undefined;
    return row === undefined
      ? undefined
      : {
          rowId: row.row_id,
          chat: row.chat,
          createdAt: row.created_at,
          accepted: row.accepted === 1,
          messageId: row.message_id,
        };
  }
  prepare(rowId: string, chat: string, messageId: string, at: number): PendingSend {
    this.db
      .prepare(
        'INSERT INTO pending_sends(row_id,chat,message_id,created_at) VALUES(?,?,?,?) ON CONFLICT(row_id) DO NOTHING',
      )
      .run(rowId, chat, messageId, at);
    const held = this.pending(rowId);
    if (!held || held.chat !== chat || held.messageId !== messageId)
      throw new Error('WhatsApp outbound row changed address');
    return held;
  }
  accepted(rowId: string): void {
    this.db.prepare('UPDATE pending_sends SET accepted=1 WHERE row_id=?').run(rowId);
  }
  complete(rowId: string): void {
    this.db.prepare('DELETE FROM pending_sends WHERE row_id=?').run(rowId);
  }
  alias(lid: string, phone: string): void {
    this.db
      .prepare('INSERT INTO aliases(phone,lid) VALUES(?,?) ON CONFLICT(phone) DO UPDATE SET lid=excluded.lid')
      .run(phone, lid);
  }
  lid(phone: string): string | undefined {
    return (this.db.prepare('SELECT lid FROM aliases WHERE phone=?').get(phone) as { lid: string } | undefined)?.lid;
  }
  phone(lid: string): string | undefined {
    return (this.db.prepare('SELECT phone FROM aliases WHERE lid=?').get(lid) as { phone: string } | undefined)?.phone;
  }
  name(jid: string): string | undefined {
    return (this.db.prepare('SELECT name FROM names WHERE jid=?').get(jid) as { name: string } | undefined)?.name;
  }
  rememberName(jid: string, name: string): void {
    this.db
      .prepare('INSERT INTO names(jid,name) VALUES(?,?) ON CONFLICT(jid) DO UPDATE SET name=excluded.name')
      .run(jid, name);
  }
  request(messageId: string): { questionId: string; platformId: string; postedAt?: string } | undefined {
    const row = this.db.prepare('SELECT question_id,chat,posted_at FROM requests WHERE message_id=?').get(messageId) as
      | { question_id: string; chat: string; posted_at: string | null }
      | undefined;
    return row
      ? { questionId: row.question_id, platformId: row.chat, ...(row.posted_at ? { postedAt: row.posted_at } : {}) }
      : undefined;
  }
  requestMessage(questionId: string, chat: string): string | undefined {
    return (
      this.db
        .prepare('SELECT message_id FROM requests WHERE question_id=? AND chat=? ORDER BY rowid DESC LIMIT 1')
        .get(questionId, chat) as { message_id: string } | undefined
    )?.message_id;
  }
  rememberRequest(messageId: string, chat: string, questionId: string, postedAt?: string): void {
    this.db
      .prepare(
        'INSERT INTO requests(message_id,chat,question_id,posted_at) VALUES(?,?,?,?) ON CONFLICT(message_id) DO NOTHING',
      )
      .run(messageId, chat, questionId, postedAt ?? null);
  }
  close(): void {
    this.db.close();
  }
}
