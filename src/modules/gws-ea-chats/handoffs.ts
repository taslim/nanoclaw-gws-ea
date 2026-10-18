import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { OutboundFile } from '../../channels/adapter.js';
import { DATA_DIR } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { listOpenMatterLinks } from '../gws-ea-matters/db.js';

export interface ChatHandoff {
  readonly id: string;
  readonly messaging_group_id: string;
  readonly message: string;
  readonly matter_id: string | null;
  readonly created_at: string;
  readonly delivered_session_id: string | null;
}
export interface ChatFile {
  readonly handoff_id: string;
  readonly file_name: string;
  readonly sha256: string;
  readonly host_path: string;
}
export async function chatMatterIds(chat: string): Promise<string[]> {
  if (!(await getDb().hasTable('gws_ea_matter_links'))) return [];
  return (await listOpenMatterLinks())
    .filter((link) => link.kind === 'chat' && link.reference === chat)
    .map((link) => link.matter_id);
}
export async function getChatCalendar(chat: string): Promise<string | null> {
  return (
    (
      await getDb().get<{ calendar_id: string | null }>(
        'SELECT calendar_id FROM gws_ea_chats WHERE messaging_group_id=?',
        chat,
      )
    )?.calendar_id ?? null
  );
}
export async function setChatCalendar(chat: string, calendar: string): Promise<void> {
  await getDb().run(
    'UPDATE gws_ea_chats SET calendar_id=?,updated_at=? WHERE messaging_group_id=?',
    calendar,
    new Date().toISOString(),
    chat,
  );
}
export async function chatIsPlaced(chat: string): Promise<boolean> {
  const row = await getDb().get<{ placed_nowhere: number }>(
    'SELECT placed_nowhere FROM gws_ea_chats WHERE messaging_group_id=?',
    chat,
  );
  return row?.placed_nowhere === 1 || (await chatMatterIds(chat)).length > 0;
}
export async function listChatHandoffs(chat: string, pendingOnly = false): Promise<ChatHandoff[]> {
  return getDb().all<ChatHandoff>(
    `SELECT * FROM gws_ea_chat_handoffs WHERE messaging_group_id=? ${pendingOnly ? 'AND delivered_session_id IS NULL' : ''} ORDER BY created_at,id`,
    chat,
  );
}
export async function chatFiles(chat: string): Promise<ChatFile[]> {
  return getDb().all<ChatFile>(
    `SELECT f.* FROM gws_ea_chat_files f JOIN gws_ea_chat_handoffs h ON h.id=f.handoff_id WHERE h.messaging_group_id=? ORDER BY h.created_at,f.file_name`,
    chat,
  );
}
/** Persist only bytes read from the calling request's outbox; moving chats can deliver them after cutover. */
export async function recordChatHandoff(
  handoff: Omit<ChatHandoff, 'delivered_session_id'>,
  files: readonly OutboundFile[],
): Promise<void> {
  const directory = path.join(DATA_DIR, 'gws-ea-chats', 'handoffs', handoff.id);
  for (const file of files) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, file.filename), file.data, { mode: 0o600 });
  }
  await getDb().run(
    `INSERT INTO gws_ea_chat_handoffs(id,messaging_group_id,message,matter_id,created_at) VALUES(@id,@messaging_group_id,@message,@matter_id,@created_at) ON CONFLICT(id) DO NOTHING`,
    handoff,
  );
  for (const file of files)
    await getDb().run(
      `INSERT INTO gws_ea_chat_files(handoff_id,file_name,sha256,host_path) VALUES(?,?,?,?) ON CONFLICT(handoff_id,file_name) DO NOTHING`,
      handoff.id,
      file.filename,
      createHash('sha256').update(file.data).digest('hex'),
      path.join(directory, file.filename),
    );
}
export async function filesForHandoff(id: string): Promise<OutboundFile[]> {
  const files = await getDb().all<ChatFile>(
    'SELECT * FROM gws_ea_chat_files WHERE handoff_id=? ORDER BY file_name',
    id,
  );
  return files.map((file) => ({ filename: file.file_name, data: fs.readFileSync(file.host_path) }));
}
