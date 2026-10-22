import { getDb } from '../../db/connection.js';

export type ChatState = 'asking' | 'connected' | 'moving' | 'job' | 'declined' | 'detached';
export interface Chat {
  readonly messaging_group_id: string;
  readonly state: ChatState;
  readonly serving_agent_group_id: string;
  readonly principal_present: number;
  readonly asking_notified_at: string | null;
  readonly connected_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}
export async function getChat(id: string): Promise<Chat | undefined> {
  if (!(await getDb().hasTable('gws_ea_chats'))) return undefined;
  return getDb().get<Chat>('SELECT * FROM gws_ea_chats WHERE messaging_group_id = ?', id);
}
export async function listChats(): Promise<Chat[]> {
  return getDb().all<Chat>('SELECT * FROM gws_ea_chats ORDER BY created_at, messaging_group_id');
}
export function chatIsActive(chat: Chat): boolean {
  return chat.state === 'connected' || chat.state === 'job';
}
/** Checked by native receive paths before attachment download; unrecorded and asking chats retain their media. */
export async function chatAcceptsInbound(channel: string, platformId: string): Promise<boolean> {
  const db = getDb();
  if (!(await db.hasTable('gws_ea_chats'))) return true;
  const chat = await db.get<{ state: ChatState }>(
    `SELECT c.state FROM gws_ea_chats c
    JOIN messaging_groups mg ON mg.id = c.messaging_group_id WHERE mg.channel_type = ? AND mg.platform_id = ?`,
    channel,
    platformId,
  );
  return chat?.state !== 'declined' && chat?.state !== 'detached';
}
