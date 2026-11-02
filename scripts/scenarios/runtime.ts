import fs from 'node:fs';
import path from 'node:path';
import {
  resolveClaudeCapabilityPolicy,
  resolveClaudeExecutionPolicy,
  resolveClaudeInference,
  resolveClaudeMcpServers,
  resolveClaudeToolOptions,
} from '../../container/agent-runner/src/providers/claude-config.js';
import type { McpServerConfig } from '../../container/agent-runner/src/providers/types.js';
import type { ScenarioComposition } from './types.js';

/** The shipped tools, model and effort; the fixture's PreToolUse hook refuses what it cannot serve. */
export function scenarioRuntime(
  composition: Pick<ScenarioComposition, 'capabilities' | 'moduleEnvironment' | 'inference'>,
  mcpServers: Record<string, McpServerConfig>,
  inherited: NodeJS.ProcessEnv,
  isolation: Readonly<Record<string, string>>,
) {
  const execution = resolveClaudeExecutionPolicy();
  const { env, ...tools } = resolveClaudeToolOptions(
    resolveClaudeCapabilityPolicy(new Set(composition.capabilities)),
    resolveClaudeMcpServers(mcpServers, inherited),
    execution.disallowedTools,
  );
  return {
    execution,
    // Strict MCP config keeps the operator's own MCP servers out of the synthetic session.
    tools: { ...tools, strictMcpConfig: true as const },
    inference: resolveClaudeInference(composition.inference, inherited),
    env: { ...inherited, ...composition.moduleEnvironment, ...env, ...isolation },
  };
}

/** Freeze only the date-fixed scenario's hook subprocess, never the model or its timers. */
export function scenarioWeekViewCommand(
  directory: string,
  tree: string,
  composition: Pick<ScenarioComposition, 'weekViewFile' | 'weekViewReferenceAt'>,
): string {
  if (!composition.weekViewFile) throw new Error('The scenario has no week view.');
  const args = ['bun'];
  if (composition.weekViewReferenceAt) {
    const now = Date.parse(composition.weekViewReferenceAt);
    if (!Number.isFinite(now)) throw new Error('The scenario week-view clock is invalid.');
    const clock = path.join(directory, 'week-view-clock.ts');
    fs.writeFileSync(clock, `Date.now = () => ${now};\n`);
    args.push('--preload', clock);
  }
  args.push(
    path.join(tree, 'container/agent-runner/src/week-view/hook.ts'),
    composition.weekViewFile,
    path.join(directory, 'week-delivered'),
  );
  return args.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(' ');
}
