import { getDb } from '../../db/connection.js';
import type { DbDriver } from '../../db/driver.js';
import { requirePrincipalMessage } from '../gws-ea-profile/marks.js';
import type { PrivateValueReference } from './outbound.js';

const ACTIVE_CHAT_STATES = ['connected', 'moving', 'job'];

async function activeChat(messagingGroupId: string, db: DbDriver): Promise<boolean> {
  if (!(await db.hasTable('gws_ea_chats'))) return false;
  const row = await db.get<{ state: string }>(
    'SELECT state FROM gws_ea_chats WHERE messaging_group_id = ?',
    messagingGroupId,
  );
  return row !== undefined && ACTIVE_CHAT_STATES.includes(row.state);
}

/** Authorized only by the principal's own message in this chat; each reference must match a stored value. */
export async function recordChatClearances(
  input: {
    readonly messagingGroupId: string;
    readonly principalMessageId: string;
    readonly values: readonly PrivateValueReference[];
  },
  db: DbDriver = getDb(),
): Promise<void> {
  await db.transaction(async () => {
    await requirePrincipalMessage(input.principalMessageId, input.messagingGroupId, undefined, db);
    if (!(await activeChat(input.messagingGroupId, db))) throw new Error('This chat is not connected.');
    for (const value of input.values) {
      const stored = await db.get<{ kind: string }>('SELECT kind FROM gws_ea_private_values WHERE id = ?', value.id);
      if (stored?.kind !== value.kind) throw new Error('The private value reference does not match a stored value.');
    }
    const now = new Date().toISOString();
    for (const value of input.values) {
      await db.run(
        `INSERT INTO gws_ea_chat_clearances (messaging_group_id, private_value_id, principal_message_id, cleared_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (messaging_group_id, private_value_id) DO NOTHING`,
        input.messagingGroupId,
        value.id,
        input.principalMessageId,
        now,
      );
    }
  });
}

/** DB-only so detach removes these grants atomically with the chat transition. */
export async function deleteChatClearances(messagingGroupId: string, db: DbDriver = getDb()): Promise<void> {
  if (await db.hasTable('gws_ea_chat_clearances')) {
    await db.run('DELETE FROM gws_ea_chat_clearances WHERE messaging_group_id = ?', messagingGroupId);
  }
}

/** A chat's grants remain usable through cutover, and nowhere outside its active lifetime. */
export async function clearedPrivateValueIds(
  messagingGroupId: string,
  db: DbDriver = getDb(),
): Promise<ReadonlySet<string>> {
  if (!(await db.hasTable('gws_ea_chat_clearances')) || !(await activeChat(messagingGroupId, db))) return new Set();
  const rows = await db.all<{ private_value_id: string }>(
    'SELECT private_value_id FROM gws_ea_chat_clearances WHERE messaging_group_id = ?',
    messagingGroupId,
  );
  return new Set(rows.map((row) => row.private_value_id));
}
