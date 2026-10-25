import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ data: '' }));
vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  get DATA_DIR() {
    return storage.data;
  },
  get GROUPS_DIR() {
    return path.join(storage.data, 'groups');
  },
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
import Database from 'better-sqlite3';
import type { InboundMessage } from '../../channels/adapter.js';
import { routeInbound } from '../../router.js';
import { resolveSession, writeOutboundDirect } from '../../session-manager.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import '../gws-ea-profile/index.js';
import '../permissions/index.js';
import {
  createChannelDeliveryAdapter,
  getChannelAdapterExact,
  initChannelAdapters,
  registerChannelAdapter,
  startChannelAdapter,
  stopChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import { getDeliveryAttempt } from '../../db/coordination.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { deriveGcpClaims } from '../../gws-ea/gcp-identity.js';
import { resolveControlPlanePaths } from '../../gws-ea/paths.js';
import { reserveInstance } from '../../gws-ea/journal.js';
import { getInstanceReservation } from '../../gws-ea/registry.js';
import { preparePrincipalMessageContent } from '../gws-ea-profile/marks.js';
import { isVerifiedPrincipalUser, reconcileGwsEaProfile } from '../gws-ea-profile/db.js';
import {
  bindPrincipalIdentity,
  bindWhatsAppPrincipal,
  removeWhatsAppPrincipalBinding,
} from '../gws-ea-profile/bind.js';
import { createMessagingGroup, getMessagingGroup, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { gwsEaPrivacyMigration } from '../gws-ea-privacy/migration.js';
import { addPrivateValue } from '../gws-ea-privacy/db.js';
import { upsertUser } from '../permissions/db/users.js';
import { createWhatsAppAdapter, type WhatsAppAdapter } from './adapter.js';
import { readWhatsAppLink, writeWhatsAppLink } from './paths.js';
import { FakeSocket, incoming } from './testing/fake-socket.js';
import { WhatsAppIndex } from './index-store.js';
import { WhatsAppAuthStore } from './auth-store.js';
import { WhatsAppLinking, whatsAppLinking } from './link.js';
import { deliverSessionMessages, getDeliveryAction, setDeliveryAdapter } from '../../delivery.js';
import { dispatch } from '../../cli/dispatch.js';
import { registerWhatsAppObserver, type WhatsAppLinkNotice } from './observers.js';
import * as channelRegistry from '../../channels/channel-registry.js';
import * as instanceRegistry from '../../gws-ea/registry.js';
import * as mainNotes from '../gws-ea-profile/main-note.js';
import { sweepChatLifecycle } from '../gws-ea-chats/lifecycle.js';
import { chatsMigration } from '../gws-ea-chats/migration.js';

const instanceId = '12345678-1234-4234-8234-123456789abc';
let root: string;
let linking: WhatsAppLinking;
let sockets: FakeSocket[];
let notices: WhatsAppLinkNotice[];
/** Holds back each new socket's pairing announcement, as a slow or failing WhatsApp server would. */
let holdPairingAnnouncement: boolean;
let unobserve: (() => void) | undefined;
const onInbound = vi.fn(async (platformId: string, threadId: string | null, message: InboundMessage) =>
  routeInbound({
    channelType: 'whatsapp',
    instance: 'whatsapp',
    platformId,
    threadId,
    message: { ...message, content: JSON.stringify(message.content) },
  }),
);

beforeEach(async () => {
  vi.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-link-'));
  storage.data = path.join(root, 'data');
  const paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'config'),
    stateRoot: path.join(root, 'assistants'),
  });
  await reserveInstance(paths, {
    instance_id: instanceId,
    release_track: 'dogfood',
    source_remote: 'https://example.test/repo.git',
    deployed_commit: 'a'.repeat(40),
    allocated_ports: { onecli_app: 31002, onecli_gateway: 31003 },
    exclusive_resource_claims: {
      ...deriveGcpClaims(instanceId),
      gcp_account: 'operator@example.test',
      workspace_email: 'aya@example.test',
      onecli_project: 'aya',
    },
  });
  const directory = path.join(paths.instanceRoot(instanceId), 'secrets', 'whatsapp');
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: 'main',
    name: 'Main',
    folder: 'main',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await reconcileGwsEaProfile({
    assistantName: { firstName: 'Aya', lastName: null },
    assistantWorkspaceEmail: 'aya@example.test',
    principalName: { firstName: 'Pat', lastName: null },
    principalTimezone: 'UTC',
    mainAgentGroupId: 'main',
  });
  await upsertUser({ id: 'gchat:users/1', kind: 'gchat', display_name: 'Pat', created_at: new Date().toISOString() });
  await createMessagingGroup({
    id: 'principal-dm',
    channel_type: 'gchat',
    platform_id: 'gchat:spaces/dm',
    instance: 'gchat',
    name: null,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: new Date().toISOString(),
  });
  await bindPrincipalIdentity({
    userId: 'gchat:users/1',
    messagingGroupId: 'principal-dm',
    verifiedAt: new Date().toISOString(),
  });
  sockets = [];
  notices = [];
  holdPairingAnnouncement = false;
  unobserve = registerWhatsAppObserver({
    onLinkNotice: async (notice) => {
      notices.push(notice);
      return true;
    },
  });
  registerChannelAdapter('whatsapp', {
    factory: () =>
      fs.existsSync(path.join(directory, 'link.json'))
        ? createWhatsAppAdapter({
            directory,
            resolveVersion: async () => [2, 3000, 123456],
            makeSocket: (config) => {
              const socket = new FakeSocket();
              sockets.push(socket);
              // As Baileys does a moment after the socket opens, for credentials with no `me` to log in
              // as, unless a test holds it back.
              setTimeout(() => {
                if (!holdPairingAnnouncement && !config.auth?.creds.me) void socket.announcePairing();
              }, 0);
              return socket;
            },
          })
        : null,
  });
  await initChannelAdapters(() => ({
    onInbound,
    onInboundEvent: vi.fn(),
    onMetadata: vi.fn(),
    onAction: vi.fn(async () => undefined),
  }));
  linking = new WhatsAppLinking({ directory, paths, instanceId });
});
afterEach(async () => {
  linking?.close();
  unobserve?.();
  vi.unstubAllEnvs();
  await teardownChannelAdapters();
  await closeDb();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

async function marked(id: string, text: string, forwarded = false) {
  const group = await getMessagingGroup('principal-dm');
  if (!group) throw new Error('Missing fixture DM');
  await preparePrincipalMessageContent({
    content: JSON.stringify({ text, forwarded }),
    channelType: 'gchat',
    instance: 'gchat',
    platformId: group.platform_id,
    messageId: id,
    timestamp: new Date().toISOString(),
    authenticatedSender: { userId: 'gchat:users/1', kind: 'human' },
    messagingGroup: group,
    session: {
      id: 'main-session',
      agent_group_id: 'main',
      messaging_group_id: group.id,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    },
  });
}
const caller = { kind: 'principal' as const, agentGroupId: 'main', principalMessages: ['numbers'] };

it('links from marked numbers, holds the principal until proof, then releases the original message once', async () => {
  await marked('numbers', 'Link WhatsApp: your number is +1 555 000 0000, mine is +44 7700 900123.');
  expect(await linking.link('+15550000000', '+447700900123', caller)).toMatchObject({
    state: 'linking',
    pairingCode: '12345678',
  });
  const socket = sockets[0];
  await socket.emit('connection.update', { connection: 'open' });
  const link = await linking.status();
  expect(link).toMatchObject({ state: 'connected', number: '+15550000000' });
  const notes = (await mailboxRows()).map(({ content }) => content).join('\n');
  const code = /binding code: ([A-Z0-9-]+)/u.exec(notes)?.[1];
  expect(code).toBeDefined();
  await socket.emit('messages.upsert', {
    type: 'notify',
    messages: [
      incoming('held', 'Hello before proof', {
        key: { id: 'held', remoteJid: '12000@lid', remoteJidAlt: '447700900123@s.whatsapp.net' },
      }),
    ],
  });
  expect(onInbound).not.toHaveBeenCalled();
  expect(socket.sends).toHaveLength(0);
  await socket.emit('messages.upsert', {
    type: 'notify',
    messages: [
      incoming('proof', code, {
        key: { id: 'proof', remoteJid: '12000@lid', remoteJidAlt: '447700900123@s.whatsapp.net' },
      }),
    ],
  });
  await vi.waitFor(() => expect(onInbound).toHaveBeenCalledTimes(1), { timeout: 2500 });
  expect(onInbound.mock.calls[0]?.[2]).toMatchObject({ id: 'held' });
  expect((await mailboxRows()).find(({ id }) => id === 'held:main')).toMatchObject({
    channel_type: 'whatsapp',
    platform_id: '12000@lid',
  });
  await socket.emit('messages.upsert', { type: 'notify', messages: [principalMessage('after', 'My next message')] });
  expect((await mailboxRows()).filter(({ id }) => id === 'after:main')).toHaveLength(1);
  expect(sockets).toHaveLength(1);
  expect(socket.profileName).toBe('Aya');
  expect(socket.profileAbout).toBe('Personal assistant');
  expect((await linking.status()).principal).toEqual({ lid: '12000', phoneJid: '447700900123@s.whatsapp.net' });
  const bound = await readWhatsAppLink(linking.options.directory);
  expect(bound?.principalVerifiedAt).toEqual(expect.any(String));
  expect(await getDb().get("SELECT verified_at FROM gws_ea_principal_users WHERE user_id = 'whatsapp:12000'")).toEqual({
    verified_at: bound?.principalVerifiedAt,
  });
});

interface MailboxRow {
  readonly id: string;
  readonly content: string;
  readonly channel_type: string;
  readonly platform_id: string;
}
async function mailboxRows(): Promise<MailboxRow[]> {
  const { session } = await resolveSession('main', 'principal-dm', null, 'agent-shared');
  const db = new Database(inboundDbPath('main', session.id), { readonly: true });
  try {
    return db.prepare('SELECT id,content,channel_type,platform_id FROM messages_in ORDER BY seq').all() as MailboxRow[];
  } finally {
    db.close();
  }
}
function principalMessage(id: string, text: string, phone = '447700900123') {
  return incoming(id, text, { key: { id, remoteJid: '12000@lid', remoteJidAlt: `${phone}@s.whatsapp.net` } });
}
async function connect() {
  await marked('numbers', 'Your number +15550000000, mine +44 7700 900123.');
  await linking.link('+15550000000', '+447700900123', caller);
  const socket = sockets.at(-1)!;
  await socket.emit('connection.update', { connection: 'open' });
  const text = (await mailboxRows()).map(({ content }) => content).join('\n');
  const code = /binding code: ([A-Z0-9-]+)/u.exec(text)?.[1];
  if (!code) throw new Error('No binding code reached the principal’s real main mailbox');
  return { socket, code };
}

async function enableLinkRecoveryLifecycle(): Promise<void> {
  await runMigrations(getDb(), [chatsMigration]);
  const options = linking.options;
  linking.close();
  vi.stubEnv('GWS_EA_WHATSAPP_DIR', options.directory);
  vi.stubEnv('GWS_EA_CONFIG_ROOT', options.paths.configRoot);
  vi.stubEnv('GWS_EA_STATE_ROOT', options.paths.stateRoot);
  vi.stubEnv('GWS_EA_INSTANCE_ID', instanceId);
  linking = whatsAppLinking();
}

it.each(['new link', 'bound re-link'] as const)(
  'finishes a %s after a transient profile failure through the lifecycle without another connection event',
  async (attempt) => {
    await enableLinkRecoveryLifecycle();
    if (attempt === 'bound re-link') {
      const { socket, code } = await connect();
      await socket.emit('messages.upsert', { type: 'notify', messages: [principalMessage('original-proof', code)] });
      await socket.emit('connection.update', {
        connection: 'close',
        lastDisconnect: {
          error: Object.assign(new Error('logged out'), { output: { statusCode: 401 } }),
          date: new Date(),
        },
      });
      await marked('relink', 'Please re-link WhatsApp.');
      await linking.link(undefined, undefined, { ...caller, principalMessages: ['relink'] });
    } else {
      await marked('numbers', 'Your number +15550000000, mine +447700900123.');
      await linking.link('+15550000000', '+447700900123', caller);
    }
    const socket = sockets.at(-1)!;
    const profile = vi.spyOn(socket, 'updateProfileStatus').mockRejectedValueOnce(new Error('Profile unavailable'));
    try {
      await socket.emit('connection.update', { connection: 'open' });
      expect(socket.profileAbout).toBeUndefined();
      await sweepChatLifecycle();
      await sweepChatLifecycle();
      expect(socket.profileName).toBe('Aya');
      expect(socket.profileAbout).toBe('Personal assistant');
      expect(await linking.status()).toMatchObject({ state: 'connected' });
      expect((await readWhatsAppLink(linking.options.directory))?.pairing).toBeUndefined();
      const notes = (await mailboxRows()).filter(({ id }) => id.startsWith('whatsapp-link:bind:'));
      expect(notes).toHaveLength(1);
      if (attempt === 'new link') {
        expect(await isVerifiedPrincipalUser('whatsapp:12000')).toBe(false);
        const code = /binding code: ([A-Z0-9-]+)/u.exec(notes[0].content)?.[1];
        if (!code) throw new Error('Recovered binding code did not reach main');
        await socket.emit('messages.upsert', { type: 'notify', messages: [principalMessage('recovered-proof', code)] });
      }
      expect(await isVerifiedPrincipalUser('whatsapp:12000')).toBe(true);
      expect(socket.sends).toHaveLength(0);
      expect(sockets).toHaveLength(attempt === 'new link' ? 1 : 2);
    } finally {
      profile.mockRestore();
    }
  },
);

it('drains an in-flight principal proof during unlink without deadlocking or restoring removed authority', async () => {
  const { socket, code } = await connect();
  let releaseLookup!: () => void;
  socket.lookupGate = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  socket.usync.set('447700900123@s.whatsapp.net', '12000@lid');
  const proof = socket.emit('messages.upsert', {
    type: 'notify',
    messages: [
      incoming('proof-during-unlink', code, {
        key: { id: 'proof-during-unlink', remoteJid: '447700900123@s.whatsapp.net' },
      }),
    ],
  });
  await vi.waitFor(() => expect(socket.lookups).toContain('447700900123@s.whatsapp.net'));
  const unlinked = linking.unlink();
  await vi.waitFor(() => expect(socket.ended).toBe(true));
  releaseLookup();
  const outcome = await Promise.race([
    Promise.all([proof, unlinked]).then(() => 'completed'),
    new Promise<string>((resolve) => {
      setTimeout(() => resolve('deadlocked'), 1500).unref();
    }),
  ]);
  expect(outcome).toBe('completed');
  expect(await linking.status()).toEqual({ state: 'unlinked' });
  expect(fs.existsSync(path.join(linking.options.directory, 'link.json'))).toBe(false);
  expect(await isVerifiedPrincipalUser('whatsapp:12000')).toBe(false);
  expect(socket.sends).toHaveLength(0);
});

it('retries a failed binding note in the lifecycle using the saved unexpired code and one main note', async () => {
  await enableLinkRecoveryLifecycle();
  await marked('numbers', 'Your number +15550000000, mine +447700900123.');
  await linking.link('+15550000000', '+447700900123', caller);
  const socket = sockets.at(-1)!;
  const note = vi.spyOn(mainNotes, 'writeNoteForMain').mockRejectedValueOnce(new Error('Main mailbox unavailable'));
  try {
    await socket.emit('connection.update', { connection: 'open' });
    const pending = (await readWhatsAppLink(linking.options.directory))?.binding;
    expect(pending).toBeDefined();
    expect((await mailboxRows()).some(({ id }) => id.startsWith('whatsapp-link:bind:'))).toBe(false);
    await sweepChatLifecycle();
    await sweepChatLifecycle();
    expect((await readWhatsAppLink(linking.options.directory))?.binding).toMatchObject(pending!);
    const notes = (await mailboxRows()).filter(({ id }) => id.startsWith('whatsapp-link:bind:'));
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe(`whatsapp-link:bind:${pending!.code}`);
    expect(notes[0].content).toContain(pending!.code);
    expect(await isVerifiedPrincipalUser('whatsapp:12000')).toBe(false);
    expect(sockets).toHaveLength(1);
    expect(socket.sends).toHaveLength(0);
  } finally {
    note.mockRestore();
  }
});

it.each([
  ['number absent', 'My number is +447700900123.', '+15550000000', '+447700900123', false, /did not give/],
  ['equal numbers', 'Use +15550000000 for both.', '+15550000000', '+15550000000', false, /own number/],
  ['forwarded request', 'Use +15550000000, mine +447700900123.', '+15550000000', '+447700900123', true, /principal/],
] as const)(
  'refuses %s before claiming or opening any socket',
  async (_name, text, number, principal, forwarded, reason) => {
    await marked('numbers', text, forwarded);
    await expect(linking.link(number, principal, caller)).rejects.toThrow(reason);
    expect(await linking.status()).toEqual({ state: 'unlinked' });
    expect(sockets).toHaveLength(0);
  },
);

it('refuses an unmarked message and a non-main caller', async () => {
  await expect(linking.link('+15550000000', '+447700900123', caller)).rejects.toThrow(/principal/);
  await marked('numbers', '+15550000000 and +447700900123');
  await expect(
    linking.link('+15550000000', '+447700900123', { ...caller, agentGroupId: 'external-chat' }),
  ).rejects.toThrow(/Only/);
  expect(sockets).toHaveLength(0);
});

it('ends a pairing whose connection closes, removes its credentials, releases the claim, and tells main it closed', async () => {
  await marked('numbers', 'Use +15550000000 and +447700900123.');
  await linking.link('+15550000000', '+447700900123', caller);
  await sockets[0].emit('connection.update', { connection: 'close' });
  await vi.waitFor(async () => expect(await linking.status()).toEqual({ state: 'unlinked' }));
  expect(fs.existsSync(path.join(linking.options.directory, 'auth.sqlite'))).toBe(false);
  expect(sockets).toHaveLength(1);
  expect(sockets[0].ended).toBe(true);
  await vi.waitFor(async () => {
    const notes = (await mailboxRows()).map(({ content }) => content).join('\n');
    expect(notes).toContain('pairing connection closed before the account connected');
    expect(notes).not.toContain('expired');
  });
  expect(
    (await getInstanceReservation(linking.options.paths, instanceId)).exclusive_resource_claims.whatsapp_number,
  ).toBeUndefined();
});

it('asks WhatsApp for a pairing code only once the new socket announces it can pair', async () => {
  holdPairingAnnouncement = true;
  await marked('numbers', 'Use +15550000000 and +447700900123.');
  let settled = false;
  const linked = linking.link('+15550000000', '+447700900123', caller).finally(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(settled).toBe(false);
  await sockets[0].announcePairing();
  await expect(linked).resolves.toMatchObject({ state: 'linking', pairingCode: '12345678' });
});

it('reports a pairing connection that closes before it is ready, with no code and no expiry note', async () => {
  holdPairingAnnouncement = true;
  await marked('numbers', 'Use +15550000000 and +447700900123.');
  const linked = linking.link('+15550000000', '+447700900123', caller);
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  await sockets[0].emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: new Error('Stream Errored (restart required)'), date: new Date() },
  });
  await expect(linked).rejects.toThrow(
    'WhatsApp closed its pairing connection before it was ready: Stream Errored (restart required)',
  );
  expect(await linking.status()).toEqual({ state: 'unlinked' });
  expect(
    (await getInstanceReservation(linking.options.paths, instanceId)).exclusive_resource_claims.whatsapp_number,
  ).toBeUndefined();
  const notes = (await mailboxRows()).map(({ content }) => content).join('\n');
  expect(notes).not.toContain('pairing code expired');
  expect(notes).not.toContain('pairing connection closed');
});

it('refuses a connected account with a different authenticated number', async () => {
  await marked('numbers', 'Use +15550000000 and +447700900123.');
  await linking.link('+15550000000', '+447700900123', caller);
  sockets[0].user.id = '15550000099:1@s.whatsapp.net';
  await sockets[0].emit('connection.update', { connection: 'open' });
  await vi.waitFor(async () => expect(await linking.status()).toEqual({ state: 'unlinked' }));
  expect((await mailboxRows()).some(({ content }) => content.includes('binding code:'))).toBe(false);
  await sockets[0].emit('messages.upsert', {
    type: 'notify',
    messages: [principalMessage('mismatched-account-message', 'A request')],
  });
  expect(onInbound).not.toHaveBeenCalled();
  expect(sockets[0].sends).toHaveLength(0);
});

it('binds neither another number, a wrong code, a forwarded code nor an expired code, and renews proof without pairing again', async () => {
  await enableLinkRecoveryLifecycle();
  const { socket, code } = await connect();
  await socket.emit('messages.upsert', {
    type: 'notify',
    messages: [
      incoming('other', code, {
        key: { id: 'other', remoteJid: '13000@lid', remoteJidAlt: '15559999999@s.whatsapp.net' },
      }),
    ],
  });
  await socket.emit('messages.upsert', { type: 'notify', messages: [principalMessage('wrong', 'EA-WRONGCODE')] });
  await socket.emit('messages.upsert', {
    type: 'notify',
    messages: [
      {
        ...principalMessage('forwarded', code),
        message: { extendedTextMessage: { text: code, contextInfo: { isForwarded: true } } },
      },
    ],
  });
  expect((await linking.status()).principal).toBeUndefined();
  const record = await readWhatsAppLink(linking.options.directory);
  if (!record?.binding) throw new Error('No production binding challenge');
  await writeWhatsAppLink(linking.options.directory, {
    ...record,
    binding: { ...record.binding, expiresAt: Date.now() - 1 },
  });
  await socket.emit('messages.upsert', { type: 'notify', messages: [principalMessage('expired', code)] });
  expect((await linking.status()).principal).toBeUndefined();
  await sweepChatLifecycle();
  expect((await readWhatsAppLink(linking.options.directory))?.binding?.code).toBe(code);
  expect((await mailboxRows()).filter(({ id }) => id.startsWith('whatsapp-link:bind:'))).toHaveLength(1);
  await linking.link('+15550000000', '+447700900123', caller);
  const renewed = await readWhatsAppLink(linking.options.directory);
  expect(renewed?.binding?.code).not.toBe(code);
  expect(sockets).toHaveLength(1);
  await socket.emit('messages.upsert', { type: 'notify', messages: [principalMessage('old-after-renewal', code)] });
  expect((await linking.status()).principal).toBeUndefined();
  expect(socket.sends).toHaveLength(0);
});

it('keeps pending principal messages durable across transport restart and releases them only after the original challenge', async () => {
  const { socket, code } = await connect();
  await socket.emit('messages.upsert', {
    type: 'notify',
    messages: [principalMessage('durable', 'My earlier request')],
  });
  await stopChannelAdapter('whatsapp');
  await startChannelAdapter('whatsapp');
  const fresh = getChannelAdapterExact('whatsapp') as WhatsAppAdapter;
  await fresh.reconnect();
  const restarted = sockets.at(-1)!;
  await restarted.emit('connection.update', { connection: 'open' });
  expect(onInbound).not.toHaveBeenCalled();
  await restarted.emit('messages.upsert', {
    type: 'notify',
    messages: [principalMessage('binding-after-restart', code)],
  });
  await vi.waitFor(
    async () => expect((await mailboxRows()).filter(({ id }) => id === 'durable:main')).toHaveLength(1),
    { timeout: 2500 },
  );
  await restarted.emit('messages.upsert', {
    type: 'append',
    messages: [principalMessage('durable', 'My earlier request')],
  });
  expect((await mailboxRows()).filter(({ id }) => id === 'durable:main')).toHaveLength(1);
});

it('requests one code-free logout notice, re-links without numbers, keeps the principal, and restores needs-relink if pairing expires', async () => {
  const { socket, code } = await connect();
  await socket.emit('messages.upsert', { type: 'notify', messages: [principalMessage('bind', code)] });
  const principalVerifiedAt = (await readWhatsAppLink(linking.options.directory))?.principalVerifiedAt;
  expect(principalVerifiedAt).toEqual(expect.any(String));
  const logout = {
    connection: 'close' as const,
    lastDisconnect: {
      error: Object.assign(new Error('logged out'), { output: { statusCode: 401 } }),
      date: new Date(),
    },
  };
  await socket.emit('connection.update', logout);
  await socket.emit('connection.update', logout);
  expect(await linking.status()).toMatchObject({ state: 'needs-relink', principal: { lid: '12000' } });
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ kind: 'needs-relink' });
  expect(notices[0].text).not.toContain('12345678');
  expect(notices[0].text).not.toContain(code);
  await marked('relink', 'Please re-link WhatsApp.');
  expect(await linking.link(undefined, undefined, { ...caller, principalMessages: ['relink'] })).toMatchObject({
    pairingCode: '12345678',
  });
  const pairingSocket = sockets.at(-1)!;
  await pairingSocket.emit('connection.update', { connection: 'close' });
  await vi.waitFor(async () =>
    expect(await linking.status()).toMatchObject({ state: 'needs-relink', principal: { lid: '12000' } }),
  );
  await expect(linking.link('+15550000000', '+447700900999', { kind: 'operator' })).rejects.toThrow(/keeps/);
  await linking.link(undefined, undefined, { ...caller, principalMessages: ['relink'] });
  await sockets.at(-1)!.emit('connection.update', { connection: 'open' });
  expect(await linking.status()).toMatchObject({
    state: 'connected',
    principal: { lid: '12000', phoneJid: '447700900123@s.whatsapp.net' },
    bindingPending: false,
  });
  expect((await readWhatsAppLink(linking.options.directory))?.principalVerifiedAt).toBe(principalVerifiedAt);
});

it('blocks a bound principal LID whose authenticated phone changed before answers or normal routing', async () => {
  const { socket, code } = await connect();
  await socket.emit('messages.upsert', { type: 'notify', messages: [principalMessage('bind', code)] });
  await socket.emit('messages.upsert', {
    type: 'notify',
    messages: [principalMessage('changed', 'Please show my private details', '447700900999')],
  });
  expect(onInbound).not.toHaveBeenCalled();
  expect((await mailboxRows()).some(({ id }) => id === 'changed:main')).toBe(false);
  expect((await linking.status()).principal?.phoneJid).toBe('447700900123@s.whatsapp.net');
  await expect(
    (getChannelAdapterExact('whatsapp') as WhatsAppAdapter).deliver(
      '12000@lid',
      null,
      { kind: 'chat', content: { text: 'A private followup' } },
      'changed-number-followup',
    ),
  ).rejects.toMatchObject({ guardId: 'gws-ea-whatsapp:principal-unbound' });
});

it('unlink removes binding, auth, old held messages and claim, retains the account ledger, and admits a fresh principal', async () => {
  const { socket, code } = await connect();
  const adapter = getChannelAdapterExact('whatsapp') as WhatsAppAdapter;
  await adapter.deliver('15000@lid', null, { kind: 'chat', content: { text: 'First contact' } }, 'refused-contact');
  const sent = socket.sends.at(-1);
  await socket.emit('messages.update', [
    {
      key: { remoteJid: '15000@lid', fromMe: true, id: sent?.options.messageId },
      update: { status: 0, messageStubParameters: ['463'] },
    },
  ]);
  await socket.emit('messages.upsert', {
    type: 'notify',
    messages: [principalMessage('old-held', 'Before I prove my number'), principalMessage('bind', code)],
  });
  await linking.unlink();
  expect(notices).toHaveLength(0);
  expect(await linking.status()).toEqual({ state: 'unlinked' });
  expect(await isVerifiedPrincipalUser('whatsapp:12000')).toBe(false);
  expect(fs.existsSync(path.join(linking.options.directory, 'contacts.sqlite'))).toBe(true);
  expect(fs.existsSync(path.join(linking.options.directory, 'auth.sqlite'))).toBe(false);
  expect(fs.existsSync(path.join(linking.options.directory, 'messages.sqlite'))).toBe(true);
  const held = new WhatsAppIndex(linking.options.directory, () => '15550000000@s.whatsapp.net');
  expect(held.unrouted()).toEqual([]);
  expect(held.message('12000@lid', 'old-held')).toBeUndefined();
  held.close();
  await marked('new-numbers', 'Link +15550000000; my new number is +447700900999.');
  await linking.link('+15550000000', '+447700900999', { ...caller, principalMessages: ['new-numbers'] });
  const fresh = sockets.at(-1)!;
  await fresh.emit('connection.update', { connection: 'open' });
  const record = await readWhatsAppLink(linking.options.directory);
  if (!record?.binding) throw new Error('New proof is missing');
  await fresh.emit('messages.upsert', {
    type: 'notify',
    messages: [
      incoming('new-proof', record.binding.code, {
        key: { id: 'new-proof', remoteJid: '14000@lid', remoteJidAlt: '447700900999@s.whatsapp.net' },
      }),
    ],
  });
  expect((await linking.status()).principal).toEqual({ lid: '14000', phoneJid: '447700900999@s.whatsapp.net' });
  await expect(
    (getChannelAdapterExact('whatsapp') as WhatsAppAdapter).deliver(
      '15000@lid',
      null,
      { kind: 'chat', content: { text: 'Refused again' } },
      'after-unlink',
    ),
  ).rejects.toMatchObject({ guardId: 'gws-ea-whatsapp:contact-refused' });
  expect((await mailboxRows()).some(({ id }) => id === 'old-held:main')).toBe(false);
});

it('enforces no outbound handoff or native resend to the pending principal number before code proof', async () => {
  const { socket } = await connect();
  await socket.emit('messages.upsert', { type: 'notify', messages: [principalMessage('pending', 'Hello')] });
  const adapter = getChannelAdapterExact('whatsapp') as WhatsAppAdapter;
  await expect(
    adapter.deliver('12000@lid', null, { kind: 'chat', content: { text: 'Too early' } }, 'before-proof'),
  ).rejects.toMatchObject({ guardId: 'gws-ea-whatsapp:principal-unbound' });
  expect(socket.sends).toHaveLength(0);
});

it('publishes a new principal binding to the active adapter’s native group operation immediately', async () => {
  const { socket, code } = await connect();
  await socket.emit('messages.upsert', { type: 'notify', messages: [principalMessage('bind', code)] });
  const adapter = getChannelAdapterExact('whatsapp') as WhatsAppAdapter;
  await adapter.createGroup('A shared errand', [], {
    requestId: 'admitted-group-operation',
    principalMessageId: 'real-admitted-group-request',
  });
  expect(socket.createdGroups[0].participants).toContain('12000@lid');
});

it('checks both public WhatsApp profile fields before either native write', async () => {
  const { socket } = await connect();
  await runMigrations(getDb(), [gwsEaPrivacyMigration]);
  await addPrivateValue({ label: 'A private phrase', kind: 'other', value: 'Nebula secret phrase' });
  socket.profileName = undefined;
  socket.profileAbout = undefined;
  const adapter = getChannelAdapterExact('whatsapp') as WhatsAppAdapter;
  await expect(adapter.setProfile('Safe assistant name', 'Nebula secret phrase')).rejects.toMatchObject({
    guardId: 'gws-ea-privacy:audience',
  });
  expect(socket.profileName).toBeUndefined();
  expect(socket.profileAbout).toBeUndefined();
});

it('runs the registered main action and operator command through the same native host function', async () => {
  linking.close();
  vi.stubEnv('GWS_EA_WHATSAPP_DIR', linking.options.directory);
  vi.stubEnv('GWS_EA_CONFIG_ROOT', linking.options.paths.configRoot);
  vi.stubEnv('GWS_EA_STATE_ROOT', linking.options.paths.stateRoot);
  vi.stubEnv('GWS_EA_INSTANCE_ID', instanceId);
  await marked('numbers', 'Use +15550000000; mine is +447700900123.');
  const { session } = await resolveSession('main', 'principal-dm', null, 'agent-shared');
  const action = getDeliveryAction('whatsapp_link');
  if (!action) throw new Error('The production WhatsApp linking action was not registered');
  try {
    await action(
      {
        action: 'whatsapp_link',
        requestId: 'main-link-request',
        number: '+15550000000',
        principal_number: '+447700900123',
        principal_messages: ['numbers'],
      },
      session,
    );
    const response = (await mailboxRows()).find(({ id }) => id === 'action-resp-main-link-request');
    expect(response && JSON.parse(response.content)).toMatchObject({
      frame: { ok: true, data: { state: 'linking', pairingCode: '12345678' } },
    });
    expect(
      await dispatch({ id: 'operator-status', command: 'gws-ea-whatsapp-status', args: {} }, { caller: 'host' }),
    ).toMatchObject({ ok: true, data: { state: 'linking', number: '+15550000000' } });
    expect(
      await dispatch(
        { id: 'operator-link', command: 'gws-ea-whatsapp-link', args: { 'principal-number': '+447700900123' } },
        { caller: 'host' },
      ),
    ).toMatchObject({ ok: false, error: { message: expect.stringContaining('Give both numbers') } });
    expect(
      await dispatch(
        { id: 'agent-status', command: 'gws-ea-whatsapp-status', args: {} },
        { caller: 'agent', sessionId: session.id, agentGroupId: 'main', messagingGroupId: 'principal-dm' },
      ),
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  } finally {
    whatsAppLinking().close();
  }
});

it('replays an unaccepted logout notice after restart and records acceptance only when its notice owner confirms it', async () => {
  const { socket, code } = await connect();
  await socket.emit('messages.upsert', { type: 'notify', messages: [principalMessage('bind', code)] });
  unobserve?.();
  unobserve = registerWhatsAppObserver({
    onLinkNotice: async (notice) => {
      notices.push(notice);
      return false;
    },
  });
  await socket.emit('connection.update', {
    connection: 'close',
    lastDisconnect: {
      error: Object.assign(new Error('logged out'), { output: { statusCode: 401 } }),
      date: new Date(),
    },
  });
  const pending = await readWhatsAppLink(linking.options.directory);
  expect(pending?.outage?.notified).not.toBe(true);
  linking.close();
  linking = new WhatsAppLinking(linking.options);
  unobserve();
  unobserve = registerWhatsAppObserver({
    onLinkNotice: async (notice) => {
      notices.push(notice);
      return true;
    },
  });
  await linking.reconcile();
  await linking.reconcile();
  expect(notices).toHaveLength(2);
  expect(notices[0].id).toBe(notices[1].id);
  expect((await readWhatsAppLink(linking.options.directory))?.outage?.notified).toBe(true);
});

it('retains a handed-off row receipt through unlink and same-number re-link without a second WhatsApp send', async () => {
  const { socket, code } = await connect();
  await socket.emit('messages.upsert', { type: 'notify', messages: [principalMessage('bind', code)] });
  const adapter = getChannelAdapterExact('whatsapp') as WhatsAppAdapter;
  const id = await adapter.deliver(
    'team@g.us',
    null,
    { kind: 'chat', content: { text: 'A single handoff' } },
    'accepted-before-unlink',
  );
  await linking.unlink();
  await linking.link('+15550000000', '+447700900123', caller);
  const fresh = sockets.at(-1)!;
  await fresh.emit('connection.update', { connection: 'open' });
  expect(
    await (getChannelAdapterExact('whatsapp') as WhatsAppAdapter).deliver(
      'team@g.us',
      null,
      { kind: 'chat', content: { text: 'A single handoff' } },
      'accepted-before-unlink',
    ),
  ).toBe(id);
  expect(fresh.sends).toHaveLength(0);
});

it('abandons the interrupted pairing socket on host restart, restores unlinked and keeps no unverified intake', async () => {
  await marked('numbers', 'Use +15550000000; mine is +447700900123.');
  await linking.link('+15550000000', '+447700900123', caller);
  await sockets[0].emit('messages.upsert', {
    type: 'notify',
    messages: [principalMessage('unverified-before-open', 'A queued request')],
  });
  expect(onInbound).not.toHaveBeenCalled();
  await stopChannelAdapter('whatsapp');
  linking.close();
  linking = new WhatsAppLinking(linking.options);
  await linking.reconcile();
  expect(await linking.status()).toEqual({ state: 'unlinked' });
  expect(sockets).toHaveLength(1);
  expect(fs.existsSync(path.join(linking.options.directory, 'auth.sqlite'))).toBe(false);
  const state = new WhatsAppIndex(linking.options.directory, () => '15550000000@s.whatsapp.net');
  expect(state.unrouted()).toEqual([]);
  state.close();
  const notes = (await mailboxRows()).map(({ content }) => content).join('\n');
  expect(notes).toContain('pairing connection closed before the account connected');
  expect(notes).not.toContain('pairing code expired');
});

it('refuses a delayed reply to the unlinked principal DM at the native delivery boundary after a fresh principal binds', async () => {
  const { socket, code } = await connect();
  await socket.emit('messages.upsert', { type: 'notify', messages: [principalMessage('bind', code)] });
  const dm = await getMessagingGroupByPlatform('whatsapp', '12000@lid', 'whatsapp');
  if (!dm) throw new Error('Principal DM was not bound');
  const { session } = await resolveSession('main', dm.id, null, 'shared');
  await writeOutboundDirect('main', session.id, {
    id: 'late-origin-reply',
    kind: 'chat',
    platformId: dm.platform_id,
    channelType: 'whatsapp',
    threadId: null,
    content: JSON.stringify({ text: 'A delayed private reply' }),
  });
  await linking.unlink();
  await marked('fresh', 'Link +15550000000; my number is now +447700900999.');
  await linking.link('+15550000000', '+447700900999', { ...caller, principalMessages: ['fresh'] });
  const fresh = sockets.at(-1)!;
  await fresh.emit('connection.update', { connection: 'open' });
  const record = await readWhatsAppLink(linking.options.directory);
  if (!record?.binding) throw new Error('No fresh principal proof');
  await fresh.emit('messages.upsert', {
    type: 'notify',
    messages: [
      incoming('new-bind', record.binding.code, {
        key: { id: 'new-bind', remoteJid: '14000@lid', remoteJidAlt: '447700900999@s.whatsapp.net' },
      }),
    ],
  });
  setDeliveryAdapter(createChannelDeliveryAdapter());
  await deliverSessionMessages(session);
  expect((await getDeliveryAttempt('late-origin-reply'))?.last_error).toContain('detached');
  expect(fresh.sends).toHaveLength(0);
});

it('repairs a rollback across linking with the exact private proof and routes the next principal message to main', async () => {
  const { socket, code } = await connect();
  await socket.emit('messages.upsert', { type: 'notify', messages: [principalMessage('proof', code)] });
  const proof = (await readWhatsAppLink(linking.options.directory))?.principalVerifiedAt;
  await removeWhatsAppPrincipalBinding('12000');
  expect(await isVerifiedPrincipalUser('whatsapp:12000')).toBe(false);
  await linking.reconcile();
  await linking.reconcile();
  expect(await getDb().get("SELECT verified_at FROM gws_ea_principal_users WHERE user_id = 'whatsapp:12000'")).toEqual({
    verified_at: proof,
  });
  expect(await isVerifiedPrincipalUser('gchat:users/1')).toBe(true);
  await socket.emit('messages.upsert', {
    type: 'notify',
    messages: [principalMessage('after-rollback', 'Continue my errand')],
  });
  expect((await mailboxRows()).filter(({ id }) => id === 'after-rollback:main')).toHaveLength(1);
  expect(socket.sends).toHaveLength(0);
});

it('withdraws resurrected WhatsApp authority in favor of the current private proof, including after unlink', async () => {
  const { socket, code } = await connect();
  await socket.emit('messages.upsert', { type: 'notify', messages: [principalMessage('proof', code)] });
  const proof = (await readWhatsAppLink(linking.options.directory))?.principalVerifiedAt;
  await bindWhatsAppPrincipal({ lid: '14000', phoneJid: '447700900999@s.whatsapp.net' }, '2026-01-01T00:00:00.000Z');
  await bindWhatsAppPrincipal({ lid: '12000', phoneJid: '447700900123@s.whatsapp.net' }, '2026-01-02T00:00:00.000Z');
  await linking.reconcile();
  expect(await isVerifiedPrincipalUser('whatsapp:14000')).toBe(false);
  expect(await getDb().get("SELECT verified_at FROM gws_ea_principal_users WHERE user_id = 'whatsapp:12000'")).toEqual({
    verified_at: proof,
  });
  const stale = await getMessagingGroupByPlatform('whatsapp', '14000@lid', 'whatsapp');
  expect(stale?.detached_at).toEqual(expect.any(String));
  await linking.unlink();
  await bindWhatsAppPrincipal({ lid: '12000', phoneJid: '447700900123@s.whatsapp.net' }, proof!);
  await linking.reconcile();
  expect(await isVerifiedPrincipalUser('whatsapp:12000')).toBe(false);
  expect(await isVerifiedPrincipalUser('gchat:users/1')).toBe(true);
});

it('keeps authenticated proof durable when the central binding fails, then finishes from that same proof', async () => {
  const { socket, code } = await connect();
  const db = getDb();
  const run = db.run.bind(db);
  const fail = vi.spyOn(db, 'run').mockImplementation(async (sql, ...params) => {
    if (sql.includes('INSERT INTO gws_ea_principal_users')) throw new Error('Central binding unavailable');
    return run(sql, ...params);
  });
  await socket.emit('messages.upsert', { type: 'notify', messages: [principalMessage('proof-retry', code)] });
  fail.mockRestore();
  expect(await isVerifiedPrincipalUser('whatsapp:12000')).toBe(false);
  const saved = await readWhatsAppLink(linking.options.directory);
  expect(saved?.principal).toEqual({ lid: '12000', phoneJid: '447700900123@s.whatsapp.net' });
  expect(saved?.principalVerifiedAt).toEqual(expect.any(String));
  await socket.emit('messages.upsert', { type: 'append', messages: [principalMessage('proof-retry', code)] });
  await vi.waitFor(async () => expect(await isVerifiedPrincipalUser('whatsapp:12000')).toBe(true));
  expect(await getDb().get("SELECT verified_at FROM gws_ea_principal_users WHERE user_id = 'whatsapp:12000'")).toEqual({
    verified_at: saved?.principalVerifiedAt,
  });
  expect((await readWhatsAppLink(linking.options.directory))?.binding).toBeUndefined();
  expect((await mailboxRows()).some(({ id }) => id === 'proof-retry:main')).toBe(false);
  expect(socket.sends).toHaveLength(0);
});

it.each(['transport-stopped', 'link-removed', 'claim-released', 'auth-removed'] as const)(
  'finishes an unlink interrupted after %s without losing native logout proof or repeating signout',
  async (boundary) => {
    const { socket, code } = await connect();
    await socket.emit('messages.upsert', { type: 'notify', messages: [principalMessage('proof', code)] });
    const logout = vi.spyOn(socket, 'logout');
    const crash = new Error(`Interrupted after ${boundary}`);
    const nativeRm = fs.promises.rm;
    const rm = vi.spyOn(fs.promises, 'rm').mockImplementation(async (...args) => {
      await nativeRm(...args);
      if (
        (boundary === 'link-removed' && String(args[0]).endsWith('/link.json')) ||
        (boundary === 'auth-removed' && String(args[0]).endsWith('/auth.sqlite'))
      )
        throw crash;
    });
    const nativeStop = channelRegistry.stopChannelAdapter;
    const stop = vi.spyOn(channelRegistry, 'stopChannelAdapter').mockImplementation(async (...args) => {
      const result = await nativeStop(...args);
      if (boundary === 'transport-stopped') throw crash;
      return result;
    });
    const nativeClaim = instanceRegistry.claimInstanceWhatsApp;
    const claim = vi.spyOn(instanceRegistry, 'claimInstanceWhatsApp').mockImplementation(async (...args) => {
      const result = await nativeClaim(...args);
      if (boundary === 'claim-released') throw crash;
      return result;
    });
    try {
      await expect(linking.unlink()).rejects.toThrow(crash.message);
    } finally {
      rm.mockRestore();
      stop.mockRestore();
      claim.mockRestore();
    }
    linking.close();
    linking = new WhatsAppLinking(linking.options);
    await linking.unlink();
    expect(logout).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
    expect(await linking.status()).toEqual({ state: 'unlinked' });
    expect(
      (await getInstanceReservation(linking.options.paths, instanceId)).exclusive_resource_claims.whatsapp_number,
    ).toBeUndefined();
    expect(fs.existsSync(path.join(linking.options.directory, 'auth.sqlite'))).toBe(false);
    expect(await isVerifiedPrincipalUser('gchat:users/1')).toBe(true);
    logout.mockRestore();
  },
);

it('finishes native pairing received before open with the retained authenticated credentials and admitted-number check', async () => {
  await marked('numbers', 'Use +15550000000; mine is +447700900123.');
  await linking.link('+15550000000', '+447700900123', caller);
  const pairing = sockets[0];
  await pairing.emit('messages.upsert', {
    type: 'notify',
    messages: [principalMessage('before-paired-open', 'Keep this request through native restart')],
  });
  await pairing.emit('creds.update', {
    account: { details: Buffer.from('native paired account') },
    me: { id: '15550000000:1@s.whatsapp.net', name: 'Assistant', lid: '999000@lid' },
  });
  await pairing.emit('connection.update', {
    connection: 'close',
    lastDisconnect: {
      error: Object.assign(new Error('Restart required after native pairing'), { output: { statusCode: 515 } }),
      date: new Date(),
    },
  });
  await vi.waitFor(() => expect(sockets).toHaveLength(2));
  expect(pairing.ended).toBe(true);
  const auth = new WhatsAppAuthStore(linking.options.directory);
  expect(auth.state.creds.account?.details).toEqual(Buffer.from('native paired account'));
  auth.close();
  const intake = new WhatsAppIndex(linking.options.directory, () => '15550000000@s.whatsapp.net');
  expect(intake.unrouted().map((message) => message.key.id)).toContain('before-paired-open');
  intake.close();
  await sockets[1].emit('connection.update', { connection: 'open' });
  expect(await linking.status()).toMatchObject({ state: 'connected', bindingPending: true });
  expect(onInbound).not.toHaveBeenCalled();
  const pendingProof = await readWhatsAppLink(linking.options.directory);
  if (!pendingProof?.binding) throw new Error('The native reconnect did not issue principal proof');
  await sockets[1].emit('messages.upsert', {
    type: 'notify',
    messages: [principalMessage('proof-after-native-restart', pendingProof.binding.code)],
  });
  await vi.waitFor(
    async () => expect((await mailboxRows()).filter(({ id }) => id === 'before-paired-open:main')).toHaveLength(1),
    { timeout: 2500 },
  );
  expect(
    (await getInstanceReservation(linking.options.paths, instanceId)).exclusive_resource_claims.whatsapp_number,
  ).toBe('+15550000000');
});

it('retains exact native logout proof through an unregistered re-link expiry and can then unlink without another socket', async () => {
  const { socket, code } = await connect();
  await socket.emit('messages.upsert', { type: 'notify', messages: [principalMessage('proof', code)] });
  await socket.emit('connection.update', {
    connection: 'close',
    lastDisconnect: {
      error: Object.assign(new Error('logged out'), { output: { statusCode: 401 } }),
      date: new Date(),
    },
  });
  await marked('relink', 'Please re-link WhatsApp.');
  await linking.link(undefined, undefined, { ...caller, principalMessages: ['relink'] });
  await sockets[1].emit('connection.update', { connection: 'close' });
  await vi.waitFor(async () => expect(await linking.status()).toMatchObject({ state: 'needs-relink' }));
  expect(fs.existsSync(path.join(linking.options.directory, 'auth.sqlite'))).toBe(true);
  const auth = new WhatsAppAuthStore(linking.options.directory);
  expect(auth.loggedOut('15550000000@s.whatsapp.net')).toBe(true);
  auth.close();
  await linking.unlink();
  expect(sockets).toHaveLength(2);
  expect(await linking.status()).toEqual({ state: 'unlinked' });
});
