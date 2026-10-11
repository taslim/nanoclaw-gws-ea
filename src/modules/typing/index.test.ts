/**
 * Typing-refresh tests.
 *
 * Three tick sites can fire setTyping — the immediate tick on a new
 * refresher, the 4s interval tick, and the immediate re-trigger when
 * startTypingRefresh is called for an already-refreshing session. All three
 * must forward the adapter instance, or a named instance's typing indicator
 * fires through the wrong bot.
 *
 * Each conversation a turn is engaged from keeps its anchor, the message the
 * turn works on there, until that work ends: anything sent to the
 * conversation, a newer message there, the turn going idle, a failed wake, or
 * the container's exit. The end fires once per anchor.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-typing' };
});

import { endTypingInConversation, setTypingAdapter, startTypingRefresh, stopTypingRefresh } from './index.js';

type Call = { channelType: string; platformId: string; threadId: string | null; instance?: string };
type Pulse = Call & { anchor?: string };
type End = Call & { anchor: string };

function captureAdapter() {
  const calls: Call[] = [];
  setTypingAdapter({
    async setTyping(channelType, platformId, threadId, instance) {
      calls.push({ channelType, platformId, threadId, instance });
    },
  });
  return calls;
}

/** An adapter that marks the message a turn works on, as the Chat assistant's 👀 does. */
function captureAnchoredAdapter() {
  const pulses: Pulse[] = [];
  const ends: End[] = [];
  setTypingAdapter({
    async setTyping(channelType, platformId, threadId, instance, _status, _statusKind, anchor) {
      pulses.push({ channelType, platformId, threadId, instance, anchor });
    },
    async endTyping(channelType, platformId, threadId, anchor, instance) {
      ends.push({ channelType, platformId, threadId, instance, anchor });
    },
  });
  return { pulses, ends };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const session of ['sess-1', 'sess-2']) stopTypingRefresh(session);
  vi.useRealTimers();
});

describe('startTypingRefresh — instance forwarding', () => {
  it('immediate tick passes the instance to the adapter', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      channelType: 'slack',
      platformId: 'slack:C1',
      threadId: null,
      instance: 'slack-tester',
    });
  });

  it('interval ticks inside the grace window pass the stored entry instance', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // Two 4s ticks — well inside the 15s grace window, so they fire
    // unconditionally (no heartbeat file needed) from the stored entry.
    await vi.advanceTimersByTimeAsync(8_500);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect(c.instance).toBe('slack-tester');
      expect(c.threadId).toBe('T1');
    }
  });

  it('re-trigger on an active session passes (and stores) the new instance', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // Second call for the same session: immediate tick with the new value.
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-worker');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].instance).toBe('slack-worker');

    // And the stored entry was updated — subsequent interval ticks carry it.
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(4_500);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[calls.length - 1].instance).toBe('slack-worker');
  });

  it('re-trigger with a changed address updates the whole entry — interval ticks stay self-consistent', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // Same session re-triggered from a different platform and chat
    // (agent-shared sessions span messaging groups). The stored entry must
    // not tear: keeping the old address with the new instance would hand a
    // telegram platformId to the slack-tester adapter on the next tick.
    startTypingRefresh('sess-1', 'ag-1', 'telegram', 'tg:99', null, 'telegram');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      channelType: 'telegram',
      platformId: 'tg:99',
      threadId: null,
      instance: 'telegram',
    });

    // Interval ticks fire from the stored entry — all four fields must
    // have moved together.
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(4_500);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const c of calls) {
      expect(c).toEqual({
        channelType: 'telegram',
        platformId: 'tg:99',
        threadId: null,
        instance: 'telegram',
      });
    }
  });
});

describe('anchors — the message each conversation’s turn works on', () => {
  const DM = 'gchat:spaces/AAAAjuno';
  const JUNO_1 = 'spaces/AAAAjuno/messages/juno.1';
  const JUNO_2 = 'spaces/AAAAjuno/messages/juno.2';
  const EMAIL = 'email:principal';
  const MAIL_1 = 'mail-thread-1';

  const chat = (anchor?: string) => startTypingRefresh('sess-1', 'ag-1', 'gchat', DM, null, 'gchat', anchor);
  const chatEnd = (anchor: string): End => ({
    channelType: 'gchat',
    platformId: DM,
    threadId: null,
    instance: 'gchat',
    anchor,
  });

  it('each pulse carries the anchor of the conversation it goes to', async () => {
    const { pulses, ends } = captureAnchoredAdapter();
    chat(JUNO_1);
    await vi.advanceTimersByTimeAsync(8_500);

    expect(pulses.length).toBeGreaterThanOrEqual(3);
    for (const pulse of pulses) {
      expect(pulse).toEqual({
        channelType: 'gchat',
        platformId: DM,
        threadId: null,
        instance: 'gchat',
        anchor: JUNO_1,
      });
    }
    expect(ends).toEqual([]);
  });

  it('a newer message in the same conversation ends the older anchor once and pulses the newer one', async () => {
    const { pulses, ends } = captureAnchoredAdapter();
    chat(JUNO_1);
    await vi.advanceTimersByTimeAsync(0);

    chat(JUNO_2);
    await vi.advanceTimersByTimeAsync(4_500);

    expect(ends).toEqual([chatEnd(JUNO_1)]);
    expect(pulses.at(-1)?.anchor).toBe(JUNO_2);
  });

  it("an email arriving in the shared session mid-turn adds its anchor and leaves the Chat anchor live until the Chat conversation's end", async () => {
    const { pulses, ends } = captureAnchoredAdapter();
    chat(JUNO_1);
    startTypingRefresh('sess-1', 'ag-1', 'email', EMAIL, null, 'email', MAIL_1);
    await vi.advanceTimersByTimeAsync(4_500);

    expect(ends).toEqual([]);
    expect(pulses.at(-1)).toMatchObject({ platformId: EMAIL, anchor: MAIL_1 });

    // The agent answers the email: only the email's anchor ends.
    endTypingInConversation('email', EMAIL, null, 'email');
    expect(ends).toEqual([
      { channelType: 'email', platformId: EMAIL, threadId: null, instance: 'email', anchor: MAIL_1 },
    ]);

    // Then it answers in Chat.
    endTypingInConversation('gchat', DM, null, 'gchat');
    expect(ends.at(-1)).toEqual(chatEnd(JUNO_1));

    stopTypingRefresh('sess-1');
    expect(ends).toHaveLength(2);
  });

  it('anything sent to the conversation ends its anchor once; later pulses there carry none', async () => {
    const { pulses, ends } = captureAnchoredAdapter();
    chat(JUNO_1);
    await vi.advanceTimersByTimeAsync(0);

    endTypingInConversation('gchat', DM, null, 'gchat');
    endTypingInConversation('gchat', DM, null, 'gchat');
    expect(ends).toEqual([chatEnd(JUNO_1)]);

    // The turn may still be working: typing goes on, without the anchor.
    pulses.length = 0;
    await vi.advanceTimersByTimeAsync(4_500);
    expect(pulses.length).toBeGreaterThanOrEqual(1);
    for (const pulse of pulses) expect(pulse.anchor).toBeUndefined();

    stopTypingRefresh('sess-1');
    expect(ends).toHaveLength(1);
  });

  it('ends the anchors of every turn in that conversation, and none in another thread, platform, or instance', async () => {
    const { ends } = captureAnchoredAdapter();
    const ROOM = 'gchat:spaces/AAAAroom';
    startTypingRefresh('sess-1', 'ag-1', 'gchat', ROOM, 'thread-lunch', 'gchat', 'spaces/AAAAroom/messages/remy.1');
    startTypingRefresh('sess-2', 'ag-2', 'gchat', ROOM, 'thread-lunch', 'gchat', 'spaces/AAAAroom/messages/remy.1');

    endTypingInConversation('gchat', ROOM, 'thread-offsite', 'gchat');
    endTypingInConversation('gchat', ROOM, null, 'gchat');
    endTypingInConversation('slack', ROOM, 'thread-lunch', 'slack');
    endTypingInConversation('gchat', ROOM, 'thread-lunch', 'gchat-second');
    expect(ends).toEqual([]);

    endTypingInConversation('gchat', ROOM, 'thread-lunch');
    expect(ends.map((end) => end.anchor)).toEqual([
      'spaces/AAAAroom/messages/remy.1',
      'spaces/AAAAroom/messages/remy.1',
    ]);
  });

  it('the turn going idle ends every live anchor once and stops the pulse', async () => {
    const { pulses, ends } = captureAnchoredAdapter();
    chat(JUNO_1);
    startTypingRefresh('sess-1', 'ag-1', 'email', EMAIL, null, 'email', MAIL_1);

    // Past the grace window with no heartbeat: the agent is idle.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ends.map((end) => end.anchor).sort()).toEqual([JUNO_1, MAIL_1].sort());

    const pulsed = pulses.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(pulses).toHaveLength(pulsed);
    stopTypingRefresh('sess-1');
    expect(ends).toHaveLength(2);
  });

  it('a stop (a failed wake, the container’s exit) ends each live anchor of that session once', async () => {
    const { ends } = captureAnchoredAdapter();
    chat(JUNO_1);
    startTypingRefresh('sess-2', 'ag-2', 'gchat', 'gchat:spaces/AAAAroom', null, 'gchat', 'spaces/AAAAroom/messages/x');

    stopTypingRefresh('sess-1');
    stopTypingRefresh('sess-1');
    expect(ends).toEqual([chatEnd(JUNO_1)]);

    stopTypingRefresh('sess-2');
    expect(ends.map((end) => end.anchor)).toEqual([JUNO_1, 'spaces/AAAAroom/messages/x']);
  });

  it('a turn engaged by no message (a reaction) leaves the conversation’s live anchor in place', async () => {
    const { pulses, ends } = captureAnchoredAdapter();
    chat(JUNO_1);
    chat(undefined);
    await vi.advanceTimersByTimeAsync(4_500);

    expect(ends).toEqual([]);
    expect(pulses.at(-1)?.anchor).toBe(JUNO_1);
  });

  it('an end that fails, even at once, never fails the send or the stop that fired it', async () => {
    setTypingAdapter({
      async setTyping() {},
      endTyping() {
        throw new Error('Chat unavailable');
      },
    });
    chat(JUNO_1);
    expect(() => endTypingInConversation('gchat', DM, null, 'gchat')).not.toThrow();

    chat(JUNO_2);
    setTypingAdapter({
      async setTyping() {},
      endTyping: async () => {
        throw new Error('Chat unavailable');
      },
    });
    expect(() => stopTypingRefresh('sess-1')).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
  });
});
