/**
 * The typed `action_response`: how every delivery action that answers a
 * calling tool writes its answer, `cli_request` included.
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-test-delivery-action';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-delivery-action' };
});

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../db/index.js';
import { getDeliveryAction } from '../delivery.js';
import { inboundDbPath } from '../mailbox/sqlite/paths.js';
import { resolveSession } from '../session-manager.js';
import type { Session } from '../types.js';
import { writeActionResponse } from './delivery-action.js';

let session: Session;

function answers(requestId: string): Array<{ kind: string; trigger: number; content: Record<string, unknown> }> {
  const db = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  const rows = db.prepare('SELECT kind, trigger, content FROM messages_in ORDER BY seq').all() as Array<{
    kind: string;
    trigger: number;
    content: string;
  }>;
  db.close();
  return rows
    .map((row) => ({ ...row, content: JSON.parse(row.content) as Record<string, unknown> }))
    .filter((row) => row.content.requestId === requestId);
}

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: 'ag-1',
    name: 'one',
    folder: 'one',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  session = (await resolveSession('ag-1', null, null, 'agent-shared')).session;
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('action_response', () => {
  it('answers a request in the caller’s session without waking it', async () => {
    await writeActionResponse(session, 'req-1', { id: 'req-1', ok: true, data: { done: true } });
    expect(answers('req-1')).toEqual([
      {
        kind: 'system',
        trigger: 0,
        content: {
          type: 'action_response',
          requestId: 'req-1',
          frame: { id: 'req-1', ok: true, data: { done: true } },
        },
      },
    ]);
  });

  it('keeps the first answer when a replay answers again', async () => {
    await writeActionResponse(session, 'req-2', { id: 'req-2', ok: true, data: 1 });
    await writeActionResponse(session, 'req-2', { id: 'req-2', ok: true, data: 2 });
    expect(answers('req-2').map((row) => (row.content.frame as { data: unknown }).data)).toEqual([1]);
  });

  it('carries the answer to a cli_request, and a replayed cli_request answers once', async () => {
    const handler = getDeliveryAction('cli_request');
    const request = { action: 'cli_request', requestId: 'cli-1', command: 'no-such-command', args: {} };
    await handler?.(request, session);
    await handler?.(request, session);
    const [answer, ...rest] = answers('cli-1');
    expect(rest).toEqual([]);
    expect(answer.content).toMatchObject({
      type: 'action_response',
      requestId: 'cli-1',
      frame: { id: 'cli-1', ok: false, error: { code: 'unknown-command' } },
    });
  });
});
