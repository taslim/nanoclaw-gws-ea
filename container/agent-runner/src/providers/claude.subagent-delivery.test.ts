import { afterEach, beforeEach, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeSessionDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';

type PreToolUse = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
let capturedOptions: { hooks?: { PreToolUse?: Array<{ hooks: PreToolUse[] }> } } | undefined;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options?: typeof capturedOptions }) => {
    capturedOptions = args.options;
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'subagent-session' };
      yield { type: 'result', subtype: 'success', result: '' };
    })();
  },
}));

await import('./index.js');
await import('../provider-contracts/index.js');
const { createProvider } = await import('./factory.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

let tmp: string;
let previousHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-subagent-delivery-'));
  previousHome = process.env.HOME;
  process.env.HOME = tmp;
  capturedOptions = undefined;
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The PreToolUse hook the provider hands the Claude SDK. */
async function preToolUseHook(): Promise<PreToolUse> {
  const provider = createProvider('claude');
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const query = provider.query({ prompt: 'go', cwd: tmp });
  for await (const _event of query.events) {
    // Drain the stub stream so the provider has called the SDK.
  }
  const hook = capturedOptions?.hooks?.PreToolUse?.[0]?.hooks[0];
  if (!hook) throw new Error('the provider gave the SDK no PreToolUse hook');
  return hook;
}

function call(toolName: string, subagent: boolean): Record<string, unknown> {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'subagent-session',
    transcript_path: path.join(tmp, 'transcript.jsonl'),
    cwd: tmp,
    tool_name: toolName,
    tool_input: {},
    tool_use_id: 'toolu_1',
    ...(subagent ? { agent_id: 'agent-1', agent_type: 'general-purpose' } : {}),
  };
}

const DELIVERY_TOOLS = ['send_message', 'send_file', 'edit_message', 'add_reaction', 'send_card', 'ask_user_question'];

it.each(DELIVERY_TOOLS)("refuses a subagent's %s, telling it to report back instead", async (tool) => {
  const hook = await preToolUseHook();

  const decision = await hook(call(`mcp__nanoclaw__${tool}`, true));

  expect(decision).toMatchObject({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringContaining('Return what you found as your result'),
    },
  });
});

it('lets the agent itself message the conversation', async () => {
  const hook = await preToolUseHook();

  expect(await hook(call('mcp__nanoclaw__send_message', false))).toEqual({ continue: true });
});

it("leaves a subagent's other tools alone", async () => {
  const hook = await preToolUseHook();

  expect(await hook(call('Bash', true))).toEqual({ continue: true });
  expect(await hook(call('mcp__nanoclaw__time_now', true))).toEqual({ continue: true });
});
