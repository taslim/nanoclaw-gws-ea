/**
 * A person left waiting in a live chat is acknowledged: the runner reminds the
 * agent once, after a while, and only while nothing has gone out this turn.
 * Where the chat itself shows the person that the agent is working (Google
 * Chat's 👀), there is no reminder.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { ACKNOWLEDGE_AFTER_MS, acknowledgmentReminder, startWaiting, stopWaiting } from './acknowledge.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { extractRouting } from './formatter.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { processQuery } from './poll-loop.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';
import type { MessageInRow } from './db/messages-in.js';

const T0 = 1_000_000;

/** The conversation each channel's rows come from, and where the agent's reply goes. */
const PLATFORM_IDS: Record<string, string> = { gchat: 'spaces/dm', whatsapp: 'whatsapp:15550100' };

afterEach(() => stopWaiting());

describe('the reminder', () => {
  it('comes once, only after the person has waited long enough', () => {
    startWaiting(() => false, T0);
    expect(acknowledgmentReminder(T0 + ACKNOWLEDGE_AFTER_MS - 1)).toBeUndefined();
    const reminder = acknowledgmentReminder(T0 + ACKNOWLEDGE_AFTER_MS + 2_000);
    expect(reminder).toContain('waited 12 seconds');
    expect(reminder).toContain('one line, in your own words');
    expect(reminder).toContain('If your next message is the reply itself, just send it.');
    expect(acknowledgmentReminder(T0 + 60_000)).toBeUndefined();
  });

  it('never comes once something has gone out this turn', () => {
    startWaiting(() => true, T0);
    expect(acknowledgmentReminder(T0 + 60_000)).toBeUndefined();
  });

  it('never comes when no one is waiting, or after the turn ended', () => {
    expect(acknowledgmentReminder(T0 + 60_000)).toBeUndefined();
    startWaiting(() => false, T0);
    stopWaiting();
    expect(acknowledgmentReminder(T0 + 60_000)).toBeUndefined();
  });
});

function row(
  kind: MessageInRow['kind'],
  content: object,
  channelType: string | null = 'whatsapp',
  trigger = 1,
): MessageInRow {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    seq: 2,
    kind,
    timestamp: new Date().toISOString(),
    status: 'pending',
    process_after: null,
    recurrence: null,
    series_id: null,
    tries: 0,
    trigger,
    platform_id: channelType === null ? null : (PLATFORM_IDS[channelType] ?? `${channelType}:chat`),
    channel_type: channelType,
    thread_id: null,
    content: JSON.stringify(content),
    source_session_id: null,
    on_wake: 0,
  };
}

describe('who is waiting', () => {
  // A batch of tasks reads whether this session is a task session.
  beforeEach(() => initTestSessionDb());
  afterEach(() => closeSessionDb());

  it('is someone who wrote in a live chat, not a host note, an email, or a scheduled task', () => {
    expect(extractRouting([row('chat-sdk', { text: 'find me an hour', senderId: '15550100' })]).personWaiting).toBe(
      true,
    );
    expect(extractRouting([row('chat', { text: 'A meeting moved', senderId: 'system' }, 'agent')]).personWaiting).toBe(
      false,
    );
    expect(
      extractRouting([row('chat', { text: 'Can we meet?', sender: 'sam@acme.example' }, 'email')]).personWaiting,
    ).toBe(false);
    expect(extractRouting([row('task', { prompt: 'weekly review' }, null)]).personWaiting).toBe(false);
  });

  it('is no one when the chat message only rode along as context and did not wake the turn', () => {
    const routing = extractRouting([
      row('chat', { text: 'A meeting moved', senderId: 'system' }, 'agent'),
      row('chat-sdk', { text: 'chatting among ourselves', senderId: '15550100' }, 'whatsapp', 0),
    ]);
    expect(routing.personWaiting).toBe(false);
  });

  it('leaves a failure-notice wake as upstream defines it: no one waits, and the notice is still the whole wake', () => {
    const notice = row('chat', { text: 'Incorrect API key', failureNotice: true }, 'agent');
    expect(extractRouting([notice])).toMatchObject({ failureNoticeWake: true, personWaiting: false });
    const asked = row('chat-sdk', { text: 'any update?', senderId: '15550100' });
    expect(extractRouting([notice, asked])).toMatchObject({
      inReplyTo: asked.id,
      failureNoticeWake: false,
      personWaiting: true,
    });
  });

  it('is no one in Google Chat, whose 👀 shows the person their message is being worked on', () => {
    expect(
      extractRouting([row('chat-sdk', { text: 'find me an hour', senderId: 'users/7' }, 'gchat')]).personWaiting,
    ).toBe(false);
  });

  it('is still someone when a turn also answers a chat with no such sign', () => {
    const routing = extractRouting([
      row('chat-sdk', { text: 'find me an hour', senderId: 'users/7' }, 'gchat'),
      row('chat-sdk', { text: 'and lunch on Friday?', senderId: '15550100' }, 'whatsapp'),
    ]);
    expect(routing.personWaiting).toBe(true);
  });
});

describe('a turn in the poll loop', () => {
  /** Where the principal hears the agent on each channel. */
  const DESTINATIONS: Record<string, string> = { gchat: 'principal-chat', whatsapp: 'principal-whatsapp' };

  beforeEach(() => {
    initTestSessionDb();
    for (const [channelType, name] of Object.entries(DESTINATIONS)) {
      getInboundDb()
        .prepare(
          `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
           VALUES (?, ?, 'channel', ?, ?, NULL)`,
        )
        .run(name, name, channelType, PLATFORM_IDS[channelType]!);
    }
  });
  afterEach(() => closeSessionDb());

  const fromWhatsApp = (): MessageInRow =>
    row('chat-sdk', { text: 'find an hour with Remy', senderId: '15550100' }, 'whatsapp');
  const fromChat = (): MessageInRow =>
    row('chat-sdk', { text: 'find an hour with Remy', senderId: 'users/7' }, 'gchat');

  /**
   * Run the turn a person's message starts, routed as the poll loop routes it,
   * whose stream asks for the reminder after a tool batch that ends ten seconds
   * in, as the provider's hook does.
   */
  async function turn(started: MessageInRow, ack: boolean): Promise<string[]> {
    const to = DESTINATIONS[started.channel_type!]!;
    const asked: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'c1' };
      if (ack) yield { type: 'text', text: `<message to="${to}">On it: checking your week.</message>` };
      const reminder = acknowledgmentReminder(Date.now() + ACKNOWLEDGE_AFTER_MS + 1_000);
      if (reminder !== undefined) asked.push(reminder);
      yield { type: 'text', text: `<message to="${to}">Thursday 10:00 is free.</message>` };
      yield { type: 'result', text: '' };
    }
    const query: AgentQuery = { push: () => {}, end: () => {}, abort: () => {}, events: events() };
    await processQuery(query, extractRouting([started]), [started.id], 'claude', undefined, 'prompt', undefined, true);
    return asked;
  }

  it('reminds the agent when a person in a chat with no working sign has heard nothing, and not after the turn', async () => {
    expect(await turn(fromWhatsApp(), false)).toHaveLength(1);
    expect(acknowledgmentReminder(Date.now() + 60_000)).toBeUndefined();
  });

  it('stays quiet once the agent has acknowledged', async () => {
    expect(await turn(fromWhatsApp(), true)).toEqual([]);
    expect(getUndeliveredMessages().map((message) => JSON.parse(message.content).text)).toEqual([
      'On it: checking your week.',
      'Thursday 10:00 is free.',
    ]);
  });

  it('stays quiet in Google Chat, where the person sees 👀 on their message while the agent works', async () => {
    expect(await turn(fromChat(), false)).toEqual([]);
    expect(getUndeliveredMessages().map((message) => JSON.parse(message.content).text)).toEqual([
      'Thursday 10:00 is free.',
    ]);
  });

  it('forgets the wait when the turn fails, so a later turn is never reminded of it', async () => {
    async function* failing(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'c1' };
      throw new Error('the provider went away');
    }
    const started = fromWhatsApp();
    const query: AgentQuery = { push: () => {}, end: () => {}, abort: () => {}, events: failing() };
    await expect(
      processQuery(query, extractRouting([started]), [started.id], 'claude', undefined, 'prompt', undefined, true),
    ).rejects.toThrow('the provider went away');
    expect(acknowledgmentReminder(Date.now() + 60_000)).toBeUndefined();
  });
});
