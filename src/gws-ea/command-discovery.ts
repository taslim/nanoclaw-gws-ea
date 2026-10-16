import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  COMMAND_DEFINITIONS,
  COMMON_OPTIONS,
  optionsFor,
  type CommandDefinition,
  type DiscoveryTarget,
  type OptionDefinition,
} from './command-definitions.js';
import { buildToolEnvironment, runSanitizedCommand } from './process.js';
import { GwsEaError } from './types.js';

function optionUsage(option: OptionDefinition): string {
  const text = `--${option.name}${option.type === 'string' ? ` <${option.valueName}>` : ''}${option.repeatable ? '...' : ''}`;
  return option.required ? text : `[${text}]`;
}

function commandUsage(command: CommandDefinition): string {
  const args = (command.arguments ?? []).map((argument) => {
    const value = `<${argument.name}>${argument.variadic ? '...' : ''}`;
    return argument.required ? value : `[${value}]`;
  });
  return [
    command.path.join(' '),
    ...command.options.map(optionUsage),
    ...(command.passThrough ? ['--'] : []),
    ...args,
  ].join(' ');
}

/** Human discovery is rendered directly from the same definitions as parsing. */
export function helpLines(command?: DiscoveryTarget): readonly string[] {
  if (!command) {
    return [
      'Usage: gws-ea <command> [options]',
      'Operate managed Google Workspace assistants and their optional capabilities.',
      ...(['Assistants', 'Service', 'Advanced', 'Capabilities', 'Discovery'] as const).flatMap((group) => [
        '',
        `${group}:`,
        ...COMMAND_DEFINITIONS.filter((definition) => definition.group === group).map(
          (definition) => `  ${definition.path.join(' ')}  ${definition.summary}`,
        ),
      ]),
      '',
      'Common options (before or after a command path; stop at --):',
      ...COMMON_OPTIONS.map((option) => `  ${optionUsage(option)}  ${option.description}`),
      '  --version  Identify this tool release and exact revision when available.',
      '',
      'Examples:',
      '  gws-ea create --track dogfood',
      '  gws-ea list',
      '  gws-ea help update',
      '  gws-ea schema --json',
      '',
      'Exit codes: 0 completed or declined; 1 operational failure; 2 invalid invocation;',
      '  10 human prerequisite; 75 busy; 128 + signal interrupted. ncl and logs retain native exits.',
    ];
  }
  if ('commands' in command)
    return [
      `Usage: gws-ea ${command.path.join(' ')} <action> [options]`,
      'Operate optional capabilities. Assistant-scoped browser commands require an explicit --id; voice and 1Password are host-wide.',
      '',
      'Scope: each registered command declares host or assistant ownership.',
      'Commands:',
      ...command.commands.map((definition) => `  ${definition.path.join(' ')}  ${definition.summary}`),
      '',
      `Run gws-ea help ${command.path.join(' ')} <action> for effects, prerequisites, and recovery.`,
    ];
  return [
    `Usage: gws-ea ${commandUsage(command)}`,
    command.summary,
    '',
    `Scope: ${command.scope}`,
    'Effects:',
    ...command.effects.map((line) => `  ${line}`),
    'Prerequisites:',
    ...(command.prerequisites.length
      ? command.prerequisites
      : ['No cloud login, running assistant, or runtime secrets required.']
    ).map((line) => `  ${line}`),
    'Recovery:',
    ...(command.recovery.length ? command.recovery : ['No runtime operation to resume.']).map((line) => `  ${line}`),
    '',
    'Options:',
    ...optionsFor(command).map((option) => `  ${optionUsage(option)}  ${option.description}`),
    ...(command.arguments?.length
      ? ['Arguments:', ...command.arguments.map((argument) => `  ${argument.name}  ${argument.description}`)]
      : []),
    `Output modes: ${command.outputModes.join(', ')}`,
    '',
    'Examples:',
    ...command.examples.map((line) => `  ${line}`),
  ];
}

export function schemaDocument(command?: DiscoveryTarget) {
  return {
    schema_version: 1,
    tool: 'gws-ea',
    commands: (command ? ('commands' in command ? command.commands : [command]) : COMMAND_DEFINITIONS).map(
      (definition) => ({
        path: definition.path,
        summary: definition.summary,
        arguments: (definition.arguments ?? []).map((argument) => ({
          ...argument,
          type: 'string',
          repeatable: argument.variadic ?? false,
          required: argument.required ?? false,
          variadic: argument.variadic ?? false,
        })),
        options: optionsFor(definition).map((option) => ({
          ...option,
          required: option.required ?? false,
          repeatable: option.repeatable ?? false,
        })),
        scope: definition.scope,
        effects: definition.effects,
        prerequisites: definition.prerequisites,
        recovery: definition.recovery,
        examples: definition.examples,
        output_modes: definition.outputModes,
        result_schema: definition.resultSchema,
        pass_through: definition.passThrough ?? false,
      }),
    ),
  };
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

type Shell = 'bash' | 'zsh' | 'fish';
interface CompletionState {
  readonly children: Set<string>;
  readonly command?: CommandDefinition;
  readonly discovery?: CommandDefinition;
}

/** Paths, including scoped help/schema paths, come only from the registered grammar. */
function completionStates(): ReadonlyMap<string, CompletionState> {
  const states = new Map<string, CompletionState>([['', { children: new Set() }]]);
  const add = (path: readonly string[], command: CommandDefinition, discovery?: CommandDefinition): void => {
    for (let length = 0; length <= path.length; length += 1) {
      const prefix = path.slice(0, length).join(' ');
      const state = states.get(prefix) ?? { children: new Set<string>(), ...(discovery ? { discovery } : {}) };
      if (length < path.length) state.children.add(path[length]);
      states.set(prefix, length === path.length ? { ...state, command, ...(discovery ? { discovery } : {}) } : state);
    }
  };
  for (const command of COMMAND_DEFINITIONS) add(command.path, command);
  for (const discovery of COMMAND_DEFINITIONS.filter(
    (command) => command.handler.kind === 'discovery' && ['help', 'schema'].includes(command.handler.command),
  ))
    for (const command of COMMAND_DEFINITIONS) add([...discovery.path, ...command.path], command, discovery);
  return states;
}

function completionOptions(state: CompletionState): readonly OptionDefinition[] {
  return state.discovery ? optionsFor(state.discovery) : state.command ? optionsFor(state.command) : COMMON_OPTIONS;
}
function positionalChoices(state: CompletionState): readonly string[] {
  return state.discovery ? [] : (state.command?.arguments?.[0]?.choices ?? []);
}

/** Each shell consumes option values before following command words; -- terminates outer completion. */
function wordCompletion(shell: Exclude<Shell, 'fish'>): string {
  const bash = shell === 'bash';
  const states = completionStates();
  const stringOptions = [...states].flatMap(([state, definition]) =>
    completionOptions(definition)
      .filter((option) => option.type === 'string')
      .map((option) => ({ state, option })),
  );
  return [
    ...(bash ? [] : ['#compdef gws-ea']),
    '_gws_ea() {',
    '  local command="" word current choices="" i pending="" equals_prefix="" kind="" positionals=0',
    bash ? '  current="${COMP_WORDS[COMP_CWORD]}"; COMPREPLY=()' : '  current="${words[CURRENT]}"',
    bash ? '  for ((i=1; i<COMP_CWORD; i++)); do' : '  for ((i=2; i<CURRENT; i++)); do',
    bash ? '    word="${COMP_WORDS[i]}"' : '    word="${words[i]}"',
    '    [[ "$word" == -- ]] && return 0',
    '    if [[ -n "$pending" ]]; then [[ "$word" == = ]] && continue; pending=""; continue; fi',
    '    [[ "$word" == --*=* ]] && continue',
    '    case "$command:$word" in',
    ...stringOptions.map(
      ({ state, option }) =>
        `      ${quote(`${state}:--${option.name}`)}) pending=${quote(`--${option.name}`)}; continue ;;`,
    ),
    '    esac',
    '    case "$command${command:+ }$word" in',
    ...[...states.keys()]
      .filter(Boolean)
      .map((state) => `      ${quote(state)}) command=${quote(state)}; positionals=0 ;;`),
    '      *) [[ "$word" == -* ]] || ((positionals+=1)) ;;',
    '    esac',
    '  done',
    '  if [[ "$current" == --*=* ]]; then pending="${current%%=*}"; equals_prefix="$pending="; current="${current#*=}"; fi',
    '  if [[ -n "$pending" ]]; then',
    '    case "$command:$pending" in',
    ...stringOptions.map(
      ({ state, option }) =>
        `      ${quote(`${state}:--${option.name}`)}) choices=${quote(option.type === 'string' ? (option.choices ?? []).join(' ') : '')}; kind=${quote(option.type === 'string' && option.valueKind === 'file' ? 'file' : 'value')} ;;`,
    ),
    '    esac',
    '  else',
    '    case "$command" in',
    ...[...states].map(
      ([state, definition]) =>
        `      ${quote(state)}) choices=${quote([...definition.children, ...completionOptions(definition).map((option) => `--${option.name}`)].join(' '))}${positionalChoices(definition).length ? `; [[ "$positionals" == 0 ]] && choices="$choices ${positionalChoices(definition).join(' ')}"` : ''} ;;`,
    ),
    '    esac',
    '  fi',
    ...(bash
      ? [
          '  if [[ "$kind" == file ]]; then',
          '    while IFS= read -r word; do COMPREPLY+=("$equals_prefix$word"); done < <(compgen -f -- "$current")',
          '    compopt -o filenames 2>/dev/null || true',
          '  else',
          '    while IFS= read -r word; do COMPREPLY+=("$equals_prefix$word"); done < <(compgen -W "$choices" -- "$current")',
          '  fi',
        ]
      : [
          '  if [[ "$kind" == file ]]; then _files -P "$equals_prefix"; return; fi',
          '  local -a suggestions',
          '  suggestions=( ${(z)choices} )',
          '  compadd -P "$equals_prefix" -- "${suggestions[@]}"',
        ]),
    '}',
    bash ? 'complete -o filenames -F _gws_ea gws-ea' : 'compdef _gws_ea gws-ea',
  ].join('\n');
}

function fishCompletion(): string {
  const states = completionStates();
  const key = (state: string): string => state || 'root';
  const lines = [
    'function __gws_ea_context',
    '  set -l words (commandline -opc)',
    '  set -l state root; set -l pending -; set -l positionals 0',
    '  for word in $words[2..-1]',
    '    test "$word" = --; and return 1',
    '    if test "$pending" != -; set pending -; continue; end',
    "    string match -q -- '--*=*' $word; and continue",
    '    switch "$state:$word"',
    ...[...states].flatMap(([state, definition]) =>
      completionOptions(definition)
        .filter((option) => option.type === 'string')
        .map(
          (option) =>
            `      case ${quote(`${key(state)}:--${option.name}`)}; set pending ${quote(option.name)}; continue`,
        ),
    ),
    '    end',
    '    set -l candidate $word',
    '    test "$state" != root; and set candidate "$state $word"',
    '    switch $candidate',
    ...[...states.keys()]
      .filter(Boolean)
      .map((state) => `      case ${quote(state)}; set state ${quote(state)}; set positionals 0`),
    "      case '*'; string match -q -- '-*' $word; or set positionals (math $positionals + 1)",
    '    end',
    '  end',
    '  printf "%s\\n" "$state" "$pending" "$positionals"',
    'end',
    'function __gws_ea_at',
    '  set -l context (__gws_ea_context)',
    '  test (count $context) -eq 3; or return 1',
    '  test "$context[1]" = "$argv[1]"; and begin; test "$context[2]" = -; or test "$argv[2]" = value; end',
    'end',
    'function __gws_ea_argument',
    '  __gws_ea_at $argv[1]; or return 1',
    '  set -l context (__gws_ea_context)',
    '  test "$context[3]" = 0',
    'end',
    'complete -c gws-ea -f',
  ];
  for (const [state, definition] of states) {
    const condition = `__gws_ea_at ${quote(key(state))}`;
    for (const child of definition.children) lines.push(`complete -c gws-ea -n ${quote(condition)} -a ${quote(child)}`);
    for (const option of completionOptions(definition)) {
      lines.push(`# ${state} --${option.name}`);
      lines.push(
        `complete -c gws-ea -n ${quote(`${condition} value`)} -l ${quote(option.name)}${option.type === 'boolean' && option.short ? ` -s ${quote(option.short)}` : ''}${option.type === 'string' ? ` -r${option.valueKind === 'file' ? ' -F' : ''}${option.choices ? ` -a ${quote(option.choices.join(' '))}` : ''}` : ''} -d ${quote(option.description)}`,
      );
    }
    if (positionalChoices(definition).length)
      lines.push(
        `complete -c gws-ea -n ${quote(`__gws_ea_argument ${quote(key(state))}`)} -a ${quote(positionalChoices(definition).join(' '))}`,
      );
  }
  return lines.join('\n');
}

export function completionScript(shell: string): string {
  switch (shell) {
    case 'bash':
      return wordCompletion('bash');
    case 'zsh':
      return wordCompletion('zsh');
    case 'fish':
      return fishCompletion();
    default:
      throw new GwsEaError('invalid_arguments', 'shell must be zsh, bash, fish.');
  }
}

/** Always identifies the source checkout of this tool, never a managed assistant's deployed checkout. */
export async function toolVersion(): Promise<{
  readonly tool: 'gws-ea';
  readonly version: string;
  readonly revision: string | null;
}> {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const manifest: unknown = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('version' in manifest) ||
    typeof manifest.version !== 'string'
  )
    throw new GwsEaError('tool_version_unavailable', 'Tool package metadata does not contain a version.');
  let revision: string | null = null;
  try {
    const result = await runSanitizedCommand({
      command: 'git',
      args: ['rev-parse', 'HEAD'],
      cwd: root,
      env: buildToolEnvironment(process.env),
      timeoutMs: 5_000,
    });
    const commit = result.stdout.trim();
    if (/^[a-f0-9]{40,64}$/u.test(commit)) revision = commit;
  } catch (error) {
    if (!(error instanceof GwsEaError)) throw error;
    // A packaged source tree can lack Git; the package release remains an actual release fact.
  }
  return { tool: 'gws-ea', version: manifest.version, revision };
}
