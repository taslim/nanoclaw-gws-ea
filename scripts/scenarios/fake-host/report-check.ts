import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FixtureMailbox } from './mailbox.js';
import { readState, writeState } from './state.js';
import { registerAgentMailbox } from '../../../container/agent-runner/src/mailbox/index.js';
import { processQuery } from '../../../container/agent-runner/src/poll-loop.js';
import type { ProviderEvent } from '../../../container/agent-runner/src/providers/types.js';

const file = process.argv[2];
if (!file) throw new Error('An observation fixture is required.');
const before = readState(file);
assert.ok(before.scenario.observationOnly);
const mailbox = new FixtureMailbox(file);
registerAgentMailbox(() => mailbox);
const report = 'Synthetic internal preflight report JUNO-CEDAR-27.';
async function* events(): AsyncGenerator<ProviderEvent> {
  yield { type: 'text', text: report };
  yield { type: 'result', text: report };
}
try {
  await processQuery(
    {
      events: events(),
      push: () => assert.fail('Internal task prose must not trigger a send nudge'),
      end: () => {},
      abort: () => {},
    },
    { ...mailbox.getSessionRouting(), inReplyTo: 'synthetic-preflight', taskRun: true },
    ['synthetic-preflight'],
    'claude',
    undefined,
    'Synthetic task-delivery contract proof; no model is called.',
    undefined,
    true,
  );
  const after = readState(file);
  const added = after.outbound.slice(before.outbound.length);
  assert.equal(added.length, 1);
  assert.equal(added[0]?.kind, 'task_log');
  assert.equal(JSON.parse(String(added[0]?.content)).text, report);
  assert.deepEqual(after.effects, before.effects);
  fs.writeFileSync(
    path.join(path.dirname(file), 'preflight-internal-report.json'),
    JSON.stringify(
      {
        productionProcessQuery: true,
        nativeOutboundKind: added[0]?.kind,
        outwardEffects: 0,
        modelCalls: 0,
      },
      null,
      2,
    ),
  );
} finally {
  const state = readState(file);
  state.outbound = before.outbound;
  writeState(file, state);
}
