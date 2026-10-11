import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GoogleApiError } from '../gws-ea-inbox/gmail-api.js';
import {
  CHAT_MESSAGE_BATCH_CREATED,
  CHAT_REACTION_BATCH_CREATED,
  chatEventParts,
  createChatHydrator,
  messageOfReaction,
  spaceOfMessage,
  type ChatHydrator,
} from './hydrate.js';
import type { WorkspaceEvent } from './pubsub-pull.js';
import { CHAT_MESSAGE_CREATED, CHAT_REACTION_CREATED } from './subscription.js';
import { CHAT_TOKEN, DIRECTORY_TOKEN, FakeChatApi, chatMessage, mentionOf } from './testing/fake-chat-api.js';

const DM = 'spaces/AAAAjuno';

let api: FakeChatApi;
let hydrator: ChatHydrator;

beforeEach(() => {
  api = new FakeChatApi();
  hydrator = createChatHydrator({
    chatToken: async () => CHAT_TOKEN,
    directoryToken: async () => DIRECTORY_TOKEN,
    fetch: api.fetch,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function event(type: string, data: Record<string, unknown>): WorkspaceEvent {
  return {
    messageId: 'pubsub-1',
    type,
    source: '//workspaceevents.googleapis.com/subscriptions/chat-1',
    subject: `//chat.googleapis.com/${DM}`,
    time: '2026-10-10T17:00:00Z',
    data,
  };
}

describe('the parts of an event', () => {
  it('reads a name-only message or reaction event as its one part', () => {
    expect(chatEventParts(event(CHAT_MESSAGE_CREATED, { message: { name: `${DM}/messages/remy.1` } }))).toEqual([
      { kind: 'message', name: `${DM}/messages/remy.1` },
    ]);
    expect(
      chatEventParts(event(CHAT_REACTION_CREATED, { reaction: { name: `${DM}/messages/remy.1/reactions/r1` } })),
    ).toEqual([{ kind: 'reaction', name: `${DM}/messages/remy.1/reactions/r1` }]);
  });

  it('unpacks a batch into one part for each of its events, in the order Google lists them', () => {
    const messages = ['remy.3', 'remy.1', 'remy.2'].map((id) => ({ message: { name: `${DM}/messages/${id}` } }));
    expect(chatEventParts(event(CHAT_MESSAGE_BATCH_CREATED, { messages })).map((part) => part.name)).toEqual([
      `${DM}/messages/remy.3`,
      `${DM}/messages/remy.1`,
      `${DM}/messages/remy.2`,
    ]);
    const reactions = [{ reaction: { name: `${DM}/messages/remy.1/reactions/r1` } }];
    expect(chatEventParts(event(CHAT_REACTION_BATCH_CREATED, { reactions }))).toEqual([
      { kind: 'reaction', name: `${DM}/messages/remy.1/reactions/r1` },
    ]);
  });

  it('finds nothing to handle in another event type, or in an event naming no resource', () => {
    expect(chatEventParts(event('google.workspace.chat.message.v1.updated', { message: { name: 'x' } }))).toEqual([]);
    expect(chatEventParts(event(CHAT_MESSAGE_CREATED, {}))).toEqual([]);
    expect(chatEventParts(event(CHAT_MESSAGE_BATCH_CREATED, { messages: [{}, 'junk'] }))).toEqual([]);
  });

  it('names the space a message is in and the message a reaction is on', () => {
    expect(spaceOfMessage(`${DM}/messages/remy.1`)).toBe(DM);
    expect(messageOfReaction(`${DM}/messages/remy.1/reactions/r1`)).toBe(`${DM}/messages/remy.1`);
    expect(spaceOfMessage('users/2001')).toBeUndefined();
    expect(messageOfReaction(`${DM}/messages/remy.1`)).toBeUndefined();
  });
});

describe('a message', () => {
  it('is read as the assistant, with what the SDK and the reply context read from it', async () => {
    api.addMessage(
      chatMessage(DM, 'remy.1', {
        text: '@Morgan can you move Thursday?',
        annotations: [mentionOf('users/1001', 0, 7)],
        attachment: [
          {
            name: `${DM}/messages/remy.1/attachments/a1`,
            contentName: 'agenda.pdf',
            contentType: 'application/pdf',
            attachmentDataRef: { resourceName: 'ref-agenda' },
          },
        ],
        quotedMessageMetadata: {
          name: `${DM}/messages/old.1`,
          quoteType: 'REPLY',
          quotedMessageSnapshot: { sender: 'Juno Hale', text: 'Thursday is open.' },
        },
      }),
    );

    expect(await hydrator.message(`${DM}/messages/remy.1`)).toEqual({
      name: `${DM}/messages/remy.1`,
      createTime: '2026-10-10T17:00:00.000000Z',
      sender: { name: 'users/2001', type: 'HUMAN', displayName: '' },
      text: '@Morgan can you move Thursday?',
      thread: { name: `${DM}/threads/remy` },
      annotations: [
        {
          type: 'USER_MENTION',
          startIndex: 0,
          length: 7,
          userMention: { user: { name: 'users/1001', type: 'HUMAN' }, type: 'MENTION' },
        },
      ],
      attachment: [
        {
          name: `${DM}/messages/remy.1/attachments/a1`,
          contentName: 'agenda.pdf',
          contentType: 'application/pdf',
          attachmentDataRef: { resourceName: 'ref-agenda' },
        },
      ],
      quotedMessageMetadata: {
        name: `${DM}/messages/old.1`,
        quoteType: 'REPLY',
        quotedMessageSnapshot: { sender: 'Juno Hale', text: 'Thursday is open.' },
      },
    });
  });

  it('reads an attachment-only message as one with no text', async () => {
    api.addMessage({ ...chatMessage(DM, 'remy.1'), text: undefined });

    expect(await hydrator.message(`${DM}/messages/remy.1`)).toMatchObject({ text: '' });
  });

  it('is gone when Google no longer has it, or no longer lets the assistant read it', async () => {
    expect(await hydrator.message(`${DM}/messages/remy.1`)).toBeUndefined();

    api.addMessage(chatMessage(DM, 'remy.2'));
    api.failures.set(`${DM}/messages/remy.2`, { status: 403, message: 'The caller does not have permission' });
    expect(await hydrator.message(`${DM}/messages/remy.2`)).toBeUndefined();
  });

  it('is refused while Google fails, so the event comes again', async () => {
    api.addMessage(chatMessage(DM, 'remy.1'));
    api.failures.set(`${DM}/messages/remy.1`, { status: 500, message: 'Internal error' });

    const failure = await hydrator.message(`${DM}/messages/remy.1`).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GoogleApiError);
    expect((failure as GoogleApiError).status).toBe(500);
  });

  it('is dropped when Google returns one without a sender or time, which no retry changes', async () => {
    api.messages.set(`${DM}/messages/remy.1`, {
      name: `${DM}/messages/remy.1`,
    } as unknown as ReturnType<typeof chatMessage>);

    expect(await hydrator.message(`${DM}/messages/remy.1`)).toBeUndefined();
  });
});

describe('a space', () => {
  it("is read once for its type, and kept: a space's type does not change", async () => {
    api.addSpace(DM, 'DIRECT_MESSAGE');

    expect(await hydrator.space(DM)).toEqual({ name: DM, type: 'DIRECT_MESSAGE' });
    expect(await hydrator.space(DM)).toEqual({ name: DM, type: 'DIRECT_MESSAGE' });
    expect(api.calls(DM)).toHaveLength(1);
  });

  it('reads the older type field when Google gives no space type', async () => {
    api.spaces.set(DM, { name: DM, type: 'DM' } as unknown as { name: string; spaceType: string });

    expect(await hydrator.space(DM)).toEqual({ name: DM, type: 'DIRECT_MESSAGE' });
  });

  it('is gone when the assistant is no longer in it, and refused while Google fails', async () => {
    expect(await hydrator.space(DM)).toBeUndefined();

    api.addSpace(DM, 'SPACE');
    api.failures.set(DM, { status: 503, message: 'Unavailable' });
    await expect(hydrator.space(DM)).rejects.toBeInstanceOf(GoogleApiError);
    api.failures.delete(DM);
    expect(await hydrator.space(DM)).toEqual({ name: DM, type: 'SPACE' });
  });
});

describe('a reaction', () => {
  const message = `${DM}/messages/remy.1`;

  it("is found among its message's reactions, across pages", async () => {
    api.addMessage(chatMessage(DM, 'remy.1'));
    api.reactionPageSize = 2;
    for (const id of ['r1', 'r2', 'r3']) {
      api.addReaction({
        name: `${message}/reactions/${id}`,
        user: { name: 'users/2001', type: 'HUMAN' },
        emoji: { unicode: id === 'r3' ? '👍' : '🎉' },
      });
    }

    expect(await hydrator.reaction(`${message}/reactions/r3`)).toEqual({
      name: `${message}/reactions/r3`,
      user: { name: 'users/2001', type: 'HUMAN' },
      emoji: '👍',
    });
    expect(api.calls(`${message}/reactions`)).toHaveLength(2);
  });

  it('is gone once it was removed, or its message deleted', async () => {
    api.addMessage(chatMessage(DM, 'remy.1'));
    expect(await hydrator.reaction(`${message}/reactions/r1`)).toBeUndefined();
    expect(await hydrator.reaction(`${DM}/messages/remy.9/reactions/r1`)).toBeUndefined();
  });

  it('is refused while Google fails', async () => {
    api.addMessage(chatMessage(DM, 'remy.1'));
    api.failures.set(`${message}/reactions`, { status: 500, message: 'Internal error' });

    await expect(hydrator.reaction(`${message}/reactions/r1`)).rejects.toBeInstanceOf(GoogleApiError);
  });
});

describe("a person's name", () => {
  it('is their People profile name, read with the directory token and kept', async () => {
    api.people.set('2001', 'Juno Hale');

    expect(await hydrator.displayName('users/2001')).toBe('Juno Hale');
    expect(await hydrator.displayName('users/2001')).toBe('Juno Hale');
    expect(api.calls('people/2001')).toEqual([expect.objectContaining({ authorization: `Bearer ${DIRECTORY_TOKEN}` })]);
  });

  it('is read again once kept for an hour, so a changed name reaches the agent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    api.people.set('2001', 'Juno Hale');
    await hydrator.displayName('users/2001');

    api.people.set('2001', 'Juno Vance');
    vi.setSystemTime(Date.now() + 61 * 60_000);
    expect(await hydrator.displayName('users/2001')).toBe('Juno Vance');
  });

  it('is their user id when no profile is visible to the assistant', async () => {
    expect(await hydrator.displayName('users/2002')).toBe('users/2002');
    expect(await hydrator.displayName('users/2002')).toBe('users/2002');
    expect(api.calls('people/2002')).toHaveLength(1);
  });

  it('is their user id while People fails, and asked again next time', async () => {
    api.people.set('2001', 'Juno Hale');
    api.failures.set('people/2001', { status: 500, message: 'Internal error' });
    expect(await hydrator.displayName('users/2001')).toBe('users/2001');

    api.failures.delete('people/2001');
    expect(await hydrator.displayName('users/2001')).toBe('Juno Hale');
  });

  it('is the user id of a user People cannot name, such as a Chat app, without asking', async () => {
    expect(await hydrator.displayName('users/app')).toBe('users/app');
    expect(api.requests).toEqual([]);
  });
});
