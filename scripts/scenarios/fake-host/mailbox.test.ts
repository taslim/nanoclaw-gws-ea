import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createOutboundRecord,
  parseOutboundWrite,
} from '../../../container/agent-runner/src/mailbox/model.generated.js';
import type { Destination } from '../../../container/agent-runner/src/mailbox/types.js';
import { selectCases } from '../cases/index.js';
import type { ScenarioComposition } from '../types.js';
import { initialFixture, writeState } from './state.js';
import { FixtureMailbox } from './mailbox.js';

const transport = vi.hoisted(() => ({ call: vi.fn(), effect: vi.fn() }));
vi.mock('./state.js', async (original) => ({
  ...(await original<typeof import('./state.js')>()),
  callHost: transport.call,
  recordEffect: transport.effect,
}));

let root: string;
let file: string;
const origin: Destination = {
  name: 'this-chat',
  displayName: 'this-chat',
  type: 'channel',
  channelType: 'gchat',
  platformId: 'synthetic-morgan-dm',
  agentGroupId: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-mailbox-routes-'));
  file = path.join(root, 'fixture.json');
  writeState(file, initialFixture(selectCases(['search-before-asking'])[0]!));
  const composition: ScenarioComposition = {
    audience: 'main',
    group: { id: 'main', name: 'main', folder: 'main' },
    capabilities: [],
    storedCapabilities: [],
    skills: [],
    moduleEnvironment: {},
    reservedEnvironmentKeys: [],
    session: { id: 'native-main', messagingGroupId: 'synthetic-morgan-dm' },
    destinations: [origin],
    routing: { channelType: 'gchat', platformId: 'synthetic-morgan-dm', threadId: null },
    db: 'sqlite',
  };
  fs.writeFileSync(path.join(root, 'composition.json'), JSON.stringify(composition));
  transport.call.mockImplementation(async (_file: string, method: string, args: Record<string, unknown>) => {
    if (method === 'outbound') return createOutboundRecord(parseOutboundWrite(args.draft), 1, new Date().toISOString());
    if (method === 'deliver') return { receipt: { status: 'delivered' } };
    throw new Error(`Unexpected fixture transport: ${method}`);
  });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it('uses the projected native destination names without granting phantom outward or agent routes', () => {
  const mailbox = new FixtureMailbox(file);
  expect(mailbox.getDestinations()).toEqual([origin]);
  expect(mailbox.findDestinationByName('principal')).toBeUndefined();
  expect(mailbox.findDestinationByName('outward')).toBeUndefined();
  expect(mailbox.findDestinationByName('external-email')).toBeUndefined();
  expect(mailbox.getSessionRouting()).toEqual({
    channelType: 'gchat',
    platformId: 'synthetic-morgan-dm',
    threadId: null,
  });
});

it('refuses an ungranted outward send before recording it in the fixture outbox', async () => {
  await expect(
    new FixtureMailbox(file).writeMessageOut({
      id: 'denied',
      kind: 'chat',
      channelType: 'email',
      platformId: 'synthetic-juno-thread',
      content: JSON.stringify({ type: 'text', text: 'Private itinerary' }),
    }),
  ).rejects.toThrow(/destination/u);
  expect(transport.call).not.toHaveBeenCalled();
  expect(transport.effect).not.toHaveBeenCalled();
});

it('retains a native email origin name and thread instead of inventing its routing', () => {
  const compositionFile = path.join(root, 'composition.json');
  const composition = JSON.parse(fs.readFileSync(compositionFile, 'utf8')) as ScenarioComposition;
  const routing = { channelType: 'email', platformId: 'email:inbox', threadId: 'mail-native-invite' };
  fs.writeFileSync(
    compositionFile,
    JSON.stringify({
      ...composition,
      destinations: [{ ...origin, name: 'inbox', channelType: 'email', platformId: 'email:inbox' }],
      routing,
    }),
  );
  const mailbox = new FixtureMailbox(file);
  expect(mailbox.getSessionRouting()).toEqual(routing);
  expect(mailbox.getLatestInboundRoute('email', 'email:inbox')).toEqual({
    threadId: 'mail-native-invite',
    inReplyTo: 'synthetic-input',
  });
  expect(mailbox.getLatestInboundRoute('gchat', 'synthetic-morgan-dm')).toBeNull();
  expect(mailbox.findDestinationByName('inbox')?.platformId).toBe('email:inbox');
});

it('requires native delivery for an allowed chat rather than crediting a local message effect', async () => {
  const sequence = await new FixtureMailbox(file).writeMessageOut({
    id: 'allowed',
    kind: 'chat',
    channelType: 'gchat',
    platformId: 'synthetic-morgan-dm',
    content: JSON.stringify({ type: 'text', text: 'Your day is ready.' }),
  });
  expect(sequence).toBe(1);
  expect(transport.call.mock.calls.map((call) => call[1])).toEqual(['outbound', 'deliver']);
  expect(transport.effect).not.toHaveBeenCalled();
});
