/**
 * Verification reads an instance's central DB and `main`'s mailbox exactly as
 * NanoClaw writes them: core migrations build the schema, the host's
 * `ncl` dispatch and profile module make the principal binding, and
 * `resolveSession` creates `main`'s agent-shared session for the principal DM
 * as the router does. Only the container's own write — an assistant reply in
 * `outbound.db` — is inserted directly, into the schema NanoClaw created.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { principalWelcomeEventId, type PrincipalCandidate } from './principal.js';
import {
  readLatestDelivery,
  readSchemaManifest,
  verifyPrincipalBinding,
  verifyTalkableConversation,
  type ConversationVerificationInput,
} from './verify.js';

/** What happens to a file just before it is read whole, as a writer opening a database mid-copy would. */
const reading = vi.hoisted(() => ({ before: undefined as ((file: string) => void) | undefined }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const readFileSync = (...args: Parameters<typeof fs.readFileSync>): ReturnType<typeof fs.readFileSync> => {
    if (typeof args[0] === 'string') reading.before?.(args[0]);
    return fs.readFileSync(...args);
  };
  return { ...fs, readFileSync };
});

const MAIN = 'ag-main';
const USER = 'gchat:users/principal';
const PLATFORM = 'gchat:spaces/dm-principal';
const INSTANCE = 'gchat';
const RUNTIME = { instance_id: '11111111-1111-4111-8111-111111111111' } as const;
const BOUND_AT = '2026-09-18T18:00:00.000Z';
const WELCOME_AT = '2026-09-18T18:00:01.000Z';
const WELCOME_REPLY_AT = '2026-09-18T18:00:02.000Z';
const WELCOME_DELIVERED_AT = '2026-09-18T18:00:03.000Z';
const LATER_AT = '2026-09-18T18:01:00.000Z';
const LATER_REPLY_AT = '2026-09-18T18:01:01.000Z';
const LATER_DELIVERED_AT = '2026-09-18T18:01:02.000Z';

const originalCwd = process.cwd();
let checkout = '';
let dmId = '';
let sessionId = '';
let host: Awaited<ReturnType<typeof composeHost>>;

/** The host's composition over a fresh install in the working directory, as `src/index.ts` loads it. */
async function composeHost() {
  vi.resetModules();
  await import('../modules/index.js');
  await import('../cli/commands/index.js');
  const { closeDb, initDb } = await import('../db/connection.js');
  const { runMigrations } = await import('../db/migrations/index.js');
  const { createAgentGroup } = await import('../db/agent-groups.js');
  const { createMessagingGroupIfAbsent, getMessagingGroupByPlatform } = await import('../db/messaging-groups.js');
  const { dispatch } = await import('../cli/dispatch.js');
  const { parseArgv } = await import('../cli/parse-argv.js');
  const { resolveSession, resolveTaskSession, withMailboxSession, writeSessionMessage } =
    await import('../session-manager.js');
  const { outboundDbPath } = await import('../mailbox/sqlite/paths.js');
  const { CENTRAL_DB_PATH } = await import('../config.js');
  await runMigrations(await initDb(CENTRAL_DB_PATH));

  /** `ncl <argv>` on the host, returning the response data or throwing its error. */
  const ncl = async (argv: readonly string[]): Promise<unknown> => {
    const { command, args } = parseArgv([...argv]);
    const frame = await dispatch({ id: 'verify-test', command, args }, { caller: 'host' });
    if (!frame.ok) throw new Error(frame.error.message);
    return frame.data;
  };
  return {
    closeDb,
    createAgentGroup,
    createMessagingGroupIfAbsent,
    getMessagingGroupByPlatform,
    ncl,
    resolveSession,
    resolveTaskSession,
    withMailboxSession,
    writeSessionMessage,
    outboundDbPath,
  };
}

/** The principal's first DM, as the router records the conversation. */
async function principalDm(): Promise<string> {
  await host.createMessagingGroupIfAbsent({
    id: 'mg-principal',
    channel_type: 'gchat',
    platform_id: PLATFORM,
    instance: INSTANCE,
    name: null,
    is_group: 0,
    unknown_sender_policy: 'strict',
    denied_at: null,
    created_at: BOUND_AT,
  });
  const dm = await host.getMessagingGroupByPlatform('gchat', PLATFORM, INSTANCE);
  if (!dm) throw new Error('The principal DM was not recorded');
  return dm.id;
}

/** The principal binding and its `main` DM wiring, made through the host in the bind step's order. */
async function bindPrincipal(dm: string): Promise<void> {
  await host.ncl(['users', 'create', '--id', USER, '--kind', 'gchat', '--display-name', 'Principal']);
  await host.ncl([
    'gws-ea-profile',
    'bind-principal',
    '--user-id',
    USER,
    '--verified-at',
    BOUND_AT,
    '--messaging-group-id',
    dm,
  ]);
  await host.ncl(['roles', 'grant', '--user', USER, '--role', 'owner']);
  await host.ncl(['members', 'add', '--user', USER, '--group', MAIN]);
  await host.ncl([
    'wirings',
    'create',
    '--messaging-group-id',
    dm,
    '--agent-group-id',
    MAIN,
    '--engage-mode',
    'pattern',
    '--engage-pattern',
    '.',
    '--sender-scope',
    'known',
    '--session-mode',
    'agent-shared',
    '--ignored-message-policy',
    'drop',
  ]);
}

function candidate(): PrincipalCandidate {
  return {
    messagingGroupId: dmId,
    platformId: PLATFORM,
    userId: USER,
    senderName: 'Principal',
    authenticatedMessageId: 'spaces/dm-principal/messages/first',
    authenticatedMessageAt: BOUND_AT,
  };
}

function input(overrides: Partial<ConversationVerificationInput> = {}): ConversationVerificationInput {
  return {
    stateRoot: checkout,
    mainAgentGroupId: MAIN,
    messagingGroupId: dmId,
    principalUserId: USER,
    adapterInstance: INSTANCE,
    boundAt: BOUND_AT,
    welcomeEventId: 'gws-ea-welcome:stable',
    ...overrides,
  };
}

/** An inbound message in `main`'s session, as the router writes it. */
async function inbound(
  id: string,
  timestamp: string,
  kind: 'chat' | 'chat-sdk',
  content: Record<string, unknown>,
  platformId = PLATFORM,
): Promise<void> {
  await host.writeSessionMessage(MAIN, sessionId, {
    id,
    kind,
    timestamp,
    platformId,
    channelType: 'gchat',
    threadId: platformId,
    content: JSON.stringify(content),
    trigger: true,
  });
}

/** The container's reply to one inbound message, marked delivered by the host when `deliveredAt` is given. */
async function reply(
  id: string,
  inReplyTo: string,
  timestamp: string,
  deliveredAt?: string,
  platformId = PLATFORM,
): Promise<void> {
  const outbound = new Database(host.outboundDbPath(MAIN, sessionId));
  try {
    const { next } = outbound.prepare('SELECT COALESCE(MAX(seq), -1) + 2 AS next FROM messages_out').get() as {
      next: number;
    };
    outbound
      .prepare(
        `INSERT INTO messages_out (id, seq, in_reply_to, timestamp, kind, platform_id, channel_type, thread_id, content)
         VALUES (?, ?, ?, ?, 'chat', ?, 'gchat', ?, '{"text":"reply"}')`,
      )
      .run(id, next, inReplyTo, timestamp, platformId, platformId);
  } finally {
    outbound.close();
  }
  if (deliveredAt === undefined) return;
  vi.setSystemTime(new Date(deliveredAt));
  await host.withMailboxSession(MAIN, sessionId, (mailbox) =>
    mailbox.markDelivered(id, `${platformId}/messages/${id}`),
  );
}

const principalMessage = { text: 'hello', senderId: 'users/principal', author: { userId: 'users/principal' } };

async function deliveredWelcome(): Promise<void> {
  await inbound('gws-ea-welcome:stable:ag-main', WELCOME_AT, 'chat', { text: 'welcome', senderId: USER });
  await reply('out-welcome', 'gws-ea-welcome:stable:ag-main', WELCOME_REPLY_AT, WELCOME_DELIVERED_AT);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(BOUND_AT) });
  checkout = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gws-ea-verify-')));
  await mkdir(path.join(checkout, 'data'));
  process.chdir(checkout);
  host = await composeHost();
  await host.createAgentGroup({ id: MAIN, name: 'main', folder: 'main', agent_provider: null, created_at: BOUND_AT });
  await host.ncl([
    'gws-ea-profile',
    'reconcile',
    '--assistant-display-name',
    'Aya',
    '--assistant-workspace-email',
    'aya@example.com',
    '--principal-display-name',
    'Principal',
    '--principal-timezone',
    'UTC',
    '--main-agent-group-id',
    MAIN,
  ]);
  dmId = await principalDm();
  await bindPrincipal(dmId);
  // The router's session for a message on an agent-shared wiring.
  ({
    session: { id: sessionId },
  } = await host.resolveSession(MAIN, dmId, null, 'agent-shared'));
});

afterEach(async () => {
  await host.closeDb();
  process.chdir(originalCwd);
  vi.useRealTimers();
  await rm(checkout, { recursive: true, force: true });
});

describe('principal binding verification', () => {
  it('matches the binding and queued welcome in the session the router created for the DM', async () => {
    const welcomeEventId = principalWelcomeEventId(RUNTIME, MAIN, candidate());
    await inbound(`${welcomeEventId}:${MAIN}`, BOUND_AT, 'chat', { text: 'welcome', senderId: USER });
    const runtime = { ...RUNTIME, state_root: checkout };

    expect(
      verifyPrincipalBinding({
        runtime,
        adapterInstance: INSTANCE,
        provisioningStartedAt: BOUND_AT,
        selectedCandidate: candidate(),
      }),
    ).toEqual({ status: 'matched', agentGroupId: MAIN, candidate: candidate(), welcomeEventId });
    expect(
      verifyPrincipalBinding({
        runtime,
        adapterInstance: INSTANCE,
        provisioningStartedAt: '2026-09-18T18:00:00.001Z',
        selectedCandidate: candidate(),
      }),
    ).toEqual({ status: 'absent' });
  });

  it('matches a principal whose owner role a retried bind granted again', async () => {
    await host.ncl(['roles', 'grant', '--user', USER, '--role', 'owner']);
    const welcomeEventId = principalWelcomeEventId(RUNTIME, MAIN, candidate());
    await inbound(`${welcomeEventId}:${MAIN}`, BOUND_AT, 'chat', { text: 'welcome', senderId: USER });

    expect(
      verifyPrincipalBinding({
        runtime: { ...RUNTIME, state_root: checkout },
        adapterInstance: INSTANCE,
        provisioningStartedAt: BOUND_AT,
        selectedCandidate: candidate(),
      }),
    ).toMatchObject({ status: 'matched', agentGroupId: MAIN });
  });

  it('is absent until the welcome is queued', () => {
    expect(
      verifyPrincipalBinding({
        runtime: { ...RUNTIME, state_root: checkout },
        adapterInstance: INSTANCE,
        provisioningStartedAt: BOUND_AT,
        selectedCandidate: candidate(),
      }),
    ).toEqual({ status: 'absent' });
  });
});

describe('talkable conversation verification', () => {
  it('requires a delivered welcome and a later delivered reply in the session the router created for the DM', async () => {
    await deliveredWelcome();
    await inbound('later-inbound', LATER_AT, 'chat-sdk', principalMessage);
    await reply('later-outbound', 'later-inbound', LATER_REPLY_AT, LATER_DELIVERED_AT);

    expect(verifyTalkableConversation(input())).toEqual({
      ready: true,
      sessionId,
      welcomeInboundId: 'gws-ea-welcome:stable:ag-main',
      welcomeOutboundId: 'out-welcome',
      laterInboundId: 'later-inbound',
      laterOutboundId: 'later-outbound',
      deliveredAt: LATER_DELIVERED_AT,
    });
  });

  it("excludes main's system-thread sessions, even a newer one", async () => {
    await deliveredWelcome();
    await inbound('later-inbound', LATER_AT, 'chat-sdk', principalMessage);
    await reply('later-outbound', 'later-inbound', LATER_REPLY_AT, LATER_DELIVERED_AT);
    vi.setSystemTime(new Date('2026-09-18T19:00:00.000Z'));
    const { session: taskSession } = await host.resolveTaskSession(MAIN, 'daily-brief');
    expect(taskSession.id).not.toBe(sessionId);

    expect(verifyTalkableConversation(input())).toMatchObject({ ready: true, sessionId });
  });

  it('does not treat a queued-only welcome as readiness', async () => {
    await inbound('gws-ea-welcome:stable:ag-main', WELCOME_AT, 'chat', { text: 'welcome', senderId: USER });
    await reply('out-welcome', 'gws-ea-welcome:stable:ag-main', WELCOME_REPLY_AT);
    await inbound('later-inbound', LATER_AT, 'chat-sdk', principalMessage);
    await reply('later-outbound', 'later-inbound', LATER_REPLY_AT, LATER_DELIVERED_AT);

    expect(verifyTalkableConversation(input())).toMatchObject({ ready: false, reason: 'welcome_not_delivered' });
  });

  it('rejects a principal message older than the delivered welcome', async () => {
    await deliveredWelcome();
    await inbound('later-inbound', '2026-09-18T18:00:02.500Z', 'chat-sdk', principalMessage);
    await reply('later-outbound', 'later-inbound', LATER_REPLY_AT, LATER_DELIVERED_AT);

    expect(verifyTalkableConversation(input())).toMatchObject({
      ready: false,
      reason: 'later_principal_message_missing',
    });
  });

  it('rejects traffic at another conversation address', async () => {
    await deliveredWelcome();
    await inbound('later-inbound', LATER_AT, 'chat-sdk', principalMessage, 'gchat:spaces/another-dm');
    await reply('later-outbound', 'later-inbound', LATER_REPLY_AT, LATER_DELIVERED_AT, 'gchat:spaces/another-dm');

    expect(verifyTalkableConversation(input())).toMatchObject({
      ready: false,
      reason: 'later_principal_message_missing',
    });
  });

  it('does not accept an undelivered later assistant output', async () => {
    await deliveredWelcome();
    await inbound('later-inbound', LATER_AT, 'chat-sdk', principalMessage);
    await reply('later-outbound', 'later-inbound', LATER_REPLY_AT);

    expect(verifyTalkableConversation(input())).toMatchObject({ ready: false, reason: 'reply_not_delivered' });
  });

  it('does not accept a later owner-routed CLI message at the principal address', async () => {
    await deliveredWelcome();
    // Both sender projections name the principal; only the message kind tells it apart.
    await inbound('later-inbound', LATER_AT, 'chat', principalMessage);
    await reply('later-outbound', 'later-inbound', LATER_REPLY_AT, LATER_DELIVERED_AT);

    expect(verifyTalkableConversation(input())).toMatchObject({
      ready: false,
      reason: 'later_principal_message_missing',
    });
  });

  it.each([
    ['sender ID', { text: 'hello', senderId: 'users/principal' }],
    ['author', { text: 'hello', author: { userId: 'users/principal' } }],
  ])('requires both authenticated Chat SDK sender projections, not the %s alone', async (_label, content) => {
    await deliveredWelcome();
    await inbound('later-inbound', LATER_AT, 'chat-sdk', content);
    await reply('later-outbound', 'later-inbound', LATER_REPLY_AT, LATER_DELIVERED_AT);

    expect(verifyTalkableConversation(input())).toMatchObject({
      ready: false,
      reason: 'later_principal_message_missing',
    });
  });

  it('is not ready while main has only system-thread sessions', async () => {
    const central = new Database(path.join(checkout, 'data', 'v2.db'));
    try {
      central.prepare("UPDATE sessions SET status = 'closed' WHERE id = ?").run(sessionId);
    } finally {
      central.close();
    }
    await host.resolveTaskSession(MAIN, 'daily-brief');

    expect(verifyTalkableConversation(input())).toMatchObject({ ready: false, reason: 'session_not_ready' });
  });

  // Drift the admission policy would refuse through `ncl`, written behind its back.
  it.each([
    ['session mode', "UPDATE messaging_group_agents SET session_mode = 'shared'"],
    ['sender scope', "UPDATE messaging_group_agents SET sender_scope = 'all'"],
    ['group conversation', 'UPDATE messaging_groups SET is_group = 1'],
    ['adapter instance', "UPDATE messaging_groups SET instance = 'gchat-sibling'"],
    ['principal binding', 'DELETE FROM gws_ea_principal_users'],
  ])('fails closed when the canonical binding has the wrong %s', async (_label, sql) => {
    await deliveredWelcome();
    await inbound('later-inbound', LATER_AT, 'chat-sdk', principalMessage);
    await reply('later-outbound', 'later-inbound', LATER_REPLY_AT, LATER_DELIVERED_AT);
    const central = new Database(path.join(checkout, 'data', 'v2.db'));
    try {
      central.exec(sql);
    } finally {
      central.close();
    }

    expect(verifyTalkableConversation(input())).toMatchObject({ ready: false, reason: 'binding_not_ready' });
  });
});

describe('read-only observation', () => {
  it("reads the latest delivery result of main's conversation, and the replies the host is still retrying", async () => {
    expect(readLatestDelivery(checkout)).toEqual({
      mainAgentGroupId: MAIN,
      sessionId,
      last: undefined,
      retrying: 0,
      lastError: undefined,
    });

    await deliveredWelcome();
    expect(readLatestDelivery(checkout)).toEqual({
      mainAgentGroupId: MAIN,
      sessionId,
      last: { messageOutId: 'out-welcome', status: 'delivered', at: WELCOME_DELIVERED_AT },
      retrying: 0,
      lastError: undefined,
    });

    await inbound('later-inbound', LATER_AT, 'chat-sdk', principalMessage);
    await reply('later-outbound', 'later-inbound', LATER_REPLY_AT);
    vi.setSystemTime(new Date(LATER_DELIVERED_AT));
    await host.withMailboxSession(MAIN, sessionId, (mailbox) => mailbox.markDeliveryFailed('later-outbound'));
    const { recordDeliveryAttempt } = await import('../db/coordination.js');
    await recordDeliveryAttempt({
      messageId: 'out-retrying',
      sessionId,
      now: LATER_DELIVERED_AT,
      nextAttemptAt: '2026-09-18T18:02:00.000Z',
      error: 'Google Chat answered 503',
    });

    expect(readLatestDelivery(checkout)).toEqual({
      mainAgentGroupId: MAIN,
      sessionId,
      last: { messageOutId: 'later-outbound', status: 'failed', at: LATER_DELIVERED_AT },
      retrying: 1,
      lastError: 'Google Chat answered 503',
    });
  });

  it('has no delivery to report until main is published', () => {
    const central = new Database(path.join(checkout, 'data', 'v2.db'));
    try {
      central.exec('UPDATE gws_ea_profile SET main_agent_group_id = NULL');
    } finally {
      central.close();
    }

    expect(readLatestDelivery(checkout)).toBeUndefined();
  });

  it('reads the applied migrations and every session table, merging its columns across sessions', async () => {
    // A session sorting before the router's, left by a release whose `messages_in` has a column this one lacks,
    // and an AUTOINCREMENT table, which makes SQLite add its internal `sqlite_sequence`.
    const older = path.join(checkout, 'data', 'v2-sessions', MAIN, '0-older-session', 'inbound.db');
    await mkdir(path.dirname(older));
    const seeded = new Database(older);
    try {
      seeded.exec(`
        CREATE TABLE messages_in (id TEXT PRIMARY KEY, routed_by TEXT);
        CREATE TABLE deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT);
        INSERT INTO deliveries (label) VALUES ('first');
      `);
      expect(
        seeded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").get(),
      ).toEqual({ name: 'sqlite_sequence' });
    } finally {
      seeded.close();
    }
    const routers = path.join(checkout, 'data', 'v2-sessions', MAIN, sessionId, 'inbound.db');
    const columnsOf = (file: string, table: string): string[] => {
      const session = new Database(file, { readonly: true });
      try {
        return (session.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{ name: string }>).map(
          (column) => column.name,
        );
      } finally {
        session.close();
      }
    };
    const merged = [...new Set([older, routers].flatMap((file) => columnsOf(file, 'messages_in')))].sort();
    expect(merged).toEqual(expect.arrayContaining(['routed_by', 'platform_id']));

    const manifest = readSchemaManifest(checkout);

    expect(manifest.central_migrations).toEqual(
      expect.arrayContaining(['host-coordination', 'module:gws-ea-profile:create-profile']),
    );
    expect(manifest.session_tables['inbound.messages_in']).toEqual(merged);
    expect(manifest.session_tables['inbound.deliveries']).toEqual(['id', 'label']);
    expect(Object.keys(manifest.session_tables).filter((table) => /^\w+\.sqlite_/u.test(table))).toEqual([]);
    expect(manifest.session_tables['inbound.delivered']).toEqual(
      expect.arrayContaining(['message_out_id', 'status', 'delivered_at']),
    );
    expect(manifest.session_tables['outbound.messages_out']).toEqual(expect.arrayContaining(['in_reply_to']));
  });

  it('never leaves side files beside a WAL database its writer has closed', async () => {
    await deliveredWelcome();
    await host.closeDb();
    const data = path.join(checkout, 'data');
    const before = (await readdir(data)).sort();
    expect(before).toContain('v2.db');
    expect(before).not.toContain('v2.db-wal');
    // The header's write and read versions (bytes 18 and 19) are 2 only for a WAL database.
    const header = await readFile(path.join(data, 'v2.db'));
    expect([header[18], header[19]]).toEqual([2, 2]);

    expect(readSchemaManifest(checkout).central_migrations).toContain('host-coordination');
    expect(readLatestDelivery(checkout)).toMatchObject({ last: { messageOutId: 'out-welcome' } });
    expect(
      verifyPrincipalBinding({
        runtime: { ...RUNTIME, state_root: checkout },
        adapterInstance: INSTANCE,
        provisioningStartedAt: BOUND_AT,
        selectedCandidate: candidate(),
      }),
    ).toEqual({ status: 'absent' });

    expect((await readdir(data)).sort()).toEqual(before);
  });

  it('reads in place a WAL database a writer opened while it was being copied', async () => {
    await host.closeDb();
    const file = path.join(checkout, 'data', 'v2.db');
    expect(existsSync(`${file}-wal`)).toBe(false);
    // The host starting mid-copy: opening the database creates its `-wal`, where the migration it records stays.
    let writer: Database.Database | undefined;
    reading.before = (read) => {
      if (read !== file || writer) return;
      writer = new Database(file);
      writer
        .prepare(
          `INSERT INTO schema_version (version, name, applied)
           SELECT MAX(version) + 1, 'recorded-mid-copy', ? FROM schema_version`,
        )
        .run(new Date().toISOString());
    };
    try {
      expect(readSchemaManifest(checkout).central_migrations).toContain('recorded-mid-copy');
    } finally {
      reading.before = undefined;
      writer?.close();
    }
  });
});
