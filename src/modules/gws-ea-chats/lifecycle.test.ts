import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  chats: [] as { messaging_group_id: string; state: string }[],
  start: undefined as (() => Promise<void>) | undefined,
  stop: undefined as (() => Promise<void>) | undefined,
  notify: vi.fn(async (_chat: unknown) => undefined),
  release: vi.fn(async (_id: string) => undefined),
  settle: vi.fn(async (_id: string) => undefined),
  expire: vi.fn(async () => undefined),
}));
vi.mock('../../db/connection.js', () => ({
  getDb: () => ({ hasTable: async () => true, get: async () => ({ move_source_session_id: null, settled_at: null }) }),
}));
vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroup: async (id: string) => ({ channel_type: 'whatsapp', platform_id: id }),
}));
vi.mock('../../host-lifecycle.js', () => ({
  onHostStart: (callback: () => Promise<void>) => {
    fixture.start = callback;
  },
  onHostShutdown: (callback: () => Promise<void>) => {
    fixture.stop = callback;
  },
}));
vi.mock('../../log.js', () => ({ log: { error: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../router.js', () => ({
  runInConversationTail: async (_address: unknown, work: () => Promise<void>) => work(),
}));
vi.mock('./db.js', () => ({
  listChats: async () => fixture.chats,
  getChat: async (id: string) => fixture.chats.find((chat) => chat.messaging_group_id === id),
}));
vi.mock('./hold.js', () => ({
  expireAskingChats: fixture.expire,
  releaseChatMessages: fixture.release,
  settleChatMessages: fixture.settle,
}));
vi.mock('./join.js', () => ({ notifyAskingChat: fixture.notify }));
import { registerChatLifecycleTask, sweepChatLifecycle } from './lifecycle.js';
const failedTask = vi.fn(async () => undefined);
const laterTask = vi.fn(async () => undefined);
registerChatLifecycleTask('test:first', failedTask);
registerChatLifecycleTask('test:later', laterTask);

beforeEach(() => {
  vi.clearAllMocks();
  fixture.chats = [];
});
afterEach(async () => {
  await fixture.stop?.();
  vi.useRealTimers();
});
it.each([
  ['asking', fixture.notify],
  ['connected', fixture.release],
  ['detached', fixture.settle],
] as const)('continues other chats and tasks after %s upkeep fails', async (state, operation) => {
  fixture.chats = [
    { messaging_group_id: 'broken', state },
    { messaging_group_id: 'ready', state: 'connected' },
  ];
  operation.mockRejectedValueOnce(new Error('Mailbox temporarily unavailable'));
  await expect(sweepChatLifecycle()).resolves.toBeUndefined();
  expect(fixture.release).toHaveBeenCalledWith('ready');
  expect(laterTask).toHaveBeenCalledOnce();
});
it('continues registered work when expiry or an earlier task fails', async () => {
  fixture.expire.mockRejectedValueOnce(new Error('Expiry unavailable'));
  failedTask.mockRejectedValueOnce(new Error('Retirement unavailable'));
  await expect(sweepChatLifecycle()).resolves.toBeUndefined();
  expect(failedTask).toHaveBeenCalledOnce();
  expect(laterTask).toHaveBeenCalledOnce();
});
it('starts the recurring loop despite one failed notice and retries it next beat', async () => {
  vi.useFakeTimers();
  fixture.chats = [{ messaging_group_id: 'asking', state: 'asking' }];
  fixture.notify.mockRejectedValueOnce(new Error('Main unavailable'));
  await expect(fixture.start?.()).resolves.toBeUndefined();
  expect(fixture.notify).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fixture.notify).toHaveBeenCalledTimes(2);
  expect(laterTask).toHaveBeenCalledTimes(2);
});
