import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from './schema.js';
import { wrapSqliteInbound, wrapSqliteOutbound } from './index.js';

it('reads stable full inbound identities and settles only copied holds while preserving release deadlines', async () => {
  const raw = new Database(':memory:');
  raw.exec(INBOUND_SCHEMA);
  const mailbox = wrapSqliteInbound(raw);
  try {
    for (const id of ['copied', 'waiting'])
      await mailbox.insertMessage({
        id,
        kind: 'chat',
        timestamp: '2026-10-15T12:00:00.000Z',
        status: 'held',
        channelType: 'whatsapp',
        platformId: 'trip',
        threadId: null,
        content: '{"text":"Keep the source identity"}',
        processAfter: '2999-01-01T00:00:00.000Z',
        recurrence: null,
        trigger: false,
        sourceSessionId: 'source',
        onWake: true,
      });
    expect(mailbox.getInboundRecords({ since: '2026-10-15T00:00:00.000Z', status: 'held' })).toMatchObject([
      {
        id: 'copied',
        status: 'held',
        trigger: false,
        sourceSessionId: 'source',
        onWake: true,
        processAfter: '2999-01-01T00:00:00.000Z',
      },
      { id: 'waiting', status: 'held' },
    ]);
    expect(mailbox.getInboundRecords({ since: '2026-10-16T00:00:00.000Z' })).toEqual([]);
    raw.prepare("UPDATE messages_in SET timestamp='2026-10-15 12:00:00.000' WHERE id='waiting'").run();
    expect(mailbox.getInboundRecords({ since: '2026-10-15T12:00:00.000Z' })).toHaveLength(2);
    expect(mailbox.getInboundRecords({ since: '2026-10-15T12:00:00.001Z' })).toEqual([]);
    expect(mailbox.settleUnreadMessages(['copied'])).toBe(1);
    expect(mailbox.releaseHeldMessages(null, { preserveTriggers: true, preserveProcessAfter: true })).toBe(1);
    expect(mailbox.getInboundRecords({ status: 'pending' })).toMatchObject([
      { id: 'waiting', trigger: false, processAfter: '2999-01-01T00:00:00.000Z' },
    ]);
    expect(mailbox.getInboundRecords({ status: 'completed' })).toMatchObject([{ id: 'copied' }]);
    expect(mailbox.settleUnreadMessages(['waiting'])).toBe(1);
    expect(mailbox.settleUnreadMessages(['waiting', 'copied'])).toBe(0);
  } finally {
    raw.close();
  }
});

it('reads assistant conversation source IDs and distinguishes successful delivery from failed settlement', async () => {
  const raw = new Database(':memory:');
  raw.exec(OUTBOUND_SCHEMA);
  raw.exec(INBOUND_SCHEMA);
  const mailbox = wrapSqliteOutbound(raw);
  const inbound = wrapSqliteInbound(raw);
  try {
    for (const id of ['delivered', 'pending', 'failed'])
      await mailbox.writeDirect({
        id,
        kind: 'chat',
        channelType: 'whatsapp',
        platformId: 'trip',
        threadId: null,
        content: '{"text":"Yes"}',
      });
    inbound.markDelivered('delivered', 'platform-id');
    inbound.markDeliveryFailed('failed');
    expect(mailbox.getOutboundRecords('2020-01-01T00:00:00.000Z').map((row) => row.id)).toEqual([
      'delivered',
      'pending',
      'failed',
    ]);
    expect(inbound.getDeliveredIds('delivered')).toEqual(new Set(['delivered']));
    expect(inbound.getDeliveredIds()).toEqual(new Set(['delivered', 'failed']));
    expect(mailbox.getOutboundRecords('2999-01-01T00:00:00.000Z')).toEqual([]);
    for (const [id, timestamp] of [
      ['delivered', '2026-10-15T12:00:00.100Z'],
      ['pending', '2026-10-15 12:00:00.200'],
      ['failed', '2026-10-15T12:00:00.300Z'],
    ] as const)
      raw.prepare('UPDATE messages_out SET timestamp=? WHERE id=?').run(timestamp, id);
    expect(mailbox.getOutboundRecords('2026-10-15T12:00:00.200Z').map((row) => row.id)).toEqual(['pending', 'failed']);
  } finally {
    raw.close();
  }
});
