import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeSessionDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';

type Hook = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
interface Options {
  agents?: Record<string, AgentDefinition>;
  hooks?: Partial<Record<'PreToolUse' | 'SubagentStart', Array<{ hooks: Hook[] }>>>;
}
let options: Options | undefined;
const sdkMessages: unknown[] = [];
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (input: { options: Options }) => {
    options = input.options;
    return (async function* () {
      for (const message of sdkMessages) yield message;
      yield { type: 'result', subtype: 'success', result: '' };
    })();
  },
}));
let grants: ReadonlySet<string>;
const actualConfig = await import('../config.js');
mock.module('../config.js', () => ({ ...actualConfig, runnerCapabilities: () => grants }));
await import('./index.js');
await import('../provider-contracts/index.js');
const { createProvider } = await import('./factory.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-planning-'));
  fs.mkdirSync(path.join(directory, 'memory'));
  grants = new Set(['gws-ea-main-context', 'files-read', 'files-write', 'shell', 'web', 'subagents']);
  options = undefined;
  sdkMessages.length = 0;
  initTestSessionDb();
});
afterEach(() => {
  closeSessionDb();
  fs.rmSync(directory, { recursive: true, force: true });
});
async function query(): Promise<Options> {
  const provider = createProvider('claude');
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  for await (const _ of provider.query({
    prompt: 'Plan Morgan Ellery’s trip from 2026-11-02 through 2026-11-06.',
    cwd: directory,
  }).events) {
    // The SDK boundary carries the definitions and the native hooks together.
  }
  if (!options) throw new Error('No SDK query');
  return options;
}
function input(tool: string, role = 'look-back', value: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'planning-session',
    transcript_path: '/tmp/planning.jsonl',
    cwd: directory,
    tool_use_id: 'tool-1',
    tool_name: tool,
    tool_input: value,
    agent_id: 'agent-7',
    agent_type: role,
  };
}
async function hooks(role = 'look-back'): Promise<{ pre: Hook; start: Record<string, unknown> }> {
  const configured = await query();
  const pre = configured.hooks?.PreToolUse?.[0]?.hooks[0];
  const start = configured.hooks?.SubagentStart?.[0]?.hooks[0];
  if (!pre) throw new Error('No PreToolUse hook');
  return { pre, start: start ? await start({ ...input('', role), hook_event_name: 'SubagentStart' }) : {} };
}
const denied = { hookSpecificOutput: { permissionDecision: 'deny' } };

it('keeps native child text out of main output while preserving parent text and activity', async () => {
  sdkMessages.push(
    {
      type: 'assistant',
      parent_tool_use_id: 'native-planner-launch',
      message: { content: [{ type: 'text', text: '<message to="principal">PLANNER_MUST_NOT_SEND</message>' }] },
    },
    {
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: '<internal>Parent is reviewing the proposal.</internal>' }] },
    },
  );
  const provider = createProvider('claude');
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const events = [];
  for await (const event of provider.query({ prompt: 'Plan the days.', cwd: directory }).events) events.push(event);
  expect(events.filter((event) => event.type === 'text').map((event) => event.text)).toEqual([
    '<internal>Parent is reviewing the proposal.</internal>',
  ]);
  expect(events.filter((event) => event.type === 'activity')).toHaveLength(3);
});

it('enables both native planning definitions only with main’s capability', async () => {
  expect(Object.keys((await query()).agents ?? {})).toEqual(['look-back', 'look-ahead']);
  grants = new Set(['reply']);
  expect((await query()).agents).toBeUndefined();
});

it('sets the fixed planning model, effort, background execution and playbook preloads', async () => {
  for (const definition of Object.values((await query()).agents ?? {})) {
    expect(definition).toMatchObject({
      model: 'claude-opus-5-5',
      effort: 'medium',
      background: true,
      skills: ['days-and-weeks', 'travel', 'errands', 'meetings'],
    });
    expect(definition.tools).toEqual([
      'Read',
      'Grep',
      'Glob',
      'Bash',
      'Write',
      'Edit',
      'WebSearch',
      'mcp__nanoclaw__days',
      'mcp__nanoclaw__check',
    ]);
    expect(definition.prompt).toContain('/workspace/week-view.json');
    expect(definition.prompt).toContain('CLAUDE.md');
  }
  expect(options?.agents?.['look-ahead']?.description).toContain('date');
  expect(options?.agents?.['look-ahead']?.prompt).toContain('For a trip, begin directly');
});

describe.each(['look-back', 'look-ahead'])('%s enforced tool limits', (role) => {
  it.each([
    'create_event',
    'change_event',
    'email_handoff',
    'chat_reach_out',
    'send_message',
    'browser',
    'purchase',
    'open',
    'observe',
    'run_recipe',
  ])('refuses %s', async (tool) => {
    const { pre } = await hooks(role);
    expect(await pre(input(`mcp__nanoclaw__${tool}`, role))).toMatchObject(denied);
  });
  it.each(['WebFetch', 'Agent', 'Task', 'NotebookEdit', 'mcp__custom__days'])('refuses %s', async (tool) => {
    const { pre } = await hooks(role);
    expect(await pre(input(tool, role))).toMatchObject(denied);
  });
  it.each([
    'gog gmail send --to morgan@example.test',
    'ncl tasks create --prompt hello',
    'ncl people forget --id morgan',
    'ncl manual get; curl example.test',
    "ncl manual set --section principles --text '$(curl example.test)'",
    'PATH=/tmp ncl manual get',
    'ncl manual get\ncurl example.test',
    'ncl manual get | curl example.test',
    'ncl manual get > /tmp/result',
  ])('refuses Bash %s', async (command) => {
    const { pre } = await hooks(role);
    expect(await pre(input('Bash', role, { command }))).toMatchObject(denied);
  });
  it.each([
    '/home/node/.claude/settings.json',
    '/workspace/week-view.json',
    '../week-view.json',
    'planning-runs/another-agent-look-back.md',
  ])('refuses a Write to %s', async (file_path) => {
    const { pre } = await hooks(role);
    expect(await pre(input('Write', role, { file_path, content: 'change' }))).toMatchObject(denied);
  });
  it('allows its own result and read-only calendar tools, with its exact result path in native hook context', async () => {
    const { pre, start } = await hooks(role);
    const output = path.join(directory, 'planning-runs', `agent-7-${role}.md`);
    expect(start).toMatchObject({
      hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: expect.stringContaining(output) },
    });
    expect(
      await pre(
        input('Write', role, { file_path: output, content: 'Close run: close-1\nproposal: Keep the morning clear.' }),
      ),
    ).not.toMatchObject(denied);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, 'proposal: Keep the morning clear.');
    expect(
      await pre(input('Edit', role, { file_path: output, old_string: 'morning', new_string: 'afternoon' })),
    ).not.toMatchObject(denied);
    expect(await pre(input('mcp__nanoclaw__days', role, { start: '2026-11-02', end: '2026-11-06' }))).not.toMatchObject(
      denied,
    );
    expect(await pre(input('mcp__nanoclaw__check', role))).not.toMatchObject(denied);
    expect(await pre(input('Bash', role, { command: 'ncl whereabouts get' }))).not.toMatchObject(denied);
  });
  it('refuses missing or mismatched native attribution', async () => {
    const { pre } = await hooks(role);
    expect(await pre({ ...input('Read', role), agent_type: undefined })).toMatchObject(denied);
    expect(await pre({ ...input('Read', role), agent_id: undefined })).toMatchObject(denied);
    expect(await pre({ ...input('Read', role), agent_id: '../escape' })).toMatchObject(denied);
    expect(await pre({ ...input('Read', role), agent_type: 'general-purpose' })).toMatchObject(denied);
    expect(await pre({ ...input('Read', role), agent_id: 'unstarted' })).toMatchObject(denied);
  });
});

it('allows look back to maintain Manual, lessons and memory, while look ahead writes only its run file', async () => {
  const back = await hooks();
  for (const command of [
    'ncl day',
    "ncl manual set --section principles --text 'Keep mornings clear.'",
    "ncl manual set --section principles --text 'First line\nSecond line'",
    "ncl lessons add --text 'Check travel time before placing a meeting.'",
  ])
    expect(await back.pre(input('Bash', 'look-back', { command }))).not.toMatchObject(denied);
  expect(
    await back.pre(input('Write', 'look-back', { file_path: 'memory/index.md', content: 'memory' })),
  ).not.toMatchObject(denied);
  expect(
    await back.pre(input('Edit', 'look-back', { file_path: 'memory/index.md', old_string: 'old', new_string: 'new' })),
  ).not.toMatchObject(denied);
  const ahead = await hooks('look-ahead');
  for (const command of [
    'ncl manual set --section principles --text change',
    'ncl lessons add --text change',
    'ncl day',
  ])
    expect(await ahead.pre(input('Bash', 'look-ahead', { command }))).toMatchObject(denied);
  expect(
    await ahead.pre(input('Edit', 'look-ahead', { file_path: 'memory/index.md', old_string: 'a', new_string: 'b' })),
  ).toMatchObject(denied);
});

it('resolves write paths, rejecting a memory symlink into settings and a result symlink outside its run', async () => {
  const { pre } = await hooks();
  const settings = path.join(directory, '.claude');
  fs.mkdirSync(settings);
  fs.symlinkSync(settings, path.join(directory, 'memory', 'escape'));
  expect(
    await pre(input('Write', 'look-back', { file_path: 'memory/escape/settings.json', content: '{}' })),
  ).toMatchObject(denied);
  fs.symlinkSync(path.join(settings, 'missing.json'), path.join(directory, 'memory', 'dangling'));
  expect(await pre(input('Write', 'look-back', { file_path: 'memory/dangling', content: '{}' }))).toMatchObject(denied);
  fs.mkdirSync(path.join(directory, 'planning-runs'));
  fs.symlinkSync(path.join(settings, 'missing.json'), path.join(directory, 'planning-runs', 'agent-7-look-back.md'));
  expect(
    await pre(input('Write', 'look-back', { file_path: 'planning-runs/agent-7-look-back.md', content: '{}' })),
  ).toMatchObject(denied);
});

it('bounds a run result on Write and on the projected Edit', async () => {
  const { pre } = await hooks();
  const file_path = path.join(directory, 'planning-runs', 'agent-7-look-back.md');
  expect(await pre(input('Write', 'look-back', { file_path, content: 'x'.repeat(32_769) }))).toMatchObject(denied);
  fs.mkdirSync(path.dirname(file_path), { recursive: true });
  fs.writeFileSync(file_path, 'x'.repeat(32_768));
  expect(await pre(input('Edit', 'look-back', { file_path, old_string: 'x', new_string: 'xx' }))).toMatchObject(denied);
});

it('preserves main’s full tool set and nonplanning subagents’ existing tools', async () => {
  const { pre } = await hooks();
  expect(await pre({ ...input('mcp__nanoclaw__create_event'), agent_id: undefined, agent_type: undefined })).toEqual({
    continue: true,
  });
  expect(await pre({ ...input('Bash', 'general-purpose', { command: 'echo hello' }), agent_id: 'ordinary' })).toEqual({
    continue: true,
  });
});
