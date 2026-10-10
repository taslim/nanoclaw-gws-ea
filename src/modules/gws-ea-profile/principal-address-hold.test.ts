/**
 * A new principal address waits for the principal once the inbox exists:
 * mail from a principal address authenticates as the principal and carries
 * their authority, so main's `ncl principal-addresses add` is held for the
 * principal's card. The operator adds directly, and removing an address,
 * which only narrows that authority, stays direct.
 *
 * Drives the real ncl dispatcher and the real approvals flow against a real
 * central DB and real session DBs. Only the container runner and the wake
 * are mocked.
 */
import fs from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-gws-ea-profile-hold',
    GROUPS_DIR: '/tmp/nanoclaw-test-gws-ea-profile-hold/groups',
  };
});

vi.mock('../../container-runner.js', () => ({
  getContainerStartedAtMs: vi.fn(() => Date.now()),
  isContainerRunning: vi.fn(() => false),
  killContainer: vi.fn(),
  wakeContainer: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn().mockResolvedValue(true) }));

import { dispatch } from '../../cli/dispatch.js';
import type { CallerContext } from '../../cli/frame.js';
import { getDb } from '../../db/connection.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
import { setMessagingGroupDetachedAt } from '../../db/messaging-groups.js';
import { registerMigration } from '../../db/migrations/index.js';
import { setDeliveryAdapter } from '../../delivery.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { resolveSession } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { handleApprovalsResponse } from '../approvals/response-handler.js';
import { gwsEaInboxMigration } from '../gws-ea-inbox/migration.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { upsertUser } from '../permissions/db/users.js';
import { bindVerifiedPrincipalUser, listPrincipalAddresses, reconcileGwsEaProfile } from './db.js';
import './index.js';

// The inbox's store alone: whether it exists is what the hold reads.
registerMigration(gwsEaInboxMigration);

const TEST_DIR = '/tmp/nanoclaw-test-gws-ea-profile-hold';
const PRINCIPAL = 'gchat:users/principal';
const DM = { channelType: 'gchat', platformId: 'gchat:spaces/dm' } as const;
const NEW_ADDRESS = 'morgan@new.example.test';

interface Sent {
  readonly channelType: string;
  readonly platformId: string;
  readonly content: string;
}

let sent: Sent[];
let main: Session;
let research: Session;

function now(): string {
  return new Date().toISOString();
}

function agent(session: Session): CallerContext {
  return {
    caller: 'agent',
    sessionId: session.id,
    agentGroupId: session.agent_group_id,
    messagingGroupId: session.messaging_group_id ?? '',
  };
}

const HOST: CallerContext = { caller: 'host' };

function run(command: string, args: Record<string, unknown>, ctx: CallerContext = HOST) {
  return dispatch({ id: command, command, args }, ctx);
}

async function addresses(): Promise<string[]> {
  return (await listPrincipalAddresses()).map((address) => address.email);
}

async function pendingApprovals(): Promise<PendingApproval[]> {
  return getDb().all<PendingApproval>('SELECT * FROM pending_approvals ORDER BY created_at');
}

/** What the host told the agent as a system note. */
function notes(session: Session): string[] {
  const file = inboundDbPath(session.agent_group_id, session.id);
  if (!fs.existsSync(file)) return [];
  const db = new Database(file, { readonly: true });
  try {
    return (db.prepare('SELECT content FROM messages_in ORDER BY seq').all() as Array<{ content: string }>)
      .map((row) => JSON.parse(row.content) as { sender?: string; text?: string })
      .filter((content) => content.sender === 'system')
      .map((content) => content.text ?? '');
  } finally {
    db.close();
  }
}

/** The host creates the inbox's messaging group at its first start after external-email exists. */
async function createInbox(): Promise<void> {
  await createMessagingGroup({
    id: 'mg-inbox',
    channel_type: 'email',
    platform_id: 'email:inbox',
    name: 'inbox',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await getDb().run('UPDATE gws_ea_inbox_state SET messaging_group_id = ? WHERE singleton = 1', 'mg-inbox');
}

async function click(approval: PendingApproval, value: 'approve' | 'reject', userId = PRINCIPAL): Promise<void> {
  await handleApprovalsResponse({
    questionId: approval.approval_id,
    value,
    userId,
    channelType: DM.channelType,
    platformId: DM.platformId,
    threadId: null,
  });
}

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  sent = [];
  setDeliveryAdapter({
    async deliver(channelType, platformId, _threadId, _kind, content) {
      sent.push({ channelType, platformId, content });
      return 'platform-message';
    },
  });

  for (const [id, name] of [
    ['ag-main', 'main'],
    ['ag-research', 'research'],
  ] as const) {
    await createAgentGroup({ id, name, folder: name, agent_provider: null, created_at: now() });
    await ensureContainerConfig(id);
    await updateContainerConfigScalars(id, { cli_scope: 'global' });
  }
  await createMessagingGroup({
    id: 'mg-dm',
    channel_type: DM.channelType,
    platform_id: DM.platformId,
    name: 'Principal',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await reconcileGwsEaProfile({
    assistantDisplayName: 'Aya',
    assistantWorkspaceEmail: 'aya@example.test',
    principalDisplayName: 'Morgan',
    principalTimezone: 'Africa/Lagos',
    mainAgentGroupId: 'ag-main',
    principalEmails: ['morgan@example.test', 'morgan@work.example.test'],
  });
  await upsertUser({ id: PRINCIPAL, kind: 'gchat', display_name: 'Morgan', created_at: now() });
  await bindVerifiedPrincipalUser(PRINCIPAL, now());
  await upsertUserDm({ user_id: PRINCIPAL, channel_type: 'gchat', messaging_group_id: 'mg-dm', resolved_at: now() });

  main = (await resolveSession('ag-main', 'mg-dm', null, 'agent-shared')).session;
  research = (await resolveSession('ag-research', 'mg-dm', null, 'shared')).session;
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('a new principal address before the inbox exists', () => {
  it("is added on main's word alone, since it decides only whose calendars are theirs", async () => {
    expect(await run('principal-addresses-add', { email: NEW_ADDRESS }, agent(main))).toMatchObject({
      ok: true,
      data: { email: NEW_ADDRESS, added: true },
    });
    expect(await addresses()).toContain(NEW_ADDRESS);
    expect(await pendingApprovals()).toEqual([]);
  });
});

describe('a new principal address once the inbox exists', () => {
  beforeEach(createInbox);

  it("holds main's address for the principal's card, ignores anyone else's click, and adds it once the principal approves", async () => {
    const response = await run('principal-addresses-add', { email: 'Morgan@New.Example.test' }, agent(main));
    expect(response).toMatchObject({ ok: true, data: { email: NEW_ADDRESS, status: 'awaiting-principal' } });
    expect(await addresses()).not.toContain(NEW_ADDRESS);

    const [approval] = await pendingApprovals();
    expect(approval).toMatchObject({
      action: 'principal_address_add',
      approver_user_id: PRINCIPAL,
      payload: JSON.stringify({ email: NEW_ADDRESS }),
    });
    const [card] = sent;
    expect(card).toMatchObject(DM);
    expect(JSON.parse(card!.content)).toMatchObject({
      type: 'ask_question',
      questionId: approval!.approval_id,
      question: expect.stringContaining(NEW_ADDRESS),
    });

    // Nobody but the named principal can decide it.
    await click(approval!, 'approve', 'gchat:users/someone-else');
    expect(await addresses()).not.toContain(NEW_ADDRESS);
    expect(await pendingApprovals()).toHaveLength(1);

    await click(approval!, 'approve');
    expect(await addresses()).toEqual(['morgan@example.test', NEW_ADDRESS, 'morgan@work.example.test']);
    expect(await pendingApprovals()).toEqual([]);
    expect(notes(main).at(-1)).toBe(`The principal confirmed. ${NEW_ADDRESS} is now one of their addresses.`);
  });

  it('asks as the assistant, by its name, never as the agent group', async () => {
    await run('principal-addresses-add', { email: NEW_ADDRESS }, agent(main));
    await getDb().run('UPDATE gws_ea_profile SET assistant_display_name = NULL WHERE singleton = 1');
    await run('principal-addresses-add', { email: 'morgan@other.example.test' }, agent(main));

    const questions = sent.map((card) => (JSON.parse(card.content) as { question: string }).question);
    expect(questions).toEqual([
      expect.stringMatching(/^Aya asks to record morgan@new\.example\.test as one of your email addresses\./),
      expect.stringMatching(
        /^Your assistant asks to record morgan@other\.example\.test as one of your email addresses\./,
      ),
    ]);
    for (const question of questions) expect(question).not.toMatch(/\bmain\b/);
  });

  it("tells the principal the address also gets the assistant's folder, what it is trusted with beside their mail", async () => {
    await run('principal-addresses-add', { email: NEW_ADDRESS }, agent(main));

    const [card] = sent;
    const { question } = JSON.parse(card!.content) as { question: string };
    expect(question).toMatch(/treated as yours, with your authority/u);
    expect(question).toMatch(/can open the Google Drive folder where the assistant keeps what it makes for you/u);
    expect(question).toMatch(/approve only if this address is yours\.$/u);
  });

  it('keeps the address out when the principal rejects the card', async () => {
    await run('principal-addresses-add', { email: NEW_ADDRESS }, agent(main));
    const [approval] = await pendingApprovals();

    await click(approval!, 'reject');
    expect(await addresses()).not.toContain(NEW_ADDRESS);
    expect(await pendingApprovals()).toEqual([]);
    expect(notes(main).at(-1)).toMatch(/rejected/i);
  });

  it('lets the operator add an address directly', async () => {
    expect(await run('principal-addresses-add', { email: NEW_ADDRESS })).toMatchObject({
      ok: true,
      data: { email: NEW_ADDRESS, added: true },
    });
    expect(await addresses()).toContain(NEW_ADDRESS);
    expect(await pendingApprovals()).toEqual([]);
  });

  it('removes an address on main’s word, since removing one only narrows who speaks for the principal', async () => {
    expect(await run('principal-addresses-remove', { email: 'morgan@work.example.test' }, agent(main))).toMatchObject({
      ok: true,
      data: { email: 'morgan@work.example.test', removed: true },
    });
    expect(await addresses()).toEqual(['morgan@example.test']);
    expect(await pendingApprovals()).toEqual([]);
  });

  it('sends no card for an address already held, or one refused before it could be added', async () => {
    expect(await run('principal-addresses-add', { email: 'Morgan@Example.test' }, agent(main))).toMatchObject({
      ok: true,
      data: { email: 'morgan@example.test', added: false },
    });
    for (const email of ['not-an-email', 'AYA@example.test']) {
      expect(await run('principal-addresses-add', { email }, agent(main)), email).toMatchObject({ ok: false });
    }
    expect(await run('principal-addresses-add', { email: NEW_ADDRESS }, agent(research))).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/only main/i) },
    });
    expect(await pendingApprovals()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('refuses a new address while no principal can confirm it', async () => {
    await getDb().run('DELETE FROM gws_ea_principal_users');

    expect(await run('principal-addresses-add', { email: NEW_ADDRESS }, agent(main))).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/No verified principal/) },
    });
    expect(await addresses()).not.toContain(NEW_ADDRESS);
    expect(await pendingApprovals()).toEqual([]);
  });

  it('sends the card to a principal identity whose direct message still has the assistant, never a detached one', async () => {
    const later = 'gchat:users/principal-later';
    await createMessagingGroup({
      id: 'mg-dm-later',
      channel_type: DM.channelType,
      platform_id: 'gchat:spaces/dm-later',
      name: 'Principal',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    await upsertUser({ id: later, kind: 'gchat', display_name: 'Morgan', created_at: now() });
    await bindVerifiedPrincipalUser(later, new Date(Date.now() + 60_000).toISOString());
    await upsertUserDm({
      user_id: later,
      channel_type: 'gchat',
      messaging_group_id: 'mg-dm-later',
      resolved_at: now(),
    });
    await setMessagingGroupDetachedAt('mg-dm-later', now());

    await run('principal-addresses-add', { email: NEW_ADDRESS }, agent(main));
    const [approval] = await pendingApprovals();
    expect(approval).toMatchObject({ approver_user_id: PRINCIPAL, platform_id: DM.platformId });
    expect(sent.map((card) => card.platformId)).toEqual([DM.platformId]);
  });

  it("refuses a new address while the principal's only direct message is detached", async () => {
    await setMessagingGroupDetachedAt('mg-dm', now());

    expect(await run('principal-addresses-add', { email: NEW_ADDRESS }, agent(main))).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/No verified principal/) },
    });
    expect(await pendingApprovals()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('drops an approval whose clicker is no longer the verified principal, keeping the address out', async () => {
    await run('principal-addresses-add', { email: NEW_ADDRESS }, agent(main));
    const [approval] = await pendingApprovals();
    await getDb().run('DELETE FROM gws_ea_principal_users');

    await click(approval!, 'approve');
    expect(await addresses()).not.toContain(NEW_ADDRESS);
    expect(notes(main).at(-1)).toBe(
      `${NEW_ADDRESS} was not added: only the principal can confirm one of their addresses.`,
    );
  });
});
