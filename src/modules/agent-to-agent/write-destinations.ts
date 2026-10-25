/**
 * Project the agent's central `agent_destinations` rows into its per-session
 * `inbound.db` so the running container can resolve names locally. Called on
 * every container wake and after admin-time destination edits (e.g. create_agent).
 *
 * Core container-runner calls this via a dynamic import guarded by a
 * `hasTable('agent_destinations')` check — without the agent-to-agent module
 * installed, the central table doesn't exist and the projection is skipped.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import type { Destination } from '../../mailbox/index.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { withMailboxSession } from '../../session-manager.js';
import { getDestinations } from './db/agent-destinations.js';

/** A chat's own name is written by its members, so the session's name for its origin never uses it. */
const ORIGIN_NAME = 'this-chat';

export async function writeDestinations(agentGroupId: string, sessionId: string): Promise<void> {
  const rows = await getDestinations(agentGroupId);
  const resolved: Destination[] = [];

  for (const row of rows) {
    if (row.target_type === 'channel') {
      const mg = await getMessagingGroup(row.target_id);
      if (!mg) continue;
      resolved.push({
        name: row.local_name,
        displayName: mg.name ?? row.local_name,
        type: 'channel',
        channelType: mg.channel_type,
        platformId: mg.platform_id,
        agentGroupId: null,
      });
    } else if (row.target_type === 'agent') {
      const ag = await getAgentGroup(row.target_id);
      if (!ag) continue;
      resolved.push({
        name: row.local_name,
        displayName: ag.name,
        type: 'agent',
        channelType: null,
        platformId: null,
        agentGroupId: ag.id,
        sessionMode: row.session_mode ?? 'agent-shared',
      });
    }
  }

  // Delivery always lets a session reply to its own chat, so it can always name that chat, even when its
  // wiring grants the agent group no destination for it.
  const session = await getSession(sessionId);
  const origin = session?.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
  if (
    origin &&
    !resolved.some(
      (d) => d.type === 'channel' && d.channelType === origin.channel_type && d.platformId === origin.platform_id,
    )
  ) {
    let name = ORIGIN_NAME;
    for (let suffix = 2; resolved.some((d) => d.name === name); suffix++) name = `${ORIGIN_NAME}-${suffix}`;
    resolved.push({
      name,
      displayName: name,
      type: 'channel',
      channelType: origin.channel_type,
      platformId: origin.platform_id,
      agentGroupId: null,
    });
  }

  await withMailboxSession(agentGroupId, sessionId, (db) => {
    db.replaceDestinations(resolved);
  });
  log.debug('Destination map written', { sessionId, count: resolved.length });
}
