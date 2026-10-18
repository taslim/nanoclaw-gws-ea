/** Live WhatsApp notices and binding refusals stay outside release snapshots with their acknowledged link. */
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { WhatsAppLinkNotice } from '../gws-ea-whatsapp/observers.js';
import { privateDatabaseFile, type WhatsAppLink } from '../gws-ea-whatsapp/paths.js';

export interface PendingWhatsAppNotice {
  readonly notice_id: string;
  readonly kind: WhatsAppLinkNotice['kind'];
  readonly created_at: string;
}

/** One short synchronous transaction per acceptance or receipt; network delivery never holds this store open. */
export class WhatsAppNoticeStore {
  private readonly db: Database.Database;

  constructor(directory: string) {
    this.db = new Database(privateDatabaseFile(directory, 'notices.sqlite'));
    this.db.pragma('journal_mode = DELETE');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notices (
        notice_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('needs-relink', 'principal-number-changed')),
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        principal_lid TEXT,
        principal_phone_jid TEXT,
        principal_verified_at TEXT
      );
    `);
  }

  accept(key: string, notice: WhatsAppLinkNotice): void {
    this.db
      .prepare(
        `
      INSERT INTO notices (notice_id, kind, created_at, principal_lid, principal_phone_jid, principal_verified_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (notice_id) DO NOTHING
    `,
      )
      .run(
        key,
        notice.kind,
        new Date().toISOString(),
        notice.link.principal?.lid ?? null,
        notice.link.principal?.phoneJid ?? null,
        notice.link.principalVerifiedAt ?? null,
      );
  }

  pending(): PendingWhatsAppNotice[] {
    return this.db
      .prepare<
        [],
        PendingWhatsAppNotice
      >('SELECT notice_id, kind, created_at FROM notices WHERE delivered_at IS NULL ORDER BY created_at, notice_id')
      .all();
  }

  delivered(id: string): void {
    this.db
      .prepare('UPDATE notices SET delivered_at = ? WHERE notice_id = ? AND delivered_at IS NULL')
      .run(new Date().toISOString(), id);
  }

  unavailable(link: WhatsAppLink): boolean {
    if (!link.principal?.phoneJid || !link.principalVerifiedAt) return false;
    return (
      this.db
        .prepare(
          `
      SELECT 1 FROM notices WHERE kind = 'principal-number-changed'
        AND principal_lid = ? AND principal_phone_jid = ? AND principal_verified_at = ? LIMIT 1
    `,
        )
        .get(link.principal.lid, link.principal.phoneJid, link.principalVerifiedAt) !== undefined
    );
  }

  close(): void {
    this.db.close();
  }
}

/** A profile read can happen before host-start callbacks, so the private receipt is authoritative immediately. */
export function whatsAppPrincipalUnavailable(directory: string, link: WhatsAppLink): boolean {
  if (!fs.existsSync(path.join(directory, 'notices.sqlite'))) return false;
  const store = new WhatsAppNoticeStore(directory);
  try {
    return store.unavailable(link);
  } finally {
    store.close();
  }
}
