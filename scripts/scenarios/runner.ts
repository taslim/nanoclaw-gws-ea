import fs from 'node:fs';
import path from 'node:path';
import type {
  HookCallback,
  Options,
  SDKResultMessage,
  SDKUserMessage,
} from '../../container/agent-runner/node_modules/@anthropic-ai/claude-agent-sdk/sdk.js';
const { query } = (await import(
  new URL('../../container/agent-runner/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs', import.meta.url).href
)) as typeof import('../../container/agent-runner/node_modules/@anthropic-ai/claude-agent-sdk/sdk.js');
import { FixtureMailbox } from './fake-host/mailbox.js';
import { SYNTHETIC_IDENTITY, readState, recordEffect } from './fake-host/state.js';
import { startRequestRecorder, rawUsage } from './fake-host/relay.js';
import { prepareSyntheticShell, syntheticShellCommand } from './fake-host/sandbox.js';
import type { ProviderEvent } from '../../container/agent-runner/src/providers/types.js';
import type { ScenarioCase, ScenarioComposition } from './types.js';
import { scenarioRuntime } from './runtime.js';

const [directory, kind, model, reservation, cli, phase, resume] = process.argv.slice(2);
if (!directory || !model || !reservation || !cli || !['agent', 'judge'].includes(kind ?? ''))
  throw new Error('runner <directory> <agent|judge> <model> <budget> <claude>');
const tree = path.resolve(import.meta.dir, '../..');
const file = path.join(directory, 'fixture.json');
const scenario = (JSON.parse(fs.readFileSync(file, 'utf8')) as { scenario: ScenarioCase }).scenario;
const evidence = path.join(directory, phase || kind);
fs.mkdirSync(evidence, { recursive: true });
const agent = path.join(directory, 'agent');
const composition = JSON.parse(
  fs.readFileSync(path.join(directory, 'composition.json'), 'utf8'),
) as ScenarioComposition;
const capabilities = new Set(composition.capabilities);
const recorder = await startRequestRecorder(path.join(evidence, 'raw'));
const { resetAgentMailboxForTesting, registerAgentMailbox } =
  await import('../../container/agent-runner/src/mailbox/index.js');
const { formatMessages, extractRouting } = await import('../../container/agent-runner/src/formatter.js');
const { buildCompactInstructions } = await import('../../container/agent-runner/src/compact-instructions.js');
const { buildSystemPromptAddendum } = await import('../../container/agent-runner/src/destinations.js');
const { setCurrentReplyRoute, clearCurrentReplyRoute } =
  await import('../../container/agent-runner/src/db/session-state.js');
const { processQuery } = await import('../../container/agent-runner/src/poll-loop.js');
const { sessionsSealed, prepareSessionMemory } = await import('../../container/agent-runner/src/memory/sealed.js');
const memoryRegistration = prepareSessionMemory(kind === 'judge' || sessionsSealed(capabilities), agent);
const { memoryContextForSessionStart, recordMemoryDelivered } =
  await import('../../container/agent-runner/src/memory/session-hook.js');
resetAgentMailboxForTesting();
const mailbox = new FixtureMailbox(file);
registerAgentMailbox(() => mailbox);

const messages = [
  {
    id: 'synthetic-input',
    seq: 2,
    kind: scenario.task ? ('task' as const) : ('chat' as const),
    timestamp: new Date().toISOString(),
    status: 'pending',
    process_after: null,
    recurrence: null,
    series_id: null,
    tries: 0,
    trigger: 1,
    platform_id:
      scenario.audience === 'main'
        ? 'synthetic-morgan-dm'
        : scenario.audience === 'external-chat'
          ? 'synthetic-juno-chat'
          : 'synthetic-email-inbox',
    channel_type: scenario.audience === 'main' ? 'gchat' : scenario.audience === 'external-chat' ? 'whatsapp' : 'email',
    thread_id: null,
    content: JSON.stringify({
      sender: scenario.observationOnly ? 'system' : scenario.audience === 'main' ? 'Morgan Ellery' : 'Juno Hale',
      senderId: scenario.observationOnly
        ? 'synthetic-host'
        : scenario.audience === 'main'
          ? 'synthetic-morgan'
          : 'synthetic-juno',
      text: [composition.context, scenario.input].filter(Boolean).join('\n\n'),
      principalMessage: scenario.audience === 'main',
      inConversation: true,
    }),
    source_session_id: null,
    on_wake: 0,
  },
];
const routing = extractRouting(messages);
const addendum = buildSystemPromptAddendum(
  SYNTHETIC_IDENTITY.assistantName.firstName,
  scenario.task ? { kind: 'task', taskId: 'synthetic-input' } : { kind: 'chat' },
  capabilities,
);
const formatted = formatMessages(messages);
const compact = buildCompactInstructions(
  mailbox.getDestinations().map((destination) => destination.name),
  null,
  capabilities,
);
fs.writeFileSync(path.join(evidence, 'formatted.md'), formatted);
fs.writeFileSync(path.join(evidence, 'append.md'), addendum);
fs.writeFileSync(path.join(evidence, 'compact.md'), compact);

const relocatedPath = (value: string): string => value.replace(/^\/workspace\/agent(?=\/|$)/, agent);
const within = (target: string, root: string): boolean => {
  let current = path.resolve(agent, relocatedPath(target));
  const suffix: string[] = [];
  try {
    while (!fs.lstatSync(current, { throwIfNoEntry: false })) {
      suffix.unshift(path.basename(current));
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
    const resolved = path.join(fs.realpathSync(current), ...suffix);
    const relative = path.relative(fs.realpathSync(root), resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    // eslint-disable-next-line no-catch-all/no-catch-all -- unreadable or dangling paths are refused at the synthetic file boundary
  } catch {
    return false;
  }
};
const releaseSkills = path.join(tree, 'container', 'skills');
const shell = prepareSyntheticShell(directory, tree);
const toolHook: HookCallback = async (input) => {
  if (input.hook_event_name !== 'PreToolUse') return {};
  const args =
    typeof input.tool_input === 'object' && input.tool_input !== null
      ? (input.tool_input as Record<string, unknown>)
      : {};
  let allowed =
    input.tool_name.startsWith('mcp__nanoclaw__') ||
    ['TaskStop', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TodoWrite', 'ToolSearch'].includes(
      input.tool_name,
    );
  if (input.tool_name === 'Skill') allowed = typeof args.skill === 'string' && composition.skills.includes(args.skill);
  let updatedInput: Record<string, unknown> | undefined;
  if (input.tool_name === 'Bash') {
    const command = typeof args.command === 'string' ? args.command.trim() : '';
    allowed = true;
    updatedInput = { ...args, command: syntheticShellCommand(shell.profile, command) };
  }
  if (['Read', 'Glob', 'Grep'].includes(input.tool_name)) {
    const target = String(args.file_path ?? args.path ?? '.');
    allowed = within(target, agent) || within(target, releaseSkills);
    if (relocatedPath(target) !== target)
      updatedInput = { ...args, [args.file_path !== undefined ? 'file_path' : 'path']: relocatedPath(target) };
  }
  if (['Write', 'Edit', 'NotebookEdit'].includes(input.tool_name)) {
    const target = String(args.file_path ?? args.notebook_path ?? '');
    allowed = within(target, agent);
    if (relocatedPath(target) !== target)
      updatedInput = {
        ...args,
        [input.tool_name === 'NotebookEdit' ? 'notebook_path' : 'file_path']: relocatedPath(target),
      };
  }
  if (kind === 'judge') allowed = false;
  if (input.agent_id)
    await recordEffect(file, {
      kind: 'tool',
      operation: input.tool_name,
      target: 'fixture-host',
      payload: args,
      actor:
        input.agent_type === 'look-back' || input.agent_type === 'look-ahead'
          ? input.agent_type
          : 'unattributed-planner',
    });
  fs.appendFileSync(
    path.join(evidence, 'tool-decisions.jsonl'),
    JSON.stringify({ tool: input.tool_name, input: args, allowed }) + '\n',
  );
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: allowed ? 'allow' : 'deny',
      ...(updatedInput ? { updatedInput } : {}),
      permissionDecisionReason: allowed
        ? 'Synthetic fixture operation.'
        : 'Outside the synthetic host; no real account or personal files are exposed.',
    },
  };
};
const sessionHook: HookCallback = async (input) => {
  if (
    input.hook_event_name !== 'SessionStart' ||
    input.source === 'fork' ||
    !memoryRegistration.sources.includes(input.source)
  )
    return {};
  const session = { id: input.session_id, stateDir: path.join(directory, 'memory-delivered') };
  const section = memoryContextForSessionStart(input.source, agent, session);
  if (!section) return {};
  fs.writeFileSync(path.join(evidence, `memory-${input.source}.md`), section);
  recordMemoryDelivered(session, section);
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: section } };
};
const bin = shell.bin;
const runtime = scenarioRuntime(
  composition,
  {
    nanoclaw: {
      command: process.execPath,
      args: [path.join(tree, 'scripts/scenarios/fake-host/mcp.ts'), file, JSON.stringify([...capabilities])],
    },
  },
  process.env,
  {
    ANTHROPIC_BASE_URL: recorder.url,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1600',
    TZ: 'America/Los_Angeles',
  },
);
const policy = runtime.execution;
const options: Options = {
  cwd: kind === 'judge' ? evidence : agent,
  ...(resume ? { resume } : {}),
  pathToClaudeCodeExecutable: cli,
  model,
  effort: 'low',
  maxTurns: kind === 'judge' ? 1 : 8,
  maxBudgetUsd: Number(reservation),
  settingSources: ['project'],
  systemPrompt:
    kind === 'judge'
      ? 'You are a careful independent evaluator of an executive assistant. Return only the required JSON verdict.'
      : { type: 'preset', preset: 'claude_code', append: addendum, snapshot: false },
  ...(kind === 'judge'
    ? {
        tools: [],
        allowedTools: [],
        disallowedTools: runtime.applied.disallowedTools,
        mcpServers: {},
        strictMcpConfig: true,
      }
    : runtime.applied),
  permissionMode: policy.permissionMode,
  allowDangerouslySkipPermissions: policy.allowDangerouslySkipPermissions,
  settings: {
    ...policy.settings,
    ...(kind === 'agent' && !sessionsSealed(capabilities)
      ? {
          hooks: {
            PreCompact: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: `${process.execPath} ${path.join(tree, 'scripts/scenarios/fake-host/compact-hook.ts')} '${JSON.stringify([...capabilities])}'`,
                  },
                ],
              },
            ],
          },
        }
      : {}),
  },
  env:
    kind === 'judge'
      ? { ...process.env, ANTHROPIC_BASE_URL: recorder.url, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }
      : runtime.env,
  hooks: {
    PreToolUse: [{ hooks: [toolHook] }],
    ...(kind === 'agent' && memoryRegistration.sources.length > 0 ? { SessionStart: [{ hooks: [sessionHook] }] } : {}),
  },
  stderr: (line) => {
    fs.appendFileSync(path.join(evidence, 'stderr.log'), line);
  },
};
fs.writeFileSync(
  path.join(evidence, 'options.json'),
  JSON.stringify(
    {
      ...options,
      productionTools: runtime.production,
      fixtureWithheldTools: runtime.fixtureWithheld,
      fixtureExternalMcpWithheld: runtime.fixtureExternalMcpWithheld,
      moduleEnvironment: kind === 'agent' ? composition.moduleEnvironment : {},
      env: { keys: Object.keys(options.env ?? {}).sort() },
      hooks: Object.keys(options.hooks ?? {}),
      stderr: undefined,
    },
    null,
    2,
  ),
);
let result: SDKResultMessage | undefined;
let text = '';
const prompt = kind === 'judge' ? fs.readFileSync(path.join(directory, 'judge-prompt.md'), 'utf8') : formatted;
fs.writeFileSync(path.join(evidence, 'prompt.md'), prompt);
let inputFinished = false;
let wakeInput: (() => void) | undefined;
let pushed = 0;
let resultCount = 0;
const pending: SDKUserMessage[] = [];
const push = (value: string): void => {
  pushed++;
  pending.push({ type: 'user', message: { role: 'user', content: value }, parent_tool_use_id: null, session_id: '' });
  wakeInput?.();
};
const end = (): void => {
  inputFinished = true;
  wakeInput?.();
};
async function* inputs(): AsyncGenerator<SDKUserMessage> {
  while (!inputFinished) {
    while (pending.length) yield pending.shift()!;
    if (!inputFinished)
      await new Promise<void>((resolve) => {
        wakeInput = resolve;
      });
  }
}
if (kind === 'agent') {
  setCurrentReplyRoute({
    inReplyTo: routing.inReplyTo ?? 'synthetic-input',
    channelType: routing.channelType,
    platformId: routing.platformId,
    threadId: routing.threadId,
    batch: ['synthetic-input'],
  });
  push(prompt);
}
const sdk = query({ prompt: kind === 'agent' ? inputs() : prompt, options });
async function* events(): AsyncGenerator<ProviderEvent> {
  for await (const event of sdk) {
    fs.appendFileSync(path.join(evidence, 'events.jsonl'), JSON.stringify(event) + '\n');
    yield { type: 'activity' };
    if (event.type === 'system' && event.subtype === 'init') yield { type: 'init', continuation: event.session_id };
    if (event.type === 'assistant') {
      const joined = event.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (joined) {
        text += `${joined}\n`;
        yield { type: 'text', text: joined };
      }
    }
    if (event.type === 'result') {
      result = event;
      resultCount++;
      yield {
        type: 'result',
        text: event.subtype === 'success' ? event.result : null,
        isError: event.is_error,
        ...(event.subtype === 'success' ? {} : { error: event.errors.join('\n') }),
      };
      if (kind === 'agent' && resultCount === pushed) {
        end();
        sdk.close();
        return;
      }
    }
  }
}
try {
  if (kind === 'agent') {
    const queryResult = await processQuery(
      {
        events: events(),
        push,
        end,
        abort: () => {
          end();
          sdk.close();
        },
      },
      routing,
      ['synthetic-input'],
      'claude',
      undefined,
      prompt,
      resume || undefined,
      true,
    );
    fs.writeFileSync(path.join(evidence, 'dispatch.json'), JSON.stringify(queryResult, null, 2));
  } else {
    for await (const _event of events()) {
      /* judge has no delivery route */
    }
  }
} finally {
  if (kind === 'agent') clearCurrentReplyRoute();
  fs.writeFileSync(path.join(evidence, 'text.md'), text);
  fs.writeFileSync(
    path.join(evidence, 'usage.json'),
    JSON.stringify({ result, raw: rawUsage(path.join(evidence, 'raw')) }, null, 2),
  );
  await recorder.close();
}
if (!result) throw new Error('No SDK result; retain the reservation as uncertain.');
if (kind === 'agent')
  fs.writeFileSync(path.join(evidence, 'effects.json'), JSON.stringify(readState(file).effects, null, 2));
if (result.subtype !== 'success') throw new Error(`SDK run ended ${result.subtype}.`);
