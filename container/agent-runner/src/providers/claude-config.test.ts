import { describe, expect, it } from 'bun:test';

import {
  allowsBuiltinTool,
  resolveClaudeCapabilityPolicy,
  resolveClaudeExecutionPolicy,
  resolveClaudeInference,
  resolveClaudeMcpServers,
  resolveClaudeToolOptions,
} from './claude-config.js';

describe('resolveClaudeInference', () => {
  it('passes model and effort through verbatim with no settings by default', () => {
    const resolved = resolveClaudeInference({ model: 'opus', effort: 'high' }, {});
    expect(resolved).toEqual({ model: 'opus', effort: 'high' });
    expect(resolved.settings).toBeUndefined();
  });

  it("maps speed 'fast' to the SDK fastMode setting", () => {
    expect(resolveClaudeInference({ speed: 'fast' }, {}).settings).toEqual({ fastMode: true });
  });

  it("maps speed 'standard' to the SDK default", () => {
    expect(resolveClaudeInference({ speed: 'standard' }, {}).settings).toBeUndefined();
  });

  it('ignores unknown speed values instead of guessing', () => {
    expect(resolveClaudeInference({ speed: 'ultrafast' }, {}).settings).toBeUndefined();
  });
});

describe("canonical main's built-in tools", () => {
  const EVERY_BUILTIN_KEY = ['files-read', 'files-write', 'shell', 'web', 'subagents'];
  const MAIN = [...EVERY_BUILTIN_KEY, 'gws-ea-main-context'];
  const UNUSED = ['NotebookEdit', 'Workflow', 'ListAgents', 'TeamCreate', 'TeamDelete'];
  const NEEDED = [
    'Agent',
    'Task',
    'TaskStop',
    'Bash',
    'Read',
    'Edit',
    'Write',
    'Grep',
    'Glob',
    'WebSearch',
    'WebFetch',
  ];

  const toolOptions = (grants: readonly string[]) =>
    resolveClaudeToolOptions(
      resolveClaudeCapabilityPolicy(new Set(grants)),
      resolveClaudeMcpServers({ nanoclaw: { command: 'bun', args: ['run', 'mcp.ts'] } }, {}),
      resolveClaudeExecutionPolicy().disallowedTools,
    );

  it('disallows the built-ins main has no use for and keeps the rest of the default set', () => {
    const main = toolOptions(MAIN);

    expect(main.tools).toBeUndefined();
    expect(UNUSED.filter((tool) => !main.disallowedTools.includes(tool))).toEqual([]);
    expect(UNUSED.filter((tool) => main.allowedTools.includes(tool))).toEqual([]);
    expect(NEEDED.filter((tool) => main.disallowedTools.includes(tool))).toEqual([]);
    expect(main.allowedTools).toEqual(
      expect.arrayContaining(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task']),
    );
    expect(main.allowedTools).toEqual(expect.arrayContaining(['TaskStop', 'TodoWrite', 'ToolSearch', 'Skill']));
  });

  it('refuses them at the tool gate as well', () => {
    const policy = resolveClaudeCapabilityPolicy(new Set(MAIN));

    expect(UNUSED.filter((tool) => allowsBuiltinTool(policy, tool))).toEqual([]);
    expect(NEEDED.filter((tool) => !allowsBuiltinTool(policy, tool))).toEqual([]);
  });

  it("leaves a group without main's key every built-in its keys grant", () => {
    const plain = toolOptions(EVERY_BUILTIN_KEY);

    expect(plain.tools).toBeUndefined();
    expect(UNUSED.filter((tool) => plain.disallowedTools.includes(tool))).toEqual([]);
    expect(plain.allowedTools).toEqual(expect.arrayContaining(['TeamCreate', 'TeamDelete', 'NotebookEdit']));
  });
});
