import { extractInboundContent } from '../../channels/inbound-content.js';
import { getDb } from '../../db/connection.js';
import type { DbDriver } from '../../db/driver.js';
import { isRecord } from '../../gws-ea/validation.js';
import type { InboundPreparationRequest } from '../../inbound-preparation.js';
import { isVerifiedPrincipalUser, recordPrincipalDmActivity } from './db.js';

export const PRINCIPAL_MESSAGE_LIFETIME_MS = 24 * 60 * 60 * 1_000;

/** The principal's message with recording provenance, without forwarded or quoted material. */
export interface PrincipalMessage {
  readonly id: string;
  readonly messagingGroupId: string;
  readonly userId: string;
  readonly timestamp: string;
  readonly text: string;
}

function principalMessageText(content: Record<string, unknown>): string {
  const text = typeof content.text === 'string' && content.text.trim() ? content.text : '';
  const recordings: Record<string, unknown>[] = [];
  if (Array.isArray(content.attachments)) {
    for (const attachment of content.attachments) {
      if (!isRecord(attachment)) continue;
      const source = isRecord(attachment.audioSource) ? attachment.audioSource : undefined;
      const speech = isRecord(attachment.speech) ? attachment.speech : undefined;
      if (source?.forwarded === true || source?.quoted === true) continue;
      if (speech?.status === 'recognized' && typeof speech.text === 'string' && speech.text.trim()) {
        recordings.push(attachment);
      }
    }
  }
  return extractInboundContent({ text, attachments: recordings }).text;
}

/** Registered after voice preparation: only the authenticated transport sender can earn this mark. */
export async function preparePrincipalMessageContent(request: InboundPreparationRequest): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.content) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return request.content;
    throw error;
  }
  if (!isRecord(parsed)) return request.content;
  const hadMetadata = 'principalMessage' in parsed || 'authenticatedSender' in parsed;
  delete parsed.principalMessage;
  delete parsed.authenticatedSender;
  if (request.authenticatedSender !== undefined) parsed.authenticatedSender = { ...request.authenticatedSender };
  const clean = (): string =>
    hadMetadata || request.authenticatedSender !== undefined ? JSON.stringify(parsed) : request.content;
  const db = getDb();
  if (!(await db.hasTable('gws_ea_principal_messages'))) return clean();
  const now = Date.now();
  await db.run(
    'DELETE FROM gws_ea_principal_messages WHERE timestamp < ?',
    new Date(now - PRINCIPAL_MESSAGE_LIFETIME_MS).toISOString(),
  );
  const sender = request.authenticatedSender;
  const rawUserId = sender?.userId ?? '';
  const userId = rawUserId.includes(':') ? rawUserId : `${request.channelType}:${rawUserId}`;
  const quote = isRecord(parsed.replyTo) ? parsed.replyTo : undefined;
  if (
    sender?.kind !== 'human' ||
    parsed.forwarded === true ||
    quote?.forwarded === true ||
    parsed.quoted === true ||
    parsed.reaction !== undefined ||
    !(await isVerifiedPrincipalUser(userId))
  )
    return clean();
  const text = principalMessageText(parsed);
  const received = Date.parse(request.timestamp);
  if (!text || !Number.isFinite(received) || received > now || now - received > PRINCIPAL_MESSAGE_LIFETIME_MS) {
    return clean();
  }
  // Native inbound dedup can retry preparation. The first words and time
  // remain authoritative; a retry can neither replace nor refresh them.
  await db.transaction(async () => {
    const inserted = await db.run(
      `INSERT INTO gws_ea_principal_messages (message_id, messaging_group_id, user_id, timestamp, text)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (messaging_group_id, message_id) DO NOTHING`,
      request.messageId,
      request.messagingGroup.id,
      userId,
      new Date(received).toISOString(),
      text,
    );
    if (inserted.changes > 0)
      await recordPrincipalDmActivity(userId, request.messagingGroup.id, new Date(received).toISOString());
  });
  parsed.principalMessage = { id: request.messageId, messagingGroupId: request.messagingGroup.id };
  return JSON.stringify(parsed);
}

/** A cited platform id is authority only for its own chat, for at most 24 hours. */
export async function requirePrincipalMessage(
  id: string,
  messagingGroupId: string,
  maxAgeMs: number = PRINCIPAL_MESSAGE_LIFETIME_MS,
  db: DbDriver = getDb(),
): Promise<PrincipalMessage> {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new Error('Principal message age is invalid.');
  const row = (await db.hasTable('gws_ea_principal_messages'))
    ? await db.get<PrincipalMessage>(
        `SELECT m.message_id AS id, m.messaging_group_id AS messagingGroupId,
              m.user_id AS userId, m.timestamp, m.text
         FROM gws_ea_principal_messages m
         JOIN gws_ea_principal_users p ON p.user_id = m.user_id
        WHERE m.message_id = ? AND m.messaging_group_id = ?`,
        id,
        messagingGroupId,
      )
    : undefined;
  const age = row === undefined ? Number.NaN : Date.now() - Date.parse(row.timestamp);
  if (!row || !Number.isFinite(age) || age < 0 || age > Math.min(maxAgeMs, PRINCIPAL_MESSAGE_LIFETIME_MS)) {
    throw new Error('Cite the principal’s own recent, unforwarded message from this chat.');
  }
  return row;
}

/** Resolve a consent id to its unique, still-bound principal DM without guessing its source chat. */
export async function requirePrincipalDirectMessage(
  id: string,
  maxAgeMs: number = PRINCIPAL_MESSAGE_LIFETIME_MS,
  db: DbDriver = getDb(),
): Promise<PrincipalMessage> {
  const matches = (await db.hasTable('gws_ea_principal_messages'))
    ? await db.all<{ messaging_group_id: string }>(
        `SELECT m.messaging_group_id
         FROM gws_ea_principal_messages m
         JOIN messaging_groups mg ON mg.id = m.messaging_group_id
         JOIN user_dms dm ON dm.messaging_group_id = mg.id AND dm.user_id = m.user_id
                        AND dm.channel_type = mg.channel_type
         JOIN gws_ea_principal_users p ON p.user_id = m.user_id
        WHERE m.message_id = ? AND mg.is_group = 0`,
        id,
      )
    : [];
  if (matches.length !== 1)
    throw new Error('Cite the principal’s own message from their verified direct conversation.');
  return requirePrincipalMessage(id, matches[0].messaging_group_id, maxAgeMs, db);
}
