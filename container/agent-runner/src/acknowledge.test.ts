/**
 * A person left waiting in a live chat is acknowledged: the runner reminds the
 * agent once, after a while, and only while nothing has gone out this turn.
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
  channelType: string | null = 'gchat',
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
    platform_id: channelType === null ? null : 'spaces/dm',
    channel_type: channelType,
    thread_id: null,
    content: JSON.stringify(content),
    source_session_id: null,
    on_wake: 0,
  };
}

describe('who is waiting', () => {
  it('is someone who wrote in a live chat, not a host note, an email, or a scheduled task', () => {
    expect(extractRouting([row('chat-sdk', { text: 'find me an hour', senderId: 'users/7' })]).personWaiting).toBe(
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
      row('chat-sdk', { text: 'chatting among ourselves', senderId: 'users/7' }, 'gchat', 0),
    ]);
    expect(routing.personWaiting).toBe(false);
  });

  it('leaves a failure-notice wake as upstream defines it: no one waits, and the notice is still the whole wake', () => {
    const notice = row('chat', { text: 'Incorrect API key', failureNotice: true }, 'agent');
    expect(extractRouting([notice])).toMatchObject({ failureNoticeWake: true, personWaiting: false });
    const asked = row('chat-sdk', { text: 'any update?', senderId: 'users/7' });
    expect(extractRouting([notice, asked])).toMatchObject({
      inReplyTo: asked.id,
      failureNoticeWake: false,
      personWaiting: true,
    });
  });
});

describe('a turn in the poll loop', () => {
  beforeEach(() => {
    initTestSessionDb();
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('principal', 'principal', 'channel', 'gchat', 'spaces/dm', NULL)`,
      )
      .run();
  });
  afterEach(() => closeSessionDb());

  const ROUTING = { platformId: 'spaces/dm', channelType: 'gchat', threadId: null, inReplyTo: 'm1', taskRun: false };

  /** Run one turn whose stream asks for the reminder after a tool batch, as the provider's hook does. */
  async function turn(routing: typeof ROUTING & { personWaiting?: boolean }, ack: boolean): Promise<string[]> {
    const asked: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'c1' };
      if (ack) yield { type: 'text', text: '<message to="principal">On it: checking your week.</message>' };
      // A tool batch ends long after the turn began.
      const reminder = acknowledgmentReminder(Date.now() + ACKNOWLEDGE_AFTER_MS + 1_000);
      if (reminder !== undefined) asked.push(reminder);
      yield { type: 'text', text: '<message to="principal">Thursday 10:00 is free.</message>' };
      yield { type: 'result', text: '' };
    }
    const query: AgentQuery = { push: () => {}, end: () => {}, abort: () => {}, events: events() };
    await processQuery(query, routing, ['m1'], 'claude', undefined, 'prompt', undefined, true);
    return asked;
  }

  it('reminds the agent when a person in a live chat has heard nothing, and not after the turn', async () => {
    expect(await turn({ ...ROUTING, personWaiting: true }, false)).toHaveLength(1);
    expect(acknowledgmentReminder(Date.now() + 60_000)).toBeUndefined();
  });

  it('stays quiet once the agent has acknowledged', async () => {
    expect(await turn({ ...ROUTING, personWaiting: true }, true)).toEqual([]);
    expect(getUndeliveredMessages().map((message) => JSON.parse(message.content).text)).toEqual([
      'On it: checking your week.',
      'Thursday 10:00 is free.',
    ]);
  });

  it('stays quiet for a turn no one is waiting on', async () => {
    expect(await turn(ROUTING, false)).toEqual([]);
  });

  it('forgets the wait when the turn fails, so a later turn is never reminded of it', async () => {
    async function* failing(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'c1' };
      throw new Error('the provider went away');
    }
    const query: AgentQuery = { push: () => {}, end: () => {}, abort: () => {}, events: failing() };
    await expect(
      processQuery(query, { ...ROUTING, personWaiting: true }, ['m1'], 'claude', undefined, 'prompt', undefined, true),
    ).rejects.toThrow('the provider went away');
    expect(acknowledgmentReminder(Date.now() + 60_000)).toBeUndefined();
  });
});
