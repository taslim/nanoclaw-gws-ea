/**
 * `unknownToolNames` against the instruction files for the runner's
 * calendar-facts, schedule-stats, time and reminder tools, the meetings
 * pair, and each agent's email tools:
 * each should name only a tool the runner actually exports, or a word this
 * file's own not-tools list explicitly carves out as something else (a
 * request field, a sender, an outcome word, and so on).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { unknownToolNames } from './runner-tools.js';

const MODULES = path.resolve('container', 'agent-runner', 'src', 'mcp-tools');

function instructions(name: string): string {
  return fs.readFileSync(path.join(MODULES, `${name}.instructions.md`), 'utf8');
}

/** Each instruction file this branch touched, with the backticked words in it that are not tool names. */
const FILES: ReadonlyArray<readonly [name: string, notTools: readonly string[]]> = [
  ['gws-ea-meetings', ['meeting_kind', 'thread_key', 'people', 'answer']],
  [
    'gws-ea-meetings-external',
    ['system', 'to', 'cc', 'bcc', 'date', 'time', 'after', 'before', 'timezone', 'invitation', 'settled', 'done'],
  ],
  ['calendar-facts', ['from', 'to', 'start', 'end', 'candidate_ical_uid', 'assistant_address', 'people']],
  ['schedule-stats', ['from', 'to']],
  ['time', ['reference_date']],
  ['reminders', []],
  ['gws-ea-email', ['to', 'cc']],
  ['gws-ea-email-external', []],
];

describe('the mcp-tools instruction files', () => {
  for (const [name, notTools] of FILES) {
    it(`${name}.instructions.md names only real runner tools`, () => {
      expect(unknownToolNames(instructions(name), notTools)).toEqual([]);
    });
  }
});
