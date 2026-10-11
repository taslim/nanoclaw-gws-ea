import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentGroup } from '../db/agent-groups.js';
import { closeDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { createPendingApproval, createPendingQuestion, createSession } from '../db/sessions.js';
import { log } from '../log.js';
import { registerQuestionRenderResolver, resolveQuestionRender } from './question-render-registry.js';

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  await closeDb();
  vi.restoreAllMocks();
});

describe('question render resolver registry', () => {
  it('runs module resolvers in registration order and stops on the first result', async () => {
    const order: string[] = [];
    const later = vi.fn(() => undefined);
    const expected = {
      title: 'Module question',
      options: [{ label: 'Approve', selectedLabel: 'Approved', value: 'approve' }],
    };

    registerQuestionRenderResolver((questionId) => {
      if (questionId !== 'module-order-question') return undefined;
      order.push('first');
      return undefined;
    });
    registerQuestionRenderResolver((questionId) => {
      if (questionId !== 'module-order-question') return undefined;
      order.push('second');
      return expected;
    });
    registerQuestionRenderResolver((questionId) => {
      if (questionId !== 'module-order-question') return undefined;
      later();
      return undefined;
    });

    expect(await resolveQuestionRender('module-order-question')).toBe(expected);
    expect(order).toEqual(['first', 'second']);
    expect(later).not.toHaveBeenCalled();
  });

  it('resolves over a snapshot when a resolver registers another resolver', async () => {
    const expected = {
      title: 'Registered during resolution',
      options: [{ label: 'Continue', selectedLabel: 'Continued', value: 'continue' }],
    };
    const registeredDuringResolution = vi.fn((questionId: string) =>
      questionId === 'snapshot-question' ? expected : undefined,
    );
    registerQuestionRenderResolver((questionId) => {
      if (questionId !== 'snapshot-question') return undefined;
      registerQuestionRenderResolver(registeredDuringResolution);
      return undefined;
    });

    expect(await resolveQuestionRender('snapshot-question')).toBeUndefined();
    expect(registeredDuringResolution).not.toHaveBeenCalled();

    expect(await resolveQuestionRender('snapshot-question')).toBe(expected);
    expect(registeredDuringResolution).toHaveBeenCalledOnce();
  });

  it('logs an optional resolver failure and continues to the built-in fallback', async () => {
    const failure = new Error('resolver failure');
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    registerQuestionRenderResolver((questionId) => {
      if (questionId === 'resolver-failure-question') throw failure;
      return undefined;
    });
    await createPendingApproval({
      approval_id: 'resolver-failure-question',
      request_id: 'request-resolver-failure',
      action: 'test-action',
      payload: '{}',
      created_at: new Date().toISOString(),
      title: 'Built-in fallback after failure',
      options_json: JSON.stringify([{ label: 'Allow', selectedLabel: 'Allowed', value: 'allow' }]),
    });

    expect(await resolveQuestionRender('resolver-failure-question')).toEqual({
      title: 'Built-in fallback after failure',
      kind: 'approval',
      question: '',
      options: [{ label: 'Allow', selectedLabel: 'Allowed', value: 'allow' }],
    });
    expect(errorSpy).toHaveBeenCalledWith('Question render resolver threw', { err: failure });
  });

  it('uses the existing database lookup as the final built-in fallback', async () => {
    await createPendingApproval({
      approval_id: 'built-in-render-question',
      request_id: 'request-1',
      action: 'test-action',
      payload: '{}',
      created_at: new Date().toISOString(),
      title: 'Built-in approval',
      options_json: JSON.stringify([{ label: 'Allow', selectedLabel: 'Allowed', value: 'allow' }]),
    });

    expect(await resolveQuestionRender('built-in-render-question')).toEqual({
      title: 'Built-in approval',
      kind: 'approval',
      question: '',
      options: [{ label: 'Allow', selectedLabel: 'Allowed', value: 'allow' }],
    });
  });

  it("tells a pending approval's expiry, and that an approval no longer pending is resolved", async () => {
    const approval = {
      request_id: 'request-gateway',
      action: 'gateway_request',
      payload: '{}',
      created_at: new Date().toISOString(),
      expires_at: '2026-10-10T17:02:00.000Z',
      title: 'Credentials request',
      options_json: JSON.stringify([{ label: 'Approve', selectedLabel: 'Approved', value: 'approve' }]),
    };
    await createPendingApproval({ ...approval, approval_id: 'ga-open' });
    await createPendingApproval({ ...approval, approval_id: 'ga-decided', status: 'approved' });

    expect(await resolveQuestionRender('ga-open')).toEqual(
      expect.objectContaining({ deferResolution: true, expiresAt: '2026-10-10T17:02:00.000Z' }),
    );
    expect(await resolveQuestionRender('ga-open')).not.toHaveProperty('resolved');
    expect(await resolveQuestionRender('ga-decided')).toEqual(expect.objectContaining({ resolved: true }));
    expect(await resolveQuestionRender('ga-decided')).not.toHaveProperty('expiresAt');
  });

  it("tells an agent's own question from an approval", async () => {
    const now = new Date().toISOString();
    await createAgentGroup({ id: 'ag-main', name: 'Main', folder: 'main', agent_provider: null, created_at: now });
    await createSession({
      id: 'sess-main',
      agent_group_id: 'ag-main',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: now,
      created_at: now,
    });
    await createPendingQuestion({
      question_id: 'agent-question',
      session_id: 'sess-main',
      message_out_id: 'out-agent-question',
      platform_id: 'gchat:spaces/AAAAjuno',
      channel_type: 'gchat',
      thread_id: null,
      title: 'Book the room',
      question: 'Shall I book Atlas for Thursday?',
      options: [
        { label: 'Yes', selectedLabel: 'Yes', value: 'yes' },
        { label: 'No', selectedLabel: 'No', value: 'no' },
      ],
      deadline: '2026-10-10T17:05:00.000Z',
      created_at: now,
    });
    await createPendingApproval({
      approval_id: 'install-approval',
      request_id: 'request-install',
      action: 'install_packages',
      payload: '{}',
      created_at: now,
      title: 'Install packages',
      options_json: JSON.stringify([{ label: 'Approve', selectedLabel: 'Approved', value: 'approve' }]),
    });

    expect(await resolveQuestionRender('agent-question')).toEqual(
      expect.objectContaining({ kind: 'question', expiresAt: '2026-10-10T17:05:00.000Z' }),
    );
    expect(await resolveQuestionRender('install-approval')).toEqual(expect.objectContaining({ kind: 'approval' }));
  });

  it('returns undefined when neither a module nor the built-in fallback owns the id', async () => {
    expect(await resolveQuestionRender('unowned-render-question')).toBeUndefined();
  });
});
