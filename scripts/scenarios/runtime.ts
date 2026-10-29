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
