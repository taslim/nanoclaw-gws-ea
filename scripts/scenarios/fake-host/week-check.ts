import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ScenarioComposition } from '../types.js';
import { parseClockTimeline } from '../../../container/agent-runner/src/week-view/clock.js';

const [directory, tree] = process.argv.slice(2);
if (!directory || !tree) throw new Error('week-check <synthetic directory> <tree>');
const composition = JSON.parse(
  fs.readFileSync(path.join(directory, 'composition.json'), 'utf8'),
) as ScenarioComposition;
assert.ok(composition.weekViewFile);
const view = JSON.parse(fs.readFileSync(composition.weekViewFile, 'utf8')) as {
  schema: number;
  asOf: string;
  text: string;
  manual: string;
  timeline: unknown;
};
assert.equal(view.schema, 1);
assert.ok(parseClockTimeline(view.timeline));
assert.ok(Date.now() - Date.parse(view.asOf) < 60_000);
const receipts = path.join(directory, 'preflight-week-delivered');
const invoke = (event: Readonly<Record<string, string>>) => {
  const result = spawnSync(
    'bun',
    [path.join(tree, 'container/agent-runner/src/week-view/hook.ts'), composition.weekViewFile!, receipts],
    {
      input: JSON.stringify({ session_id: 'synthetic-hook-session', ...event }),
      encoding: 'utf8',
      env: { ...process.env, TZ: 'America/Los_Angeles' },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
const startup = invoke({ hook_event_name: 'SessionStart', source: 'startup' });
assert.ok(startup.includes('Coming days (as of'));
assert.ok(startup.includes(view.text));
assert.ok(startup.includes(view.manual));
const resume = invoke({ hook_event_name: 'SessionStart', source: 'resume' });
assert.equal(resume, '');
const submission = invoke({ hook_event_name: 'UserPromptSubmit' });
assert.ok(submission.startsWith('Now: '));
assert.ok(!submission.includes('Current Principal Manual'));
fs.writeFileSync(
  path.join(directory, 'preflight-week-hook.json'),
  JSON.stringify(
    {
      command: [
        'bun',
        path.join(tree, 'container/agent-runner/src/week-view/hook.ts'),
        composition.weekViewFile,
        receipts,
      ],
      startup,
      resume,
      submission,
      modelCalls: 0,
    },
    null,
    2,
  ),
);
