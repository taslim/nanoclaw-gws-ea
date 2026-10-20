/**
 * Regression coverage for approval response authorization.
 *
 * Approval cards may be delivered to an admin DM, but the callback payload is
 * still untrusted input. The response handler must not dispatch sensitive
 * approval handlers merely because a response carries a valid questionId.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession, createPendingApproval, getPendingApproval } from '../../db/sessions.js';
import { setDeliveryAdapter } from '../../delivery.js';
import { normalizeOptions } from '../../channels/ask-question.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import Database from 'better-sqlite3';
import { upsertUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-approval-response-authz' };
});

const TEST_DIR = '/tmp/nanoclaw-test-approval-response-authz';

function now() {
  return new Date().toISOString();
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
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('approval response authorization', () => {
  it('ignores a valid approval id clicked by a non-admin user', async () => {
    const { registerApprovalHandler } = await import('./primitive.js');
    const { handleApprovalsResponse } = await import('./response-handler.js');
    const handler = vi.fn().mockResolvedValue(undefined);
    registerApprovalHandler('install_packages', handler);

    await createPendingApproval({
      approval_id: 'appr-1',
      session_id: 'sess-1',
      request_id: 'appr-1',
      action: 'install_packages',
      payload: JSON.stringify({ packages: ['left-pad'] }),
      created_at: now(),
      title: 'Install packages',
      options_json: JSON.stringify([]),
    });

    const claimed = await handleApprovalsResponse({
      questionId: 'appr-1',
      value: 'approve',
      userId: 'stranger',
      channelType: 'telegram',
      platformId: 'dm-stranger',
      threadId: null,
    });

    expect(claimed).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(await getPendingApproval('appr-1')).toBeDefined();
  });

  it('allows an owner/admin click to dispatch the registered approval handler', async () => {
    await upsertUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Owner', created_at: now() });
    await grantRole({
      user_id: 'telegram:owner',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });

    const { registerApprovalHandler } = await import('./primitive.js');
    const { handleApprovalsResponse } = await import('./response-handler.js');
    const handler = vi.fn().mockResolvedValue(undefined);
    registerApprovalHandler('install_packages_allowed', handler);

    await createPendingApproval({
      approval_id: 'appr-2',
      session_id: 'sess-1',
      request_id: 'appr-2',
      action: 'install_packages_allowed',
      payload: JSON.stringify({ packages: ['left-pad'] }),
      created_at: now(),
      title: 'Install packages',
      options_json: JSON.stringify([]),
    });

    const claimed = await handleApprovalsResponse({
      questionId: 'appr-2',
      value: 'approve',
      userId: 'owner',
      channelType: 'telegram',
      platformId: 'dm-owner',
      threadId: null,
    });

    expect(claimed).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ userId: 'telegram:owner' }));
    expect(await getPendingApproval('appr-2')).toBeUndefined();
  });

  it('lets only one concurrent approval response run the action handler', async () => {
    await upsertUser({ id: 'telegram:owner-race', kind: 'telegram', display_name: 'Owner', created_at: now() });
    await grantRole({
      user_id: 'telegram:owner-race',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { registerApprovalHandler } = await import('./primitive.js');
    const { handleApprovalsResponse } = await import('./response-handler.js');
    const handler = vi.fn(async () => held);
    registerApprovalHandler('approval_race_action', handler);
    await createPendingApproval({
      approval_id: 'appr-race',
      session_id: 'sess-1',
      request_id: 'appr-race',
      action: 'approval_race_action',
      payload: JSON.stringify({}),
      created_at: now(),
      title: 'Race approval',
      options_json: JSON.stringify([]),
    });
    const response = {
      questionId: 'appr-race',
      value: 'approve',
      userId: 'owner-race',
      channelType: 'telegram',
      platformId: 'dm-owner-race',
      threadId: null,
    };

    const first = handleApprovalsResponse(response);
    const second = handleApprovalsResponse(response);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(await getPendingApproval('appr-race')).toBeUndefined();
  });

  it('allows global admins to resolve approvals without a session-scoped agent group', async () => {
    await upsertUser({
      id: 'telegram:global-admin',
      kind: 'telegram',
      display_name: 'Global Admin',
      created_at: now(),
    });
    await grantRole({
      user_id: 'telegram:global-admin',
      role: 'admin',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });

    const { registerApprovalHandler } = await import('./primitive.js');
    const { handleApprovalsResponse } = await import('./response-handler.js');
    const handler = vi.fn().mockResolvedValue(undefined);
    registerApprovalHandler('global_admin_allowed', handler);

    await createPendingApproval({
      approval_id: 'appr-3',
      session_id: 'sess-1',
      agent_group_id: null,
      request_id: 'appr-3',
      action: 'global_admin_allowed',
      payload: JSON.stringify({ packages: ['left-pad'] }),
      created_at: now(),
      title: 'Install packages',
      options_json: JSON.stringify([]),
    });

    const claimed = await handleApprovalsResponse({
      questionId: 'appr-3',
      value: 'approve',
      userId: 'global-admin',
      channelType: 'telegram',
      platformId: 'dm-global-admin',
      threadId: null,
    });

    expect(claimed).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await getPendingApproval('appr-3')).toBeUndefined();
  });

  it('an approval with approver_user_id is resolvable by that user, not a non-assignee', async () => {
    const { registerApprovalHandler } = await import('./primitive.js');
    const { handleApprovalsResponse } = await import('./response-handler.js');
    const handler = vi.fn().mockResolvedValue(undefined);
    registerApprovalHandler('assigned_approver_action', handler);

    await createPendingApproval({
      approval_id: 'appr-4',
      session_id: 'sess-1',
      request_id: 'appr-4',
      action: 'assigned_approver_action',
      payload: JSON.stringify({}),
      created_at: now(),
      title: 'Assigned approval',
      options_json: JSON.stringify([]),
      approver_user_id: 'telegram:dana',
    });

    // A non-assignee (no global/owner role) cannot resolve it.
    await handleApprovalsResponse({
      questionId: 'appr-4',
      value: 'approve',
      userId: 'stranger',
      channelType: 'telegram',
      platformId: 'dm-stranger',
      threadId: null,
    });
    expect(handler).not.toHaveBeenCalled();
    expect(await getPendingApproval('appr-4')).toBeDefined();

    // The named approver resolves it.
    await handleApprovalsResponse({
      questionId: 'appr-4',
      value: 'approve',
      userId: 'dana',
      channelType: 'telegram',
      platformId: 'dm-dana',
      threadId: null,
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await getPendingApproval('appr-4')).toBeUndefined();
  });
});

describe('an answer on a channel that left the request as posted', () => {
  // Text requests (and presentations that defer resolution) leave the request
  // unchanged until the handler that authorizes an answer edits it to its
  // outcome, addressed by question id in the conversation the answer came from.
  const OPTIONS = normalizeOptions([
    { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
    { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
    { label: 'Reject with reason…', selectedLabel: '📝 Rejected (awaiting reason)', value: 'reject_with_reason' },
  ]);
  const QUESTION = "I'd like to install ffmpeg to cut the video.";
  let edits: Array<{ platformId: string; instance: string | undefined; content: Record<string, unknown> }>;

  beforeEach(async () => {
    edits = [];
    setDeliveryAdapter({
      async deliver(_channelType, platformId, _threadId, _kind, content, _files, instance) {
        edits.push({ platformId, instance, content: JSON.parse(content) as Record<string, unknown> });
        return undefined;
      },
    });
    await upsertUser({ id: 'gchat:users/2001', kind: 'gchat', display_name: 'Morgan Ellery', created_at: now() });
    await createPendingApproval({
      approval_id: 'appr-text',
      session_id: 'sess-1',
      request_id: 'appr-text',
      action: 'install_packages_text',
      payload: JSON.stringify({ packages: ['ffmpeg'] }),
      created_at: now(),
      title: 'Install packages',
      question: QUESTION,
      options_json: JSON.stringify(OPTIONS),
      approver_user_id: 'gchat:users/2001',
    });
  });

  function answer(value: string, userId: string, reason?: string) {
    return {
      questionId: 'appr-text',
      value,
      ...(reason === undefined ? {} : { reason }),
      userId,
      channelType: 'gchat',
      instance: 'gchat',
      messageId: 'spaces/AAAAjuno/messages/morgan.1',
      platformId: 'gchat:spaces/AAAAjuno',
      threadId: null,
      deferResolution: true,
    };
  }

  function outcomeEdit(resolution: string) {
    return {
      platformId: 'gchat:spaces/AAAAjuno',
      instance: 'gchat',
      content: {
        operation: 'edit',
        questionId: 'appr-text',
        messageId: 'spaces/AAAAjuno/messages/morgan.1',
        text: `Install packages\n\n${QUESTION}\n\n${resolution}`,
        terminalCard: { title: 'Install packages', question: QUESTION, resolution },
      },
    };
  }

  function agentNotes(): string[] {
    const db = new Database(inboundDbPath('ag-1', 'sess-1'), { readonly: true });
    try {
      return (db.prepare('SELECT content FROM messages_in ORDER BY seq').all() as Array<{ content: string }>).map(
        (row) => (JSON.parse(row.content) as { text: string }).text,
      );
    } finally {
      db.close();
    }
  }

  it('leaves the request open and unedited when someone other than its approver answers', async () => {
    const { registerApprovalHandler } = await import('./primitive.js');
    const { handleApprovalsResponse } = await import('./response-handler.js');
    const handler = vi.fn().mockResolvedValue(undefined);
    registerApprovalHandler('install_packages_text', handler);

    expect(await handleApprovalsResponse(answer('approve', 'users/3003'))).toBe(true);

    expect(handler).not.toHaveBeenCalled();
    expect(edits).toEqual([]);
    expect((await getPendingApproval('appr-text'))?.status).toBe('pending');
  });

  it("edits the request to its outcome once its approver's answer is authorized, then applies it", async () => {
    const { registerApprovalHandler } = await import('./primitive.js');
    const { handleApprovalsResponse } = await import('./response-handler.js');
    const editsWhenApplied: number[] = [];
    registerApprovalHandler('install_packages_text', async () => {
      editsWhenApplied.push(edits.length);
    });

    expect(await handleApprovalsResponse(answer('approve', 'users/2001'))).toBe(true);

    expect(edits).toEqual([outcomeEdit('✅ Approved')]);
    expect(editsWhenApplied).toEqual([1]);
    expect(await getPendingApproval('appr-text')).toBeUndefined();
  });

  it('rejects with the reason given after the no, and shows it in the outcome as quoted text', async () => {
    const { handleApprovalsResponse } = await import('./response-handler.js');

    await handleApprovalsResponse(answer('reject', 'users/2001', 'too expensive, ask <users/all> "first" *today*'));

    // How quoted text reads is request-text.test.ts's; here, that the outcome shows the reason that way.
    expect(edits).toEqual([outcomeEdit(`❌ Rejected: "too expensive, ask <users/all> 'first' *today*"`)]);
    expect(agentNotes()).toEqual([
      'Your install_packages_text request was rejected by admin: "too expensive, ask <users/all> "first" *today*"',
    ]);
    expect(await getPendingApproval('appr-text')).toBeUndefined();
  });

  it('leaves a card the channel already resolved alone', async () => {
    const { handleApprovalsResponse } = await import('./response-handler.js');

    await handleApprovalsResponse({ ...answer('reject', 'users/2001'), deferResolution: undefined });

    expect(edits).toEqual([]);
    expect(await getPendingApproval('appr-text')).toBeUndefined();
  });
});
