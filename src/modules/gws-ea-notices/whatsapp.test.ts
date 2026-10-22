import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ data: '' }));
vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  get DATA_DIR() {
    return storage.data;
  },
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));

import { closeDb, getDb, initDb } from '../../db/connection.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import { getDeliveryAdapter, setDeliveryAdapter } from '../../delivery.js';
import { startHostModules } from '../../host-lifecycle.js';
import {
  createChannelDeliveryAdapter,
  registerChannelAdapter,
  startChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import { prepareInboundContent } from '../../inbound-preparation.js';
import { resolveControlPlanePaths } from '../../gws-ea/paths.js';
import { seedMain, mainSession } from '../gws-ea-matters/testing/main-conversation.js';
import { bindVerifiedPrincipalUser, principalContact } from '../gws-ea-profile/db.js';
import { bindWhatsAppPrincipal, removeWhatsAppPrincipalBinding } from '../gws-ea-profile/bind.js';
import { mountWhatsAppAvailability } from '../gws-ea-profile/testing/whatsapp-availability.js';
import '../gws-ea-profile/index.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { upsertUser } from '../permissions/db/users.js';
import { WhatsAppLinking } from '../gws-ea-whatsapp/link.js';
import { observeWhatsAppLinkNotice, type WhatsAppLinkNotice } from '../gws-ea-whatsapp/observers.js';
import { readWhatsAppLink, writeWhatsAppLink } from '../gws-ea-whatsapp/paths.js';
import './index.js';
import { AssistantChatAdapter, createAssistantChatChannel, hostChatAuth } from '../gws-ea-chat/adapter.js';
import { createChatHydrator } from '../gws-ea-chat/hydrate.js';
import { ASSISTANT, CHAT_TOKEN, DIRECTORY_TOKEN, FakeChatApi } from '../gws-ea-chat/testing/fake-chat-api.js';

let root: string;
let directory: string;
let linking: WhatsAppLinking;
let notice: WhatsAppLinkNotice;
let abort: AbortController;
let sent: { channel: string; platform: string; content: string; id?: string }[];
let reject: boolean;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'whatsapp-notices-'));
  storage.data = path.join(root, 'data');
  const paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'config'),
    stateRoot: path.join(root, 'instances'),
  });
  const instanceId = '12345678-1234-4234-8234-123456789abc';
  directory = path.join(paths.instanceRoot(instanceId), 'secrets', 'whatsapp');
  vi.stubEnv('GWS_EA_WHATSAPP_DIR', directory);
  await runMigrations(await initDb(path.join(root, 'central.db'), { role: 'test' }));
  await seedMain('UTC');
  const at = new Date(Date.now() - 1_000).toISOString();
  const dm = {
    id: 'wa-dm',
    channel_type: 'whatsapp',
    instance: 'whatsapp',
    platform_id: '12000',
    is_group: 0,
    name: null,
    unknown_sender_policy: 'strict' as const,
    created_at: at,
  };
  await createMessagingGroup(dm);
  await upsertUser({ id: 'whatsapp:12000', kind: 'whatsapp', display_name: 'Morgan', created_at: at });
  await bindVerifiedPrincipalUser('whatsapp:12000', at);
  await upsertUserDm({
    user_id: 'whatsapp:12000',
    channel_type: 'whatsapp',
    messaging_group_id: dm.id,
    resolved_at: at,
  });
  await writeWhatsAppLink(directory, {
    schema_version: 1,
    state: 'connected',
    principal: { lid: '12000', phoneJid: '15555550101@s.whatsapp.net' },
    principalVerifiedAt: at,
  });
  await mountWhatsAppAvailability(() => true);
  await prepareInboundContent({
    content: JSON.stringify({ text: 'Hello' }),
    channelType: 'whatsapp',
    instance: 'whatsapp',
    platformId: dm.platform_id,
    messageId: 'latest',
    timestamp: at,
    authenticatedSender: { userId: 'whatsapp:12000', kind: 'human' },
    messagingGroup: dm,
    session: await mainSession(),
  });
  linking = new WhatsAppLinking({ directory, paths, instanceId });
  notice = {
    id: 'outage:first',
    kind: 'needs-relink',
    text: 'An internal instruction, not words for the principal.',
    link: {
      schema_version: 1,
      state: 'needs-relink',
      principal: { lid: '12000', phoneJid: '15555550101@s.whatsapp.net' },
      principalVerifiedAt: at,
      outage: { id: 'first' },
    },
  };
  sent = [];
  reject = false;
  setDeliveryAdapter({
    deliver: async (channel, platform, _thread, _kind, content, _files, _instance, id) => {
      sent.push({ channel, platform, content, id });
      if (reject) throw new Error('Google Chat is temporarily unavailable');
      return 'posted';
    },
  });
  abort = new AbortController();
});

afterEach(async () => {
  abort.abort();
  vi.useRealTimers();
  linking.close();
  await teardownChannelAdapters();
  await closeDb();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

async function boot(): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) throw new Error('No test delivery adapter');
  await startHostModules({ db: getDb(), deliveryAdapter: adapter, signal: abort.signal });
}

async function snapshotCentral(): Promise<string> {
  const snapshot = path.join(root, 'central-snapshot.db');
  await closeDb();
  await fs.copyFile(path.join(root, 'central.db'), snapshot);
  await initDb(path.join(root, 'central.db'), { role: 'test' });
  return snapshot;
}

async function restoreCentral(snapshot: string): Promise<void> {
  await closeDb();
  await fs.copyFile(snapshot, path.join(root, 'central.db'));
  await initDb(path.join(root, 'central.db'), { role: 'test' });
}

it('keeps an accepted pending outage when rollback restores an older central database', async () => {
  const snapshot = await snapshotCentral();
  reject = true;
  await writeWhatsAppLink(directory, notice.link);
  await linking.reconcile();
  expect((await readWhatsAppLink(directory))?.outage?.notified).toBe(true);
  expect(sent).toHaveLength(1);
  await restoreCentral(snapshot);
  reject = false;
  await linking.reconcile();
  await boot();
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  await restoreCentral(snapshot);
  await boot();
  expect(sent).toHaveLength(2);
});

it('does not revive the same changed-number DM when rollback restores an older central database', async () => {
  const snapshot = await snapshotCentral();
  await observeWhatsAppLinkNotice({ ...notice, id: 'number-changed:12000', kind: 'principal-number-changed' });
  expect((await principalContact())?.directMessage.channel_type).toBe('gchat');
  await restoreCentral(snapshot);
  await boot();
  expect((await principalContact())?.directMessage.channel_type).toBe('gchat');
});

it('pins a code-free relink notice to Google Chat, once for each outage, even with WhatsApp preferred', async () => {
  expect(await observeWhatsAppLinkNotice(notice)).toBe(true);
  expect(await observeWhatsAppLinkNotice(notice)).toBe(true);
  expect(sent).toEqual([
    {
      channel: 'gchat',
      platform: 'gchat:spaces/morgan',
      content: JSON.stringify({
        text: 'My WhatsApp connection has disconnected. Reply here when you’re ready and I’ll help you link it again.',
      }),
      id: expect.any(String),
    },
  ]);
  expect(sent[0]?.content).not.toContain(notice.text);
  await observeWhatsAppLinkNotice({ ...notice, id: 'outage:second' });
  expect(sent).toHaveLength(2);
});

it('accepts durably before delivery and retries the pinned Google Chat notice after a host restart', async () => {
  reject = true;
  expect(await observeWhatsAppLinkNotice(notice)).toBe(true);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.channel).toBe('gchat');
  await closeDb();
  await initDb(path.join(root, 'central.db'), { role: 'test' });
  reject = false;
  await boot();
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  await observeWhatsAppLinkNotice(notice);
  expect(sent).toHaveLength(2);
  await closeDb();
  await initDb(path.join(root, 'central.db'), { role: 'test' });
  await boot();
  expect(sent).toHaveLength(2);
});

it('retries an accepted notice on the running host without falling back to WhatsApp', async () => {
  vi.useFakeTimers();
  reject = true;
  await observeWhatsAppLinkNotice(notice);
  await boot();
  const failures = sent.length;
  expect(failures).toBeGreaterThan(0);
  reject = false;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(sent).toHaveLength(failures + 1);
  expect(sent.every(({ channel }) => channel === 'gchat')).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(sent).toHaveLength(failures + 1);
});

it('consumes a persisted pending outage on startup reconciliation without a WhatsApp socket', async () => {
  await writeWhatsAppLink(directory, notice.link);
  await linking.reconcile();
  expect((await readWhatsAppLink(directory))?.outage).toEqual({ id: 'first', notified: true });
  expect(sent).toHaveLength(1);
  expect(sent[0]?.channel).toBe('gchat');
  await linking.reconcile();
  expect(sent).toHaveLength(1);
});

it('pins a changed-number notice to Google Chat instead of the unusable WhatsApp identity', async () => {
  expect(
    await observeWhatsAppLinkNotice({ ...notice, id: 'number-changed:12000', kind: 'principal-number-changed' }),
  ).toBe(true);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ channel: 'gchat', platform: 'gchat:spaces/morgan' });
  expect(JSON.parse(sent[0]?.content ?? '{}')).toEqual({
    text: 'Your WhatsApp number has changed, so I can’t use that conversation. Reply here and I’ll help you connect the new number.',
  });
});

it('cannot route a proactive note to a changed-number identity even when its link still says connected', async () => {
  expect((await principalContact())?.directMessage.channel_type).toBe('whatsapp');
  await observeWhatsAppLinkNotice({ ...notice, id: 'number-changed:12000', kind: 'principal-number-changed' });
  expect((await readWhatsAppLink(directory))?.state).toBe('connected');
  expect((await principalContact())?.directMessage.channel_type).toBe('gchat');
  await bindVerifiedPrincipalUser('whatsapp:12000', new Date().toISOString());
  expect((await principalContact())?.directMessage.channel_type).toBe('gchat');
  await removeWhatsAppPrincipalBinding('12000');
  const verifiedAt = new Date().toISOString();
  const principal = { lid: '12000', phoneJid: '15555550101@s.whatsapp.net' };
  await bindWhatsAppPrincipal(principal, verifiedAt);
  await writeWhatsAppLink(directory, {
    schema_version: 1,
    state: 'connected',
    principal,
    principalVerifiedAt: verifiedAt,
  });
  expect((await principalContact())?.directMessage.channel_type).toBe('whatsapp');
});

it('retries an outage notice through native Google Chat without creating another message after an accepted request loses its acknowledgement', async () => {
  const api = new FakeChatApi();
  api.addSpace('spaces/morgan', 'DIRECT_MESSAGE');
  const receipts = new Map<string, Response>();
  const keys: (string | null)[] = [];
  let loseAcknowledgement = true;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === 'POST' && url.pathname.endsWith('/messages')) {
      const key = url.searchParams.get('requestId');
      keys.push(key);
      const accepted = key === null ? undefined : receipts.get(key);
      if (accepted) return accepted.clone();
      const response = await api.fetch(input, init);
      if (key !== null) receipts.set(key, response.clone());
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new Error('Google accepted before the connection closed');
      }
      return response;
    }
    return api.fetch(input, init);
  };
  const native = new AssistantChatAdapter({
    botUserId: ASSISTANT,
    userName: 'morgan',
    auth: hostChatAuth(async () => CHAT_TOKEN, fetch),
    hydrator: createChatHydrator({
      chatToken: async () => CHAT_TOKEN,
      directoryToken: async () => DIRECTORY_TOKEN,
      fetch,
    }),
    chatToken: async () => CHAT_TOKEN,
    fetch,
    startDelivery: () => ({ stop: async () => {} }),
  });
  registerChannelAdapter('gchat', { factory: () => createAssistantChatChannel(native) });
  try {
    expect(await startChannelAdapter('gchat')).toBe('started');
    setDeliveryAdapter(createChannelDeliveryAdapter());
    expect(await observeWhatsAppLinkNotice(notice)).toBe(true);
    expect(api.posted()).toHaveLength(1);
    expect(await observeWhatsAppLinkNotice(notice)).toBe(true);
    expect(api.posted()).toHaveLength(1);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toEqual(expect.any(String));
    expect(keys[1]).toBe(keys[0]);
    expect(api.posted()[0]?.text).toContain('Reply here when you’re ready');
    await observeWhatsAppLinkNotice(notice);
    expect(keys).toHaveLength(2);
  } finally {
    registerChannelAdapter('gchat', { factory: () => null });
  }
});
