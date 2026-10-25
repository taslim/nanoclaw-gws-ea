import { getDb } from '../../db/connection.js';
import { identityMatchKey, normalizePrincipalEmail } from '../../gws-ea/validation.js';
import type { ForgottenPerson } from '../gws-ea-people/db.js';
import { isVerifiedPrincipalUser } from '../gws-ea-profile/db.js';

export interface ChatMemberFact {
  readonly key: string;
  readonly name?: string;
  readonly isPrincipal: boolean;
}
export interface ChatMember {
  readonly messaging_group_id: string;
  readonly member_key: string;
  readonly person_id: string | null;
  readonly name: string | null;
  readonly is_principal: number;
  readonly email: string | null;
  readonly email_source: 'main' | 'member' | null;
  readonly updated_at: string;
}
export function channelUserId(channel: string, id: string): string {
  return id.includes(':') ? id : `${channel}:${id}`;
}
export async function memberFact(channel: string, id: string, name?: string): Promise<ChatMemberFact> {
  const key = channelUserId(channel, id);
  return { key, ...(name === undefined ? {} : { name }), isPrincipal: await isVerifiedPrincipalUser(key) };
}
export async function personForMember(key: string): Promise<string | null> {
  const row = await getDb().get<{ person_id: string }>(
    'SELECT person_id FROM gws_ea_people_identities WHERE match_key = ?',
    identityMatchKey(key),
  );
  return row?.person_id ?? null;
}
export async function listChatMembers(chat: string): Promise<ChatMember[]> {
  return getDb().all<ChatMember>(
    'SELECT * FROM gws_ea_chat_members WHERE messaging_group_id = ? ORDER BY member_key',
    chat,
  );
}
export async function getChatMember(chat: string, key: string): Promise<ChatMember | undefined> {
  return getDb().get<ChatMember>(
    'SELECT * FROM gws_ea_chat_members WHERE messaging_group_id = ? AND member_key = ?',
    chat,
    key,
  );
}
async function writeMemberFact(chat: string, member: ChatMemberFact): Promise<void> {
  await getDb().run(
    `INSERT INTO gws_ea_chat_members
    (messaging_group_id, member_key, person_id, name, is_principal, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (messaging_group_id, member_key) DO UPDATE SET
      person_id = excluded.person_id, name = COALESCE(excluded.name, gws_ea_chat_members.name),
      is_principal = excluded.is_principal, updated_at = excluded.updated_at`,
    chat,
    member.key,
    await personForMember(member.key),
    member.name ?? null,
    Number(member.isPrincipal),
    new Date().toISOString(),
  );
}
/** An authenticated speaker is current membership evidence, even when a platform omitted its join event. */
export async function recordChatSpeaker(chat: string, member: ChatMemberFact): Promise<void> {
  await getDb().transaction(async () => {
    await writeMemberFact(chat, member);
    if (member.isPrincipal)
      await getDb().run(
        'UPDATE gws_ea_chats SET principal_present = 1, updated_at = ? WHERE messaging_group_id = ?',
        new Date().toISOString(),
        chat,
      );
  });
}
/** Replaces the stored roster with the platform's; a member still present keeps any email main or they supplied. */
export async function refreshChatRoster(chat: string, members: readonly ChatMemberFact[]): Promise<void> {
  await getDb().transaction(async () => {
    const keys = new Set(members.map((member) => member.key));
    for (const previous of await listChatMembers(chat)) {
      if (!keys.has(previous.member_key))
        await getDb().run(
          'DELETE FROM gws_ea_chat_members WHERE messaging_group_id = ? AND member_key = ?',
          chat,
          previous.member_key,
        );
    }
    for (const member of members) await writeMemberFact(chat, member);
    await getDb().run(
      'UPDATE gws_ea_chats SET principal_present = ?, updated_at = ? WHERE messaging_group_id = ?',
      Number(members.some((member) => member.isPrincipal)),
      new Date().toISOString(),
      chat,
    );
  });
}
/** Only a host handoff or the member's own admitted words may supply a roster email. */
export async function setChatMemberEmail(
  chat: string,
  key: string,
  value: string,
  source: 'main' | 'member',
): Promise<void> {
  const email = normalizePrincipalEmail(value);
  if (email === undefined) throw new Error('The member email is invalid.');
  const result = await getDb().run(
    `UPDATE gws_ea_chat_members SET email = ?, email_source = ?, updated_at = ?
    WHERE messaging_group_id = ? AND member_key = ? AND (? = 'main' OR email_source IS NULL OR email_source = 'member')`,
    email,
    source,
    new Date().toISOString(),
    chat,
    key,
    source,
  );
  if (result.changes === 0 && !(await getChatMember(chat, key)))
    throw new Error('The person is not a member of this chat.');
}
export async function forgetFromChatRosters(person: ForgottenPerson): Promise<void> {
  await getDb().transaction(async () => {
    await getDb().run('DELETE FROM gws_ea_chat_members WHERE person_id = ?', person.id);
    for (const handle of person.handles)
      await getDb().run('DELETE FROM gws_ea_chat_members WHERE member_key = ?', handle);
  });
}
