/**
 * Opening the principal's DM at create (KTD11): the assistant asks Chat for
 * its DM with the one address create named, checks that Google answered with
 * a direct message between it and one person, and returns that person by the
 * numeric ID Chat knows them by, with the conversation the adapter routes
 * their messages to. Google's HTTP is faked at the `fetch` boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatch } from '../../cli/dispatch.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { getMessagingGroup, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { AssistantChatAdapter, hostChatAuth } from './adapter.js';
import { createChatHydrator } from './hydrate.js';
import { openPrincipalDm, type PrincipalDmResult } from './dm.js';
import { ASSISTANT, ASSISTANT_SUB, CHAT_TOKEN, DIRECTORY_TOKEN } from './testing/fake-chat-api.js';
import { FakeChatDirectMessages } from './testing/fake-chat-dm.js';

vi.mock('../gws-ea-google/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gws-ea-google/index.js')>()),
  hostGoogleAccessToken: vi.fn(async (service: string) => {
    if (service !== 'chat') throw new Error(`The DM needs only the Chat token, not ${service}`);
    return CHAT_TOKEN;
  }),
  assistantGoogleAccount: vi.fn(async () => ({ account: 'morgan.ellery@northwind.example', sub: ASSISTANT_SUB })),
}));

// Registered with the module, as the host loads it.
await import('./index.js');

const JUNO = 'juno.hale@northwind.example';
const JUNO_ID = '2001';

let chat: FakeChatDirectMessages;
let sleeps: number[];

beforeEach(async () => {
  await runMigrations(await initTestDb());
  chat = new FakeChatDirectMessages();
  chat.people.set(JUNO, { id: JUNO_ID });
  sleeps = [];
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await closeDb();
});

function open(email = JUNO): Promise<PrincipalDmResult> {
  return openPrincipalDm(email, {
    chatToken: async () => CHAT_TOKEN,
    assistantUserId: ASSISTANT,
    fetch: chat.fetch,
    sleep: async (milliseconds) => void sleeps.push(milliseconds),
  });
}

/** The conversation id the assistant's adapter gives a DM in `space`: what an inbound message there carries. */
function adapterPlatformId(space: string): string {
  const adapter = new AssistantChatAdapter({
    botUserId: ASSISTANT,
    userName: 'morgan.ellery',
    auth: hostChatAuth(async () => CHAT_TOKEN),
    hydrator: createChatHydrator({ chatToken: async () => CHAT_TOKEN, directoryToken: async () => DIRECTORY_TOKEN }),
    chatToken: async () => CHAT_TOKEN,
    startDelivery: () => ({ stop: async () => undefined }),
  });
  return adapter.channelIdFromThreadId(adapter.encodeThreadId({ spaceName: space, isDM: true }));
}

describe("opening the principal's DM", () => {
  it('opens the DM with the named address and returns the person by numeric ID, with its conversation', async () => {
    const result = await open();

    expect(result).toEqual({
      status: 'opened',
      user_id: `gchat:users/${JUNO_ID}`,
      platform_id: adapterPlatformId(`spaces/dm-${JUNO_ID}`),
      messaging_group_id: expect.any(String),
    });
    // Chat is asked by the address alias; the alias never becomes the person's ID.
    expect(chat.setups()).toEqual([`users/${JUNO}`]);
    expect(chat.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'POST spaces:setup',
      `GET spaces/dm-${JUNO_ID}/members`,
    ]);

    const opened = result as Extract<PrincipalDmResult, { status: 'opened' }>;
    expect(await getMessagingGroup(opened.messaging_group_id)).toMatchObject({
      channel_type: 'gchat',
      instance: 'gchat',
      platform_id: opened.platform_id,
      is_group: 0,
      // A host-opened DM to the principal: no stranger can reach it.
      unknown_sender_policy: 'strict',
    });
  });

  it('reuses the conversation a message there already opened, and opens nothing twice', async () => {
    const first = (await open()) as Extract<PrincipalDmResult, { status: 'opened' }>;
    const again = await open();

    expect(again).toEqual(first);
    expect(await getMessagingGroupByPlatform('gchat', first.platform_id, 'gchat')).toMatchObject({
      id: first.messaging_group_id,
    });
  });

  it('retries Google while it is unavailable, then opens the DM, asking only for the named address', async () => {
    chat.failures.push({ status: 503, message: 'The service is currently unavailable.' });
    chat.failures.push({ status: 429, message: 'Quota exceeded.' });

    await expect(open()).resolves.toMatchObject({ status: 'opened', user_id: `gchat:users/${JUNO_ID}` });
    expect(sleeps).toHaveLength(2);
    expect(new Set(chat.setups())).toEqual(new Set([`users/${JUNO}`]));
  });

  it('reports Google unavailable once its retries are spent, having tried no other address', async () => {
    chat.people.set('juno@hale.example', { id: '2002' });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      chat.failures.push({ status: 503, message: 'The service is currently unavailable.' });
    }

    const result = await open();

    expect(result).toEqual({
      status: 'unavailable',
      reason: expect.stringContaining('The service is currently unavailable.'),
    });
    expect(chat.setups().length).toBeGreaterThan(1);
    expect(new Set(chat.setups())).toEqual(new Set([`users/${JUNO}`]));
    expect(await getMessagingGroupByPlatform('gchat', `gchat:spaces/dm-${JUNO_ID}`, 'gchat')).toBeUndefined();
  });

  it('stops, naming the address, when Google cannot resolve it, without retrying', async () => {
    await expect(open('nobody@northwind.example')).rejects.toThrow(/nobody@northwind\.example/u);
    expect(chat.setups()).toEqual(['users/nobody@northwind.example']);
    expect(sleeps).toEqual([]);
  });

  it('opens the DM with the person whether Google lists them as invited, as before the DM holds a message, or joined', async () => {
    const invited = await open();
    chat.joined.add(JUNO_ID);
    const joined = await open();

    expect(invited).toMatchObject({ status: 'opened', user_id: `gchat:users/${JUNO_ID}` });
    expect(joined).toEqual(invited);
  });

  it.each([
    ['a space that is not a direct message', (fake: FakeChatDirectMessages) => (fake.space = { spaceType: 'SPACE' })],
    [
      'a DM with a Chat app, not the person',
      (fake: FakeChatDirectMessages) => (fake.space = { spaceType: 'DIRECT_MESSAGE', singleUserBotDm: true }),
    ],
    [
      'a conversation with a third member',
      (fake: FakeChatDirectMessages) =>
        void fake.extraMembers.push({
          name: `spaces/dm-${JUNO_ID}/members/3003`,
          state: 'JOINED',
          member: { name: 'users/3003', type: 'HUMAN' },
        }),
    ],
    [
      'a DM whose other member is listed as a Chat app',
      (fake: FakeChatDirectMessages) => void fake.people.set(JUNO, { id: JUNO_ID, type: 'BOT' }),
    ],
  ])('refuses %s, binding nothing', async (_label, change) => {
    change(chat);

    await expect(open()).rejects.toThrow(
      `Google Chat answered ${JUNO} with spaces/dm-${JUNO_ID}, which is not a direct message between the assistant and one person`,
    );
    expect(await getMessagingGroupByPlatform('gchat', `gchat:spaces/dm-${JUNO_ID}`, 'gchat')).toBeUndefined();
  });
});

describe('the host command', () => {
  it('opens the DM as the signed-in assistant, from the host only, for one valid address', async () => {
    vi.stubGlobal('fetch', chat.fetch);

    const opened = await dispatch(
      { id: 'o', command: 'gws-ea-chat-open-principal-dm', args: { email: ' Juno.Hale@Northwind.example ' } },
      { caller: 'host' },
    );
    expect(opened).toMatchObject({ ok: true, data: { status: 'opened', user_id: `gchat:users/${JUNO_ID}` } });
    expect(chat.setups()).toEqual([`users/${JUNO}`]);

    const agent = await dispatch(
      { id: 'a', command: 'gws-ea-chat-open-principal-dm', args: { email: JUNO } },
      { caller: 'agent', agentGroupId: 'ag-main', sessionId: 'sess-main', messagingGroupId: 'mg-dm' },
    );
    expect(agent).toMatchObject({ ok: false, error: { code: 'forbidden' } });

    for (const args of [{}, { email: 'not-an-address' }, { email: JUNO, fallback: 'juno@hale.example' }]) {
      const refused = await dispatch({ id: 'r', command: 'gws-ea-chat-open-principal-dm', args }, { caller: 'host' });
      expect(refused, JSON.stringify(args)).toMatchObject({ ok: false });
    }
    expect(chat.setups()).toHaveLength(1);
  });
});
