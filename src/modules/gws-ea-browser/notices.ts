import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';

/** Browser continuations are host chat turns; system rows are reserved for tool answers. */
export function writeBrowserNotice(session: Session, id: string, eventJson: string): Promise<void> {
  return writeSessionMessage(session.agent_group_id, session.id, {
    id,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    trigger: true,
    content: JSON.stringify({ text: eventJson, sender: 'system', senderId: 'system' }),
  });
}
