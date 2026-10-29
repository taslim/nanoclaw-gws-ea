import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FixtureMailbox } from './mailbox.js';
import { callHost } from './state.js';
import { prepareSyntheticShell } from './sandbox.js';
import { registerAgentMailbox } from '../../../container/agent-runner/src/mailbox/index.js';
import { applyPreTaskScripts } from '../../../container/agent-runner/src/scheduling/task-script.js';
import { extractRouting, formatMessages } from '../../../container/agent-runner/src/formatter.js';
import { processQuery } from '../../../container/agent-runner/src/poll-loop.js';
import type { MessageInRow } from '../../../container/agent-runner/src/db/messages-in.js';
import type { ProviderEvent } from '../../../container/agent-runner/src/providers/types.js';
import type { ScenarioComposition } from '../types.js';

const [file, tree] = process.argv.slice(2);
if (!file || !tree) throw new Error('close-process-check <fixture> <tree>');
const directory = path.dirname(file);
const composition = JSON.parse(
  fs.readFileSync(path.join(directory, 'composition.json'), 'utf8'),
) as ScenarioComposition;
const close = composition.close;
assert.ok(close);
const shell = prepareSyntheticShell(directory, tree);
process.env.SCENARIO_PHASE = 'close-script-proof';
process.env.PATH = `${shell.bin}:${process.env.PATH ?? ''}`;
registerAgentMailbox(() => new FixtureMailbox(file));
const task = close.task;
const message: MessageInRow = {
  id: task.id,
  seq: task.sequence,
  kind: 'task',
  timestamp: task.timestamp,
  status: 'pending',
  process_after: task.processAfter,
  recurrence: task.recurrence,
  series_id: task.seriesId,
  tries: task.tries,
  trigger: 1,
  platform_id: null,
  channel_type: null,
  thread_id: null,
  content: task.content,
  source_session_id: null,
  on_wake: 0,
};
const scripts = await applyPreTaskScripts([message]);
assert.deepEqual(scripts.skipped, []);
const routing = extractRouting(scripts.keep);
assert.equal(routing.taskRun, false);
assert.equal(routing.tasksOnly, true);
assert.equal(routing.channelType, null);
const formatted = formatMessages(scripts.keep);
assert.ok(formatted.includes(close.runId));
assert.ok(formatted.includes('The evening close.'));
async function* events(): AsyncGenerator<ProviderEvent> {
  yield { type: 'result', text: null };
}
const result = await processQuery(
  {
    events: events(),
    push: () => assert.fail('An empty conversational close response needs no delivery nudge.'),
    end() {},
    abort() {},
  },
  routing,
  [task.id],
  'claude',
  undefined,
  formatted,
  undefined,
  true,
);
const snapshot = (await callHost(file, 'snapshot')) as {
  closeRuns: { id: string; state: string; ledger_through_at: string | null }[];
};
assert.equal(
  snapshot.closeRuns.find((row) => row.id === close.runId),
  undefined,
  'The actual pre-task script probe is rolled back before behavioral measurement; processQuery does not complete a close.',
);
fs.writeFileSync(
  path.join(directory, 'preflight-close-process.json'),
  JSON.stringify(
    {
      modelCalls: 0,
      actualNativeScript: true,
      scripts,
      formatted,
      routing,
      processQuery: result,
      completionStillRequiresDone: true,
    },
    null,
    2,
  ),
);
