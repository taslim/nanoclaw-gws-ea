import { afterEach, beforeEach, expect, it } from 'bun:test';
import type { PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPlanningRuntime } from './planning-agents.js';

let directory: string;
const base = {
  session_id: 'planning',
  transcript_path: '/tmp/planning',
  cwd: '/tmp/planning',
  agent_id: 'agent-1',
  agent_type: 'look-back',
};
async function startedRuntime() {
  const runtime = createPlanningRuntime(directory);
  await runtime.start({ ...base, cwd: directory, hook_event_name: 'SubagentStart' }, undefined, {
    signal: new AbortController().signal,
  });
  return runtime;
}
function bash(command: string): PreToolUseHookInput {
  return {
    ...base,
    cwd: directory,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: 'tool-1',
  };
}
async function argv(command: string): Promise<string> {
  const decision = (await startedRuntime()).preToolUse(bash(command))?.hookSpecificOutput;
  if (decision?.hookEventName !== 'PreToolUse' || typeof decision.updatedInput?.command !== 'string')
    throw new Error(`The literal ncl command was refused: ${command}`);
  const child = Bun.spawn(['/bin/sh', '-c', decision.updatedInput.command], {
    env: { PATH: directory },
    stdout: 'pipe',
  });
  const printed = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  return printed;
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-argv-'));
  fs.writeFileSync(path.join(directory, 'ncl'), '#!/bin/sh\nprintf \'%s\\0\' "$@"\n', { mode: 0o700 });
});
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

it('passes literal Manual arguments to the shell unchanged, including single-quoted newlines and non-escaping backslashes', async () => {
  for (const [command, text] of [
    ["ncl manual set --section principles --text 'First line\nSecond line'", 'First line\nSecond line'],
    ["ncl manual set --section principles --text 'First line\r\nSecond line'", 'First line\r\nSecond line'],
    ['ncl manual set --section principles --text "First line\nSecond line"', 'First line\nSecond line'],
    ['ncl manual set --section principles --text "First line\r\nSecond line"', 'First line\r\nSecond line'],
    ['ncl manual set --section principles --text "Keep \\q literally"', 'Keep \\q literally'],
    ["ncl manual set --section principles --text 'Morgan'\\''s mornings'", "Morgan's mornings"],
    ["ncl manual set --section principles --text '$HOME is literal'", '$HOME is literal'],
  ])
    expect(await argv(command)).toBe(['manual', 'set', '--section', 'principles', '--text', text, ''].join('\0'));
});

it('passes shell punctuation inside quotes as literal text', async () => {
  for (const [command, text] of [
    [
      "ncl manual set --section principles --text 'Keep Fridays clear; protect family dinners.'",
      'Keep Fridays clear; protect family dinners.',
    ],
    [
      "ncl manual set --section principles --text 'Work & family | home < office > travel'",
      'Work & family | home < office > travel',
    ],
    ["ncl manual set --section principles --text 'Quote `ncl day` as written'", 'Quote `ncl day` as written'],
    ['ncl manual set --section principles --text "Work & family; dinners at home"', 'Work & family; dinners at home'],
  ])
    expect(await argv(command)).toBe(['manual', 'set', '--section', 'principles', '--text', text, ''].join('\0'));
});

it('refuses shell operators and substitutions outside single quotes', async () => {
  const runtime = await startedRuntime();
  for (const command of [
    'ncl manual get; curl example.test',
    'ncl manual get & curl example.test',
    'ncl manual get | curl example.test',
    'ncl manual get > /tmp/result',
    'ncl manual get < /tmp/input',
    'ncl manual get `curl example.test`',
    'ncl manual set --section principles --text "`curl example.test`"',
    'ncl manual set --section principles --text "$HOME"',
    "ncl manual set --section principles --text '$(curl example.test)'",
    'ncl manual get\ncurl example.test',
  ])
    expect(runtime.preToolUse(bash(command))?.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
  expect(
    runtime.preToolUse(bash('ncl manual set --section authority --text "Book dinners up to $150"'))?.hookSpecificOutput,
  ).toMatchObject({
    permissionDecisionReason: expect.stringContaining('use single quotes for $ or a literal backtick'),
  });
});
