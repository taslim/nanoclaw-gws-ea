/**
 * The Claude provider hands the agent the acknowledgement reminder after a
 * batch of tool calls (acknowledge.ts): once, only when a person has waited
 * in silence long enough, and never to a subagent.
 */
import { afterEach, beforeEach, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ACKNOWLEDGE_AFTER_MS, startWaiting, stopWaiting } from '../acknowledge.js';
import { closeSessionDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';

type Hook = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
let capturedOptions: { hooks?: { PostToolBatch?: Array<{ hooks: Hook[] }> } } | undefined;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options?: typeof capturedOptions }) => {
    capturedOptions = args.options;
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'ack-session' };
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-acknowledge-'));
  previousHome = process.env.HOME;
  process.env.HOME = tmp;
  capturedOptions = undefined;
  initTestSessionDb();
});

afterEach(() => {
  stopWaiting();
  closeSessionDb();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The PostToolBatch hook the provider hands the Claude SDK. */
async function postToolBatchHook(): Promise<Hook> {
  const provider = createProvider('claude');
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  for await (const _event of provider.query({ prompt: 'go', cwd: tmp }).events) {
    // Drain the stub stream so the provider has called the SDK.
  }
  const hook = capturedOptions?.hooks?.PostToolBatch?.[0]?.hooks[0];
  if (!hook) throw new Error('the provider gave the SDK no PostToolBatch hook');
  return hook;
}

function batch(subagent: boolean): Record<string, unknown> {
  return {
    hook_event_name: 'PostToolBatch',
    session_id: 'ack-session',
    transcript_path: path.join(tmp, 'transcript.jsonl'),
    cwd: tmp,
    tool_calls: [],
    ...(subagent ? { agent_id: 'agent-1', agent_type: 'general-purpose' } : {}),
  };
}

it('hands the agent the reminder after a tool batch, once, when a person has waited in silence', async () => {
  const hook = await postToolBatchHook();
  startWaiting(() => false, Date.now() - ACKNOWLEDGE_AFTER_MS - 1_000);
  // A subagent speaks to no one: its batch neither gets the reminder nor uses it up.
  expect(await hook(batch(true))).toEqual({ continue: true });
  const first = await hook(batch(false));
  expect(first.hookSpecificOutput).toMatchObject({
    hookEventName: 'PostToolBatch',
    additionalContext: expect.stringContaining('has heard nothing from you yet'),
  });
  expect(await hook(batch(false))).toEqual({ continue: true });
});

it('adds nothing while the person has not waited long', async () => {
  const hook = await postToolBatchHook();
  startWaiting(() => false);
  expect(await hook(batch(false))).toEqual({ continue: true });
});
