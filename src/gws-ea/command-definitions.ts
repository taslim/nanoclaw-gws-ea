import { managedResultSchema, operationDataSchema, LIST_DATA_SCHEMA, STATUS_DATA_SCHEMA } from './result-schema.js';
/** The public grammar and discovery metadata, bound to existing domain handlers. */
export type AttemptCommand =
  | 'create'
  | 'resume'
  | 'connect-google'
  | 'start'
  | 'stop'
  | 'restart'
  | 'update'
  | 'rollback'
  | 'remove'
  | 'cleanup';

export type CommandHandler =
  | { readonly kind: 'attempt'; readonly command: AttemptCommand }
  | { readonly kind: 'observation'; readonly command: 'list' | 'status' | 'logs' }
  | { readonly kind: 'native'; readonly command: 'ncl' }
  | { readonly kind: 'voice'; readonly command: 'install-voice' | 'enable-voice' | 'disable-voice' | 'uninstall-voice' }
  | { readonly kind: 'discovery'; readonly command: 'help' | 'schema' | 'completion' | 'version' };

export type OutputMode = 'human' | 'json' | 'native' | 'shell';
export type ResultSchema = Readonly<Record<string, unknown>>;

interface OptionBase {
  readonly name: string;
  readonly description: string;
  readonly required?: boolean;
  readonly repeatable?: boolean;
}

export type OptionDefinition =
  | (OptionBase & { readonly type: 'boolean'; readonly short?: string })
  | (OptionBase & { readonly type: 'string'; readonly valueName: string; readonly choices?: readonly string[] });

export interface ArgumentDefinition {
  readonly name: string;
  readonly description: string;
  readonly required?: boolean;
  readonly variadic?: boolean;
  readonly choices?: readonly string[];
}

export interface CommandDefinition {
  readonly path: readonly string[];
  readonly summary: string;
  readonly group: 'Assistants' | 'Service' | 'Advanced' | 'Optional voice' | 'Discovery';
  readonly handler: CommandHandler;
  readonly options: readonly OptionDefinition[];
  readonly arguments?: readonly ArgumentDefinition[];
  readonly scope:
    | 'new-assistant'
    | 'assistant'
    | 'registry'
    | 'assistant-or-registry'
    | 'tool-checkout'
    | 'host'
    | 'local-interface';
  readonly effects: readonly string[];
  readonly prerequisites: readonly string[];
  readonly recovery: readonly string[];
  readonly examples: readonly string[];
  readonly outputModes: readonly OutputMode[];
  readonly resultSchema: ResultSchema;
  readonly passThrough?: boolean;
}

const value = (name: string, valueName: string, description: string, required = false): OptionDefinition => ({
  name,
  type: 'string',
  valueName,
  description,
  required,
});
const flag = (name: string, description: string): OptionDefinition => ({ name, type: 'boolean', description });
const id = value('id', 'instance_id', 'The full assistant ID; never inferred from the registry.', true);
const yes = flag('yes', "Supply this command's defined confirmation; never substitutes for OAuth consent.");
const secrets = value(
  'secrets-file',
  'file',
  'Owner-only file under the config root containing GWS_EA_PROVIDER_CREDENTIAL.',
);
const googleClient = value(
  'google-client-file',
  'file',
  "Desktop OAuth client downloaded for the assistant's Google sign-in.",
);
const managedModes = ['human', 'json'] as const;
const nativeResult: ResultSchema = {
  type: 'string',
  description: 'Raw delegated output; the child owns its exit contract.',
};
const observationPrerequisites = ['A readable managed registry; observations never repair runtime state.'];
const assistantPrerequisites = ["An explicitly named managed assistant and the command's recorded resources."];

export const COMMON_OPTIONS: readonly OptionDefinition[] = [
  {
    name: 'help',
    type: 'boolean',
    short: 'h',
    description: 'Show help for the selected command without runtime setup.',
  },
  flag('json', 'Emit the command result as JSON; unavailable for native output and shell completion.'),
  flag('no-input', 'Do not prompt or launch a browser; report human prerequisites.'),
  flag('quiet', 'Suppress progress while retaining results and errors.'),
];

export const COMMAND_DEFINITIONS: readonly CommandDefinition[] = [
  {
    path: ['create'],
    group: 'Assistants',
    handler: { kind: 'attempt', command: 'create' },
    summary: 'Provision one assistant and verify its conversation path.',
    scope: 'new-assistant',
    options: [
      value('track', 'track', 'Release track (dogfood or prod; other tracks require --source-remote).', true),
      value('source-remote', 'remote', 'Repository holding this committed tool release.'),
      value('google-account', 'email', 'Operator Google Cloud account.'),
      value('assistant-first-name', 'name', 'Assistant first name.'),
      value('assistant-last-name', 'name', 'Assistant last name.'),
      value('assistant-workspace-email', 'email', "Assistant's own Google Workspace email."),
      value('principal-first-name', 'name', 'Principal first name.'),
      value('principal-last-name', 'name', 'Principal last name.'),
      { ...value('principal-email', 'email', 'One address the principal uses, in input order.'), repeatable: true },
      value('principal-chat-email', 'email', 'Principal address used for Google Chat; needed with several addresses.'),
      value('principal-timezone', 'iana', 'Principal IANA timezone.'),
      value('provider', 'id', 'Installed agent provider.'),
      secrets,
    ],
    effects: [
      "Deploys this tool's own committed, clean release on the selected track.",
      'Reserves owned resources and journals provisioning; creation can pause for a person.',
    ],
    prerequisites: ['Supported host, Docker, Google Cloud and Workspace access, and provider credentials.'],
    recovery: [
      'Continue the creation journal with resume --id <instance_id>; inspect with status or tear down with remove.',
    ],
    examples: ['gws-ea create --track dogfood', 'gws-ea create --track=prod --principal-email=principal@example.com'],
    outputModes: managedModes,
    resultSchema: managedResultSchema(operationDataSchema('create')),
  },
  {
    path: ['list'],
    group: 'Assistants',
    handler: { kind: 'observation', command: 'list' },
    summary: 'Observe every managed assistant from local registry state.',
    scope: 'registry',
    options: [],
    effects: ['Read-only observation; never repairs an assistant.'],
    prerequisites: observationPrerequisites,
    recovery: ['Inspect an assistant with status --id <instance_id>.'],
    examples: ['gws-ea list', 'gws-ea --json list'],
    outputModes: managedModes,
    resultSchema: managedResultSchema(LIST_DATA_SCHEMA),
  },
  {
    path: ['status'],
    group: 'Assistants',
    handler: { kind: 'observation', command: 'status' },
    summary: 'Observe one assistant, its operation, and runtime health.',
    scope: 'assistant',
    options: [id],
    effects: ['Read-only live probes; degraded health still returns success after observation.'],
    prerequisites: observationPrerequisites,
    recovery: ["Use the observed operation's continuation or recovery action."],
    examples: ['gws-ea status --id <instance_id> --json'],
    outputModes: managedModes,
    resultSchema: managedResultSchema(STATUS_DATA_SCHEMA),
  },
  {
    path: ['resume'],
    group: 'Assistants',
    handler: { kind: 'attempt', command: 'resume' },
    summary: 'Continue an existing creation journal.',
    scope: 'assistant',
    options: [
      id,
      flag('chat-configured', 'Confirm the offered Chat configuration step.'),
      value('billing-account', 'id', 'Billing account offered by a provisioning pause.'),
      googleClient,
      secrets,
    ],
    effects: ['Continues journaled provisioning and its pending human step.'],
    prerequisites: assistantPrerequisites,
    recovery: ["Rerun resume with the pause's supplied inputs, or remove the partially created assistant."],
    examples: ['gws-ea resume --id <instance_id> --chat-configured'],
    outputModes: managedModes,
    resultSchema: managedResultSchema(operationDataSchema('resume')),
  },
  {
    path: ['connect-google'],
    group: 'Assistants',
    handler: { kind: 'attempt', command: 'connect-google' },
    summary: "Connect or repair the assistant's own Google authorization.",
    scope: 'assistant',
    options: [id, googleClient, secrets],
    effects: ['Signs the assistant in as its own account; safe to rerun.'],
    prerequisites: assistantPrerequisites,
    recovery: ['Rerun with the supplied Google client file and complete the offered consent step.'],
    examples: ['gws-ea connect-google --id <instance_id> --google-client-file <file>'],
    outputModes: managedModes,
    resultSchema: managedResultSchema(operationDataSchema('connect-google')),
  },
  ...(['start', 'stop', 'restart'] as const).map(
    (command): CommandDefinition => ({
      path: [command],
      group: 'Service',
      handler: { kind: 'attempt', command },
      summary: `${command[0].toUpperCase()}${command.slice(1)} the assistant's recorded host service.`,
      scope: 'assistant',
      options: [id],
      effects:
        command === 'stop'
          ? [
              'Stops the host service; agent containers keep running.',
              'A later login or reboot can start the service again.',
            ]
          : ['Controls the recorded host service and verifies host readiness.'],
      prerequisites: assistantPrerequisites,
      recovery: ['Inspect status and logs for the explicitly named assistant.'],
      examples: [`gws-ea ${command} --id <instance_id>`],
      outputModes: managedModes,
      resultSchema: managedResultSchema(operationDataSchema(command)),
    }),
  ),
  {
    path: ['update'],
    group: 'Assistants',
    handler: { kind: 'attempt', command: 'update' },
    summary: 'Deploy this committed tool release to one or every eligible assistant.',
    scope: 'assistant-or-registry',
    options: [
      { ...id, required: false },
      flag('all', 'Update all assistants sequentially on their own track and repository; exclusive with --id.'),
      value('track', 'track', 'Move one assistant to another release track.'),
      value('source-remote', 'remote', 'Move one assistant to another repository.'),
      yes,
    ],
    effects: [
      'Single-assistant update stages a release before confirmation; then stops briefly, switches, verifies, and retains the previous release.',
      '--all shows the plan before staging, asks once unless --yes is supplied, and pins one target for sequential rollout.',
    ],
    prerequisites: [
      'Pass --id or --all; --all rejects --track and --source-remote.',
      'Tool checkout must be committed and clean; target assistants must satisfy update readiness.',
    ],
    recovery: [
      'Rerun update to continue a cut-short operation or retry follow-ups; rollback uses the retained previous release.',
    ],
    examples: ['gws-ea update --id <instance_id> --yes', 'gws-ea update --all --yes'],
    outputModes: managedModes,
    resultSchema: managedResultSchema(operationDataSchema('update')),
  },
  {
    path: ['rollback'],
    group: 'Assistants',
    handler: { kind: 'attempt', command: 'rollback' },
    summary: 'Return to the retained previous release.',
    scope: 'assistant',
    options: [id, flag('snapshot', 'Restore the pre-update snapshot and explicitly discard post-snapshot data.'), yes],
    effects: [
      'Keeps messages since the update unless a schema change or --snapshot requires restoring the pre-update snapshot.',
      'Shows discarded data before snapshot confirmation.',
    ],
    prerequisites: [...assistantPrerequisites, 'A retained previous release belonging to this assistant.'],
    recovery: ['Rerun rollback to continue it; an unfinished update can also be reverted.'],
    examples: ['gws-ea rollback --id <instance_id>', 'gws-ea rollback --id <instance_id> --snapshot --yes'],
    outputModes: managedModes,
    resultSchema: managedResultSchema(operationDataSchema('rollback')),
  },
  {
    path: ['remove'],
    group: 'Assistants',
    handler: { kind: 'attempt', command: 'remove' },
    summary: "Tear down this assistant's owned resources, including partial creation.",
    scope: 'assistant',
    options: [
      id,
      yes,
      value(
        'abandon',
        'gcp-project,chat-subscription',
        'Explicit owned external resources removal may leave behind when they cannot be observed.',
      ),
    ],
    effects: ['Removes only recorded owned resources; external resource abandonment must be explicit.'],
    prerequisites: assistantPrerequisites,
    recovery: ['Rerun removal to continue its retained journal after fixing the stated blocker.'],
    examples: ['gws-ea remove --id <instance_id> --yes'],
    outputModes: managedModes,
    resultSchema: managedResultSchema(operationDataSchema('remove')),
  },
  {
    path: ['logs'],
    group: 'Advanced',
    handler: { kind: 'observation', command: 'logs' },
    summary: "Print or follow the assistant's raw host logs.",
    scope: 'assistant',
    options: [id, flag('errors', 'Read the host error log.'), flag('follow', 'Keep following the log stream.')],
    effects: ['Reads a recorded log file; follows it only when requested.'],
    prerequisites: [...assistantPrerequisites, 'A regular host log file.'],
    recovery: ['Inspect status if the selected log has not been created.'],
    examples: ['gws-ea logs --id <instance_id> --errors --follow'],
    outputModes: ['native'],
    resultSchema: nativeResult,
  },
  {
    path: ['ncl'],
    group: 'Advanced',
    handler: { kind: 'native', command: 'ncl' },
    summary: "Invoke the assistant's native NanoClaw administration CLI.",
    scope: 'assistant',
    options: [id],
    arguments: [
      { name: 'ncl arguments', description: 'Child arguments after -- are passed through unchanged.', variadic: true },
    ],
    passThrough: true,
    effects: [
      'The delegated ncl command owns its actions, output, and interactive behavior; outer --no-input does not control the child.',
    ],
    prerequisites: [...assistantPrerequisites, 'Created runtime and its native ncl executable.'],
    recovery: ["Use ncl's own help and flags for delegated command behavior."],
    examples: ['gws-ea ncl --id <instance_id> -- groups list --json'],
    outputModes: ['native'],
    resultSchema: nativeResult,
  },
  {
    path: ['cleanup'],
    group: 'Advanced',
    handler: { kind: 'attempt', command: 'cleanup' },
    summary: 'Remove a stray NanoClaw install from this tool checkout.',
    scope: 'tool-checkout',
    options: [],
    effects: [
      'Applies existing narrow ownership rules to the authoring checkout; create and update also perform this cleanup.',
    ],
    prerequisites: ['The launcher identifies the tool checkout and supplies its service helpers.'],
    recovery: ['Fix a reported ownership or teardown blocker, then rerun cleanup.'],
    examples: ['gws-ea cleanup'],
    outputModes: managedModes,
    resultSchema: managedResultSchema(operationDataSchema('cleanup')),
  },
  {
    path: ['install-voice'],
    group: 'Optional voice',
    handler: { kind: 'voice', command: 'install-voice' },
    summary: 'Build and select shared local voice assets, initially disabled.',
    scope: 'host',
    options: [
      {
        name: 'model',
        type: 'string',
        valueName: 'base|small|large-v3-turbo-q5_0',
        choices: ['base', 'small', 'large-v3-turbo-q5_0'],
        description: 'Voice model; defaults to large-v3-turbo-q5_0.',
      },
      value('cmake', '/absolute/path', 'Explicit CMake executable.'),
    ],
    effects: ['Downloads and builds shared host assets; installation leaves recognition disabled.'],
    prerequisites: ['Supported host and build tools; host-wide voice lock must be free.'],
    recovery: ['Rerun installation after fixing its reported asset or build blocker.'],
    examples: ['gws-ea install-voice --model large-v3-turbo-q5_0'],
    outputModes: managedModes,
    resultSchema: managedResultSchema(operationDataSchema('install-voice')),
  },
  ...(['enable-voice', 'disable-voice', 'uninstall-voice'] as const).map(
    (command): CommandDefinition => ({
      path: [command],
      group: 'Optional voice',
      handler: { kind: 'voice', command },
      scope: 'host',
      options: [],
      summary:
        command === 'enable-voice'
          ? 'Enable recognition for compatible current and future assistants.'
          : command === 'disable-voice'
            ? 'Stop new recognition while retaining shared assets.'
            : 'Remove recipe-owned shared assets after all consumers drain.',
      effects: [
        command === 'enable-voice'
          ? 'Enables shared voice host-wide.'
          : command === 'disable-voice'
            ? 'Disables new recognition; text service remains available.'
            : 'Removes recipe-owned assets only.',
      ],
      prerequisites: [
        command === 'enable-voice'
          ? 'Voice assets must already be installed.'
          : command === 'disable-voice'
            ? 'Host-wide voice lock must be free.'
            : 'Voice must be disabled and every consumer proven drained.',
      ],
      recovery: ["Follow the operation's reported asset, policy, or consumer blocker."],
      examples: [`gws-ea ${command}`],
      outputModes: managedModes,
      resultSchema: managedResultSchema(operationDataSchema(command)),
    }),
  ),
  ...(['help', 'schema'] as const).map(
    (command): CommandDefinition => ({
      path: [command],
      group: 'Discovery',
      handler: { kind: 'discovery', command },
      scope: 'local-interface',
      options: [],
      arguments: [{ name: 'command path', description: 'Optional exact command path to discover.', variadic: true }],
      summary:
        command === 'help'
          ? 'Explain the root interface or a selected command.'
          : 'Describe accepted commands and results as JSON.',
      effects: ['Reads only local interface definitions.'],
      prerequisites: command === 'schema' ? ['Pass --json.'] : [],
      recovery: ['Use an accepted command path.'],
      examples: [`gws-ea ${command} update${command === 'schema' ? ' --json' : ''}`],
      outputModes: command === 'help' ? ['human'] : ['json'],
      resultSchema:
        command === 'help'
          ? { type: 'string', description: 'Command help text.' }
          : {
              type: 'object',
              properties: { schema_version: { const: 1 }, commands: { type: 'array', items: { type: 'object' } } },
              required: ['schema_version', 'commands'],
            },
    }),
  ),
  {
    path: ['completion'],
    group: 'Discovery',
    handler: { kind: 'discovery', command: 'completion' },
    summary: 'Generate shell completion from the accepted grammar.',
    scope: 'local-interface',
    options: [],
    arguments: [
      {
        name: 'shell',
        description: 'Shell to generate completion for.',
        required: true,
        choices: ['zsh', 'bash', 'fish'],
      },
    ],
    effects: ['Prints a shell script; does not install or execute it.'],
    prerequisites: [],
    recovery: ['Select zsh, bash, or fish.'],
    examples: ['gws-ea completion zsh'],
    outputModes: ['shell'],
    resultSchema: { type: 'string', description: 'Shell completion script.' },
  },
  {
    path: ['--version'],
    group: 'Discovery',
    handler: { kind: 'discovery', command: 'version' },
    summary: 'Identify the tool package release and exact revision when available.',
    scope: 'local-interface',
    options: [],
    effects: ["Reads tool checkout metadata; this is distinct from an assistant's deployed release."],
    prerequisites: [],
    recovery: [],
    examples: ['gws-ea --version'],
    outputModes: ['human', 'json'],
    resultSchema: {
      type: 'object',
      properties: { tool: { const: 'gws-ea' }, version: { type: 'string' }, revision: { type: ['string', 'null'] } },
      required: ['tool', 'version', 'revision'],
    },
  },
];

/** Common flags share syntax; the selected command's output contract decides whether --json is accepted. */
export function optionsFor(command: CommandDefinition): readonly OptionDefinition[] {
  return [
    ...command.options,
    ...COMMON_OPTIONS.filter((option) => option.name !== 'json' || command.outputModes.includes('json')),
  ];
}

export function findCommand(path: readonly string[]): CommandDefinition | undefined {
  return COMMAND_DEFINITIONS.find(
    (command) => command.path.length === path.length && command.path.every((part, index) => part === path[index]),
  );
}
