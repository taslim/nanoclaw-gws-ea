import { GwsEaError } from './types.js';
import { INSTANCE_ID_PATTERN } from './validation.js';
import {
  COMMAND_DEFINITIONS,
  COMMON_OPTIONS,
  findCommand,
  findNamespace,
  optionsFor,
  type CommandDefinition,
  type DiscoveryTarget,
  type OptionDefinition,
} from './command-definitions.js';

/** Switches hold 'true'; repeatable options are in `repeated` instead, in input order. */
export type CommandOptions = Readonly<Record<string, string>>;
export interface ParsedOptions {
  readonly options: CommandOptions;
  readonly repeated: Readonly<Record<string, readonly string[]>>;
}
export interface ParsedInvocation extends ParsedOptions {
  readonly definition: CommandDefinition;
  readonly arguments: readonly string[];
  readonly passThrough: readonly string[];
  /** The tokens before `--`, without the command path, so a retry can parse the same invocation again. */
  readonly commandArgs: readonly string[];
  readonly help: boolean;
}

function invalid(message: string): never {
  throw new GwsEaError('invalid_arguments', message);
}

interface MutableOptions {
  readonly options: Record<string, string>;
  readonly repeated: Record<string, string[]>;
}

function consumeOption(
  args: readonly string[],
  index: number,
  definitions: readonly OptionDefinition[],
  parsed: MutableOptions,
  command?: CommandDefinition,
): number {
  const token = args[index];
  const equals = token.indexOf('=');
  const rawName = equals === -1 ? token : token.slice(0, equals);
  const name = rawName.startsWith('--') ? rawName.slice(2) : rawName.slice(1);
  const definition = definitions.find(
    (option) =>
      (rawName.startsWith('--') && option.name === name) ||
      (option.type === 'boolean' && option.short === name && rawName.startsWith('-') && !rawName.startsWith('--')),
  );
  if (!definition) {
    if (name === 'json' && command && !command.outputModes.includes('json'))
      invalid(
        command.path[0] === 'help'
          ? 'Help is human-only. Use gws-ea schema [command path] --json for machine discovery.'
          : `${command.path.join(' ')} does not support --json.`,
      );
    invalid(`Unknown option ${rawName}`);
  }
  if (!definition.repeatable && parsed.options[definition.name] !== undefined)
    invalid(`Option --${definition.name} was provided twice`);
  if (definition.type === 'boolean') {
    if (equals !== -1) invalid(`Option --${definition.name} does not take a value`);
    parsed.options[definition.name] = 'true';
    return index + 1;
  }
  const value = equals === -1 ? args[index + 1] : token.slice(equals + 1);
  if (value === undefined || value === '' || (equals === -1 && value.startsWith('--')))
    invalid(`Option --${definition.name} requires a value`);
  if (definition.choices && !definition.choices.includes(value))
    invalid(`Option --${definition.name} must be ${definition.choices.join(', ')}.`);
  if (definition.repeatable) (parsed.repeated[definition.name] ??= []).push(value);
  else parsed.options[definition.name] = value;
  return index + (equals === -1 ? 2 : 1);
}

function validateArguments(command: CommandDefinition, values: readonly string[]): void {
  const definitions = command.arguments ?? [];
  for (let index = 0; index < definitions.length; index += 1) {
    const definition = definitions[index];
    const value = values[index];
    if (definition.required && value === undefined) invalid(`Missing required ${definition.name}`);
    if (value !== undefined && definition.choices && !definition.choices.includes(value))
      invalid(
        `${definition.name} must be ${definition.choices.join(', ')}.${definition.name === 'capability' ? ' Run gws-ea connectors list for supported capabilities.' : ''}`,
      );
  }
  if (!definitions.some((argument) => argument.variadic) && values.length > definitions.length)
    invalid(`Unexpected argument ${JSON.stringify(values[definitions.length])}`);
}

/** Grammar only: runs before any path, credential, lock or lifecycle prerequisite is loaded. */
export function parseInvocation(args: readonly string[]): ParsedInvocation {
  const delimiter = args.indexOf('--');
  const own = delimiter === -1 ? args : args.slice(0, delimiter);
  const passThrough = delimiter === -1 ? [] : args.slice(delimiter + 1);
  const parsed: MutableOptions = { options: {}, repeated: {} };
  const path: string[] = [];
  const commandIndexes = new Set<number>();
  let index = 0;
  let definition: CommandDefinition | undefined;
  while (index < own.length) {
    const token = own[index];
    if (token.startsWith('-') && token !== '--version') {
      index = consumeOption(own, index, COMMON_OPTIONS, parsed);
      continue;
    }
    path.push(token);
    commandIndexes.add(index);
    index += 1;
    const candidates = COMMAND_DEFINITIONS.filter((command) =>
      path.every((part, offset) => command.path[offset] === part),
    );
    if (candidates.length === 0)
      invalid(
        `Unknown command ${JSON.stringify(path.join(' '))}.${path[0] === 'connectors' ? ' Run gws-ea help connectors for supported actions.' : ''}`,
      );
    definition = candidates.find((command) => command.path.length === path.length);
    // A command can prefix a longer one (`connectors enable` takes voice as an argument; `connectors enable
    // browser` is its own command), so stop only when the next token does not continue a longer path.
    const next = own[index];
    if (
      definition &&
      !candidates.some((command) => command.path.length > path.length && command.path[path.length] === next)
    )
      break;
  }
  const namespace = !definition ? findNamespace(path) : undefined;
  if (!definition) {
    if (path.length > 0 && !namespace) invalid(`Unknown command ${JSON.stringify(path.join(' '))}.`);
    if (own.length > 0 && parsed.options.help !== 'true') invalid('Missing command.');
    definition = findCommand(['help']);
  }
  if (!definition) throw new Error('The command definitions must include help.');
  const positionals: string[] = namespace ? [...namespace.path] : [];
  while (index < own.length) {
    const versionTarget =
      own[index] === '--version' &&
      definition.handler.kind === 'discovery' &&
      (definition.handler.command === 'help' || definition.handler.command === 'schema');
    if (own[index].startsWith('-') && !versionTarget)
      index = consumeOption(own, index, optionsFor(definition), parsed, definition);
    else {
      positionals.push(own[index]);
      index += 1;
    }
  }
  // Common options before the command path were parsed before the command was known; check its output modes now.
  if (parsed.options.json === 'true' && (parsed.options.help === 'true' || definition.path[0] === 'help'))
    invalid('Help is human-only. Use gws-ea schema [command path] --json for machine discovery.');
  if (parsed.options.json === 'true' && !definition.outputModes.includes('json'))
    invalid(`${definition.path.join(' ')} does not support --json.`);
  const help =
    parsed.options.help === 'true' ||
    (definition.handler.kind === 'discovery' && definition.handler.command === 'help');
  if (delimiter !== -1 && !definition.passThrough)
    invalid(`${definition.path.join(' ')} does not accept arguments after --.`);
  if (definition.passThrough && positionals.length > 0) invalid('Place ncl arguments after --.');
  if (!help) {
    validateArguments(definition, positionals);
    for (const option of definition.options) {
      if (option.required && parsed.options[option.name] === undefined && !parsed.repeated[option.name]?.length)
        invalid(`Missing required option --${option.name}`);
    }
    if (parsed.options.id !== undefined && !INSTANCE_ID_PATTERN.test(parsed.options.id))
      invalid('Instance ID is invalid; use the full assistant ID.');
    if (
      definition.handler.kind === 'discovery' &&
      definition.handler.command === 'schema' &&
      parsed.options.json !== 'true'
    )
      invalid('schema requires --json.');
  }
  return {
    definition,
    ...parsed,
    arguments: positionals,
    passThrough,
    commandArgs: own.filter((_, offset) => !commandIndexes.has(offset)),
    help,
  };
}

/** A help or schema path must name a registered command or namespace, even under --help. */
export function discoveryTarget(path: readonly string[]): DiscoveryTarget | undefined {
  if (path.length === 0) return undefined;
  const command = findCommand(path) ?? findNamespace(path);
  if (!command) invalid(`Unknown command ${JSON.stringify(path.join(' '))}.`);
  return command;
}

/** Best-known canonical path for parse failures; unknown nested paths retain their supplied words. */
export function requestedCommandPath(args: readonly string[]): string {
  const path: string[] = [];
  const delimiter = args.indexOf('--');
  const outer = delimiter < 0 ? args : args.slice(0, delimiter);
  const definitions = [...COMMON_OPTIONS, ...COMMAND_DEFINITIONS.flatMap((command) => command.options)];
  for (let index = 0; index < outer.length; index += 1) {
    const token = outer[index];
    if (token.startsWith('-') && token !== '--version') {
      if (
        !token.includes('=') &&
        definitions.some((option) => option.type === 'string' && `--${option.name}` === token)
      )
        index += 1;
      continue;
    }
    path.push(token);
    if (
      findCommand(path) &&
      !COMMAND_DEFINITIONS.some(
        (command) =>
          command.path.length > path.length &&
          path.every((part, offset) => command.path[offset] === part) &&
          command.path[path.length] === outer[index + 1],
      )
    )
      break;
  }
  return path.join(' ');
}
