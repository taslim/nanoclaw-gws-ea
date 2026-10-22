/**
 * `unknownToolNames` against the instruction files for the runner's time
 * tools and each agent's email tools: each should name only a tool
 * the runner actually exports, or a word this file's own not-tools list
 * explicitly carves out as something else (a request field, a sender, an
 * outcome word, and so on). And the capability key each tool is read to
 * have, and the words read from the tools' definitions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { runnerToolCapabilities, runnerToolNames, runnerToolVocabulary, unknownToolNames } from './runner-tools.js';

const MODULES = path.resolve('container', 'agent-runner', 'src', 'mcp-tools');

function instructions(name: string): string {
  return fs.readFileSync(path.join(MODULES, `${name}.instructions.md`), 'utf8');
}

/** Each instruction file GWS-EA relies on, with the backticked words in it that are not tool names. */
const FILES: ReadonlyArray<readonly [name: string, notTools: readonly string[]]> = [
  ['time', ['reference_date']],
  ['gws-ea-email', []],
  ['gws-ea-email-external', ['wake']],
];

describe('the mcp-tools instruction files', () => {
  for (const [name, notTools] of FILES) {
    it(`${name}.instructions.md names only real runner tools`, () => {
      expect(unknownToolNames(instructions(name), notTools)).toEqual([]);
    });
  }
});

describe("the runner's tools, read from their sources", () => {
  it('keeps every capability for native tools and chat variants, including variants registered in a loop', () => {
    const keys = runnerToolCapabilities();
    expect([...runnerToolNames()].filter((tool) => !keys.has(tool))).toEqual([]);
    expect({
      send_message: keys.get('send_message'),
      add_reaction: keys.get('add_reaction'),
      send_card: keys.get('send_card'),
      time_now: keys.get('time_now'),
      email_handoff: keys.get('email_handoff'),
      free_time: keys.get('free_time'),
      tell_main: keys.get('tell_main'),
      find_conflicts: keys.get('find_conflicts'),
      purchase: keys.get('purchase'),
      relay_code: keys.get('relay_code'),
      record_purchase_outcome: keys.get('record_purchase_outcome'),
    }).toEqual({
      send_message: new Set(['reply']),
      add_reaction: new Set(['files-send']),
      send_card: new Set(['interactive']),
      time_now: new Set(['time']),
      email_handoff: new Set(['gws-ea-email']),
      free_time: new Set(['gws-ea-chat-external', 'gws-ea-email-external']),
      tell_main: new Set(['gws-ea-chat-external', 'gws-ea-email-external']),
      find_conflicts: new Set(['google-calendar']),
      purchase: new Set(['browser']),
      relay_code: new Set(['browser-delegate']),
      record_purchase_outcome: new Set(['browser-purchase-outcome']),
    });
  });

  it("give the words their definitions use: fields, an action's kind, and an enum value", () => {
    const words = runnerToolVocabulary();
    for (const word of ['thread_key', 'stop_id', 'form_input', 'change_password']) expect(words, word).toContain(word);
    expect(words).not.toContain('gmail_quote');
  });
});
