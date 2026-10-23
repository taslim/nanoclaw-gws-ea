import fs from 'node:fs';
import Database from 'better-sqlite3';
import { expect, vi } from 'vitest';
import type { ChannelAdapter } from '../../../channels/adapter.js';
import {
  registerChannelAdapter,
  initChannelAdapters,
  teardownChannelAdapters,
  createChannelDeliveryAdapter,
} from '../../../channels/channel-registry.js';
import { closeDb, getDb } from '../../../db/connection.js';
import { setDeliveryAdapter, getDeliveryAction } from '../../../delivery.js';
import type { ResponseFrame } from '../../../cli/frame.js';
import { inboundDbPath } from '../../../mailbox/sqlite/paths.js';
import type { Session } from '../../../types.js';
import { seedContext } from './context-fixture.js';

export let members = [
  { key: 'whatsapp:22', name: 'Mira', isPrincipal: false },
  { key: 'whatsapp:11', name: 'Juno', isPrincipal: true },
];
export const deliveredU11 = vi.fn<ChannelAdapter['deliver']>(async () => undefined);
registerChannelAdapter('whatsapp', {
  factory: () => ({
    name: 'whatsapp',
    channelType: 'whatsapp',
    supportsThreads: false,
    setup: async () => {},
    teardown: async () => {},
    isConnected: () => true,
    deliver: deliveredU11,
    fetchGroupMembers: async (platformId: string) => ({ platformId, name: 'Trip', members }),
  }),
});
export function platformMembers(value: typeof members): void {
  members = value;
}
export async function seedU11() {
  members = [
    { key: 'whatsapp:22', name: 'Mira', isPrincipal: false },
    { key: 'whatsapp:11', name: 'Juno', isPrincipal: true },
  ];
  deliveredU11.mockClear();
  const seeded = await seedContext();
  await getDb().run(
    "UPDATE gws_ea_profile SET assistant_first_name = 'Robin', assistant_last_name = NULL, principal_timezone='UTC' WHERE singleton=1",
  );
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
  setDeliveryAdapter(createChannelDeliveryAdapter());
  return seeded;
}
export async function cleanU11(root: string): Promise<void> {
  await teardownChannelAdapters();
  await closeDb();
  fs.rmSync(root, { recursive: true, force: true });
}
let sequence = 0;
export async function sendU11(
  session: Session,
  action: string,
  fields: Record<string, unknown>,
  id = `u11-${++sequence}`,
): Promise<ResponseFrame> {
  const handler = getDeliveryAction(action);
  if (!handler) throw new Error(`${action} is not registered`);
  await handler({ ...fields, action, requestId: id }, session);
  const db = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  try {
    const rows = db.prepare('SELECT content FROM messages_in WHERE id=?').all(`action-resp-${id}`) as {
      content: string;
    }[];
    expect(rows).toHaveLength(1);
    return (JSON.parse(rows[0].content) as { frame: ResponseFrame }).frame;
  } finally {
    db.close();
  }
}
export function dataU11(frame: ResponseFrame): Record<string, unknown> {
  if (!frame.ok) throw new Error(frame.error.message);
  return frame.data as Record<string, unknown>;
}
export function refusalU11(frame: ResponseFrame): string {
  if (frame.ok) throw new Error(`Unexpected success: ${JSON.stringify(frame.data)}`);
  return frame.error.message;
}
