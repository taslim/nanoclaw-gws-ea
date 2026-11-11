/**
 * A parked send (one past its delivery deadline) keeps the claim a
 * conversation cleanup waits on until it settles, and a row given up on while
 * parked reaches the delivery-failed hooks before it is recorded failed.
 *
 * Same on-disk mailbox fixture as delivery-deadline.test.ts, under fake timers.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-delivery-deadline-claims',
    GROUPS_DIR: '/tmp/nanoclaw-test-delivery-deadline-claims/groups',
  };
});

/** How many coming failure records fail, as a session DB that cannot be written does. */
const failingRecords = vi.hoisted(() => ({ remaining: 0 }));

vi.mock('./mailbox/sqlite/session-db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mailbox/sqlite/session-db.js')>();
  return {
    ...actual,
    markDeliveryFailed: (...args: Parameters<typeof actual.markDeliveryFailed>) => {
      if (failingRecords.remaining > 0) {
        failingRecords.remaining -= 1;
        throw new Error('disk I/O error');
      }
      return actual.markDeliveryFailed(...args);
    },
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-delivery-deadline-claims';
const DEADLINE_MS = 60_000; // DELIVERY_DEADLINE_MS in delivery.ts
const GIVE_UP_MS = 60 * 60_000; // OVERDUE_GIVE_UP_MS in delivery.ts
const RECORD_RETRY_MS = 60_000; // GIVEN_UP_RECORD_RETRY_MS in delivery.ts
const STOP_WAIT_MS = 10_000; // STOP_WAIT_MS in delivery.ts

import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from './db/index.js';
import {
  _resetDeliveryStateForTesting,
  deliverSessionMessages,
  registerDeliveryFailedHook,
  setDeliveryAdapter,
  waitForSessionChannelDelivery,
} from './delivery.js';
import { log } from './log.js';
import { inboundDbPath, outboundDbPath } from './mailbox/sqlite/paths.js';
import { resolveSession } from './session-manager.js';
import type { Session } from './types.js';

function now(): string {
  return new Date().toISOString();
}

function insertOutbound(target: Session, msgId: string): void {
  const db = new Database(outboundDbPath(target.agent_group_id, target.id));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, ?, 'chat', 'telegram:123', 'telegram', ?)`,
  ).run(msgId, now(), JSON.stringify({ text: msgId }));
  db.close();
}

function deliveredStatus(target: Session, msgId: string): string | undefined {
  const db = new Database(inboundDbPath(target.agent_group_id, target.id), { readonly: true });
  const row = db.prepare('SELECT status FROM delivered WHERE message_out_id = ?').get(msgId) as
    | { status: string }
    | undefined;
  db.close();
  return row?.status;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Sends answered from `plan` (a promise to hold the send on, or nothing for an immediate success). */
function recordingAdapter(plan: (text: string, call: number) => Promise<string> | undefined): string[] {
  const calls: string[] = [];
  setDeliveryAdapter({
    async deliver(_ct, _pid, _tid, _kind, content) {
      const text = (JSON.parse(content) as { text: string }).text;
      calls.push(text);
      return (await plan(text, calls.filter((t) => t === text).length)) ?? `pm-${text}`;
    },
  });
  return calls;
}

/** Park the session's next send: one drain held past the deadline. */
async function parkNextSend(target: Session): Promise<void> {
  const drain = deliverSessionMessages(target);
  await vi.advanceTimersByTimeAsync(DEADLINE_MS);
  await drain;
}

/** Whether a cleanup's wait would settle now, and how. */
async function cleanupWait(target: Session): Promise<'settled' | 'pending' | Error> {
  let outcome: 'settled' | 'pending' | Error = 'pending';
  void waitForSessionChannelDelivery(target.id).then(
    () => (outcome = 'settled'),
    (err: unknown) => (outcome = err as Error),
  );
  await vi.advanceTimersByTimeAsync(0);
  return outcome;
}

let session: Session;
/** Delivery-failed reports for this test's session, each with the row's recorded status at report time. */
let reports: Array<{ id: string; recordedAtReport: string | undefined }>;

// Hooks cannot be unregistered; this one reports only the current test's session.
registerDeliveryFailedHook((failed, hookSession) => {
  if (hookSession.id !== session.id) return;
  for (const msg of failed) reports.push({ id: msg.id, recordedAtReport: deliveredStatus(session, msg.id) });
});

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'telegram:123',
    name: 'Test Chat',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  ({ session } = await resolveSession('ag-1', 'mg-1', null, 'shared'));
  reports = [];
  failingRecords.remaining = 0;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(log, 'warn').mockImplementation(() => {});
  vi.spyOn(log, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  _resetDeliveryStateForTesting();
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('parked sends and conversation cleanup', () => {
  it('keeps a cleanup waiting while a parked send is out, even after a later reply lands', async () => {
    insertOutbound(session, 'out-slow');
    const slow = deferred<string>();
    recordingAdapter((text) => (text === 'out-slow' ? slow.promise : undefined));

    await parkNextSend(session);
    insertOutbound(session, 'out-next');
    await deliverSessionMessages(session);
    expect(deliveredStatus(session, 'out-next')).toBe('delivered');

    // The later reply's claim is gone; the parked one's is not.
    const waiting = waitForSessionChannelDelivery(session.id);
    const settled = expect(waiting).rejects.toThrow('has not settled');
    await vi.advanceTimersByTimeAsync(STOP_WAIT_MS);
    await settled;

    slow.resolve('pm-slow');
    await vi.waitFor(() => expect(deliveredStatus(session, 'out-slow')).toBe('delivered'));
    expect(await cleanupWait(session)).toBe('settled');
  });

  it('a send that never settles is reported before it is recorded failed, and frees the cleanup', async () => {
    insertOutbound(session, 'out-wedged');
    recordingAdapter((text) => (text === 'out-wedged' ? new Promise<string>(() => {}) : undefined));

    await parkNextSend(session);
    expect(await cleanupWait(session)).toBe('pending');

    await vi.advanceTimersByTimeAsync(GIVE_UP_MS);
    await vi.waitFor(() => expect(deliveredStatus(session, 'out-wedged')).toBe('failed'));
    expect(reports).toEqual([{ id: 'out-wedged', recordedAtReport: undefined }]);
    expect(await cleanupWait(session)).toBe('settled');
  });

  it('a given-up row whose failure cannot be recorded stays parked, never sent again, until the record holds', async () => {
    insertOutbound(session, 'out-stuck');
    const calls = recordingAdapter((text) => (text === 'out-stuck' ? new Promise<string>(() => {}) : undefined));

    await parkNextSend(session);
    failingRecords.remaining = 1;
    await vi.advanceTimersByTimeAsync(GIVE_UP_MS);
    await vi.waitFor(() => expect(reports).toEqual([{ id: 'out-stuck', recordedAtReport: undefined }]));
    expect(deliveredStatus(session, 'out-stuck')).toBeUndefined();

    await deliverSessionMessages(session);
    expect(calls).toEqual(['out-stuck']);
    expect(await cleanupWait(session)).toBe('pending');

    await vi.advanceTimersByTimeAsync(RECORD_RETRY_MS);
    await vi.waitFor(() => expect(deliveredStatus(session, 'out-stuck')).toBe('failed'));
    expect(reports).toHaveLength(1);
    expect(await cleanupWait(session)).toBe('settled');
    await deliverSessionMessages(session);
    expect(calls).toEqual(['out-stuck']);
  });

  it('a parked send that fails its last attempt late is reported, then recorded failed', async () => {
    insertOutbound(session, 'out-flaky');
    const last = deferred<string>();
    const calls = recordingAdapter((text, call) => {
      if (text !== 'out-flaky') return undefined;
      return call < 3 ? Promise.reject(new Error('socket hang up')) : last.promise;
    });

    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    await parkNextSend(session);
    expect(reports).toEqual([]);

    last.reject(new Error('socket hang up'));
    await vi.waitFor(() => expect(deliveredStatus(session, 'out-flaky')).toBe('failed'));
    expect(reports).toEqual([{ id: 'out-flaky', recordedAtReport: undefined }]);
    await deliverSessionMessages(session);
    expect(calls).toEqual(['out-flaky', 'out-flaky', 'out-flaky']);
  });
});
