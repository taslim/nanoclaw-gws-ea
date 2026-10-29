import fs from 'node:fs';
import path from 'node:path';
import type {
  HookCallback,
  PreToolUseHookInput,
  SyncHookJSONOutput,
} from '../../../container/agent-runner/node_modules/@anthropic-ai/claude-agent-sdk/sdk.js';
import { createPlanningRuntime, PLANNING_AGENTS } from '../../../container/agent-runner/src/planning-agents.js';
import { createPreToolUseHook } from '../../../container/agent-runner/src/providers/claude.js';
import { resolveClaudeCapabilityPolicy } from '../../../container/agent-runner/src/providers/claude-config.js';
import { recordEffect } from './state.js';
import { syntheticShellCommand } from './sandbox.js';
import { webEgressRefusal } from './web-egress.js';
import type { PlannerPolicy, ScenarioCase, ScenarioComposition } from '../types.js';

const READ_PAIRS = [
  'whereabouts get',
  'preferences get',
  'people get',
  'people list',
  'matters get',
  'matters list',
  'tasks get',
  'tasks list',
  'manual get',
  'manual history',
  'lessons list',
];
const within = (target: string, root: string): boolean => {
  let candidate = path.resolve(target);
  const suffix: string[] = [];
  try {
    while (!fs.lstatSync(candidate, { throwIfNoEntry: false })) {
      suffix.unshift(path.basename(candidate));
      const parent = path.dirname(candidate);
      if (parent === candidate) return false;
      candidate = parent;
    }
    const relative = path.relative(fs.realpathSync(root), path.join(fs.realpathSync(candidate), ...suffix));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    // eslint-disable-next-line no-catch-all/no-catch-all -- filesystem uncertainty cannot grant access outside the invented mount
  } catch {
    return false;
  }
};
function output(
  value: SyncHookJSONOutput,
): { permissionDecision?: string; updatedInput?: Record<string, unknown> } | undefined {
  const specific = value.hookSpecificOutput;
  return specific?.hookEventName === 'PreToolUse' ? specific : undefined;
}

/** The mount translation precedes the production gate; shell wrapping follows its literal-command decision. */
export function nativeScenarioHooks(
  directory: string,
  tree: string,
  evidence: string,
  scenario: ScenarioCase,
  composition: ScenarioComposition,
  shellProfile: string,
) {
  const agent = fs.realpathSync(path.join(directory, 'agent'));
  if (
    composition.fixturePlanning &&
    (composition.audience !== 'main' || composition.moduleEnvironment.GWS_EA_PLANNING_AGENTS !== '1')
  )
    throw new Error('The native main planning-agent configuration is required for planner-limits.');
  const fixture = path.join(directory, 'fixture.json');
  const planning = composition.fixturePlanning ? createPlanningRuntime(agent) : undefined;
  const production = createPreToolUseHook(resolveClaudeCapabilityPolicy(new Set(composition.capabilities)), planning);
  const policies: PlannerPolicy[] = [];
  const admitted = new Map<string, PreToolUseHookInput>();
  const callKey = (input: Pick<PreToolUseHookInput, 'agent_id' | 'tool_use_id'>) =>
    `${input.agent_id ?? 'main'}:${input.tool_use_id}`;
  const relocated = (value: string): string =>
    value
      .replace(/^\/workspace\/agent(?=\/|$)/u, agent)
      .replace(/^\/app\/skills(?=\/|$)/u, path.join(tree, 'container/skills'))
      .replace(/^\/workspace\/week-view\.json$/u, composition.weekViewFile ?? '/unavailable-week-view');
  const translated = (input: PreToolUseHookInput): PreToolUseHookInput => {
    if (typeof input.tool_input !== 'object' || input.tool_input === null) return input;
    const args = { ...(input.tool_input as Record<string, unknown>) };
    for (const key of ['file_path', 'path', 'notebook_path'])
      if (typeof args[key] === 'string') args[key] = relocated(args[key]);
    return { ...input, tool_input: args };
  };
  const start: HookCallback = async (input, id, options) => {
    if (!planning || input.hook_event_name !== 'SubagentStart') return {};
    const answer = await planning.start(input, id, options);
    if (
      (input.agent_type === 'look-back' || input.agent_type === 'look-ahead') &&
      'hookSpecificOutput' in answer &&
      answer.hookSpecificOutput?.hookEventName === 'SubagentStart' &&
      answer.hookSpecificOutput.additionalContext
    ) {
      policies.push({
        agentId: input.agent_id,
        role: input.agent_type,
        runFile: path.join(agent, 'planning-runs', `${input.agent_id}-${input.agent_type}.md`),
        ...(input.agent_type === 'look-back' ? { memoryDirectory: path.join(agent, 'memory') } : {}),
        allowedNclPairs: [
          ...READ_PAIRS,
          ...(input.agent_type === 'look-back' ? ['day', 'manual set', 'lessons add'] : []),
        ],
      });
      fs.writeFileSync(path.join(evidence, 'planner-policies.json'), JSON.stringify(policies, null, 2));
    }
    fs.appendFileSync(path.join(evidence, 'planning-starts.jsonl'), JSON.stringify({ input, answer }) + '\n');
    return answer;
  };
  const pre: HookCallback = async (original, id, options) => {
    if (original.hook_event_name !== 'PreToolUse') return {};
    const input = translated(original);
    const args =
      typeof input.tool_input === 'object' && input.tool_input !== null
        ? (input.tool_input as Record<string, unknown>)
        : {};
    const native = await production(input, id, options);
    if ('async' in native && native.async) return native;
    const decision = native as SyncHookJSONOutput;
    const specific = output(decision);
    let reason: string | undefined;
    let updated = specific?.updatedInput ?? args;
    if (specific?.permissionDecision === 'deny' || decision.decision === 'block') {
      fs.appendFileSync(
        path.join(evidence, 'tool-decisions.jsonl'),
        JSON.stringify({ input, native, allowed: false }) + '\n',
      );
      return native;
    }
    if (['WebSearch', 'WebFetch'].includes(input.tool_name)) {
      reason = webEgressRefusal(scenario, input.tool_name, args);
      fs.appendFileSync(
        path.join(evidence, 'web-reads.jsonl'),
        JSON.stringify({
          stage: 'request',
          tool: input.tool_name,
          args,
          allowed: !reason,
          at: new Date().toISOString(),
        }) + '\n',
      );
    } else if (input.tool_name === 'Bash') {
      updated = {
        ...updated,
        command: syntheticShellCommand(shellProfile, typeof updated.command === 'string' ? updated.command : '', tree),
      };
    } else if (['Read', 'Glob', 'Grep', 'Write', 'Edit', 'NotebookEdit'].includes(input.tool_name)) {
      const target = path.resolve(agent, String(args.file_path ?? args.notebook_path ?? args.path ?? '.'));
      const reading = ['Read', 'Glob', 'Grep'].includes(input.tool_name);
      const view = composition.weekViewFile;
      if (
        !within(target, agent) &&
        !(reading && (within(target, path.join(tree, 'container/skills')) || target === view))
      )
        reason = 'Outside the synthetic agent file mount.';
    } else if (input.tool_name === 'Skill') {
      if (typeof args.skill !== 'string' || !composition.skills.includes(args.skill))
        reason = 'Outside the release skill mount.';
    } else if (['Agent', 'Task'].includes(input.tool_name) && !planning)
      reason = 'Native planning is unavailable in this scenario.';
    else if (
      !input.tool_name.startsWith('mcp__nanoclaw__') &&
      ![
        'Agent',
        'Task',
        'TaskStop',
        'TaskCreate',
        'TaskGet',
        'TaskList',
        'TaskUpdate',
        'TodoWrite',
        'ToolSearch',
      ].includes(input.tool_name)
    )
      reason = 'Outside the synthetic fixture transport.';
    if (!reason)
      admitted.set(callKey(input), {
        ...input,
        tool_input: {
          ...args,
          ...(typeof specific?.updatedInput?.command === 'string' ? { command: specific.updatedInput.command } : {}),
        },
      });
    fs.appendFileSync(
      path.join(evidence, 'tool-decisions.jsonl'),
      JSON.stringify({ input, native, allowed: !reason, ...(reason ? { reason } : {}) }) + '\n',
    );
    return {
      ...decision,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: reason ? 'deny' : 'allow',
        permissionDecisionReason: reason ?? 'Production gate and synthetic transport admitted the operation.',
        ...(!reason ? { updatedInput: updated } : {}),
      },
    };
  };
  const post: HookCallback = async (original) => {
    if (original.hook_event_name !== 'PostToolUse') return {};
    const input = admitted.get(callKey(original)) ?? translated({ ...original, hook_event_name: 'PreToolUse' });
    admitted.delete(callKey(original));
    const args = input.tool_input as Record<string, unknown>;
    if (['WebSearch', 'WebFetch'].includes(input.tool_name))
      fs.appendFileSync(
        path.join(evidence, 'web-reads.jsonl'),
        JSON.stringify({
          stage: 'result',
          tool: input.tool_name,
          args,
          result: original.tool_response,
          at: new Date().toISOString(),
        }) + '\n',
      );
    if (input.agent_id) {
      const role = input.agent_type;
      const command =
        typeof args.command === 'string'
          ? (args.command.match(/^'ncl' '([^']+)'(?: '([^']+)')?/u) ?? args.command.match(/^ncl\s+(\S+)(?:\s+(\S+))?/u))
          : undefined;
      await recordEffect(fixture, {
        kind: 'tool',
        operation: input.tool_name === 'Bash' ? 'ncl' : input.tool_name.replace(/^mcp__nanoclaw__/u, ''),
        target: 'fixture-host',
        payload: {
          ...args,
          ...(command ? { command: [command[1], command[2]].filter(Boolean).join(' ') } : {}),
          ...(typeof args.file_path === 'string'
            ? { resolvedPath: fs.realpathSync(path.resolve(agent, args.file_path)) }
            : {}),
          agentId: input.agent_id,
        },
        actor: role === 'look-back' || role === 'look-ahead' ? role : 'unattributed-planner',
      });
    }
    return {};
  };
  return { pre, post, start, ...(planning ? { agents: PLANNING_AGENTS } : {}) };
}
