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
import { SYNTHETIC_IDENTITY, readState } from './fake-host/state.js';
import { startRequestRecorder, rawUsage } from './fake-host/relay.js';
import { prepareSyntheticShell } from './fake-host/sandbox.js';
import type { MessageInRow } from '../../container/agent-runner/src/db/messages-in.js';
import type { ProviderEvent } from '../../container/agent-runner/src/providers/types.js';
import type { ScenarioComposition } from './types.js';
import { scenarioRuntime } from './runtime.js';
import { nativeScenarioHooks } from './fake-host/native-hooks.js';

const JUDGE_MODEL = 'claude-opus-5-5';
const [directory, kind, cli, phase, resume] = process.argv.slice(2);
if (!directory || !cli || !['agent', 'judge'].includes(kind ?? ''))
  throw new Error('runner <directory> <agent|judge> <claude> [phase] [resume]');
const tree = path.resolve(import.meta.dir, '../..');
const file = path.join(directory, 'fixture.json');
const scenario = readState(file).scenario;
const evidence = path.join(directory, phase || kind);
fs.mkdirSync(evidence, { recursive: true });
const agent = path.join(directory, 'agent');
const composition = JSON.parse(
  fs.readFileSync(path.join(directory, 'composition.json'), 'utf8'),
) as ScenarioComposition;
const capabilities = new Set(composition.capabilities);
// The container's environment carries each module's contribution, which the runner's own predicates read.
if (kind === 'agent') Object.assign(process.env, composition.moduleEnvironment);
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

let messages: MessageInRow[] = [
  ...(composition.handoff
    ? [
        {
          id: composition.handoff.id,
          seq: 0,
          kind: 'chat' as const,
          timestamp: composition.handoff.timestamp,
          status: 'pending',
          process_after: null,
          recurrence: null,
          series_id: null,
          tries: 0,
          trigger: 1,
          platform_id: 'email:inbox',
          channel_type: 'email',
          thread_id: readState(file).thread?.key ?? 'mail-synthetic-identity',
          content: composition.handoff.content,
          source_session_id: null,
          on_wake: 0,
        },
      ]
    : []),
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
          : 'email:inbox',
    channel_type: scenario.audience === 'main' ? 'gchat' : scenario.audience === 'external-chat' ? 'whatsapp' : 'email',
    thread_id:
      scenario.audience === 'external-email' ? (readState(file).thread?.key ?? 'mail-synthetic-identity') : null,
    content: JSON.stringify(
      scenario.task
        ? { prompt: scenario.input }
        : {
            sender:
              scenario.audience === 'main'
                ? 'Morgan Ellery'
                : scenario.id === 'friend-dinner-length'
                  ? 'Remy Vance'
                  : 'Juno Hale',
            senderId: scenario.audience === 'main' ? 'synthetic-morgan' : 'synthetic-juno',
            text: [composition.context, scenario.input].filter(Boolean).join('\n\n'),
            principalMessage: scenario.audience === 'main',
            inConversation: true,
          },
    ),
    source_session_id: null,
    on_wake: 0,
  },
];
const shell = prepareSyntheticShell(directory, tree);
if (kind === 'agent' && composition.close) {
  const task = composition.close.task;
  messages = [
    {
      ...messages[0]!,
      id: task.id,
      seq: task.sequence,
      kind: 'task',
      status: task.status,
      timestamp: task.timestamp,
      content: task.content,
      process_after: task.processAfter,
      recurrence: task.recurrence,
      series_id: task.seriesId,
      tries: task.tries,
      platform_id: null,
      channel_type: null,
      thread_id: null,
    },
  ];
  const { applyPreTaskScripts } = await import('../../container/agent-runner/src/scheduling/task-script.js');
  const priorPath = process.env.PATH;
  process.env.PATH = `${shell.bin}:${priorPath ?? ''}`;
  try {
    const applied = await applyPreTaskScripts(messages);
    fs.writeFileSync(path.join(evidence, 'close-script.json'), JSON.stringify(applied, null, 2));
    messages = applied.keep;
    if (messages.length === 0) {
      fs.writeFileSync(
        path.join(evidence, 'usage.json'),
        JSON.stringify({ gated: true, actualModelCalls: 0, result: { total_cost_usd: 0 } }),
      );
      fs.writeFileSync(path.join(evidence, 'text.md'), '');
      fs.writeFileSync(
        path.join(evidence, 'dispatch.json'),
        JSON.stringify({ gatedByNativeScript: true, skipped: applied.skipped }),
      );
      await recorder.close();
      process.exit(0);
    }
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
  }
}
const routing = extractRouting(messages);
const addendum = buildSystemPromptAddendum(
  SYNTHETIC_IDENTITY.assistantName.firstName,
  routing.taskRun ? { kind: 'task', taskId: messages[0]!.id } : { kind: 'chat' },
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

const nativeHooks = nativeScenarioHooks(directory, tree, evidence, composition, shell.profile);
const toolHook: HookCallback =
  kind === 'judge'
    ? async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } })
    : nativeHooks.pre;
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
    TZ: 'America/Los_Angeles',
  },
);
const policy = runtime.execution;
const options: Options = {
  cwd: kind === 'judge' ? evidence : agent,
  ...(resume ? { resume } : {}),
  pathToClaudeCodeExecutable: cli,
  ...(kind === 'judge'
    ? { model: JUDGE_MODEL }
    : { model: runtime.inference.model, effort: runtime.inference.effort as Options['effort'] }),
  settingSources: ['project'],
  systemPrompt:
    kind === 'judge'
      ? 'You are a careful independent evaluator of an executive assistant. Return only the required JSON verdict.'
      : { type: 'preset', preset: 'claude_code', append: addendum, snapshot: false },
  ...(kind === 'judge'
    ? {
        tools: [],
        allowedTools: [],
        disallowedTools: runtime.tools.disallowedTools,
        mcpServers: {},
        strictMcpConfig: true,
      }
    : runtime.tools),
  permissionMode: policy.permissionMode,
  allowDangerouslySkipPermissions: policy.allowDangerouslySkipPermissions,
  settings: {
    ...(kind === 'agent' ? runtime.inference.settings : {}),
    ...policy.settings,
    ...(kind === 'agent' && !sessionsSealed(capabilities)
      ? {
          hooks: {
            ...(composition.weekViewFile
              ? Object.fromEntries(
                  ['SessionStart', 'UserPromptSubmit'].map((event) => [
                    event,
                    [
                      {
                        hooks: [
                          {
                            type: 'command',
                            command: `bun '${path.join(tree, 'container/agent-runner/src/week-view/hook.ts')}' '${composition.weekViewFile}' '${path.join(directory, 'week-delivered')}'`,
                          },
                        ],
                      },
                    ],
                  ]),
                )
              : {}),
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
  ...(kind === 'agent' && nativeHooks.agents ? { agents: nativeHooks.agents } : {}),
  hooks: {
    PreToolUse: [{ hooks: [toolHook] }],
    ...(kind === 'agent' ? { PostToolUse: [{ hooks: [nativeHooks.post] }] } : {}),
    ...(kind === 'agent' && nativeHooks.agents ? { SubagentStart: [{ hooks: [nativeHooks.start] }] } : {}),
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
    inReplyTo: routing.inReplyTo ?? messages[0]!.id,
    channelType: routing.channelType,
    platformId: routing.platformId,
    threadId: routing.threadId,
    batch: messages.map((message) => message.id),
  });
  push(prompt);
}
const activePlanning = new Set<string>();
const sdk = query({ prompt: kind === 'agent' ? inputs() : prompt, options });
async function* events(): AsyncGenerator<ProviderEvent> {
  for await (const event of sdk) {
    fs.appendFileSync(path.join(evidence, 'events.jsonl'), JSON.stringify(event) + '\n');
    yield { type: 'activity' };
    if (event.type === 'system' && event.subtype === 'init') yield { type: 'init', continuation: event.session_id };
    if (
      event.type === 'user' &&
      'tool_use_result' in event &&
      typeof event.tool_use_result === 'object' &&
      event.tool_use_result !== null &&
      'agentId' in event.tool_use_result
    ) {
      if (
        nativeHooks.agents &&
        typeof event.tool_use_result.agentId === 'string' &&
        'isAsync' in event.tool_use_result &&
        event.tool_use_result.isAsync === true
      )
        activePlanning.add(event.tool_use_result.agentId);
      fs.appendFileSync(
        path.join(evidence, 'native-agent-outputs.jsonl'),
        JSON.stringify(event.tool_use_result) + '\n',
      );
    }
    if (event.type === 'system' && event.subtype === 'task_notification' && activePlanning.delete(event.task_id))
      fs.appendFileSync(path.join(evidence, 'planning-terminals.jsonl'), JSON.stringify(event) + '\n');
    if (event.type === 'assistant' && (!nativeHooks.agents || event.parent_tool_use_id === null)) {
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
      if (kind === 'agent' && (event.is_error || (resultCount >= pushed && activePlanning.size === 0))) {
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
      messages.map((message) => message.id),
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
