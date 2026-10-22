import { getMessagingGroup } from '../../db/messaging-groups.js';
import { untrusted, untrustedLine } from '../gws-ea-inbox/untrusted.js';
import type { Chat } from './db.js';
import { listChatMembers } from './roster.js';

/** Main sees names and member-authored fields only as source material. */
export async function renderChat(chat: Chat): Promise<string> {
  const group = await getMessagingGroup(chat.messaging_group_id);
  const members = await listChatMembers(chat.messaging_group_id);
  return [
    `Chat ${chat.messaging_group_id}: ${chat.state}; principal present: ${chat.principal_present === 1}; members: ${members.length}.`,
    untrustedLine(group?.name ?? 'Unnamed chat', 500, 'chat name'),
    ...members.map((member) =>
      [
        `Member ${member.member_key}; person: ${member.person_id ?? 'unresolved'}; verified principal: ${member.is_principal === 1}.`,
        untrusted([member.name, member.email].filter((field) => field !== null).join('\n'), 800, 'chat member'),
      ].join('\n'),
    ),
  ].join('\n');
}
