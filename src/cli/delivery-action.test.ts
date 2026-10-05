/**
 * The typed `action_response`: how every delivery action that answers a
 * calling tool writes its answer, `cli_request` included.
 */
import fs from 'fs';
import path from 'path';
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
import { resolveSession, sessionDir } from '../session-manager.js';
import type { Session } from '../types.js';
import { runGuarded } from '../delivery-guard.js';
import { ALLOW, DENY, defineGuardedAction, HOLD } from '../guard/index.js';
import { ActionRefusal, answeredGuard, answeringAction, writeActionResponse } from './delivery-action.js';

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

describe('an answering action', () => {
  const frameOf = (requestId: string): unknown => answers(requestId).map((row) => row.content.frame);

  it('answers with what it returns, once, however often its request is delivered', async () => {
    let runs = 0;
    const handler = answeringAction('fixture', async (_content, _session, requestId) => ({ requestId, runs: ++runs }));
    await handler({ requestId: 'ok-1' }, session);
    await handler({ requestId: 'ok-1' }, session);
    expect(frameOf('ok-1')).toEqual([{ id: 'ok-1', ok: true, data: { requestId: 'ok-1', runs: 1 } }]);
  });

  it('answers a refusal with its code and words, and a failure as the host’s', async () => {
    const refusing = answeringAction('fixture', async () => {
      throw new ActionRefusal('invalid-args', 'when must be a time');
    });
    const failing = answeringAction('fixture', async () => {
      throw new Error('Calendar unreachable');
    });
    await refusing({ requestId: 'no-1' }, session);
    await failing({ requestId: 'no-2' }, session);
    expect(frameOf('no-1')).toEqual([
      { id: 'no-1', ok: false, error: { code: 'invalid-args', message: 'when must be a time' } },
    ]);
    expect(frameOf('no-2')).toEqual([
      {
        id: 'no-2',
        ok: false,
        error: { code: 'handler-error', message: 'The host could not do it: Calendar unreachable' },
      },
    ]);
  });

  it('does nothing for a request it answered already', async () => {
    const answer = vi.fn(async () => ({ done: true }));
    const handler = answeringAction('fixture', answer);
    await handler({ requestId: 'again-1' }, session);
    await handler({ requestId: 'again-1' }, session);
    expect(answer).toHaveBeenCalledTimes(1);
    expect(frameOf('again-1')).toEqual([{ id: 'again-1', ok: true, data: { done: true } }]);
  });

  it('lets go of the files a request staged once it answers it, a refusal included', async () => {
    const stage = (requestId: string): string => {
      const dir = path.join(sessionDir(session.agent_group_id, session.id), 'outbox', requestId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'agenda.pdf'), 'agenda');
      return dir;
    };
    const handler = answeringAction('fixture', async () => ({}));
    const refusing = answeredGuard(
      defineGuardedAction({ action: 'fixture.refusing', decide: () => DENY('Not yours.') }),
    );
    const answered = stage('files-1');
    const refused = stage('files-2');

    await handler({ requestId: 'files-1' }, session);
    await runGuarded('fixture', refusing, handler, { requestId: 'files-2' }, session, null);
    expect(fs.existsSync(answered)).toBe(false);
    expect(fs.existsSync(refused)).toBe(false);
  });

  it('does nothing for a request no tool waits on', async () => {
    const answer = vi.fn(async () => ({}));
    await answeringAction('fixture', answer)({ requestId: 'not an id' }, session);
    expect(answer).not.toHaveBeenCalled();
  });

  it('answers a denial or a hold as a refusal, so the calling tool never waits it out', async () => {
    const answer = vi.fn(async () => ({}));
    const handler = answeringAction('fixture', answer);
    const denied = answeredGuard(defineGuardedAction({ action: 'fixture.denied', decide: () => DENY('Not yours.') }));
    const held = answeredGuard(defineGuardedAction({ action: 'fixture.held', decide: () => HOLD('Ask first.') }));
    const allowed = answeredGuard(defineGuardedAction({ action: 'fixture.allowed', decide: () => ALLOW('yours') }));

    await runGuarded('fixture', denied, handler, { requestId: 'g-1' }, session, null);
    await runGuarded('fixture', held, handler, { requestId: 'g-2' }, session, null);
    await runGuarded('fixture', allowed, handler, { requestId: 'not an id' }, session, null);
    expect(answer).not.toHaveBeenCalled();
    expect(frameOf('g-1')).toEqual([{ id: 'g-1', ok: false, error: { code: 'forbidden', message: 'Not yours.' } }]);
    expect(frameOf('g-2')).toEqual([
      { id: 'g-2', ok: false, error: { code: 'forbidden', message: 'This request cannot wait for an approval.' } },
    ]);
  });
});
