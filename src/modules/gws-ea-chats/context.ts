import { createHash } from 'node:crypto';
import { getDb } from '../../db/connection.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { untrustedLine } from '../gws-ea-inbox/untrusted.js';
import { isDuplicateNote } from '../gws-ea-profile/main-note.js';
import { getChat } from './db.js';
import { chatMatterIds, getChatCalendar, listChatHandoffs } from './handoffs.js';
import { listChatMembers } from './roster.js';

/** Current chat facts, with exactly one field from a resolved person: their level. */
export async function renderChatContext(chatId: string): Promise<string> {
  const chat = await getChat(chatId);
  const group = await getMessagingGroup(chatId);
  if (!chat || !group) throw new Error('The chat does not exist.');
  const members = await listChatMembers(chatId);
  const calendar = await getChatCalendar(chatId);
  const personIds = [...new Set(members.flatMap((member) => (member.person_id === null ? [] : [member.person_id])))];
  const levels = new Map(
    personIds.length === 0
      ? []
      : (
          await getDb().all<{ id: string; level: string }>(
            `SELECT id,level FROM gws_ea_people WHERE id IN (${personIds.map(() => '?').join(',')})`,
            ...personIds,
          )
        ).map((person) => [person.id, person.level]),
  );
  const lines = [
    `You are working in chat ${chatId}. Principal present: ${chat.principal_present === 1}.`,
    untrustedLine(group.name ?? 'Unnamed chat', 500, 'chat name'),
    `Booking calendar: ${calendar === null ? 'not set' : 'set'}.`,
  ];
  for (const member of members) {
    const level = member.person_id === null ? undefined : levels.get(member.person_id);
    lines.push(
      `Member ${member.member_key}; verified principal: ${member.is_principal === 1}; level: ${level ?? 'unknown'}.`,
      untrustedLine(member.name ?? 'Unnamed member', 500, 'chat member name'),
    );
  }
  const matters = await chatMatterIds(chatId);
  lines.push(
    `Open matter keys: ${matters.length === 0 ? 'none' : matters.join(', ')}. Use a key with tell_main when more than one is open.`,
  );
  for (const handoff of await listChatHandoffs(chatId))
    lines.push(`From main${handoff.matter_id === null ? '' : ` for matter ${handoff.matter_id}`}:\n${handoff.message}`);
  return lines.join('\n');
}
function withoutUntrustedWrapperNonces(text: string): string {
  return text.replace(/^(<<<(?:END_)?EXTERNAL_UNTRUSTED_CONTENT) id="[0-9a-f]+"(>>>)$/gmu, '$1$2');
}

const contextTails = new Map<string, Promise<void>>();

/**
 * Host-owned context is written without a wake, and only when the chat's
 * facts differ from the last facts this session was told. Facts that change
 * back are told again under a new version, so the newest context row is
 * always the current one. Writes for one session run in order, and a write
 * repeated after a stop between the row and its record lands once.
 */
export async function writeChatContext(session: Session): Promise<void> {
  const previous = contextTails.get(session.id) ?? Promise.resolve();
  const result = previous.then(() => writeCurrentChatContext(session));
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  contextTails.set(session.id, tail);
  try {
    await result;
  } finally {
    if (contextTails.get(session.id) === tail) contextTails.delete(session.id);
  }
}

async function writeCurrentChatContext(session: Session): Promise<void> {
  const id = session.messaging_group_id;
  if (id === null) return;
  const chat = await getChat(id);
  if (!chat || chat.serving_agent_group_id !== session.agent_group_id) return;
  const text = await renderChatContext(id);
  const fingerprint = createHash('sha256').update(withoutUntrustedWrapperNonces(text)).digest('hex');
  const told = await getDb().get<{ fingerprint: string; version: number }>(
    'SELECT fingerprint,version FROM gws_ea_chat_contexts WHERE session_id = ?',
    session.id,
  );
  if (told?.fingerprint === fingerprint) return;
  const version = (told?.version ?? 0) + 1;
  const writtenAt = new Date().toISOString();
  try {
    await writeSessionMessage(session.agent_group_id, session.id, {
      id: `chat-context-${version}-${fingerprint}`,
      kind: 'chat',
      timestamp: writtenAt,
      content: JSON.stringify({ sender: 'system', text }),
      trigger: false,
    });
  } catch (error) {
    if (!isDuplicateNote(error)) throw error;
  }
  await getDb().run(
    `INSERT INTO gws_ea_chat_contexts (session_id,fingerprint,version,written_at) VALUES (?,?,?,?)
     ON CONFLICT(session_id) DO UPDATE SET fingerprint=excluded.fingerprint,version=excluded.version,written_at=excluded.written_at`,
    session.id,
    fingerprint,
    version,
    writtenAt,
  );
}
