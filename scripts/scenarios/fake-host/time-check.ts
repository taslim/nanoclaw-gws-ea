import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTimeTools } from '../../../container/agent-runner/src/mcp-tools/time.js';

const directory = process.argv[2];
if (!directory) throw new Error('The synthetic evidence directory is required.');
const convert = createTimeTools('America/Los_Angeles').find((tool) => tool.tool.name === 'time_convert');
assert.ok(convert);
const converted = await convert.handler({
  time: '2026-11-03T17:00:00+00:00',
  from: 'Europe/London',
  to: ['Europe/London', 'America/Los_Angeles'],
});
assert.ok(!converted.isError);
assert.ok(JSON.stringify(converted).includes('2026-11-03T09:00:00-08:00'));
fs.writeFileSync(
  path.join(directory, 'preflight-time.json'),
  JSON.stringify({ nativeTimeResult: converted, modelCalls: 0 }, null, 2),
);
