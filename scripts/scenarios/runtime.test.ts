import { expect, it } from 'vitest';
import { scenarioRuntime } from './runtime.js';

it('runs the shipped tools, model and effort, and keeps the fixture isolation last', () => {
  const runtime = scenarioRuntime(
    {
      capabilities: ['files-read', 'files-write', 'shell', 'web', 'subagents', 'mcp-servers'],
      moduleEnvironment: { GWS_EA_PLANNING_AGENTS: '1' },
      inference: { model: 'claude-opus-5-5', effort: 'high' },
    },
    { nanoclaw: { command: 'node', args: ['mcp.ts'] } },
    { INHERITED: 'kept', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
    { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' },
  );
  for (const tool of ['WebSearch', 'WebFetch', 'Agent', 'Task', 'Workflow'])
    expect(runtime.tools.disallowedTools).not.toContain(tool);
  expect(runtime.tools.strictMcpConfig).toBe(true);
  expect(Object.keys(runtime.tools.mcpServers)).toEqual(['nanoclaw']);
  expect(runtime.inference).toEqual({ model: 'claude-opus-5-5', effort: 'high' });
  expect(runtime.env).toMatchObject({
    INHERITED: 'kept',
    GWS_EA_PLANNING_AGENTS: '1',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
  });
});
