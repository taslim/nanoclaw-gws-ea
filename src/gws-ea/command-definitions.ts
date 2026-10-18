import { VOICE_CAPABILITY } from './capabilities.js';
import { BROWSER_CAPABILITY } from './browser-capability.js';
import { MANAGEMENT_TARGET, ONEPASSWORD_CAPABILITY } from './onepassword.js';
import {
  managedResultSchema,
  operationDataSchema,
  LIST_DATA_SCHEMA,
  STATUS_DATA_SCHEMA,
  CAPABILITY_LIST_SCHEMA,
  VOICE_CAPABILITY_SCHEMA,
  VOICE_OPERATION_SCHEMA,
  BROWSER_CAPABILITY_SCHEMA,
  BROWSER_OPERATION_SCHEMA,
  ONEPASSWORD_CAPABILITY_SCHEMA,
  ONEPASSWORD_DISABLE_SCHEMA,
  ONEPASSWORD_OPERATION_SCHEMA,
} from './result-schema.js';
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
  | {
      readonly kind: 'capability';
      readonly command: 'list' | 'show' | 'check' | 'install' | 'enable' | 'disable' | 'uninstall';
      readonly name?: 'browser' | 'onepassword';
    }
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
  | (OptionBase & {
      readonly type: 'string';
      readonly valueName: string;
      readonly valueKind?: 'file';
      readonly choices?: readonly string[];
    });

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
  readonly group: 'Assistants' | 'Service' | 'Advanced' | 'Capabilities' | 'Discovery';
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

const value = (
  name: string,
  valueName: string,
  description: string,
  required = false,
): Extract<OptionDefinition, { readonly type: 'string' }> => ({
  name,
  type: 'string',
  valueName,
  description,
  required,
});
const flag = (name: string, description: string): OptionDefinition => ({ name, type: 'boolean', description });
const id = value('id', 'instance_id', 'The full assistant ID; never inferred from the registry.', true);
const yes = flag('yes', "Supply this command's defined confirmation; never substitutes for OAuth consent.");
const secrets: OptionDefinition = {
  ...value('secrets-file', 'file', 'Owner-only file under the config root containing GWS_EA_PROVIDER_CREDENTIAL.'),
  valueKind: 'file',
};
const googleClient: OptionDefinition = {
  ...value('google-client-file', 'file', "Desktop OAuth client downloaded for the assistant's Google sign-in."),
  valueKind: 'file',
};
/** The operator's word on the assistant's web alias (KTD13), wherever its setup step runs. */
const aliasOptions: readonly OptionDefinition[] = [
  flag('alias-added', 'Confirm the offered web alias is added in the Google Admin console; sends it a test message.'),
  flag('alias-taken', 'The Admin console refused the offered web alias as already in use; offer the next name.'),
  value('alias', 'name', "Use this name, or whole address, for the assistant's web alias instead of the offered one."),
];
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
      'Automatically removes a stray NanoClaw install from this authoring checkout, within its existing ownership rules.',
      'Reserves owned resources and journals provisioning; creation can pause for a person.',
    ],
    prerequisites: [
      'Supported host, Docker, Google Cloud and Workspace access, and provider credentials.',
      '--google-account is the operator managing Cloud resources; --assistant-workspace-email is the assistant account receiving mail and Chat.',
      '--principal-email names the person served, once per address; --principal-chat-email selects their Chat address from that list.',
      '--provider selects the agent runtime; its credential identity is independent of the Google identities.',
    ],
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
    options: [id, flag('details', 'Include technical probes, fingerprints, and diagnostics.')],
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
      ...aliasOptions,
      secrets,
    ],
    effects: [
      'Continues journaled provisioning and its pending human step.',
      "Then sets up an enabled browser's web alias, verifying it with a test message once it is added.",
    ],
    prerequisites: assistantPrerequisites,
    recovery: ["Rerun resume with the pause's supplied inputs, or remove the partially created assistant."],
    examples: ['gws-ea resume --id <instance_id> --chat-configured', 'gws-ea resume --id <instance_id> --alias-added'],
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
      'Automatically removes a stray NanoClaw install from this authoring checkout, within its existing ownership rules.',
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
      flag(
        'delete-vault',
        "Also delete the assistant's 1Password vault with every item it holds, when this host created it; an empty one is deleted without this flag.",
      ),
      value(
        'abandon',
        'gcp-project,chat-subscription,onepassword',
        'Explicit owned external resources removal may leave behind when they cannot be observed; onepassword also closes the receipt naming service accounts you revoked.',
      ),
    ],
    effects: [
      'Removes only recorded owned resources; external resource abandonment must be explicit.',
      "Deletes the assistant's 1Password runtime token after its host stops; deletes its vault only when this host's management service account created it and it is empty or --delete-vault was confirmed, and never another vault.",
      'Never revokes a service account: the receipt outside the instance keeps their IDs for you to revoke on 1Password.com.',
    ],
    prerequisites: [
      ...assistantPrerequisites,
      '--delete-vault needs the 1Password CLI this host recorded and the management service account that created the vault; without them removal pauses before any change.',
    ],
    recovery: [
      'Rerun removal to continue its retained journal after fixing the stated blocker.',
      'After revoking the service accounts it names on 1Password.com, close the kept receipt with gws-ea remove --id <instance_id> --yes --abandon onepassword.',
    ],
    examples: ['gws-ea remove --id <instance_id> --yes', 'gws-ea remove --id <instance_id> --delete-vault'],
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
  ...(['list', ...VOICE_CAPABILITY.actions] as const).map((command): CommandDefinition => {
    if (command === 'list' || command === 'show' || command === 'check')
      return {
        path: ['capabilities', command],
        group: 'Capabilities',
        handler: { kind: 'capability', command },
        summary:
          command === 'list'
            ? 'List optional capabilities, their ownership, and observed state.'
            : command === 'show'
              ? 'Show voice scope, assets, compatibility, prerequisites, and readiness limits.'
              : 'Verify selected voice assets and observe managed consumers without changing state.',
        scope: 'host',
        options: [],
        ...(command === 'list'
          ? {}
          : {
              arguments: [
                {
                  name: 'capability',
                  description: 'Shipped capability to inspect.',
                  required: true,
                  choices: [VOICE_CAPABILITY.name],
                },
              ],
            }),
        effects: [
          command === 'check'
            ? 'Read-only asset verification and bounded native voice health probes; no downloads, enablement, restart, or recording processing.'
            : 'Read-only local capability and release inspection; consumer readiness requires check.',
        ],
        prerequisites: observationPrerequisites,
        recovery: ['Inspect capability facts; use its explicit install, enable, disable, or uninstall action.'],
        examples: [`gws-ea capabilities ${command}${command === 'list' ? '' : ' voice'} --json`],
        outputModes: managedModes,
        resultSchema: managedResultSchema(command === 'list' ? CAPABILITY_LIST_SCHEMA : VOICE_CAPABILITY_SCHEMA),
      };
    if (command === 'install')
      return {
        path: ['capabilities', 'install'],
        group: 'Capabilities',
        handler: { kind: 'capability', command: 'install' },
        summary: 'Build and select shared local voice assets, initially disabled.',
        scope: 'host',
        arguments: [
          {
            name: 'capability',
            description: 'Shipped capability to install.',
            required: true,
            choices: [VOICE_CAPABILITY.name],
          },
        ],
        options: [
          {
            name: 'model',
            type: 'string',
            valueName: 'base|small|large-v3-turbo-q5_0',
            choices: VOICE_CAPABILITY.models,
            description: `Voice model; defaults to ${VOICE_CAPABILITY.default_model}.`,
          },
          { ...value('cmake', '/absolute/path', 'Explicit CMake executable.'), valueKind: 'file' },
        ],
        effects: [
          'Downloads and builds pinned shared host assets; installation leaves recognition disabled.',
          'Verifies and reuses a valid existing installation without downloads.',
        ],
        prerequisites: VOICE_CAPABILITY.prerequisites,
        recovery: [
          'Preflight identifies the failed tool and manual repair; system tools are never installed automatically.',
          'Download/build failures retain private run/step logs and a retry preserving --model and --cmake.',
          'For corrupt assets: capabilities disable voice, capabilities uninstall voice, then capabilities install voice with the original --model.',
        ],
        examples: ['gws-ea capabilities install voice --model large-v3-turbo-q5_0'],
        outputModes: managedModes,
        resultSchema: managedResultSchema(VOICE_OPERATION_SCHEMA),
      };
    return {
      path: ['capabilities', command],
      group: 'Capabilities',
      handler: { kind: 'capability', command },
      scope: 'host',
      options: [],
      arguments: [
        {
          name: 'capability',
          description: 'Shipped capability to operate.',
          required: true,
          choices: [VOICE_CAPABILITY.name],
        },
      ],
      summary:
        command === 'enable'
          ? 'Enable voice for compatible current and future assistants.'
          : command === 'disable'
            ? 'Prevent new recognition while retaining shared assets.'
            : 'Remove recipe-owned voice assets after managed consumers drain.',
      effects: [
        command === 'enable'
          ? 'Enables voice host-wide; recognition success is not established.'
          : command === 'disable'
            ? 'Disables new recognition; existing preparation finishes and assets remain.'
            : 'Removes recipe-owned assets only; unreachable consumers do not prove drainage.',
      ],
      prerequisites: [
        command === 'enable'
          ? 'Valid recipe-owned voice assets must already be installed.'
          : command === 'disable'
            ? 'Host-wide voice lock must be free.'
            : 'Voice must be disabled, every managed consumer proven drained, and recipe-owned files have no open holders.',
      ],
      recovery: ['Follow the reported policy, asset, or consumer blocker; check observes readiness without repair.'],
      examples: [`gws-ea capabilities ${command} voice`],
      outputModes: managedModes,
      resultSchema: managedResultSchema(VOICE_OPERATION_SCHEMA),
    };
  }),
  ...BROWSER_CAPABILITY.actions.map(
    (command): CommandDefinition => ({
      path: ['capabilities', command, 'browser'],
      group: 'Capabilities',
      handler: { kind: 'capability', command, name: 'browser' },
      scope: 'assistant',
      summary:
        command === 'show'
          ? 'Show one assistant’s browser policy and prerequisites.'
          : command === 'check'
            ? 'Check Chrome and agent-network isolation without changing state.'
            : command === 'enable'
              ? 'Enable one assistant’s host browser; it signs in with emailed codes and links, and its 1Password vault once provisioned.'
              : 'Disable one assistant’s browser.',
      options: command === 'enable' ? [id, ...aliasOptions] : [id],
      effects:
        command === 'show' || command === 'check'
          ? [
              'Read-only observation; no policy writes, downloads, service changes, or host reconciliation.',
              ...(command === 'check'
                ? [
                    'Runs a bounded temporary container on the assistant network using its existing release image; never pulls an image.',
                  ]
                : []),
            ]
          : command === 'enable'
            ? [
                'Writes the enabled owner-only instance policy; host reconciliation activates the browser.',
                "Then sets up the assistant's web alias: pauses until it is added in the Google Admin console, and verifies it with a test message.",
              ]
            : [
                'Writes disabled policy; the host stops jobs and withdraws cards on reconciliation, including after restart.',
              ],
      prerequisites: [
        'An explicitly named managed assistant with a readable runtime record.',
        'Google Chrome at its absolute configured path on the host.',
      ],
      recovery: [
        'Inspect capabilities check browser --id <instance_id>; restore any reported Chrome, policy, host or Docker prerequisite.',
      ],
      examples: [
        `gws-ea capabilities ${command} browser --id <instance_id>`,
        ...(command === 'enable' ? ['gws-ea capabilities enable browser --id <instance_id> --alias-added'] : []),
      ],
      outputModes: managedModes,
      resultSchema: managedResultSchema(
        command === 'show' || command === 'check' ? BROWSER_CAPABILITY_SCHEMA : BROWSER_OPERATION_SCHEMA,
      ),
    }),
  ),
  ...ONEPASSWORD_CAPABILITY.actions.map(
    (command): CommandDefinition => ({
      path: ['capabilities', command, 'onepassword'],
      group: 'Capabilities',
      handler: { kind: 'capability', command, name: 'onepassword' },
      scope: 'host',
      summary:
        command === 'show'
          ? 'Show the 1Password account, management identity and each assistant’s recorded vault.'
          : command === 'check'
            ? 'Verify each assistant’s vault access and the account’s shared request usage.'
            : command === 'enable'
              ? 'Provision one vault and runtime service account for every compatible current and future assistant.'
              : 'Stop every assistant’s vault use and delete its runtime token, keeping vaults and their IDs.',
      options:
        command === 'enable'
          ? [
              value(
                'account',
                'account_id',
                'The exact 1Password account assistants use; needed only before the host has one.',
              ),
              value(
                'discard-unproven',
                `instance_id|${MANAGEMENT_TARGET}`,
                'After deleting or revoking what an interrupted creation may have left in 1Password, forget that attempt.',
              ),
            ]
          : [],
      effects:
        command === 'show'
          ? ['Read-only local records; no 1Password request, prompt or repair.']
          : command === 'check'
            ? [
                'Read-only service-account requests: identities, one vault read per assistant and the shared usage; each counts against the account limit.',
                'Never prompts the operator, writes to a vault or repairs anything.',
              ]
            : command === 'disable'
              ? [
                  'Publishes the disabled intent first: running and restarted hosts refuse every vault listing, fill, disclosure, write and share.',
                  'Then deletes each assistant’s runtime token from this host; vaults, their items, recorded IDs, unfinished credential attempts and the management service account stay.',
                  'Makes no 1Password request and revokes nothing: the result names each runtime service account to revoke on 1Password.com.',
                ]
              : [
                  "Verifies the operator's 1Password desktop sign-in, which may ask for approval in the app.",
                  'Creates or reuses the host management service account and records the host policy.',
                  'Creates a vault for each compatible assistant, running or stopped, and mints its runtime service account; never starts Chrome or a service.',
                  'Keeps finished assistants on a partial run; a retry continues only what is incomplete.',
                  'After a disable, reuses each vault and mints a replacement runtime service account, naming the earlier ones to revoke.',
                ],
      prerequisites:
        command === 'enable'
          ? [...ONEPASSWORD_CAPABILITY.prerequisites]
          : command === 'disable'
            ? ['The host 1Password lock and every assistant’s instance lock must be free.']
            : ['A readable managed registry; check also needs the CLI the host recorded.'],
      recovery: [
        command === 'disable'
          ? 'Rerun capabilities disable onepassword after a refusal; it continues deleting the tokens that remain. Enable again with capabilities enable onepassword.'
          : 'Follow the reported per-assistant cause; rerun capabilities enable onepassword to continue, or --discard-unproven after removing what an interrupted creation left.',
      ],
      examples: [
        command === 'enable'
          ? 'gws-ea capabilities enable onepassword --account <account_id>'
          : `gws-ea capabilities ${command} onepassword --json`,
      ],
      outputModes: managedModes,
      resultSchema: managedResultSchema(
        command === 'enable'
          ? ONEPASSWORD_OPERATION_SCHEMA
          : command === 'disable'
            ? ONEPASSWORD_DISABLE_SCHEMA
            : ONEPASSWORD_CAPABILITY_SCHEMA,
      ),
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

/** Namespaces are derived from registered leaves, never fake operations. */
export interface CommandNamespace {
  readonly path: readonly string[];
  readonly commands: readonly CommandDefinition[];
}
export type DiscoveryTarget = CommandDefinition | CommandNamespace;
export function findNamespace(path: readonly string[]): CommandNamespace | undefined {
  const commands = COMMAND_DEFINITIONS.filter(
    (command) => command.path.length > path.length && path.every((part, index) => command.path[index] === part),
  );
  return path.length > 0 && commands.length > 0 ? { path, commands } : undefined;
}
