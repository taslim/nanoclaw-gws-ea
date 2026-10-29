import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { FixtureMailbox } from './mailbox.js';
import { callHost, readState } from './state.js';
import type { ScenarioComposition } from '../types.js';
import { registerAgentMailbox } from '../../../container/agent-runner/src/mailbox/index.js';
import { setCurrentReplyRoute, clearCurrentReplyRoute } from '../../../container/agent-runner/src/db/session-state.js';

const file = process.argv[2];
if (!file) throw new Error('A synthetic fixture is required.');
registerAgentMailbox(() => new FixtureMailbox(file));
const mailbox = new FixtureMailbox(file);
const native = (await callHost(file, 'route-projection', { phase: 'preflight' })) as Pick<
  ScenarioComposition,
  'destinations' | 'routing'
>;
assert.deepEqual(mailbox.getDestinations(), native.destinations);
assert.deepEqual(mailbox.getSessionRouting(), native.routing);
assert.equal(mailbox.findDestinationByName('outward'), undefined);
assert.equal(mailbox.findDestinationByName('external-email'), undefined);
const before = readState(file);
await assert.rejects(
  mailbox.writeMessageOut({
    id: 'preflight-denied-destination',
    kind: 'chat',
    channelType: 'email',
    platformId: 'synthetic-juno-thread',
    content: JSON.stringify({ type: 'text', text: 'Invented private route proof' }),
  }),
  /destination|observes an internal report/u,
);
assert.deepEqual(readState(file).effects, before.effects);
assert.deepEqual(readState(file).outbound, before.outbound);
const stamp = {
  inReplyTo: 'synthetic-input',
  channelType: 'gchat',
  platformId: 'synthetic-morgan-dm',
  threadId: null,
  batch: ['synthetic-input'],
};
setCurrentReplyRoute(stamp);
const source = `import {FixtureMailbox} from ${JSON.stringify(path.join(import.meta.dir, 'mailbox.ts'))}; const mailbox = new FixtureMailbox(${JSON.stringify(file)}); console.log(mailbox.getState('current_reply_route')?.value);`;
const otherProcess = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8' });
assert.equal(otherProcess.status, 0, otherProcess.stderr);
assert.deepEqual(JSON.parse(otherProcess.stdout.trim()), stamp);
clearCurrentReplyRoute();
assert.equal(new FixtureMailbox(file).getState('current_reply_route'), undefined);
fs.writeFileSync(
  path.join(path.dirname(file), 'preflight-native-routes.json'),
  JSON.stringify({ modelCalls: 0, native, phantomDestinationRefused: true, noSendOrOutboxCredit: true }, null, 2),
);
console.log('Native initial reply stamp is shared with the separate MCP process.');
