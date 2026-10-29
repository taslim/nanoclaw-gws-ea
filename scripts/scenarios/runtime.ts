import {
  resolveClaudeCapabilityPolicy,
  resolveClaudeExecutionPolicy,
  resolveClaudeMcpServers,
  resolveClaudeToolOptions,
} from '../../container/agent-runner/src/providers/claude-config.js';
import type { McpServerConfig } from '../../container/agent-runner/src/providers/types.js';
import type { ScenarioComposition } from './types.js';

/** Only individually prepared native transports are admitted by the fixture. */
const FIXTURE_WITHHELD_TOOLS = [
  'WebSearch',
  'WebFetch',
  'ListAgents',
  'Agent',
  'Task',
  'TeamCreate',
  'TeamDelete',
  'Workflow',
] as const;

/** The live runner and no-inference preflight consume the same applied SDK configuration. */
export function scenarioRuntime(
  composition: ScenarioComposition,
  mcpServers: Record<string, McpServerConfig>,
  inherited: NodeJS.ProcessEnv,
  isolation: Readonly<Record<string, string>>,
) {
  const capabilities = resolveClaudeCapabilityPolicy(new Set(composition.capabilities));
  const execution = resolveClaudeExecutionPolicy();
  const production = resolveClaudeToolOptions(
    capabilities,
    resolveClaudeMcpServers(mcpServers, inherited),
    execution.disallowedTools,
  );
  const withheldTools = FIXTURE_WITHHELD_TOOLS.filter(
    (tool) =>
      !(composition.fixturePublicWeb && (tool === 'WebSearch' || tool === 'WebFetch')) &&
      !(composition.fixturePlanning && (tool === 'Agent' || tool === 'Task')),
  );
  const fixtureWithheld = withheldTools.filter(
    (tool) => !production.disallowedTools.includes(tool) && (production.tools?.includes(tool) ?? true),
  );
  const withheld = new Set<string>(withheldTools);
  const applied = {
    ...(production.tools ? { tools: production.tools.filter((tool) => !withheld.has(tool)) } : {}),
    allowedTools: production.allowedTools.filter((tool) => !withheld.has(tool)),
    disallowedTools: [...new Set([...production.disallowedTools, ...withheldTools])],
    mcpServers: production.mcpServers,
    // The synthetic server is the only configured server, even when production allows more.
    strictMcpConfig: true as const,
  };
  return {
    execution,
    production,
    applied,
    fixtureWithheld,
    fixtureExternalMcpWithheld: capabilities.externalMcpServers,
    env: { ...inherited, ...composition.moduleEnvironment, ...production.env, ...isolation },
  };
}
