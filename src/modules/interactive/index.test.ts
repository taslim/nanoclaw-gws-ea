/**
 * The answer to an agent's question: written into its session as the
 * question_response its waiting tool reads, the question closed, and — on a
 * channel that left the question as posted — the question edited in place
 * to the choice, once the answer is in.
 */
import fs from 'fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { normalizeOptions } from '../../channels/ask-question.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createPendingQuestion, createSession, getPendingQuestion } from '../../db/sessions.js';
import { setDeliveryAdapter } from '../../delivery.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { getResponseHandlers, type ResponsePayload } from '../../response-registry.js';
import { wakeContainer } from '../../container-runner.js';

vi.mock('../../container-runner.js', () => ({ wakeContainer: vi.fn().mockResolvedValue(true) }));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-interactive-response' };
});

const TEST_DIR = '/tmp/nanoclaw-test-interactive-response';
const DM = 'gchat:spaces/AAAAjuno';
const QUESTION = 'When should I book the review with Juno?';

interface Sent {
  readonly platformId: string;
  readonly instance: string | undefined;
  readonly content: Record<string, unknown>;
  /** The agent's answers already in its session when this was sent. */
  readonly answersWritten: number;
}

let sent: Sent[];

function now(): string {
  return new Date().toISOString();
}

/** The question_response rows the waiting tool would read. */
function answersInSession(): Array<Record<string, unknown>> {
  const path = inboundDbPath('ag-1', 'sess-1');
  if (!fs.existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare("SELECT content FROM messages_in WHERE kind = 'system'").all() as Array<{ content: string }>)
      .map((row) => JSON.parse(row.content) as Record<string, unknown>)
      .filter((content) => content.type === 'question_response');
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  await import('./index.js');
  await createAgentGroup({ id: 'ag-1', name: 'Main', folder: 'main', agent_provider: null, created_at: now() });
  await createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: now(),
    created_at: now(),
  });
  await createPendingQuestion({
    question_id: 'q-time',
    session_id: 'sess-1',
    message_out_id: 'out-q-time',
    platform_id: DM,
    channel_type: 'gchat',
    thread_id: null,
    title: 'Pick a time',
    question: QUESTION,
    options: normalizeOptions([
      { label: 'Tuesday 3pm', value: 'tue' },
      { label: 'Wednesday 10am', selectedLabel: '✅ Wednesday 10am', value: 'wed' },
    ]),
    deadline: new Date(Date.now() + 300_000).toISOString(),
    created_at: now(),
  });
  sent = [];
  setDeliveryAdapter({
    async deliver(_channelType, platformId, _threadId, _kind, content, _files, instance) {
      sent.push({
        platformId,
        instance,
        content: JSON.parse(content) as Record<string, unknown>,
        answersWritten: answersInSession().length,
      });
      return undefined;
    },
  });
  vi.mocked(wakeContainer).mockClear();
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

async function answer(payload: Partial<ResponsePayload>): Promise<boolean> {
  for (const handler of getResponseHandlers()) {
    if (
      await handler({
        questionId: 'q-time',
        value: 'wed',
        userId: 'users/2001',
        channelType: 'gchat',
        instance: 'gchat',
        messageId: 'spaces/AAAAjuno/messages/morgan.1',
        platformId: DM,
        threadId: null,
        ...payload,
      })
    )
      return true;
  }
  return false;
}

describe("an answer to an agent's question", () => {
  it('reaches the waiting agent, closes the question, and edits it to the choice where it was asked', async () => {
    expect(await answer({ deferResolution: true })).toBe(true);

    expect(answersInSession()).toEqual([
      { type: 'question_response', questionId: 'q-time', selectedOption: 'wed', userId: 'users/2001' },
    ]);
    expect(await getPendingQuestion('q-time')).toBeUndefined();
    expect(sent).toEqual([
      {
        platformId: DM,
        instance: 'gchat',
        answersWritten: 1,
        content: {
          operation: 'edit',
          questionId: 'q-time',
          messageId: 'spaces/AAAAjuno/messages/morgan.1',
          text: `Pick a time\n\n${QUESTION}\n\n✅ Wednesday 10am`,
          terminalCard: { title: 'Pick a time', question: QUESTION, resolution: '✅ Wednesday 10am' },
        },
      },
    ]);
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('leaves a card the channel already resolved alone', async () => {
    expect(await answer({})).toBe(true);

    expect(answersInSession()).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  it('is not claimed for a question no agent asked', async () => {
    expect(await answer({ questionId: 'q-unknown', deferResolution: true })).toBe(false);

    expect(answersInSession()).toEqual([]);
    expect(sent).toEqual([]);
  });
});
