/** Approval delivery and persistence against the real central DB. */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import * as approvalsDb from '../../db/sessions.js';
import { createSession, getPendingApprovalsByAction } from '../../db/sessions.js';
import * as delivery from '../../delivery.js';
import { setDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { requestApproval } from './primitive.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-approval-primitive' };
});

vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn() };
});

const TEST_DIR = '/tmp/nanoclaw-test-approval-primitive';
const DM_CHANNEL = 'slack';
const DM_PLATFORM = 'D-admin-1';

function now(): string {
  return new Date().toISOString();
}

let session: Session;

beforeEach(async () => {
  vi.clearAllMocks();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);

  await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  session = {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  };
  await createSession(session);

  // Authorized approver + a cached DM so ensureUserDm resolves without a
  // platform openDM call.
  await upsertUser({ id: 'slack:admin-1', kind: 'slack', display_name: 'Admin', created_at: now() });
  await grantRole({
    user_id: 'slack:admin-1',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-dm-1',
    channel_type: DM_CHANNEL,
    platform_id: DM_PLATFORM,
    name: 'Admin DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await upsertUserDm({
    user_id: 'slack:admin-1',
    channel_type: DM_CHANNEL,
    messaging_group_id: 'mg-dm-1',
    resolved_at: now(),
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

/** The text of the most recent agent-facing note written via writeSessionMessage. */
function lastNotifyText(): string | undefined {
  const call = vi.mocked(writeSessionMessage).mock.calls.at(-1);
  if (!call) return undefined;
  return (JSON.parse(call[2].content) as { text: string }).text;
}

describe('requestApproval delivery failure', () => {
  it('removes the pending approval row and notifies the agent when delivery throws', async () => {
    const failingAdapter: ChannelDeliveryAdapter = {
      async deliver() {
        throw new Error('platform down');
      },
    };
    setDeliveryAdapter(failingAdapter);

    const result = await requestApproval({
      session,
      agentName: 'Agent',
      action: 'test_action',
      payload: { key: 'value' },
      title: 'Test Approval',
      question: 'Approve the thing?',
    });

    // No orphan: the row created before the delivery attempt is gone.
    expect(result).toBeNull();
    expect(await getPendingApprovalsByAction('test_action')).toHaveLength(0);
    expect(lastNotifyText()).toMatch(/test_action failed: could not deliver/);
  });

  it('keeps the delivered approval after a transient binding failure', async () => {
    vi.spyOn(approvalsDb, 'bindPendingApprovalMessage').mockRejectedValueOnce(new Error('database busy'));
    const okAdapter: ChannelDeliveryAdapter = {
      async deliver() {
        return 'pm-1';
      },
    };
    setDeliveryAdapter(okAdapter);

    const result = await requestApproval({
      session,
      agentName: 'Agent',
      action: 'test_action',
      payload: { key: 'value' },
      title: 'Test Approval',
      question: 'Approve the thing?',
    });

    const [approval] = await getPendingApprovalsByAction('test_action');
    expect(approval).toMatchObject({ approval_id: result, platform_message_id: 'pm-1' });
    expect(vi.mocked(writeSessionMessage)).not.toHaveBeenCalled();
  });

  it('retires the posted card when its message id cannot be persisted', async () => {
    vi.spyOn(approvalsDb, 'bindPendingApprovalMessage').mockRejectedValue(new Error('binding unavailable'));
    const deliver = vi.fn<ChannelDeliveryAdapter['deliver']>().mockResolvedValue('pm-unbound');
    setDeliveryAdapter({ deliver });

    const result = await requestApproval({
      session,
      agentName: 'Agent',
      action: 'test_action',
      payload: {},
      title: 'Test Approval',
      question: 'Approve the thing?',
    });

    expect(result).toBeNull();
    expect(await getPendingApprovalsByAction('test_action')).toEqual([]);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(JSON.parse(deliver.mock.calls[1][4])).toMatchObject({
      operation: 'edit',
      messageId: 'pm-unbound',
      terminalCard: { resolution: '⚠️ Canceled — approval request could not be recorded' },
    });
    expect(lastNotifyText()).toMatch(/test_action failed: could not record the delivered approval request/);
  });
});

describe('approval presentation and expiry', () => {
  it('stores expiry and uses the caller origin instead of the unrelated default', async () => {
    setDeliveryAdapter({
      async deliver() {
        return 'pm-origin';
      },
    });
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const id = await requestApproval({
      session,
      agentName: 'Agent',
      action: 'custom_origin',
      payload: {},
      title: 'Approval',
      question: 'Approve?',
      expiresAt,
      originLine: 'This is for your Friday reservation.',
    });
    const [row] = await getPendingApprovalsByAction('custom_origin');
    expect(id).toBe(row.approval_id);
    expect(row.expires_at).toBe(expiresAt);
    expect(row.question).toBe('Approve?\n\nThis is for your Friday reservation.');
  });

  it('does not leave a pending request when no delivery adapter exists', async () => {
    const adapter = vi.spyOn(delivery, 'getDeliveryAdapter').mockReturnValue(null);
    const id = await requestApproval({
      session,
      agentName: 'Agent',
      action: 'no_adapter',
      payload: {},
      title: 'Approval',
      question: 'Approve?',
    });
    expect(id).toBeNull();
    expect(await getPendingApprovalsByAction('no_adapter')).toEqual([]);
    adapter.mockRestore();
  });
});
