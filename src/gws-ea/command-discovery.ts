import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  COMMAND_DEFINITIONS,
  COMMON_OPTIONS,
  optionsFor,
  type CommandDefinition,
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
export function helpLines(command?: CommandDefinition): readonly string[] {
  if (!command) {
    return [
      'Usage: gws-ea <command> [options]',
      'Operate managed Google Workspace assistants and their optional host capabilities.',
      ...(['Assistants', 'Service', 'Advanced', 'Optional voice', 'Discovery'] as const).flatMap((group) => [
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

export function schemaDocument(command?: CommandDefinition) {
  return {
    schema_version: 1,
    tool: 'gws-ea',
    commands: (command ? [command] : COMMAND_DEFINITIONS).map((definition) => ({
      path: definition.path,
      summary: definition.summary,
      arguments: (definition.arguments ?? []).map((argument) => ({
        ...argument,
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
    })),
  };
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Command candidates and option-value choices are derived, never maintained as separate shell inventories. */
function candidates(command: CommandDefinition): readonly string[] {
  return [
    ...optionsFor(command).map((option) => `--${option.name}`),
    ...(command.arguments?.[0]?.choices ?? []),
    ...(command.handler.kind === 'discovery' &&
    (command.handler.command === 'help' || command.handler.command === 'schema')
      ? COMMAND_DEFINITIONS.map((definition) => definition.path.join(' '))
      : []),
  ];
}

type Shell = 'bash' | 'zsh' | 'fish';

/** Every prefix comes from a registered path, including paths added by the capability catalog. */
function commandPrefixes(): ReadonlyMap<string, readonly string[]> {
  const prefixes = new Map<string, Set<string>>();
  for (const command of COMMAND_DEFINITIONS) {
    for (let length = 0; length < command.path.length; length += 1) {
      const prefix = command.path.slice(0, length).join(' ');
      const children = prefixes.get(prefix) ?? new Set<string>();
      children.add(command.path[length]);
      prefixes.set(prefix, children);
    }
    if (!prefixes.has(command.path.join(' '))) prefixes.set(command.path.join(' '), new Set());
  }
  return new Map([...prefixes].map(([prefix, children]) => [prefix, [...children]]));
}

function prefixCandidates(prefix: string, children: readonly string[]): readonly string[] {
  const command = COMMAND_DEFINITIONS.find((definition) => definition.path.join(' ') === prefix);
  return command
    ? [...children, ...candidates(command)]
    : [...children, ...COMMON_OPTIONS.map((option) => `--${option.name}`)];
}

function wordCompletion(shell: Exclude<Shell, 'fish'>): string {
  const bash = shell === 'bash';
  const prefixes = commandPrefixes();
  const lines = [
    ...(bash ? [] : ['#compdef gws-ea']),
    '_gws_ea() {',
    '  local command="" word prev current choices="" i equals_prefix=""',
    bash
      ? '  current="${COMP_WORDS[COMP_CWORD]}"; prev="${COMP_WORDS[COMP_CWORD-1]}"'
      : '  current="${words[CURRENT]}"; prev="${words[CURRENT-1]}"',
    bash ? '  COMPREPLY=()' : '',
    bash ? '  for ((i=1; i<COMP_CWORD; i++)); do' : '  for ((i=2; i<CURRENT; i++)); do',
    bash ? '    word="${COMP_WORDS[i]}"' : '    word="${words[i]}"',
    '    [[ "$word" == -- ]] && return 0',
    '    case "$command${command:+ }$word" in',
    ...[...prefixes.keys()].filter(Boolean).map((prefix) => `      ${quote(prefix)}) command=${quote(prefix)} ;;`),
    '    esac',
    '  done',
    '  if [[ "$current" == --*=* ]]; then',
    '    prev="${current%%=*}"; equals_prefix="$prev="; current="${current#*=}"',
    '  fi',
    '  case "$command:$prev" in',
    ...COMMAND_DEFINITIONS.flatMap((command) =>
      optionsFor(command)
        .filter((option) => option.type === 'string')
        .map(
          (option) =>
            `    ${quote(`${command.path.join(' ')}:--${option.name}`)}) choices=${quote(option.type === 'string' ? (option.choices ?? []).join(' ') : '')} ;;`,
        ),
    ),
    '    *)',
    '      [[ -n "$equals_prefix" ]] && return 0',
    '      case "$command" in',
    ...[...prefixes].map(
      ([prefix, children]) =>
        `        ${quote(prefix)}) choices=${quote(prefixCandidates(prefix, children).join(' '))} ;;`,
    ),
    '      esac ;;',
    '  esac',
    ...(bash
      ? [
          '  while IFS= read -r word; do COMPREPLY+=("$equals_prefix$word"); done < <(compgen -W "$choices" -- "$current")',
        ]
      : [
          '  local -a suggestions',
          '  suggestions=( ${(z)choices} )',
          '  compadd -P "$equals_prefix" -- "${suggestions[@]}"',
        ]),
    '}',
    bash ? 'complete -F _gws_ea gws-ea' : 'compdef _gws_ea gws-ea',
  ];
  return lines.filter(Boolean).join('\n');
}

function fishCompletion(): string {
  const prefixes = commandPrefixes();
  const lines = [
    'function __gws_ea_path',
    '  set -l words (commandline -opc)',
    '  set -l path ""',
    '  contains -- -- $words; and return 1',
    '  for word in $words[2..-1]',
    '    set -l candidate $word',
    '    if test -n "$path"; set candidate "$path $word"; end',
    '    switch $candidate',
    ...[...prefixes.keys()]
      .filter(Boolean)
      .map((prefix) => `      case ${quote(prefix)}\n        set path ${quote(prefix)}`),
    '    end',
    '  end',
    '  if test -n "$path"; echo "$path"; end',
    'end',
    'complete -c gws-ea -f',
  ];
  for (const [prefix, children] of prefixes) {
    const condition = `not contains -- -- (commandline -opc); and ${prefix ? `contains -- ${quote(prefix)} (__gws_ea_path)` : 'test (count (__gws_ea_path)) -eq 0'}`;
    for (const child of children) {
      const fullPath = [prefix, child].filter(Boolean).join(' ');
      const command = COMMAND_DEFINITIONS.find((definition) => definition.path.join(' ') === fullPath);
      lines.push(
        `complete -c gws-ea -n ${quote(condition)} -a ${quote(child)}${command ? ` -d ${quote(command.summary)}` : ''}`,
      );
    }
    const command = COMMAND_DEFINITIONS.find((definition) => definition.path.join(' ') === prefix);
    for (const option of command ? optionsFor(command) : COMMON_OPTIONS) {
      lines.push(`# ${prefix} --${option.name}`);
      lines.push(
        `complete -c gws-ea -n ${quote(condition)} -l ${quote(option.name)}${option.type === 'boolean' && option.short ? ` -s ${quote(option.short)}` : ''}${option.type === 'string' ? ` -r${option.choices ? ` -a ${quote(option.choices.join(' '))}` : ''}` : ''} -d ${quote(option.description)}`,
      );
    }
    if (command) {
      const positionals = candidates(command).filter((candidate) => !candidate.startsWith('--'));
      if (positionals.length)
        lines.push(`complete -c gws-ea -n ${quote(condition)} -a ${quote(positionals.join(' '))}`);
    }
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
