import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initDb } from '../../db/connection.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import { OutboundRefusedError, setDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import { prepareInboundContent } from '../../inbound-preparation.js';
import type { MessagingGroup } from '../../types.js';
import { bindVerifiedPrincipalUser } from '../gws-ea-profile/db.js';
import '../gws-ea-profile/index.js';
import { upsertUser } from '../permissions/db/users.js';
import { deleteChatClearances, recordChatClearances } from './clearance.js';
import { addPrivateValue } from './db.js';
import { checkOutbound, privateValuesGivenAway, type PrivateValueReference } from './index.js';

const PRINCIPAL = 'whatsapp:12345';
const LANDING = '16:42 at Terminal 7';
let root: string;
let groupA: MessagingGroup;
let guarded: ChannelDeliveryAdapter;
let sent: string[];
let value: PrivateValueReference;

async function principalMessage(id = 'request-a', group = groupA, forwarded = false, userId = PRINCIPAL) {
  const timestamp = new Date().toISOString();
  return prepareInboundContent({
    channelType: group.channel_type,
    instance: group.channel_type,
    platformId: group.platform_id,
    messageId: id,
    timestamp,
    authenticatedSender: { userId, kind: 'human' },
    messagingGroup: group,
    content: JSON.stringify({ text: 'Share my landing time with Juno.', forwarded }),
    session: {
      id: 'session-a',
      agent_group_id: 'external-chat',
      messaging_group_id: group.id,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: timestamp,
    },
  });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-clearances-'));
  await initDb(path.join(root, 'central.db'), { role: 'test' });
  await runMigrations(getDb());
  const timestamp = new Date().toISOString();
  await upsertUser({ id: PRINCIPAL, kind: 'whatsapp', display_name: 'Morgan', created_at: timestamp });
  await bindVerifiedPrincipalUser(PRINCIPAL, timestamp);
  groupA = {
    id: 'chat-a',
    channel_type: 'whatsapp',
    platform_id: '123@g.us',
    is_group: 1,
    name: null,
    unknown_sender_policy: 'strict',
    created_at: timestamp,
  };
  await createMessagingGroup(groupA);
  await createMessagingGroup({ ...groupA, id: 'chat-b', platform_id: '456@g.us' });
  // gws-ea-chats owns this table; exercise the agreed native columns without importing
  // that module's routing or lifecycle registrations into privacy tests.
  await getDb().exec(`CREATE TABLE gws_ea_chats (
    messaging_group_id TEXT PRIMARY KEY REFERENCES messaging_groups(id),
    state TEXT NOT NULL, serving_agent_group_id TEXT
  )`);
  await getDb().run('INSERT INTO gws_ea_chats (messaging_group_id, state) VALUES (?, ?)', 'chat-a', 'connected');
  value = await addPrivateValue({ label: 'Landing', kind: 'other', value: LANDING });
  sent = [];
  guarded = setDeliveryAdapter({
    async deliver(_channel, platformId) {
      sent.push(platformId);
      return 'sent';
    },
  });
});

afterEach(async () => {
  await closeDb();
  await fs.rm(root, { force: true, recursive: true });
});

const send = (platformId: string, text = LANDING) =>
  guarded.deliver('whatsapp', platformId, null, 'chat', JSON.stringify({ text }));

describe('one-case chat clearances', () => {
  it('shares only in chat A now and later, including moving and job, while chat B stays refused', async () => {
    await principalMessage();
    expect(await privateValuesGivenAway(`Landing: ${LANDING}`)).toEqual([{ id: value.id, kind: 'other' }]);
    await recordChatClearances({ messagingGroupId: 'chat-a', principalMessageId: 'request-a', values: [value] });
    for (const state of ['connected', 'moving', 'job']) {
      await getDb().run('UPDATE gws_ea_chats SET state = ? WHERE messaging_group_id = ?', state, 'chat-a');
      await send('123@g.us');
      expect(await checkOutbound(LANDING, 'others', 'chat-a')).toEqual({ allowed: true });
      await expect(send('456@g.us')).rejects.toBeInstanceOf(OutboundRefusedError);
    }
    expect(sent).toEqual(['123@g.us', '123@g.us', '123@g.us']);
    expect(await checkOutbound(LANDING, 'others')).toMatchObject({ allowed: false });
    // Pruning the day-old consent words does not revoke an admitted share.
    await getDb().run('DELETE FROM gws_ea_principal_messages');
    await send('123@g.us');
  });

  it('allows only the exact recorded value reference and still checks every other value and reading', async () => {
    const home = await addPrivateValue({ label: 'Home', kind: 'address', value: '123 Main Street, Springfield' });
    await principalMessage();
    await expect(
      recordChatClearances({
        messagingGroupId: 'chat-a',
        principalMessageId: 'request-a',
        values: [{ id: value.id, kind: 'phone' }],
      }),
    ).rejects.toThrow('value');
    await recordChatClearances({
      messagingGroupId: 'chat-a',
      principalMessageId: 'request-a',
      values: [{ id: value.id, kind: value.kind }],
    });
    await expect(send('123@g.us', `${LANDING}, ${home.value}`)).rejects.toBeInstanceOf(OutboundRefusedError);
    expect(await privateValuesGivenAway(['123 Main', ' Street, Springfield'])).toEqual([
      { id: home.id, kind: 'address' },
    ]);
    expect(await privateValuesGivenAway(`[where](https://example.test/${encodeURIComponent(home.value)})`)).toEqual([
      { id: home.id, kind: 'address' },
    ]);
  });

  it.each([
    ['another member’s claim', 'member-request', false, 'whatsapp:member'],
    ['a forward from the principal', 'forwarded-request', true, PRINCIPAL],
  ])('cannot record a clearance from %s', async (_label, id, forwarded, userId) => {
    await principalMessage(id, groupA, forwarded, userId);
    await expect(
      recordChatClearances({ messagingGroupId: 'chat-a', principalMessageId: id, values: [value] }),
    ).rejects.toThrow('principal');
    await expect(send('123@g.us')).rejects.toBeInstanceOf(OutboundRefusedError);
    expect(await getDb().all('SELECT * FROM gws_ea_chat_clearances')).toEqual([]);
  });

  it('cannot cite a principal request from another chat', async () => {
    await principalMessage();
    await getDb().run('INSERT INTO gws_ea_chats (messaging_group_id, state) VALUES (?, ?)', 'chat-b', 'connected');
    await expect(
      recordChatClearances({ messagingGroupId: 'chat-b', principalMessageId: 'request-a', values: [value] }),
    ).rejects.toThrow('principal');
  });

  it('deletes clearances in the same detach transaction and does not revive them on reconnect', async () => {
    await principalMessage();
    await recordChatClearances({ messagingGroupId: 'chat-a', principalMessageId: 'request-a', values: [value] });
    await expect(
      getDb().transaction(async () => {
        await deleteChatClearances('chat-a', getDb());
        await getDb().run('UPDATE gws_ea_chats SET state = ? WHERE messaging_group_id = ?', 'detached', 'chat-a');
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    await send('123@g.us');
    await getDb().transaction(async () => {
      await deleteChatClearances('chat-a', getDb());
      await getDb().run('UPDATE gws_ea_chats SET state = ? WHERE messaging_group_id = ?', 'detached', 'chat-a');
    });
    await getDb().run('UPDATE gws_ea_chats SET state = ? WHERE messaging_group_id = ?', 'connected', 'chat-a');
    await expect(send('123@g.us')).rejects.toBeInstanceOf(OutboundRefusedError);
    expect(await getDb().all('SELECT * FROM gws_ea_chat_clearances')).toEqual([]);
  });

  it('fails closed for an inactive chat and never borrows a sibling adapter instance', async () => {
    await principalMessage();
    await recordChatClearances({ messagingGroupId: 'chat-a', principalMessageId: 'request-a', values: [value] });
    await expect(
      guarded.deliver(
        'whatsapp',
        '123@g.us',
        null,
        'chat',
        JSON.stringify({ text: LANDING }),
        undefined,
        'other-instance',
      ),
    ).rejects.toBeInstanceOf(OutboundRefusedError);
    await getDb().run('UPDATE gws_ea_chats SET state = ? WHERE messaging_group_id = ?', 'detached', 'chat-a');
    await expect(send('123@g.us')).rejects.toBeInstanceOf(OutboundRefusedError);
    await expect(
      recordChatClearances({ messagingGroupId: 'chat-a', principalMessageId: 'request-a', values: [value] }),
    ).rejects.toThrow('chat');
  });

  it('grants nothing without the optional chats table', async () => {
    await getDb().exec('DROP TABLE gws_ea_chats');
    await expect(send('123@g.us')).rejects.toBeInstanceOf(OutboundRefusedError);
  });
});
