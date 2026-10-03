/**
 * KTD5's destination admission: no raw destination joins main and
 * external-email, external-email addresses nothing but its inbox, and no
 * other group addresses the inbox. Each write path refuses one, and status
 * reports a row that got in behind the check.
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-gws-ea-external-email-destinations-test';

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-gws-ea-external-email-destinations-test/groups',
  DATA_DIR: '/tmp/nanoclaw-gws-ea-external-email-destinations-test/data',
  TEMPLATES_DIR: `${process.cwd()}/templates`,
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

// Answering create_agent wakes the requester's container; stop at its inbound queue.
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));

import { dispatch } from '../../cli/dispatch.js';
import '../../cli/resources/destinations.js';
import '../../cli/resources/wirings.js';
import { ensureContainerConfig } from '../../db/container-configs.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import {
  closeDb,
  createAgentGroup,
  createSession,
  getAllAgentGroups,
  getDb,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { getHostStartCallbacks } from '../../host-lifecycle.js';
import { initSessionFolder } from '../../session-manager.js';
import type { AgentGroup, Session } from '../../types.js';
import { createAgent } from '../agent-to-agent/create-agent.js';
import { reconcileGwsEaProfile } from '../gws-ea-profile/db.js';
import { externalEmailHealth, getExternalEmailAgentGroupId } from './index.js';
import '../gws-ea-profile/index.js';

const INBOX = 'mg-inbox';
const CHAT = 'mg-chat';

let main: AgentGroup;
let research: AgentGroup;
let ee: string;

function group(id: string, name: string): AgentGroup {
  return { id, name, folder: name, agent_provider: null, created_at: new Date().toISOString() };
}

async function startHost(): Promise<void> {
  const signal = new AbortController().signal;
  const deliveryAdapter = { deliver: async () => undefined };
  for (const start of getHostStartCallbacks()) await start({ db: getDb(), deliveryAdapter, signal });
}

async function addDestination(owner: string, targetType: 'agent' | 'channel', target: string) {
  return dispatch(
    {
      id: 'add',
      command: 'destinations-add',
      args: { agent_group_id: owner, local_name: `to-${target}`, target_type: targetType, target_id: target },
    },
    { caller: 'host' },
  );
}

async function wire(agentGroupId: string) {
  return dispatch(
    {
      id: 'wire',
      command: 'wirings-create',
      args: { messaging_group_id: INBOX, agent_group_id: agentGroupId },
    },
    { caller: 'host' },
  );
}

async function destinations(): Promise<Array<{ agent_group_id: string; target_type: string; target_id: string }>> {
  return getDb().all('SELECT agent_group_id, target_type, target_id FROM agent_destinations ORDER BY agent_group_id');
}

async function sessionOf(agentGroupId: string): Promise<Session> {
  const session: Session = {
    id: `sess-${agentGroupId}`,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
  await createSession(session);
  initSessionFolder(agentGroupId, session.id);
  return session;
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  await runMigrations(await initTestDb());
  main = group('ag-main', 'main');
  research = group('ag-research', 'research');
  for (const value of [main, research]) {
    await createAgentGroup(value);
    await ensureContainerConfig(value.id);
  }
  await reconcileGwsEaProfile({
    assistantDisplayName: 'Aya',
    assistantWorkspaceEmail: 'aya@example.test',
    principalDisplayName: 'Taslim',
    principalTimezone: 'America/Los_Angeles',
    mainAgentGroupId: main.id,
  });
  await startHost();
  const id = await getExternalEmailAgentGroupId();
  if (id === null) throw new Error('external-email was not created');
  ee = id;
  for (const [id, channel] of [
    [INBOX, 'email'],
    [CHAT, 'gchat'],
  ] as const) {
    await createMessagingGroup({
      id,
      channel_type: channel,
      platform_id: `${channel}:${id}`,
      name: id,
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: new Date().toISOString(),
    });
  }
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('ncl destinations add', () => {
  it.each([
    ['main to external-email', () => [main.id, 'agent', ee] as const],
    ['external-email to main', () => [ee, 'agent', main.id] as const],
    ['another group to external-email', () => [research.id, 'agent', ee] as const],
    ['external-email to any other chat', () => [ee, 'channel', CHAT] as const],
    ['another group to the inbox', () => [research.id, 'channel', INBOX] as const],
  ])('refuses %s', async (_label, row) => {
    const [owner, type, target] = row();

    const response = await addDestination(owner, type, target);

    expect(response).toMatchObject({ ok: false, error: { message: expect.stringMatching(/refused/) } });
    expect(await destinations()).toEqual([]);
  });

  it('admits a destination that touches neither', async () => {
    expect(await addDestination(main.id, 'agent', research.id)).toMatchObject({ ok: true });
    expect(await addDestination(main.id, 'channel', CHAT)).toMatchObject({ ok: true });
  });
});

describe('wiring companion rows', () => {
  it("gives external-email its inbox wiring's destination, and refuses another group's wiring to the inbox", async () => {
    expect(await wire(ee)).toMatchObject({ ok: true });
    expect(await destinations()).toEqual([{ agent_group_id: ee, target_type: 'channel', target_id: INBOX }]);

    expect(await wire(research.id)).toMatchObject({ ok: false });
    expect(
      await getDb().all('SELECT agent_group_id FROM messaging_group_agents WHERE messaging_group_id = ?', INBOX),
    ).toEqual([{ agent_group_id: ee }]);
    expect(await destinations()).toEqual([{ agent_group_id: ee, target_type: 'channel', target_id: INBOX }]);
  });
});

describe('create_agent', () => {
  it('refuses a child of external-email before any group or destination exists', async () => {
    const before = (await getAllAgentGroups()).map((value) => value.id).sort();

    await createAgent({ name: 'helper' }, await sessionOf(ee));

    expect((await getAllAgentGroups()).map((value) => value.id).sort()).toEqual(before);
    expect(await destinations()).toEqual([]);
  });

  it('still creates a child of main, with both destinations', async () => {
    await createAgent({ name: 'helper' }, await sessionOf(main.id));

    const child = (await getAllAgentGroups()).find((value) => value.name === 'helper');
    expect(child).toBeDefined();
    expect(await destinations()).toEqual(
      expect.arrayContaining([
        { agent_group_id: main.id, target_type: 'agent', target_id: child?.id },
        { agent_group_id: child?.id, target_type: 'agent', target_id: main.id },
      ]),
    );
  });
});

describe('status', () => {
  it('names each row that got in behind the check', async () => {
    const now = new Date().toISOString();
    for (const [owner, name, type, target] of [
      [main.id, 'helper', 'agent', ee],
      [research.id, 'inbox', 'channel', INBOX],
    ] as const) {
      await getDb().run(
        'INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?)',
        owner,
        name,
        type,
        target,
        now,
      );
    }

    const { problems } = await externalEmailHealth();

    expect(problems).toEqual([
      expect.stringMatching(new RegExp(`${main.id}.*helper`, 'u')),
      expect.stringMatching(new RegExp(`${research.id}.*inbox`, 'u')),
    ]);
  });
});
