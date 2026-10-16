/**
 * Approval-resolved callback registry.
 *
 * Drives the real response-handler entry (`handleApprovalsResponse`) and
 * asserts that callbacks registered via `registerApprovalResolvedHandler`
 * fire when an admin resolves a pending approval — the hook modules use to
 * observe approval resolution (e.g. clearing an "awaiting approval" status
 * indicator). Goes red if the response handler stops calling
 * `notifyApprovalResolved`.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDb, initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import {
  createSession,
  createPendingApproval,
  getPendingApproval,
  transitionPendingApprovalStatus,
} from '../../db/sessions.js';
import { upsertUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { initSessionFolder } from '../../session-manager.js';
import { handleApprovalsResponse, resumeApprovedApprovals } from './response-handler.js';
import { registerApprovalHandler, registerApprovalResolvedHandler, type ApprovalResolvedEvent } from './primitive.js';
import { detachApproval, finishApprovalWithdrawal, sweepExpiredApprovals, withdrawApproval } from './lifecycle.js';
import { setDeliveryAdapter } from '../../delivery.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-approval-resolved' };
});

const TEST_DIR = '/tmp/nanoclaw-test-approval-resolved';

function now() {
  return new Date().toISOString();
}

async function seedApproval(approvalId: string, action: string): Promise<void> {
  await createPendingApproval({
    approval_id: approvalId,
    session_id: 'sess-1',
    request_id: approvalId,
    action,
    payload: JSON.stringify({}),
    created_at: now(),
    title: 'Test approval',
    options_json: JSON.stringify([]),
  });
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);

  await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  await createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  });
  initSessionFolder('ag-1', 'sess-1');

  // Resolution only happens for authorized clicks — seed the clicking admin.
  await upsertUser({ id: 'slack:admin-1', kind: 'slack', display_name: 'Admin', created_at: now() });
  await grantRole({
    user_id: 'slack:admin-1',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('approval-resolved callbacks', () => {
  it('fires registered callbacks on reject with the approval, session, and outcome', async () => {
    const events: ApprovalResolvedEvent[] = [];
    registerApprovalResolvedHandler((event) => {
      events.push(event);
    });

    await seedApproval('appr-reject-1', 'test_reject_action');
    const claimed = await handleApprovalsResponse({
      questionId: 'appr-reject-1',
      value: 'reject',
      userId: 'slack:admin-1',
      channelType: 'slack',
      platformId: 'slack:C1',
      threadId: null,
    });

    expect(claimed).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('reject');
    expect(events[0].approval.approval_id).toBe('appr-reject-1');
    expect(events[0].approval.action).toBe('test_reject_action');
    expect(events[0].session.id).toBe('sess-1');
    expect(events[0].userId).toBe('slack:admin-1');
  });

  it('keeps an approved grant live during its handler and emits only approve', async () => {
    const calls: string[] = [];
    registerApprovalHandler('test_approve_action', async ({ approval }) => {
      calls.push(`withdraw:${await withdrawApproval(approval.approval_id, 'Cancelled')}`);
      calls.push(`grant:${(await getPendingApproval(approval.approval_id))?.status}`);
    });
    registerApprovalResolvedHandler(({ outcome }) => {
      calls.push(`resolved:${outcome}`);
    });

    await seedApproval('appr-approve-1', 'test_approve_action');
    await handleApprovalsResponse({
      questionId: 'appr-approve-1',
      value: 'approve',
      userId: 'slack:admin-1',
      channelType: 'slack',
      platformId: 'slack:C1',
      threadId: null,
    });

    expect(calls).toEqual(['withdraw:false', 'grant:approved', 'resolved:approve']);
  });

  it('isolates a throwing callback so later callbacks still fire', async () => {
    const events: string[] = [];
    registerApprovalResolvedHandler(() => {
      events.push('boom');
      throw new Error('callback exploded');
    });
    registerApprovalResolvedHandler(() => {
      events.push('after');
    });

    await seedApproval('appr-reject-2', 'test_isolation_action');
    const claimed = await handleApprovalsResponse({
      questionId: 'appr-reject-2',
      value: 'reject',
      userId: 'slack:admin-1',
      channelType: 'slack',
      platformId: 'slack:C1',
      threadId: null,
    });

    expect(claimed).toBe(true);
    expect(events).toEqual(['boom', 'after']);
  });
});

describe('approval lifecycle', () => {
  it('withdraws a bound card once and makes a later click inert', async () => {
    const delivered: string[] = [];
    setDeliveryAdapter({
      async deliver(_channel, _platform, _thread, _kind, content) {
        delivered.push(content);
        return 'edited';
      },
    });
    const events: ApprovalResolvedEvent[] = [];
    registerApprovalResolvedHandler((event) => {
      events.push(event);
    });
    const handler = vi.fn();
    registerApprovalHandler('withdrawn_action', handler);
    await seedApproval('appr-withdraw', 'withdrawn_action');
    await getDb().run(
      'UPDATE pending_approvals SET channel_type = ?, platform_id = ?, platform_message_id = ?, instance = ? WHERE approval_id = ?',
      'slack',
      'D-admin',
      'pm-bound',
      'slack-named',
      'appr-withdraw',
    );
    expect(await withdrawApproval('appr-withdraw', 'Withdrawn — job cancelled')).toBe(true);
    expect(await withdrawApproval('appr-withdraw', 'Withdrawn again')).toBe(false);
    expect(await getPendingApproval('appr-withdraw')).toBeUndefined();
    expect(events.map((event) => event.outcome)).toEqual(['withdrawn']);
    const edit = JSON.parse(delivered[0]) as { messageId: string; terminalCard: { resolution: string } };
    expect(edit.messageId).toBe('pm-bound');
    expect(edit.terminalCard.resolution).toBe('Withdrawn — job cancelled');
    expect(
      await handleApprovalsResponse({
        questionId: 'appr-withdraw',
        value: 'approve',
        userId: 'slack:admin-1',
        channelType: 'slack',
        platformId: 'D-admin',
        threadId: null,
      }),
    ).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('detaches inside a caller transaction and edits only after commit', async () => {
    const delivered: string[] = [];
    setDeliveryAdapter({
      async deliver(_channel, _platform, _thread, _kind, content) {
        delivered.push(content);
        return 'edited';
      },
    });
    await seedApproval('appr-split', 'split_action');
    await getDb().run(
      'UPDATE pending_approvals SET channel_type = ?, platform_id = ?, platform_message_id = ? WHERE approval_id = ?',
      'slack',
      'D-admin',
      'pm-split',
      'appr-split',
    );
    const row = await getDb().transaction(async () => {
      const detached = await detachApproval('appr-split');
      expect(await getPendingApproval('appr-split')).toBeUndefined();
      expect(delivered).toEqual([]);
      return detached;
    });
    expect(row).not.toBeNull();
    if (!row) throw new Error('Expected detached approval');
    expect(
      await handleApprovalsResponse({
        questionId: row.approval_id,
        value: 'approve',
        userId: 'slack:admin-1',
        channelType: 'slack',
        platformId: 'D-admin',
        threadId: null,
      }),
    ).toBe(false);
    await finishApprovalWithdrawal(row, 'Withdrawn — replaced');
    expect(delivered).toHaveLength(1);
  });

  it('sweeps expired module approvals once without taking gateway rows', async () => {
    const events: ApprovalResolvedEvent[] = [];
    registerApprovalResolvedHandler((event) => {
      events.push(event);
    });
    registerApprovalHandler('expires_action', async () => undefined);
    await seedApproval('appr-expired', 'expires_action');
    await seedApproval('appr-gateway', 'gateway_request');
    await seedApproval('appr-already-approved', 'expires_action');
    await getDb().run('UPDATE pending_approvals SET expires_at = ?', new Date(Date.now() - 1_000).toISOString());
    await transitionPendingApprovalStatus('appr-already-approved', 'pending', 'approved');
    await seedApproval('appr-future', 'expires_action');
    await getDb().run(
      'UPDATE pending_approvals SET expires_at = ? WHERE approval_id = ?',
      new Date(Date.now() + 60_000).toISOString(),
      'appr-future',
    );
    await seedApproval('appr-no-expiry', 'expires_action');
    await sweepExpiredApprovals();
    await sweepExpiredApprovals();
    expect(await getPendingApproval('appr-expired')).toBeUndefined();
    expect(await getPendingApproval('appr-gateway')).toBeDefined();
    expect((await getPendingApproval('appr-already-approved'))?.status).toBe('approved');
    expect(await getPendingApproval('appr-future')).toBeDefined();
    expect(await getPendingApproval('appr-no-expiry')).toBeDefined();
    expect(events.map((event) => event.outcome)).toEqual(['expired']);
  });

  it('replays only explicitly restart-safe approved handlers and keeps their grant live', async () => {
    const observed: string[] = [];
    registerApprovalHandler(
      'restart_safe_action',
      async ({ approval }) => {
        const row = await getPendingApproval(approval.approval_id);
        observed.push(row?.status ?? 'missing');
      },
      { restartSafe: true },
    );
    const createAgent = vi.fn();
    registerApprovalHandler('create_agent', createAgent);
    await seedApproval('appr-safe', 'restart_safe_action');
    await seedApproval('appr-unsafe', 'create_agent');
    await transitionPendingApprovalStatus('appr-safe', 'pending', 'approved');
    await transitionPendingApprovalStatus('appr-unsafe', 'pending', 'approved');
    await resumeApprovedApprovals();
    await resumeApprovedApprovals();
    expect(observed).toEqual(['approved']);
    expect(createAgent).not.toHaveBeenCalled();
    expect(await getPendingApproval('appr-safe')).toBeUndefined();
    expect((await getPendingApproval('appr-unsafe'))?.status).toBe('approved');
  });

  it('never accepts an approval clicked after expiry but before the next sweep', async () => {
    const handler = vi.fn();
    registerApprovalHandler('expired_click', handler);
    await seedApproval('appr-expired-click', 'expired_click');
    await getDb().run(
      'UPDATE pending_approvals SET expires_at = ? WHERE approval_id = ?',
      new Date(Date.now() - 1_000).toISOString(),
      'appr-expired-click',
    );
    expect(
      await handleApprovalsResponse({
        questionId: 'appr-expired-click',
        value: 'approve',
        userId: 'slack:admin-1',
        channelType: 'slack',
        platformId: 'D-admin',
        threadId: null,
      }),
    ).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(await getPendingApproval('appr-expired-click')).toBeUndefined();
  });
});
