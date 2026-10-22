/**
 * For tests that check a text names only tools an agent has. The container
 * cannot import the host, so the agent-runner's tools are read from their
 * definitions: each is a `name: '<tool>',` line in its MCP tool sources, and
 * the capability key that grants it is read from the `registerTools` call
 * that registers it, or the `loadToolModule` key its module loads under.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const TOOLS_DIR = path.resolve('container', 'agent-runner', 'src', 'mcp-tools');

let sources: ReadonlyArray<readonly [file: string, source: string]> | undefined;
let parsed: ReadonlyArray<readonly [file: string, source: string, tree: ts.SourceFile]> | undefined;

/** The runner's tool sources, by file name, tests left out. They don't change during a test run, so they are read once. */
function toolSources(): ReadonlyArray<readonly [file: string, source: string]> {
  sources ??= fs
    .readdirSync(TOOLS_DIR)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => [file, fs.readFileSync(path.join(TOOLS_DIR, file), 'utf8')] as const);
  return sources;
}

/** The tool sources with their syntax trees, each parsed once. */
function parsedToolSources(): ReadonlyArray<readonly [file: string, source: string, tree: ts.SourceFile]> {
  parsed ??= toolSources().map(
    ([file, text]) => [file, text, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)] as const,
  );
  return parsed;
}

function toolNamesIn(source: string): string[] {
  return [...source.matchAll(/^\s*name: '([a-z_]+)',$/gmu)].flatMap(([, name]) => (name ? [name] : []));
}

/** Every tool the agent-runner defines. */
export function runnerToolNames(): Set<string> {
  return new Set(toolSources().flatMap(([, source]) => toolNamesIn(source)));
}

/** The key each tool module the barrel loads with `loadToolModule` is loaded under, by file name. */
function loadKeys(): ReadonlyMap<string, string> {
  const barrel = fs.readFileSync(path.join(TOOLS_DIR, 'index.ts'), 'utf8');
  return new Map(
    [...barrel.matchAll(/loadToolModule\('([a-z-]+)', \(\) => import\('\.\/([a-z-]+)\.js'\)\)/gu)].map(
      ([, key, file]) => [`${file}.ts`, key] as const,
    ),
  );
}

/** The first `name: '<tool>'` an expression's object literals carry, as a tool definition does. */
function definedName(node: ts.Node): string | undefined {
  if (ts.isPropertyAssignment(node) && node.name.getText() === 'name' && ts.isStringLiteral(node.initializer)) {
    return node.initializer.text;
  }
  return ts.forEachChild(node, definedName);
}

/**
 * The capability key that grants each runner tool, read from the
 * `registerTools([...], key)` calls in the tool sources. A call without a key
 * takes its module's `loadToolModule` key; a list that is not written out
 * (`registerTools(createTimeTools(...))`) registers every tool its file
 * defines. A tool no key grants is served to no group, so it is left out.
 */
export function runnerToolCapabilities(): ReadonlyMap<string, string> {
  const keys = loadKeys();
  const granted = new Map<string, string>();
  for (const [file, text, source] of parsedToolSources()) {
    const constants = new Map<string, ts.Expression>();
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        constants.set(node.name.text, node.initializer);
      }
      ts.forEachChild(node, collect);
    };
    collect(source);
    const keyOf = (argument: ts.Expression | undefined): string | undefined => {
      if (argument === undefined) return keys.get(file);
      if (ts.isStringLiteral(argument)) return argument.text;
      const value = ts.isIdentifier(argument) ? constants.get(argument.text) : undefined;
      return value && ts.isStringLiteral(value) ? value.text : undefined;
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText() === 'registerTools') {
        const [list, keyArgument] = node.arguments;
        const key = keyOf(keyArgument);
        const names =
          list && ts.isArrayLiteralExpression(list)
            ? list.elements.flatMap((element) => {
                const definition = ts.isIdentifier(element) ? constants.get(element.text) : element;
                const name = definition && definedName(definition);
                return name ? [name] : [];
              })
            : toolNamesIn(text);
        if (key !== undefined) for (const name of names) granted.set(name, key);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return granted;
}

/**
 * The snake_case words the runner's tool definitions use as fields and
 * values: every property name in their object literals, and every string
 * literal that is one snake_case word (an enum value, an action's kind). An
 * agent reads these in its tool schemas, so a host text may use them.
 */
export function runnerToolVocabulary(): Set<string> {
  const words = new Set<string>();
  const snake = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u;
  for (const [, , source] of parsedToolSources()) {
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
        const name = ts.isStringLiteral(node.name) ? node.name.text : node.name.getText();
        if (snake.test(name)) words.add(name);
      }
      if (ts.isStringLiteral(node) && snake.test(node.text)) words.add(node.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return words;
}

/**
 * The backticked words in `guidance` shaped like a tool name (snake_case, or
 * one bare lowercase word) that name no runner tool and are not in `notTools`.
 */
export function unknownToolNames(guidance: string, notTools: readonly string[]): string[] {
  const tools = runnerToolNames();
  return guidance
    .split('`')
    .filter((span, index) => index % 2 === 1 && /^[a-z]+(?:_[a-z]+)*$/u.test(span))
    .filter((name) => !tools.has(name) && !notTools.includes(name));
}
