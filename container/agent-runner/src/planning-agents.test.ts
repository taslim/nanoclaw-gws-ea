import { afterEach, beforeEach, expect, it } from 'bun:test';
import type { PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPlanningRuntime } from './planning-agents.js';

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-argv-'));
  fs.writeFileSync(path.join(directory, 'ncl'), '#!/bin/sh\nprintf \'%s\\0\' "$@"\n', { mode: 0o700 });
});
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

it('passes literal Manual arguments to the shell unchanged, including single-quoted newlines and non-escaping backslashes', async () => {
  const runtime = createPlanningRuntime(directory);
  const base = {
    session_id: 'planning',
    transcript_path: '/tmp/planning',
    cwd: directory,
    agent_id: 'agent-1',
    agent_type: 'look-back',
  };
  await runtime.start({ ...base, hook_event_name: 'SubagentStart' }, undefined, {
    signal: new AbortController().signal,
  });
  for (const [command, text] of [
    ["ncl manual set --section principles --text 'First line\nSecond line'", 'First line\nSecond line'],
    ["ncl manual set --section principles --text 'First line\r\nSecond line'", 'First line\r\nSecond line'],
    ['ncl manual set --section principles --text "Keep \\q literally"', 'Keep \\q literally'],
    ["ncl manual set --section principles --text 'Morgan'\\''s mornings'", "Morgan's mornings"],
    ["ncl manual set --section principles --text '$HOME is literal'", '$HOME is literal'],
  ]) {
    const input: PreToolUseHookInput = {
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      tool_use_id: 'tool-1',
    };
    const decision = runtime.preToolUse(input)?.hookSpecificOutput;
    if (decision?.hookEventName !== 'PreToolUse' || typeof decision.updatedInput?.command !== 'string')
      throw new Error(`The literal ncl command was refused: ${command}`);
    const child = Bun.spawn(['/bin/sh', '-c', decision.updatedInput.command], {
      env: { PATH: directory },
      stdout: 'pipe',
    });
    expect(await new Response(child.stdout).text()).toBe(
      ['manual', 'set', '--section', 'principles', '--text', text, ''].join('\0'),
    );
    expect(await child.exited).toBe(0);
  }
});
