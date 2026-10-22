import { getDb } from '../../db/connection.js';

export interface ChatLinkState {
  readonly name: string | null;
  readonly state: string;
  readonly serving_agent_group_id: string;
  readonly member_count: number;
}

/** A registered chat as its host records say it is now, absent when the chat module is not installed. */
export async function readChatLink(messagingGroupId: string): Promise<ChatLinkState | undefined> {
  const db = getDb();
  if (!(await db.hasTable('gws_ea_chats'))) return undefined;
  const chat = await db.get<Omit<ChatLinkState, 'member_count'>>(
    `SELECT groups.name, chats.state, chats.serving_agent_group_id
       FROM gws_ea_chats chats JOIN messaging_groups groups ON groups.id = chats.messaging_group_id
      WHERE chats.messaging_group_id = ?`,
    messagingGroupId,
  );
  if (chat === undefined) return undefined;
  const members = await db.get<{ readonly count: number }>(
    'SELECT COUNT(*) AS count FROM gws_ea_chat_members WHERE messaging_group_id = ?',
    messagingGroupId,
  );
  return { ...chat, member_count: members?.count ?? 0 };
}

/** The people whose identities the host has resolved in this chat's roster. */
export async function chatMemberPeople(messagingGroupId: string): Promise<readonly string[]> {
  const db = getDb();
  if (!(await db.hasTable('gws_ea_chat_members'))) return [];
  const rows = await db.all<{ readonly person_id: string }>(
    'SELECT DISTINCT person_id FROM gws_ea_chat_members WHERE messaging_group_id = ? AND person_id IS NOT NULL',
    messagingGroupId,
  );
  return rows.map((row) => row.person_id);
}

/** Chat keys whose roster holds a person, read before that person's forget hooks remove the roster entry. */
export async function chatsWithPerson(personId: string): Promise<ReadonlySet<string>> {
  const db = getDb();
  if (!(await db.hasTable('gws_ea_chat_members'))) return new Set();
  const rows = await db.all<{ readonly messaging_group_id: string }>(
    'SELECT DISTINCT messaging_group_id FROM gws_ea_chat_members WHERE person_id = ?',
    personId,
  );
  return new Set(rows.map((row) => row.messaging_group_id));
}
