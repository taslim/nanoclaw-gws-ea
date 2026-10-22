import Database from 'better-sqlite3';
import { BufferJSON, proto, type WAMessage } from '@whiskeysockets/baileys';

import { OutboundRefusedError } from '../../delivery.js';
import { privateDatabaseFile } from './paths.js';

export interface IndexedMessage {
  readonly chat: string;
  readonly id: string;
  readonly sender: string;
  /** In a group, the member's address exactly as WhatsApp keyed the message; a reaction must name it. */
  readonly participant?: string;
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
  participant: string | null;
  from_me: number;
  forwarded: number;
  text: string;
  at: number;
  routed: number;
}
export interface PendingSend {
  readonly rowId: string;
  readonly account: string;
  readonly chat: string;
  readonly createdAt: number;
  readonly accepted: boolean;
  readonly messageId: string;
}
interface SendRow {
  row_id: string;
  account: string;
  chat: string;
  created_at: number;
  accepted: number;
  message_id: string;
}

function sendRecord(row: SendRow | undefined): PendingSend | undefined {
  return row === undefined
    ? undefined
    : {
        rowId: row.row_id,
        account: row.account,
        chat: row.chat,
        createdAt: row.created_at,
        accepted: row.accepted === 1,
        messageId: row.message_id,
      };
}

export class WhatsAppIndex {
  private readonly db: Database.Database;
  constructor(
    directory: string,
    private readonly currentAccount: () => string,
  ) {
    this.db = new Database(privateDatabaseFile(directory, 'messages.sqlite'));
    this.db.pragma('journal_mode = DELETE');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS intake(account TEXT NOT NULL,chat TEXT NOT NULL,id TEXT NOT NULL,raw TEXT NOT NULL,PRIMARY KEY(account,chat,id));
      CREATE TABLE IF NOT EXISTS held_intake(account TEXT NOT NULL,chat TEXT NOT NULL,id TEXT NOT NULL,lid TEXT NOT NULL,PRIMARY KEY(account,chat,id));
      CREATE TABLE IF NOT EXISTS messages(account TEXT NOT NULL,chat TEXT NOT NULL,id TEXT NOT NULL,sender TEXT NOT NULL,participant TEXT,from_me INTEGER NOT NULL,forwarded INTEGER NOT NULL,text TEXT NOT NULL,at INTEGER NOT NULL,routed INTEGER NOT NULL,raw TEXT,wire TEXT,PRIMARY KEY(account,chat,id));
      CREATE INDEX IF NOT EXISTS messages_prune ON messages(at) WHERE from_me=0 AND routed=1;
      CREATE TABLE IF NOT EXISTS pending_sends(row_id TEXT PRIMARY KEY,account TEXT NOT NULL,chat TEXT NOT NULL,created_at INTEGER NOT NULL,accepted INTEGER NOT NULL DEFAULT 0,message_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS completed_sends(row_id TEXT PRIMARY KEY,account TEXT NOT NULL,chat TEXT NOT NULL,created_at INTEGER NOT NULL,accepted INTEGER NOT NULL CHECK(accepted=1),message_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(account TEXT NOT NULL,message_id TEXT NOT NULL,chat TEXT NOT NULL,question_id TEXT NOT NULL,posted_at TEXT,PRIMARY KEY(account,message_id));
      CREATE TABLE IF NOT EXISTS aliases(account TEXT NOT NULL,phone TEXT NOT NULL,lid TEXT NOT NULL,PRIMARY KEY(account,phone),UNIQUE(account,lid));
      CREATE TABLE IF NOT EXISTS names(account TEXT NOT NULL,jid TEXT NOT NULL,name TEXT NOT NULL,PRIMARY KEY(account,jid));
    `);
  }
  private account(): string {
    const account = this.currentAccount();
    if (!/^\d+@s\.whatsapp\.net$/u.test(account))
      throw new Error('WhatsApp message state requires the linked phone account');
    return account;
  }
  message(chat: string, id: string): IndexedMessage | undefined {
    const row = this.db
      .prepare(
        'SELECT chat,id,sender,participant,from_me,forwarded,text,at,routed FROM messages WHERE account=? AND chat=? AND id=?',
      )
      .get(this.account(), chat, id) as MessageRow | undefined;
    return row === undefined
      ? undefined
      : {
          chat: row.chat,
          id: row.id,
          sender: row.sender,
          ...(row.participant === null ? {} : { participant: row.participant }),
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
        'INSERT INTO messages(account,chat,id,sender,participant,from_me,forwarded,text,at,routed,raw) VALUES(?,?,?,?,?,?,?,?,?,0,?) ON CONFLICT(account,chat,id) DO NOTHING',
      )
      .run(
        this.account(),
        message.chat,
        message.id,
        message.sender,
        message.participant ?? null,
        Number(message.fromMe),
        Number(message.forwarded),
        message.text,
        message.at,
        JSON.stringify(raw, BufferJSON.replacer),
      );
  }
  intake(raw: WAMessage): void {
    if (!raw.key.remoteJid || !raw.key.id || raw.key.fromMe || !raw.message || raw.key.remoteJid.endsWith('@broadcast'))
      return;
    this.db
      .prepare('INSERT INTO intake(account,chat,id,raw) VALUES(?,?,?,?) ON CONFLICT(account,chat,id) DO NOTHING')
      .run(this.account(), raw.key.remoteJid, raw.key.id, JSON.stringify(raw, BufferJSON.replacer));
  }
  finishIntake(rawChat: string, id: string): void {
    const account = this.account();
    this.db.prepare('DELETE FROM intake WHERE account=? AND chat=? AND id=?').run(account, rawChat, id);
    this.db.prepare('DELETE FROM held_intake WHERE account=? AND chat=? AND id=?').run(account, rawChat, id);
  }
  routed(chat: string, id: string, rawChat = chat): void {
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE messages SET routed=1,raw=NULL WHERE account=? AND chat=? AND id=?')
        .run(this.account(), chat, id);
      this.finishIntake(rawChat, id);
    })();
  }
  hasUnrouted(): boolean {
    return (
      this.db
        .prepare(
          'SELECT 1 FROM intake i WHERE i.account=? AND NOT EXISTS(SELECT 1 FROM held_intake h WHERE h.account=i.account AND h.chat=i.chat AND h.id=i.id) LIMIT 1',
        )
        .get(this.account()) !== undefined
    );
  }
  unrouted(): WAMessage[] {
    const rows = this.db
      .prepare(
        'SELECT i.raw FROM intake i WHERE i.account=? AND NOT EXISTS(SELECT 1 FROM held_intake h WHERE h.account=i.account AND h.chat=i.chat AND h.id=i.id) ORDER BY i.rowid',
      )
      .all(this.account()) as { raw: string }[];
    return rows.map(({ raw }) => {
      const stored = JSON.parse(raw, BufferJSON.reviver) as WAMessage;
      const parsed = proto.WebMessageInfo.fromObject(stored);
      if (!parsed.key) throw new Error('WhatsApp inbox record has no message key');
      // These authenticated Baileys aliases are WAMessageKey extensions, absent from the protobuf schema.
      return {
        ...parsed,
        key: {
          ...parsed.key,
          ...(stored.key.remoteJidAlt !== undefined ? { remoteJidAlt: stored.key.remoteJidAlt } : {}),
          ...(stored.key.participantAlt !== undefined ? { participantAlt: stored.key.participantAlt } : {}),
        },
      };
    });
  }
  hold(rawChat: string, id: string, lid: string): void {
    this.db
      .prepare('INSERT INTO held_intake(account,chat,id,lid) VALUES(?,?,?,?) ON CONFLICT(account,chat,id) DO NOTHING')
      .run(this.account(), rawChat, id, lid);
  }
  releaseHeld(lid: string): void {
    this.db.prepare('DELETE FROM held_intake WHERE account=? AND lid=?').run(this.account(), lid);
  }
  /** Abandon an unlinked account's queued input after transport quiescence, retaining handed-off message receipts. */
  discardUnrouted(): void {
    const account = this.account();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM intake WHERE account=?').run(account);
      this.db.prepare('DELETE FROM held_intake WHERE account=?').run(account);
      this.db.prepare('DELETE FROM messages WHERE account=? AND from_me=0 AND routed=0').run(account);
    })();
  }
  wireMessage(chat: string, id: string): proto.IMessage | undefined {
    const row = this.db
      .prepare('SELECT wire,text FROM messages WHERE account=? AND chat=? AND id=?')
      .get(this.account(), chat, id) as { wire: string | null; text: string } | undefined;
    if (!row) return undefined;
    return row.wire
      ? proto.Message.fromObject(JSON.parse(row.wire, BufferJSON.reviver) as Record<string, unknown>)
      : { conversation: row.text };
  }
  edit(chat: string, id: string, text: string): void {
    this.db
      .prepare('UPDATE messages SET text=? WHERE account=? AND chat=? AND id=?')
      .run(text, this.account(), chat, id);
  }
  sent(message: Omit<IndexedMessage, 'routed'>, wire?: proto.IMessage | null): void {
    this.db
      .prepare(
        'INSERT INTO messages(account,chat,id,sender,from_me,forwarded,text,at,routed,wire) VALUES(?,?,?,?,1,?,?,?,1,?) ON CONFLICT(account,chat,id) DO UPDATE SET sender=excluded.sender,text=excluded.text,from_me=1,routed=1,raw=NULL,wire=excluded.wire',
      )
      .run(
        this.account(),
        message.chat,
        message.id,
        message.sender,
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
    const account = this.account();
    this.db.transaction(() => {
      for (const table of ['messages', 'pending_sends', 'requests', 'intake', 'held_intake'])
        this.db.prepare(`DELETE FROM ${table} WHERE account=? AND chat=?`).run(account, chat);
    })();
  }
  pending(rowId: string): PendingSend | undefined {
    const row = this.db.prepare('SELECT * FROM pending_sends WHERE row_id=?').get(rowId) as SendRow | undefined;
    return sendRecord(row);
  }
  prepare(rowId: string, chat: string, messageId: string, at: number): PendingSend {
    const account = this.account();
    this.db
      .prepare(
        'INSERT INTO pending_sends(row_id,account,chat,message_id,created_at) SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM completed_sends WHERE row_id=?) ON CONFLICT(row_id) DO NOTHING',
      )
      .run(rowId, account, chat, messageId, at, rowId);
    const row = this.db
      .prepare(
        'SELECT * FROM pending_sends WHERE row_id=? UNION ALL SELECT * FROM completed_sends WHERE row_id=? LIMIT 1',
      )
      .get(rowId, rowId) as SendRow | undefined;
    const held = sendRecord(row);
    if (!held || held.chat !== chat || held.messageId !== messageId)
      throw new Error('WhatsApp outbound row changed address');
    if (held.account !== account && !held.accepted)
      throw new OutboundRefusedError(
        'gws-ea-whatsapp:account-changed',
        'This message was queued for a different WhatsApp account. Check whether it is still wanted before sending a new message.',
      );
    return held;
  }
  accepted(rowId: string): void {
    this.db.prepare('UPDATE pending_sends SET accepted=1 WHERE row_id=?').run(rowId);
  }
  complete(rowId: string): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO completed_sends SELECT * FROM pending_sends WHERE row_id=? AND accepted=1 ON CONFLICT(row_id) DO NOTHING',
        )
        .run(rowId);
      this.db.prepare('DELETE FROM pending_sends WHERE row_id=?').run(rowId);
    })();
  }
  alias(lid: string, phone: string): void {
    const account = this.account();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM aliases WHERE account=? AND lid=? AND phone<>?').run(account, lid, phone);
      this.db
        .prepare(
          'INSERT INTO aliases(account,phone,lid) VALUES(?,?,?) ON CONFLICT(account,phone) DO UPDATE SET lid=excluded.lid',
        )
        .run(account, phone, lid);
    })();
  }
  lid(phone: string): string | undefined {
    return (
      this.db.prepare('SELECT lid FROM aliases WHERE account=? AND phone=?').get(this.account(), phone) as
        | { lid: string }
        | undefined
    )?.lid;
  }
  phone(lid: string): string | undefined {
    return (
      this.db.prepare('SELECT phone FROM aliases WHERE account=? AND lid=?').get(this.account(), lid) as
        | { phone: string }
        | undefined
    )?.phone;
  }
  name(jid: string): string | undefined {
    return (
      this.db.prepare('SELECT name FROM names WHERE account=? AND jid=?').get(this.account(), jid) as
        | { name: string }
        | undefined
    )?.name;
  }
  rememberName(jid: string, name: string): void {
    this.db
      .prepare(
        'INSERT INTO names(account,jid,name) VALUES(?,?,?) ON CONFLICT(account,jid) DO UPDATE SET name=excluded.name',
      )
      .run(this.account(), jid, name);
  }
  request(messageId: string): { questionId: string; platformId: string; postedAt?: string } | undefined {
    const row = this.db
      .prepare('SELECT question_id,chat,posted_at FROM requests WHERE account=? AND message_id=?')
      .get(this.account(), messageId) as { question_id: string; chat: string; posted_at: string | null } | undefined;
    return row
      ? { questionId: row.question_id, platformId: row.chat, ...(row.posted_at ? { postedAt: row.posted_at } : {}) }
      : undefined;
  }
  requestMessage(questionId: string, chat: string): string | undefined {
    return (
      this.db
        .prepare(
          'SELECT message_id FROM requests WHERE account=? AND question_id=? AND chat=? ORDER BY rowid DESC LIMIT 1',
        )
        .get(this.account(), questionId, chat) as { message_id: string } | undefined
    )?.message_id;
  }
  rememberRequest(messageId: string, chat: string, questionId: string, postedAt?: string): void {
    this.db
      .prepare(
        'INSERT INTO requests(account,message_id,chat,question_id,posted_at) VALUES(?,?,?,?,?) ON CONFLICT(account,message_id) DO NOTHING',
      )
      .run(this.account(), messageId, chat, questionId, postedAt ?? null);
  }
  close(): void {
    this.db.close();
  }
}
