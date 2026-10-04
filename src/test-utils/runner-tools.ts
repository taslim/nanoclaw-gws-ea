/**
 * For tests that check a guidance file names only tools an agent has. The
 * container cannot import the host, so the agent-runner's tools are read from
 * their definitions: each is a `name: '<tool>',` line in its MCP tool sources.
 */
import fs from 'node:fs';
import path from 'node:path';

const TOOLS_DIR = path.resolve('container', 'agent-runner', 'src', 'mcp-tools');

function runnerToolNames(): Set<string> {
  const names = new Set<string>();
  for (const file of fs.readdirSync(TOOLS_DIR)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    const source = fs.readFileSync(path.join(TOOLS_DIR, file), 'utf8');
    for (const [, name] of source.matchAll(/^\s*name: '([a-z_]+)',$/gmu)) if (name) names.add(name);
  }
  return names;
}

/**
 * The backticked words in `guidance` shaped like a tool name (snake_case, or
 * one bare lowercase word) that name no runner tool and are not in `notTools`.
 */
export function unknownToolNames(guidance: string, notTools: readonly string[]): string[] {
  const tools = runnerToolNames();
  return guidance
    .split('`')
    .filter((span, index) => index % 2 === 1 && /^[a-z]+(?:_[a-z]+)*$/u.test(span))
    .filter((name) => !tools.has(name) && !notTools.includes(name));
}
