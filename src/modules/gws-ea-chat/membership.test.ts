import { beforeEach, expect, it } from 'vitest';
import { AssistantChatAdapter, hostChatAuth } from './adapter.js';
import { createChatHydrator } from './hydrate.js';
import { registerChatMembershipObserver, type ChatMembershipEvent } from './membership.js';
import { CHAT_MEMBERSHIP_CREATED, CHAT_MEMBERSHIP_DELETED, CHAT_MEMBERSHIP_UPDATED } from './subscription.js';

let members: string[];
let removed = false;
let reads: string[];
let seen: ChatMembershipEvent[];
const assistant = 'users/100';
registerChatMembershipObserver(async (event) => {
  seen.push(event);
});
const fetch: typeof globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  reads.push(`${init?.method === 'DELETE' ? 'DELETE ' : ''}${url.pathname}${url.search}`);
  if (init?.method === 'DELETE' && url.pathname === '/v1/spaces/room/members/100') return Response.json({});
  if (removed) return Response.json({ error: { code: 403, message: 'Not a member' } }, { status: 403 });
  if (url.pathname === '/v1/spaces/room')
    return Response.json({ name: 'spaces/room', spaceType: 'SPACE', displayName: 'Trip' });
  if (url.pathname === '/v1/spaces/room/members') {
    const page = url.searchParams.get('pageToken') === 'next' ? members.slice(1) : members.slice(0, 1);
    return Response.json({
      memberships: page.map((id) => ({ state: 'JOINED', member: { name: id, type: 'HUMAN' } })),
      ...(!url.searchParams.has('pageToken') && members.length > 1 ? { nextPageToken: 'next' } : {}),
    });
  }
  if (url.hostname === 'people.googleapis.com')
    return Response.json({ names: [{ displayName: url.pathname.endsWith('/200') ? 'Juno' : 'Avery' }] });
  if (url.pathname === '/v1/spaces/room/messages/ours')
    return Response.json({
      name: 'spaces/room/messages/ours',
      createTime: new Date().toISOString(),
      sender: { name: assistant, type: 'HUMAN' },
      thread: { name: 'spaces/room/threads/t' },
      text: 'Help?',
    });
  throw new Error(`Unexpected membership request: ${url}`);
};
function build() {
  return new AssistantChatAdapter({
    botUserId: assistant,
    userName: 'Avery',
    auth: hostChatAuth(async () => 'chat', fetch),
    chatToken: async () => 'chat',
    fetch,
    hydrator: createChatHydrator({ chatToken: async () => 'chat', directoryToken: async () => 'directory', fetch }),
    startDelivery: () => ({ stop: async () => {} }),
  });
}
async function event(type: string, member = '200') {
  await build().handleChatEvent({
    messageId: 'membership',
    type,
    source: 'subscription',
    subject: `//chat.googleapis.com/spaces/room/members/${member}`,
    time: new Date().toISOString(),
    data: { membership: { name: `spaces/room/members/${member}` } },
  });
}
beforeEach(() => {
  members = [assistant, 'users/200'];
  removed = false;
  reads = [];
  seen = [];
});
it('reads every page through the authenticated native adapter and emits human roster facts without the assistant', async () => {
  await event(CHAT_MEMBERSHIP_CREATED);
  expect(seen).toEqual([
    {
      kind: 'join',
      group: {
        platformId: 'gchat:spaces/room',
        name: 'Trip',
        isGroup: true,
        members: [{ userId: 'users/200', name: 'Juno' }],
      },
    },
  ]);
  expect(reads).toContain('/v1/spaces/room/members?pageSize=100&pageToken=next');
});
it('refreshes ordinary removals and detaches the assistant on a native membership deletion', async () => {
  await event(CHAT_MEMBERSHIP_UPDATED);
  expect(seen[0]?.kind).toBe('roster');
  await event(CHAT_MEMBERSHIP_DELETED, '100');
  expect(seen[1]).toEqual({ kind: 'detach', platformId: 'gchat:spaces/room' });
  removed = true;
  await event(CHAT_MEMBERSHIP_DELETED, '100');
  expect(seen[2]).toEqual({ kind: 'detach', platformId: 'gchat:spaces/room' });
});
it('verifies a quote against the assistant sender in the same space', async () => {
  const adapter = build();
  expect(await adapter.isOwnMessage('gchat:spaces/room', 'spaces/room/messages/ours')).toBe(true);
  expect(await adapter.isOwnMessage('gchat:spaces/other', 'spaces/room/messages/ours')).toBe(false);
});
it('reads every space in a native batch membership event', async () => {
  await build().handleChatEvent({
    messageId: 'batch',
    type: 'google.workspace.chat.membership.v1.batchCreated',
    source: 'subscription',
    subject: '',
    time: new Date().toISOString(),
    data: {
      memberships: [{ membership: { name: 'spaces/room/members/100' } }],
    },
  });
  expect(seen).toHaveLength(1);
  expect(seen[0]?.kind).toBe('join');
});

it('leaves only the assistant membership in the requested space through native Google Chat', async () => {
  const adapter = build();
  await adapter.leaveChat('gchat:spaces/room');
  expect(reads).toContain('DELETE /v1/spaces/room/members/100');
});
