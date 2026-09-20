import { getDb } from './connection.js';

export interface UnregisteredSender {
  channel_type: string;
  platform_id: string;
  instance: string;
  user_id: string | null;
  sender_name: string | null;
  sender_authenticated: number;
  sender_kind: 'human' | 'bot' | 'unknown';
  is_group: number | null;
  authenticated_message_id: string | null;
  authenticated_message_at: string | null;
  reason: string;
  messaging_group_id: string | null;
  agent_group_id: string | null;
  message_count: number;
  first_seen: string;
  last_seen: string;
}

export async function recordDroppedMessage(msg: {
  channel_type: string;
  platform_id: string;
  instance?: string;
  user_id: string | null;
  sender_name: string | null;
  sender_authenticated?: boolean;
  sender_kind?: 'human' | 'bot' | 'unknown';
  is_group?: boolean;
  message_id?: string;
  message_timestamp?: string;
  reason: string;
  messaging_group_id: string | null;
  agent_group_id: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  const validMessageId =
    typeof msg.message_id === 'string' &&
    msg.message_id.length > 0 &&
    msg.message_id.length <= 256 &&
    ![...msg.message_id].some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code <= 0x1f || code === 0x7f);
    });
  const parsedMessageAt = msg.message_timestamp ? new Date(msg.message_timestamp) : null;
  const canonicalMessageAt =
    parsedMessageAt &&
    Number.isFinite(parsedMessageAt.getTime()) &&
    parsedMessageAt.toISOString() === msg.message_timestamp;
  const authenticated = msg.sender_authenticated === true && validMessageId && canonicalMessageAt;
  const authenticatedMessageAt = authenticated && parsedMessageAt ? parsedMessageAt.toISOString() : null;
  const values = {
    ...msg,
    instance: msg.instance ?? msg.channel_type,
    sender_authenticated: authenticated && authenticatedMessageAt !== null ? 1 : 0,
    sender_kind: authenticated && authenticatedMessageAt !== null ? (msg.sender_kind ?? 'unknown') : 'unknown',
    is_group: msg.is_group === undefined ? null : msg.is_group ? 1 : 0,
    authenticated_message_id: authenticated && authenticatedMessageAt !== null ? (msg.message_id ?? null) : null,
    authenticated_message_at: authenticatedMessageAt,
    now,
  };
  await getDb().run(
    `INSERT INTO unregistered_senders (
         channel_type, platform_id, instance, user_id, sender_name,
         sender_authenticated, sender_kind, is_group,
         authenticated_message_id, authenticated_message_at,
         reason, messaging_group_id, agent_group_id, message_count, first_seen, last_seen
       ) VALUES (
         @channel_type, @platform_id, @instance, @user_id, @sender_name,
         @sender_authenticated, @sender_kind, @is_group,
         @authenticated_message_id, @authenticated_message_at,
         @reason, @messaging_group_id, @agent_group_id, 1, @now, @now
       )
       ON CONFLICT (channel_type, platform_id, instance) DO UPDATE SET
         user_id = CASE WHEN excluded.sender_authenticated = 1 THEN excluded.user_id ELSE unregistered_senders.user_id END,
         sender_name = CASE WHEN excluded.sender_authenticated = 1 THEN excluded.sender_name ELSE COALESCE(unregistered_senders.sender_name, excluded.sender_name) END,
         sender_authenticated = MAX(unregistered_senders.sender_authenticated, excluded.sender_authenticated),
         sender_kind = CASE WHEN excluded.sender_authenticated = 1 THEN excluded.sender_kind ELSE unregistered_senders.sender_kind END,
         is_group = CASE WHEN excluded.sender_authenticated = 1 THEN excluded.is_group ELSE unregistered_senders.is_group END,
         authenticated_message_id = COALESCE(excluded.authenticated_message_id, unregistered_senders.authenticated_message_id),
         authenticated_message_at = COALESCE(excluded.authenticated_message_at, unregistered_senders.authenticated_message_at),
         reason = excluded.reason,
         messaging_group_id = COALESCE(excluded.messaging_group_id, unregistered_senders.messaging_group_id),
         agent_group_id = COALESCE(excluded.agent_group_id, unregistered_senders.agent_group_id),
         message_count = unregistered_senders.message_count + 1,
         last_seen = excluded.last_seen`,
    values,
  );
}

export async function getUnregisteredSenders(limit = 50): Promise<UnregisteredSender[]> {
  return getDb().all<UnregisteredSender>(
    'SELECT * FROM unregistered_senders ORDER BY last_seen DESC, channel_type, platform_id, instance LIMIT ?',
    limit,
  );
}
