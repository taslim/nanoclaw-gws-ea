import { UNKNOWN_SENDER_POLICIES } from '../../types.js';
import { registerResource } from '../crud.js';

/**
 * Every reason the router or access gate records. Unknown-sender drops are
 * tagged with the messaging group's policy, so the list follows
 * UNKNOWN_SENDER_POLICIES.
 */
export const DROPPED_MESSAGE_REASONS = [
  'no_agent_wired',
  'no_agent_engaged',
  ...UNKNOWN_SENDER_POLICIES.map((policy) => `unknown_sender_${policy}` as const),
];

registerResource({
  name: 'dropped-message',
  plural: 'dropped-messages',
  table: 'unregistered_senders',
  description:
    "Dropped message log — tracks messages that were dropped by the router or access gate. Aggregates by (channel_type, platform_id, instance) with a running count. Reasons include: no_agent_wired (no wiring exists), no_agent_engaged (wiring exists but engage rules didn't fire), unknown_sender_<policy> (sender not recognized; the suffix is the messaging group's unknown_sender_policy, e.g. unknown_sender_strict, unknown_sender_request_approval, unknown_sender_decline_notify).",
  idColumn: 'channel_type',
  listOrder: 'last_seen DESC, channel_type, instance, platform_id',
  columns: [
    { name: 'channel_type', type: 'string', description: 'Channel adapter type of the dropped message.' },
    { name: 'platform_id', type: 'string', description: 'Platform chat ID where the message was dropped.' },
    { name: 'instance', type: 'string', description: 'Exact adapter instance that received the message.' },
    { name: 'user_id', type: 'string', description: 'Sender user ID if resolved, null otherwise.' },
    { name: 'sender_name', type: 'string', description: 'Sender display name if available.' },
    { name: 'sender_authenticated', type: 'number', description: '1 when the adapter authenticated the sender.' },
    { name: 'sender_kind', type: 'string', description: 'Authenticated sender kind: human, bot, or unknown.' },
    { name: 'is_group', type: 'number', description: '1 for a group conversation, 0 for a direct conversation.' },
    { name: 'authenticated_message_id', type: 'string', description: 'Adapter-authenticated source message ID.' },
    { name: 'authenticated_message_at', type: 'string', description: 'Canonical timestamp of authenticated evidence.' },
    {
      name: 'reason',
      type: 'string',
      description: 'Why the message was dropped.',
      enum: DROPPED_MESSAGE_REASONS,
    },
    { name: 'messaging_group_id', type: 'string', description: 'Messaging group ID if resolved.' },
    { name: 'agent_group_id', type: 'string', description: 'Target agent group ID if resolved.' },
    { name: 'message_count', type: 'number', description: 'Number of dropped messages from this sender on this chat.' },
    { name: 'first_seen', type: 'string', description: 'First drop timestamp.' },
    { name: 'last_seen', type: 'string', description: 'Most recent drop timestamp.' },
  ],
  operations: { list: 'open' },
});
