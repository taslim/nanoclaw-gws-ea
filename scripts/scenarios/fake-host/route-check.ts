import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FixtureMailbox } from './mailbox.js';
import { registerAgentMailbox } from '../../../container/agent-runner/src/mailbox/index.js';
import { setCurrentReplyRoute, clearCurrentReplyRoute } from '../../../container/agent-runner/src/db/session-state.js';

const file = process.argv[2];
if (!file) throw new Error('A synthetic fixture is required.');
registerAgentMailbox(() => new FixtureMailbox(file));
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
console.log('Native initial reply stamp is shared with the separate MCP process.');
