import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ data: '' }));
vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  get DATA_DIR() {
    return storage.data;
  },
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));

import { closeDb, getDb, initDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import { prepareInboundContent } from '../../inbound-preparation.js';
import { setDeliveryAdapter } from '../../delivery.js';
import { resolveSession, withExistingMailboxSession } from '../../session-manager.js';
import type { MessagingGroup, Session } from '../../types.js';
import { requestApproval } from '../approvals/primitive.js';
import { teardownChannelAdapters } from '../../channels/channel-registry.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { upsertUser } from '../permissions/db/users.js';
import { writeWhatsAppLink, type WhatsAppLink } from '../gws-ea-whatsapp/paths.js';
import { bindVerifiedPrincipalUser, principalContact } from './db.js';
import { resolveMainConversation, writeNoteForMain } from './main-note.js';
import './index.js';
import { mountWhatsAppAvailability } from './testing/whatsapp-availability.js';

const GOOGLE = 'gchat:users/200';
const WHATSAPP = 'whatsapp:12000';
let root: string;
let directory: string;
let google: MessagingGroup;
let whatsapp: MessagingGroup;
let session: Session;
let sent: { channel: string; platform: string; content: string }[];
let connected: boolean;
let bindingAt: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'principal-contact-'));
  storage.data = root;
  directory = path.join(root, 'secrets', 'whatsapp');
  vi.stubEnv('GWS_EA_WHATSAPP_DIR', directory);
  await runMigrations(await initDb(path.join(root, 'central.db'), { role: 'test' }));
  const at = new Date(Date.now() - 30_000).toISOString();
  bindingAt = at;
  await createAgentGroup({ id: 'main', name: 'main', folder: 'main', agent_provider: null, created_at: at });
  await getDb().run("UPDATE gws_ea_profile SET main_agent_group_id = 'main' WHERE singleton = 1");
  google = {
    id: 'google-dm',
    channel_type: 'gchat',
    instance: 'gchat',
    platform_id: 'gchat:spaces/dm',
    is_group: 0,
    name: null,
    unknown_sender_policy: 'strict',
    created_at: at,
  };
  whatsapp = { ...google, id: 'whatsapp-dm', channel_type: 'whatsapp', instance: 'whatsapp', platform_id: '12000' };
  for (const [userId, dm] of [
    [GOOGLE, google],
    [WHATSAPP, whatsapp],
  ] as const) {
    await createMessagingGroup(dm);
    await upsertUser({ id: userId, kind: dm.channel_type, display_name: 'Morgan', created_at: at });
    await bindVerifiedPrincipalUser(userId, at);
    await upsertUserDm({ user_id: userId, channel_type: dm.channel_type, messaging_group_id: dm.id, resolved_at: at });
    await grantRole({ user_id: userId, role: 'owner', agent_group_id: null, granted_by: null, granted_at: at });
  }
  session = (await resolveSession('main', google.id, null, 'agent-shared')).session;
  sent = [];
  setDeliveryAdapter({
    deliver: async (channel, platform, _thread, _kind, content) => {
      sent.push({ channel, platform, content });
      return 'posted';
    },
  });
  await link('connected');
  connected = true;
  await mountWhatsAppAvailability(() => connected);
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

async function link(state: WhatsAppLink['state']): Promise<void> {
  await writeWhatsAppLink(directory, {
    schema_version: 1,
    state,
    principal: { lid: '12000', phoneJid: '15555550101@s.whatsapp.net' },
    principalVerifiedAt: bindingAt,
  });
}

async function mark(
  dm: MessagingGroup,
  id: string,
  ago: number,
  userId = dm.channel_type === 'gchat' ? 'users/200' : WHATSAPP,
): Promise<void> {
  await prepareInboundContent({
    content: JSON.stringify({ text: 'Could you help with this?' }),
    channelType: dm.channel_type,
    instance: dm.instance ?? dm.channel_type,
    platformId: dm.platform_id,
    messageId: id,
    timestamp: new Date(Date.now() - ago).toISOString(),
    authenticatedSender: { userId, kind: 'human' },
    messagingGroup: dm,
    session,
  });
}

async function noteRoute(id: string): Promise<unknown> {
  expect(await writeNoteForMain({ id, timestamp: new Date().toISOString(), text: 'Your reminder.', wake: true })).toBe(
    'written',
  );
  const rows = await withExistingMailboxSession('main', session.id, (mailbox) => mailbox.getInboundMessages([id]));
  return rows?.map(({ channelType, platformId }) => ({ channelType, platformId }));
}

describe('the principal’s current direct conversation', () => {
  it('routes proactive notes to the last marked DM, using the same main conversation on both channels', async () => {
    await mark(google, 'google-first', 20_000);
    await mark(whatsapp, 'whatsapp-next', 10_000);
    expect(await noteRoute('wa-note')).toEqual([{ channelType: 'whatsapp', platformId: '12000' }]);
    expect(await resolveMainConversation()).toMatchObject({ session: { id: session.id } });
    await mark(google, 'google-next', 1_000);
    expect(await noteRoute('google-note')).toEqual([{ channelType: 'gchat', platformId: google.platform_id }]);
  });

  it.each(['needs-relink', 'linking'] as const)('falls back to Google Chat while WhatsApp is %s', async (state) => {
    await mark(whatsapp, 'wa-last', 5_000);
    expect((await principalContact())?.directMessage.id).toBe(whatsapp.id);
    await link(state);
    expect(await noteRoute('fallback')).toEqual([{ channelType: 'gchat', platformId: google.platform_id }]);
  });

  it('keeps first-receipt timestamps, so a late old message or a replay cannot steal the preference', async () => {
    await mark(whatsapp, 'wa-old', 20_000);
    await mark(google, 'google-new', 10_000);
    await mark(whatsapp, 'wa-old', 0);
    await mark(whatsapp, 'wa-delayed', 15_000);
    expect((await principalContact())?.directMessage.id).toBe(google.id);
    await closeDb();
    await initDb(path.join(root, 'central.db'), { role: 'test' });
    expect((await principalContact())?.directMessage.id).toBe(google.id);
  });

  it('falls back for proactive notes and approval cards during a transient transport disconnect', async () => {
    await mark(whatsapp, 'wa-last', 5_000);
    expect((await principalContact())?.directMessage.id).toBe(whatsapp.id);
    connected = false;
    expect(await noteRoute('during-disconnect')).toEqual([{ channelType: 'gchat', platformId: google.platform_id }]);
    const id = await requestApproval({
      session,
      agentName: 'main',
      action: 'transient-proof',
      payload: {},
      title: 'May I do this?',
      question: 'Please confirm.',
      approverUserId: WHATSAPP,
    });
    expect(id).not.toBeNull();
    expect(sent.map(({ channel }) => channel)).toEqual(['gchat']);
    expect(await getDb().get('SELECT approver_user_id FROM pending_approvals WHERE approval_id = ?', id)).toEqual({
      approver_user_id: GOOGLE,
    });
    connected = true;
    expect((await principalContact())?.directMessage.id).toBe(whatsapp.id);
    await teardownChannelAdapters();
    expect((await principalContact())?.directMessage.id).toBe(google.id);
  });

  it('does not change the DM from a group mark or an unverified sender', async () => {
    await mark(google, 'google-last', 10_000);
    const group = { ...whatsapp, id: 'group', platform_id: '456@g.us', is_group: 1 };
    await createMessagingGroup(group);
    await mark(group, 'group-message', 1_000);
    await mark(whatsapp, 'unverified', 0, 'whatsapp:99999');
    expect((await principalContact())?.directMessage.id).toBe(google.id);
  });

  it('delivers an approval from a WhatsApp chat to the DM the profile currently names', async () => {
    await mark(whatsapp, 'wa-first', 10_000);
    await mark(google, 'google-last', 1_000);
    const origin = (await resolveSession('main', whatsapp.id, null, 'shared')).session;
    const id = await requestApproval({
      session: origin,
      agentName: 'main',
      action: 'contact-proof',
      payload: {},
      title: 'May I do this?',
      question: 'Please confirm.',
    });
    expect(id).not.toBeNull();
    expect(sent).toEqual([{ channel: 'gchat', platform: google.platform_id, content: expect.any(String) }]);
    expect(
      await getDb().get('SELECT approver_user_id, channel_type FROM pending_approvals WHERE approval_id = ?', id),
    ).toEqual({ approver_user_id: GOOGLE, channel_type: 'gchat' });
  });

  it('delivers an approval from Google Chat on WhatsApp after the principal writes there', async () => {
    await mark(google, 'google-first', 10_000);
    await mark(whatsapp, 'wa-last', 1_000);
    const id = await requestApproval({
      session,
      agentName: 'main',
      action: 'wa-approval-proof',
      payload: {},
      title: 'May I do this?',
      question: 'Please confirm.',
    });
    expect(id).not.toBeNull();
    expect(sent.map(({ channel, platform }) => ({ channel, platform }))).toEqual([
      { channel: 'whatsapp', platform: whatsapp.platform_id },
    ]);
    expect(await getDb().get('SELECT approver_user_id FROM pending_approvals WHERE approval_id = ?', id)).toEqual({
      approver_user_id: WHATSAPP,
    });
  });
});
