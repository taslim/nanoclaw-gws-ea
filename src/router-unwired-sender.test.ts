import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./request-wake.js', () => ({ requestWake: vi.fn() }));

import './modules/permissions/index.js';
import { closeDb, getDb, initSqliteTestDb } from './db/connection.js';
import { getUnregisteredSenders } from './db/dropped-messages.js';
import { runMigrations } from './db/migrations/index.js';
import { routeInbound } from './router.js';

const timestamp = '2026-09-18T20:00:00.000Z';

function event(
  instance: string,
  overrides: Partial<Parameters<typeof routeInbound>[0]['message']> = {},
): Parameters<typeof routeInbound>[0] {
  return {
    channelType: 'gchat',
    instance,
    platformId: 'spaces/dm-1',
    threadId: null,
    message: {
      id: `message-${instance}`,
      kind: 'chat-sdk',
      timestamp,
      content: JSON.stringify({ senderId: 'spoofed-content-id', sender: 'Spoofed', text: 'hello' }),
      isMention: true,
      isGroup: false,
      authenticatedSender: { userId: 'users/real', displayName: 'Real Principal', kind: 'human' },
      ...overrides,
    },
  };
}

beforeEach(async () => {
  await runMigrations(await initSqliteTestDb());
});

afterEach(async () => {
  await closeDb();
});

describe('unwired sender evidence', () => {
  it('upserts only the authenticated sender before recording exact-instance DM evidence', async () => {
    await routeInbound(event('gchat-alpha'));
    await routeInbound(event('gchat-beta'));

    expect(await getDb().all('SELECT id, display_name FROM users')).toEqual([
      { id: 'gchat:users/real', display_name: 'Real Principal' },
    ]);
    expect(await getUnregisteredSenders()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instance: 'gchat-alpha',
          sender_authenticated: 1,
          sender_kind: 'human',
          is_group: 0,
        }),
        expect.objectContaining({ instance: 'gchat-beta', sender_authenticated: 1, sender_kind: 'human', is_group: 0 }),
      ]),
    );
    expect(await getDb().get<{ count: number }>('SELECT COUNT(*) AS count FROM sessions')).toEqual({ count: 0 });
  });

  it('fails closed for content-only identities and records no authenticated candidate', async () => {
    await routeInbound(event('gchat-alpha', { authenticatedSender: undefined }));

    // Legacy permission interceptors may still materialize content-derived
    // users, but that identity is never attached to trust-bearing evidence.
    expect(await getDb().all('SELECT id FROM users')).toEqual([{ id: 'gchat:spoofed-content-id' }]);
    expect(await getUnregisteredSenders()).toEqual([
      expect.objectContaining({ user_id: null, sender_authenticated: 0, sender_kind: 'unknown' }),
    ]);
  });

  it('retains authenticated bot and group evidence so candidate filtering can reject it', async () => {
    await routeInbound(
      event('gchat-bot', {
        authenticatedSender: { userId: 'bots/1', displayName: 'A Bot', kind: 'bot' },
      }),
    );
    await routeInbound(
      event('gchat-group', {
        id: 'message-group',
        isGroup: true,
        authenticatedSender: { userId: 'users/2', displayName: 'Another Human', kind: 'human' },
      }),
    );

    expect(await getUnregisteredSenders()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ instance: 'gchat-group', is_group: 1, sender_kind: 'human' }),
        expect.objectContaining({ instance: 'gchat-bot', is_group: 0, sender_kind: 'bot' }),
      ]),
    );
  });
});
