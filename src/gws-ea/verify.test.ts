import Database from 'better-sqlite3';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { principalWelcomeEventId } from './principal.js';
import { verifyPrincipalBinding, verifyTalkableConversation, type ConversationVerificationInput } from './verify.js';

const MAIN = 'ag-main';
const DM = 'mg-principal';
const USER = 'gchat:users/principal';
const PLATFORM = 'gchat:spaces/dm-principal';
const INSTANCE = 'gchat-assistant';
const WELCOME = 'gws-ea-welcome:stable';
const BOUND_AT = '2026-09-18T18:00:00.000Z';
const WELCOME_AT = '2026-09-18T18:00:01.000Z';
const WELCOME_DELIVERED_AT = '2026-09-18T18:00:03.000Z';
const LATER_AT = '2026-09-18T18:01:00.000Z';

let checkout = '';
let central: Database.Database;
let inbound: Database.Database;
let outbound: Database.Database;

function input(overrides: Partial<ConversationVerificationInput> = {}): ConversationVerificationInput {
  return {
    checkoutRoot: checkout,
    mainAgentGroupId: MAIN,
    messagingGroupId: DM,
    principalUserId: USER,
    adapterInstance: INSTANCE,
    boundAt: BOUND_AT,
    welcomeEventId: WELCOME,
    ...overrides,
  };
}

function seedBinding(): void {
  central.exec(`
    CREATE TABLE gws_ea_profile (singleton INTEGER PRIMARY KEY, main_agent_group_id TEXT);
    CREATE TABLE gws_ea_principal_users (user_id TEXT PRIMARY KEY, verified_at TEXT NOT NULL);
    CREATE TABLE user_dms (user_id TEXT, channel_type TEXT, messaging_group_id TEXT);
    CREATE TABLE messaging_groups (
      id TEXT PRIMARY KEY, channel_type TEXT, platform_id TEXT, instance TEXT, is_group INTEGER
    );
    CREATE TABLE messaging_group_agents (
      messaging_group_id TEXT, agent_group_id TEXT, sender_scope TEXT, session_mode TEXT
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, agent_group_id TEXT, messaging_group_id TEXT, thread_id TEXT, status TEXT
    );
    CREATE TABLE agent_group_members (user_id TEXT, agent_group_id TEXT);
    CREATE TABLE user_roles (user_id TEXT, role TEXT, agent_group_id TEXT);
    CREATE TABLE unregistered_senders (
      channel_type TEXT, platform_id TEXT, instance TEXT, user_id TEXT, sender_name TEXT,
      sender_authenticated INTEGER, sender_kind TEXT, is_group INTEGER,
      authenticated_message_id TEXT, authenticated_message_at TEXT, reason TEXT,
      messaging_group_id TEXT
    );
  `);
  central.prepare('INSERT INTO gws_ea_profile VALUES (1, ?)').run(MAIN);
  central.prepare('INSERT INTO gws_ea_principal_users VALUES (?, ?)').run(USER, BOUND_AT);
  central.prepare('INSERT INTO user_dms VALUES (?, ?, ?)').run(USER, 'gchat', DM);
  central.prepare('INSERT INTO messaging_groups VALUES (?, ?, ?, ?, 0)').run(DM, 'gchat', PLATFORM, INSTANCE);
  central.prepare('INSERT INTO messaging_group_agents VALUES (?, ?, ?, ?)').run(DM, MAIN, 'known', 'agent-shared');
  central.prepare("INSERT INTO sessions VALUES ('session-main', ?, NULL, NULL, 'active')").run(MAIN);
}

function seedMailboxes(): void {
  inbound.exec(`
    CREATE TABLE messages_in (
      id TEXT PRIMARY KEY, kind TEXT, timestamp TEXT, status TEXT, trigger INTEGER,
      platform_id TEXT, channel_type TEXT, thread_id TEXT, content TEXT
    );
    CREATE TABLE delivered (
      message_out_id TEXT PRIMARY KEY, platform_message_id TEXT, status TEXT, delivered_at TEXT
    );
  `);
  outbound.exec(`
    CREATE TABLE messages_out (
      id TEXT PRIMARY KEY, in_reply_to TEXT, timestamp TEXT, kind TEXT,
      platform_id TEXT, channel_type TEXT, thread_id TEXT, content TEXT
    );
  `);
}

function seedDeliveredWelcome(): void {
  const welcomeInboundId = `${WELCOME}:${MAIN}`;
  inbound
    .prepare('INSERT INTO messages_in VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(welcomeInboundId, 'chat', WELCOME_AT, 'completed', 1, PLATFORM, 'gchat', PLATFORM, '{"text":"welcome"}');
  outbound
    .prepare('INSERT INTO messages_out VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('out-welcome', welcomeInboundId, '2026-09-18T18:00:02.000Z', 'chat', PLATFORM, 'gchat', PLATFORM, '{}');
  inbound
    .prepare('INSERT INTO delivered VALUES (?, ?, ?, ?)')
    .run('out-welcome', 'spaces/dm-principal/messages/welcome', 'delivered', WELCOME_DELIVERED_AT);
}

function seedLaterReply(options: { platform?: string; delivered?: boolean; at?: string } = {}): void {
  const platform = options.platform ?? PLATFORM;
  const at = options.at ?? LATER_AT;
  inbound
    .prepare('INSERT INTO messages_in VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      'later-inbound',
      'chat-sdk',
      at,
      'completed',
      1,
      platform,
      'gchat',
      platform,
      '{"text":"hello","senderId":"users/principal","author":{"userId":"users/principal"}}',
    );
  outbound
    .prepare('INSERT INTO messages_out VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('later-outbound', 'later-inbound', '2026-09-18T18:01:01.000Z', 'chat', platform, 'gchat', platform, '{}');
  if (options.delivered ?? true) {
    inbound
      .prepare('INSERT INTO delivered VALUES (?, ?, ?, ?)')
      .run('later-outbound', 'spaces/dm-principal/messages/reply', 'delivered', '2026-09-18T18:01:02.000Z');
  }
}

beforeEach(async () => {
  checkout = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-verify-'));
  await mkdir(path.join(checkout, 'data', 'v2-sessions', MAIN, 'session-main'), { recursive: true });
  central = new Database(path.join(checkout, 'data', 'v2.db'));
  inbound = new Database(path.join(checkout, 'data', 'v2-sessions', MAIN, 'session-main', 'inbound.db'));
  outbound = new Database(path.join(checkout, 'data', 'v2-sessions', MAIN, 'session-main', 'outbound.db'));
  seedBinding();
  seedMailboxes();
});

afterEach(() => {
  central.close();
  inbound.close();
  outbound.close();
});

describe('talkable conversation verification', () => {
  it('observes an authoritative binding and queued welcome without mutating it', () => {
    central.prepare('INSERT INTO agent_group_members VALUES (?, ?)').run(USER, MAIN);
    central.prepare('INSERT INTO user_roles VALUES (?, ?, NULL)').run(USER, 'owner');
    central
      .prepare('INSERT INTO unregistered_senders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        'gchat',
        PLATFORM,
        INSTANCE,
        USER,
        'Principal',
        1,
        'human',
        0,
        'signed-first-dm',
        BOUND_AT,
        'no_agent_wired',
        DM,
      );
    const runtime = {
      checkout_realpath: checkout,
      instance_id: '11111111-1111-4111-8111-111111111111',
    };
    const candidate = {
      messagingGroupId: DM,
      platformId: PLATFORM,
      userId: USER,
      senderName: 'Principal',
      authenticatedMessageId: 'signed-first-dm',
      authenticatedMessageAt: BOUND_AT,
    };
    const welcomeEventId = principalWelcomeEventId(runtime, MAIN, candidate);
    inbound
      .prepare('INSERT INTO messages_in VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`${welcomeEventId}:${MAIN}`, 'chat', BOUND_AT, 'pending', 1, PLATFORM, 'gchat', PLATFORM, '{}');

    expect(
      verifyPrincipalBinding({
        runtime,
        adapterInstance: INSTANCE,
        provisioningStartedAt: BOUND_AT,
        selectedCandidate: candidate,
      }),
    ).toEqual({ status: 'matched', agentGroupId: MAIN, candidate, welcomeEventId });
    expect(
      verifyPrincipalBinding({
        runtime,
        adapterInstance: INSTANCE,
        provisioningStartedAt: '2026-09-18T18:00:00.001Z',
        selectedCandidate: candidate,
      }),
    ).toEqual({ status: 'absent' });
    expect(inbound.prepare('SELECT COUNT(*) AS count FROM messages_in').get()).toEqual({ count: 1 });
  });

  it('requires a delivered welcome and a later delivered reply in the same agent-shared session', () => {
    seedDeliveredWelcome();
    seedLaterReply();

    expect(verifyTalkableConversation(input())).toEqual({
      ready: true,
      sessionId: 'session-main',
      welcomeInboundId: `${WELCOME}:${MAIN}`,
      welcomeOutboundId: 'out-welcome',
      laterInboundId: 'later-inbound',
      laterOutboundId: 'later-outbound',
      deliveredAt: '2026-09-18T18:01:02.000Z',
    });
  });

  it('does not treat a queued-only welcome as readiness', () => {
    const welcomeInboundId = `${WELCOME}:${MAIN}`;
    inbound
      .prepare('INSERT INTO messages_in VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(welcomeInboundId, 'chat', WELCOME_AT, 'completed', 1, PLATFORM, 'gchat', PLATFORM, '{}');
    outbound
      .prepare('INSERT INTO messages_out VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('out-welcome', welcomeInboundId, '2026-09-18T18:00:02.000Z', 'chat', PLATFORM, 'gchat', PLATFORM, '{}');
    seedLaterReply();

    expect(verifyTalkableConversation(input())).toMatchObject({ ready: false, reason: 'welcome_not_delivered' });
  });

  it('rejects old messages and traffic from another messaging group address', () => {
    seedDeliveredWelcome();
    seedLaterReply({ at: '2026-09-18T17:59:59.000Z' });
    expect(verifyTalkableConversation(input())).toMatchObject({
      ready: false,
      reason: 'later_principal_message_missing',
    });

    inbound.prepare("DELETE FROM messages_in WHERE id = 'later-inbound'").run();
    outbound.prepare("DELETE FROM messages_out WHERE id = 'later-outbound'").run();
    inbound.prepare("DELETE FROM delivered WHERE message_out_id = 'later-outbound'").run();
    seedLaterReply({ platform: 'gchat:spaces/another-dm' });
    expect(verifyTalkableConversation(input())).toMatchObject({
      ready: false,
      reason: 'later_principal_message_missing',
    });
  });

  it('does not accept an undelivered later assistant output', () => {
    seedDeliveredWelcome();
    seedLaterReply({ delivered: false });

    expect(verifyTalkableConversation(input())).toMatchObject({ ready: false, reason: 'reply_not_delivered' });
  });

  it('does not accept a later owner-routed CLI message at the principal address', () => {
    seedDeliveredWelcome();
    seedLaterReply();
    inbound
      .prepare("UPDATE messages_in SET kind = 'chat', content = ? WHERE id = 'later-inbound'")
      .run('{"text":"spoof","senderId":"users/principal"}');

    expect(verifyTalkableConversation(input())).toMatchObject({
      ready: false,
      reason: 'later_principal_message_missing',
    });
  });

  it('requires both authenticated Chat SDK sender projections', () => {
    seedDeliveredWelcome();
    seedLaterReply();
    inbound
      .prepare("UPDATE messages_in SET content = ? WHERE id = 'later-inbound'")
      .run('{"text":"hello","senderId":"users/principal"}');

    expect(verifyTalkableConversation(input())).toMatchObject({
      ready: false,
      reason: 'later_principal_message_missing',
    });
  });

  it.each([
    ['session mode', "UPDATE messaging_group_agents SET session_mode = 'shared'"],
    ['sender scope', "UPDATE messaging_group_agents SET sender_scope = 'all'"],
    ['group conversation', 'UPDATE messaging_groups SET is_group = 1'],
    ['adapter instance', "UPDATE messaging_groups SET instance = 'gchat-sibling'"],
    ['principal binding', 'DELETE FROM gws_ea_principal_users'],
  ])('fails closed when the canonical binding has the wrong %s', (_label, sql) => {
    seedDeliveredWelcome();
    seedLaterReply();
    central.exec(sql);

    expect(verifyTalkableConversation(input())).toMatchObject({ ready: false, reason: 'binding_not_ready' });
  });
});
