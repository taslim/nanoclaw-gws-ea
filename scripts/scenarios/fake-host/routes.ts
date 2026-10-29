import type { ScenarioComposition } from '../types.js';
import type { Session } from '../../../src/types.js';

/** The same host projection a native container reads on every wake. */
export async function projectSessionRoutes(
  session: Session,
): Promise<Pick<ScenarioComposition, 'destinations' | 'routing'>> {
  const { writeDestinations } = await import('../../../src/modules/agent-to-agent/write-destinations.js');
  const { writeSessionRouting } = await import('../../../src/session-manager.js');
  await writeDestinations(session.agent_group_id, session.id);
  await writeSessionRouting(session.agent_group_id, session.id);
  return readSessionRoutes(session);
}

export async function readSessionRoutes(
  session: Session,
): Promise<Pick<ScenarioComposition, 'destinations' | 'routing'>> {
  const Database = (await import('better-sqlite3')).default;
  const { inboundDbPath } = await import('../../../src/mailbox/sqlite/paths.js');
  const { parseDestinationRecord, parseSessionRoutingRecord } = await import('../../../src/mailbox/model.js');
  const inbox = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  try {
    return {
      destinations: inbox
        .prepare(
          'SELECT name,display_name AS displayName,type,channel_type AS channelType,platform_id AS platformId,agent_group_id AS agentGroupId,session_mode AS sessionMode FROM destinations ORDER BY name',
        )
        .all()
        .map(parseDestinationRecord),
      routing: parseSessionRoutingRecord(
        inbox
          .prepare(
            'SELECT channel_type AS channelType,platform_id AS platformId,thread_id AS threadId FROM session_routing WHERE id=1',
          )
          .get(),
      ),
    };
  } finally {
    inbox.close();
  }
}
