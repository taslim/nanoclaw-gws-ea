/**
 * Every GWS-EA approval words its own rejection (KTD14): the principal's no reads as their decision, with no
 * "admin" and no action id. A module that tells the agent itself registers a null note, so the agent hears once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import type { PendingApproval } from '../types.js';
import { getApprovalRejectionNote, getRegisteredApprovalActions } from './approvals/primitive.js';
import './index.js';

/** NanoClaw's own approvals, which keep its generic rejection text. */
const UPSTREAM_ACTIONS: ReadonlySet<string> = new Set([
  'install_packages',
  'add_mcp_server',
  'create_agent',
  'a2a_message_gate',
  'cli_command',
]);
/** Actions whose module-owned settlement already tells the requesting job once. */
const TOLD_BY_THEIR_MODULE = [
  'browser_consent',
  'browser_purchase',
  'browser_watch_setup',
  'artifact_share_private_values',
];
const WORDED = [
  'browser_credential_release',
  'browser_reservation_guarantee',
  'browser_vault_email',
  'principal_address_add',
  'private_value_remove',
];

function rejected(action: string): PendingApproval {
  return {
    approval_id: 'appr-1760900000000-a1b2c3',
    session_id: 'session-main',
    request_id: 'appr-1760900000000-a1b2c3',
    action,
    payload: '{}',
    created_at: '2026-10-19T17:00:00.000Z',
    agent_group_id: null,
    channel_type: 'gchat',
    platform_id: 'spaces/morgan',
    instance: null,
    platform_message_id: 'card-1',
    expires_at: null,
    status: 'pending',
    title: 'Approve?',
    question: 'May I?',
    options_json: '[]',
    approver_user_id: 'gchat:users/morgan',
  };
}

beforeEach(async () => {
  await runMigrations(await initTestDb());
});
afterEach(async () => {
  await closeDb();
});

describe('rejections of GWS-EA approvals', () => {
  it('registers a rejection note for every GWS-EA approval action', () => {
    const actions = getRegisteredApprovalActions().filter((action) => !UPSTREAM_ACTIONS.has(action));
    expect([...actions].sort()).toEqual([...TOLD_BY_THEIR_MODULE, ...WORDED].sort());
    for (const action of actions) expect(getApprovalRejectionNote(action), action).toBeDefined();
  });

  it.each(TOLD_BY_THEIR_MODULE)('writes no generic note for %s, whose module tells the job once', async (action) => {
    expect(await getApprovalRejectionNote(action)!(rejected(action), 'not now')).toBeNull();
  });

  it.each(WORDED)('words a no on %s as the principal’s decision, with no admin and no action id', async (action) => {
    for (const reason of [undefined, 'not now']) {
      const note = await getApprovalRejectionNote(action)!(rejected(action), reason);
      expect(note).toMatch(/^The principal (declined|chose) /u);
      expect(note).not.toMatch(/admin|appr-|_/u);
      if (reason) expect(note).toContain(`"${reason}"`);
    }
  });
});
