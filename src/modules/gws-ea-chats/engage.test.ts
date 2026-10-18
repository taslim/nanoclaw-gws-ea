import { afterEach, expect, it, vi } from 'vitest';
const { ROOT } = vi.hoisted(() => ({ ROOT: `/tmp/chat-engage-u11-${process.pid}` }));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
}));
import { decideChatEngagement, registerExpectedChatReplyReader } from './engage.js';
import { cleanU11, seedU11 } from './testing/u11-fixture.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getDb } from '../../db/connection.js';
import type { MessagingGroupAgent } from '../../types.js';
import type { EngagementDecisionRequest } from '../../router.js';
const expected = new Set<string>();
registerExpectedChatReplyReader('u11:consume', async (_chat, user) => expected.delete(user));
afterEach(async () => {
  expected.clear();
  await cleanU11(ROOT);
});
it('consumes a named answer even when its mention already wakes the assistant', async () => {
  const { chat, session } = await seedU11();
  const group = await getMessagingGroup(chat.messaging_group_id);
  if (!group) throw new Error('No chat group');
  const wiring = await getDb().get<MessagingGroupAgent>(
    'SELECT * FROM messaging_group_agents WHERE messaging_group_id=?',
    group.id,
  );
  if (!wiring) throw new Error('No wiring');
  const request = (text: string): EngagementDecisionRequest => ({
    messagingGroup: group,
    session,
    wiring,
    event: {
      channelType: 'whatsapp',
      platformId: group.platform_id,
      threadId: null,
      message: {
        id: text,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        content: JSON.stringify({ text }),
        authenticatedSender: { kind: 'human', userId: '22' },
      },
    },
  });
  expected.add('whatsapp:22');
  expect(await decideChatEngagement(request('Robin, Thursday'))).toBe(true);
  expect(await decideChatEngagement(request('unrelated later banter'))).toBe(false);
});
