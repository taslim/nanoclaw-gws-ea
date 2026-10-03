/**
 * Per-agent capabilities on the Claude provider.
 *
 * Two layers. The provider's SDK options are captured through a stubbed SDK.
 * Those same options are then replayed into the PINNED SDK against an
 * in-process stand-in for the Anthropic API, which answers 401: the first
 * /v1/messages request carries the whole tool list the model would be offered,
 * so the wire, not the options, decides what an agent can call. No request
 * leaves the machine.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { closeSessionDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';

// The real SDK, kept before the module is stubbed below: the provider's
// options are replayed into it to read the tool list the pinned CLI sends.
const pinnedSdk = await import('@anthropic-ai/claude-agent-sdk');
const pinnedQuery = pinnedSdk.query;

type PreToolUse = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
interface CapturedOptions {
  tools?: unknown;
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpServers?: Record<string, unknown>;
  strictMcpConfig?: boolean;
  env?: Record<string, string | undefined>;
  settings?: Record<string, unknown>;
  hooks?: { PreToolUse?: Array<{ hooks: PreToolUse[] }> };
  [key: string]: unknown;
}
let captured: CapturedOptions | undefined;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...pinnedSdk,
  query: (args: { options?: CapturedOptions }) => {
    captured = args.options;
    return (async function* () {
      yield { type: 'result', subtype: 'success', result: '' };
    })();
  },
}));

let grants: ReadonlySet<string> = new Set();
const actualConfig = await import('../config.js');
mock.module('../config.js', () => ({ ...actualConfig, runnerCapabilities: () => grants }));

await import('./index.js');
await import('../provider-contracts/index.js');
const { createProvider } = await import('./factory.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');
const { BASE_BUILTIN_TOOLS, SDK_DISALLOWED_TOOLS, TOOL_ALLOWLIST } = await import('./claude-config.js');

/** The list a host writes into container.json for a group stored as `all`. */
const ALL = [
  'reply',
  'files-send',
  'files-read',
  'files-write',
  'shell',
  'web',
  'subagents',
  'conversation-context',
  'mcp-servers',
  'interactive',
  'agents',
  'self-mod',
  'time',
  'schedule-stats',
  'calendar-facts',
];

const CONFIGURED_SERVERS = {
  nanoclaw: { command: 'bun', args: ['run', '/app/src/mcp-tools/index.ts'], env: {} },
  'custom.server': { command: 'custom-server' },
};

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-capabilities-'));
  captured = undefined;
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The SDK options the provider builds for a group holding `keys`. */
async function optionsFor(
  keys: readonly string[],
  mcpServers: Record<string, unknown> = CONFIGURED_SERVERS,
): Promise<CapturedOptions> {
  grants = new Set(keys);
  const provider = createProvider('claude', { mcpServers: mcpServers as never, env: { PATH: process.env.PATH } });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const query = provider.query({ prompt: 'go', cwd: tmp });
  for await (const _event of query.events) {
    // Drain the stub stream so the provider has called the SDK.
  }
  if (!captured) throw new Error('the provider never called the SDK');
  return captured;
}

async function hookFor(keys: readonly string[]): Promise<PreToolUse> {
  const hook = (await optionsFor(keys)).hooks?.PreToolUse?.[0]?.hooks[0];
  if (!hook) throw new Error('the provider gave the SDK no PreToolUse hook');
  return hook;
}

function call(toolName: string, toolInput: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 'capabilities-session',
    transcript_path: path.join(tmp, 'transcript.jsonl'),
    cwd: tmp,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'toolu_1',
  };
}

// ── The pinned SDK on the wire ──

const waiting = new Map<string, (body: string) => void>();
const api = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const body = await request.text();
    if (new URL(request.url).pathname.endsWith('/v1/messages')) {
      for (const [nonce, resolve] of waiting) {
        if (!body.includes(nonce)) continue;
        waiting.delete(nonce);
        resolve(body);
      }
    }
    return Response.json(
      { type: 'error', error: { type: 'authentication_error', message: 'capability wire stub' } },
      { status: 401 },
    );
  },
});

afterAll(() => {
  api.stop(true);
});

/**
 * Replay `options` into the pinned SDK and return the tool names its first
 * model request offers. Each run gets its own home, workspace and prompt
 * nonce, so a request from an earlier run can never be mistaken for this one.
 * The Claude Code binary is the SDK's own (the same version the image pins),
 * and MCP servers are left out: NanoClaw's tool server gates its own tools.
 */
async function wireTools(options: CapturedOptions): Promise<string[]> {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  const cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
  const nonce = `capability-wire-${randomUUID()}`;
  const request = new Promise<string>((resolve) => waiting.set(nonce, resolve));
  const { pathToClaudeCodeExecutable: _binary, hooks: _hooks, mcpServers: _servers, ...replayed } = options;
  const run = pinnedQuery({
    prompt: `Reply with one word. ${nonce}`,
    options: {
      ...replayed,
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}`,
        ANTHROPIC_API_KEY: 'capability-wire-stub',
        DISABLE_TELEMETRY: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    } as never,
  });
  void (async () => {
    try {
      for await (const _message of run) {
        // The stub answers 401; the run ends on its own.
      }
    } catch {
      // Expected: the stub refuses every request.
    }
  })();
  try {
    const body = await request;
    const tools = (JSON.parse(body) as { tools?: Array<{ name: string }> }).tools ?? [];
    return tools.map((tool) => tool.name).sort();
  } finally {
    run.close();
  }
}

/** The surface today's options offer: what the provider sent before capabilities existed. */
function baselineOptions(): CapturedOptions {
  return {
    allowedTools: [...TOOL_ALLOWLIST],
    disallowedTools: [...SDK_DISALLOWED_TOOLS],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['project', 'user', 'local'],
  };
}

const REPLY_AND_TIME = ['reply', 'time'];
const WITHHELD_FROM_REPLY_AND_TIME = [
  'Bash',
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Write',
  'Edit',
  'NotebookEdit',
  'Task',
  'Agent',
];

describe('the pinned SDK offers only granted built-in tools', () => {
  it('never offers a group holding reply and time a shell, file, web or subagent tool', async () => {
    const offered = await wireTools(await optionsFor(REPLY_AND_TIME));

    expect(offered.filter((tool) => WITHHELD_FROM_REPLY_AND_TIME.includes(tool))).toEqual([]);
  }, 60_000);

  it("offers a group holding every key exactly today's tools", async () => {
    const today = await wireTools(baselineOptions());

    expect(await wireTools(await optionsFor(ALL))).toEqual(today);
    expect(today).toContain('Bash');
  }, 60_000);
});

describe('the SDK options a group holding every key gets', () => {
  it('are the options from before capabilities existed', async () => {
    const options = await optionsFor(ALL);

    expect(options.tools).toBeUndefined();
    expect(options.disallowedTools).toEqual([...SDK_DISALLOWED_TOOLS]);
    expect(options.allowedTools).toEqual([...TOOL_ALLOWLIST, 'mcp__nanoclaw__*', 'mcp__custom_server__*']);
    expect(Object.keys(options.mcpServers ?? {})).toEqual(['nanoclaw', 'custom.server']);
    expect(options.strictMcpConfig).toBeUndefined();
    expect(options.env).not.toHaveProperty('ENABLE_CLAUDEAI_MCP_SERVERS');
  });

  it('let the agent call a shell and a configured server', async () => {
    const hook = await hookFor(ALL);

    expect(await hook(call('Bash', { command: 'ls' }))).toEqual({ continue: true });
    expect(await hook(call('mcp__custom_server__lookup'))).toEqual({ continue: true });
  });
});

describe('a group holding reply and time', () => {
  it('is offered only the built-ins every agent keeps, with nothing else to start', async () => {
    const options = await optionsFor(REPLY_AND_TIME);

    expect(options.tools).toEqual([...BASE_BUILTIN_TOOLS]);
    expect(options.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Read', 'WebFetch', 'Write', 'Agent']));
    expect(options.allowedTools).toEqual(
      expect.not.arrayContaining(['Bash', 'Read', 'WebSearch', 'Task', 'mcp__custom_server__*']),
    );
    expect(Object.keys(options.mcpServers ?? {})).toEqual(['nanoclaw']);
    expect(options.strictMcpConfig).toBe(true);
    // claude.ai connectors stay off without mcp-servers.
    expect(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
  });

  it.each(['Bash', 'Read', 'Glob', 'Write', 'WebFetch', 'Agent', 'Task'])('denies a forced %s call', async (tool) => {
    const hook = await hookFor(REPLY_AND_TIME);

    expect(await hook(call(tool))).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('not available to this agent'),
      },
    });
  });

  it.each(['mcp__custom_server__lookup', 'mcp__plugin_tools__run', 'mcp__claude_ai_Gmail__search_threads'])(
    'denies %s from a server other than NanoClaw',
    async (tool) => {
      const hook = await hookFor(REPLY_AND_TIME);

      expect(await hook(call(tool))).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    },
  );

  it('lets the agent reply, read the time, and load its skills', async () => {
    const hook = await hookFor(REPLY_AND_TIME);

    expect(await hook(call('mcp__nanoclaw__send_message'))).toEqual({ continue: true });
    expect(await hook(call('mcp__nanoclaw__time_now'))).toEqual({ continue: true });
    expect(await hook(call('Skill'))).toEqual({ continue: true });
  });
});

describe('a container.json without a valid capability list', () => {
  it.each([[{}], [{ capabilities: 'all' }], [{ capabilities: ['reply', 7] }]])(
    'grants no tools at all (%j)',
    async (raw) => {
      const { capabilities } = actualConfig.runnerConfigFromRaw(raw);
      const options = await optionsFor([...capabilities]);

      expect(options.tools).toEqual([]);
      expect(Object.keys(options.mcpServers ?? {})).toEqual(['nanoclaw']);
      const hook = await hookFor([...capabilities]);
      expect(await hook(call('Skill'))).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    },
  );
});
