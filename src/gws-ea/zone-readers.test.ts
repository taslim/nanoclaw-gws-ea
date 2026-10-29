import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

const modules = path.resolve('src/modules');

function files(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'testing' ? [] : files(file);
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [file] : [];
  });
}

function inSpawnSection(node: ts.Node, key: string): boolean {
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (
      ts.isCallExpression(parent) &&
      ts.isIdentifier(parent.expression) &&
      parent.expression.text === 'registerRequiredProjectDocSection' &&
      parent.arguments[0] &&
      ts.isStringLiteral(parent.arguments[0]) &&
      parent.arguments[0].text === key
    )
      return true;
  }
  return false;
}

function allowed(file: string, node: ts.Node, name: string): boolean {
  // Storage and the timeline's home input own the durable home clock.
  if (file.startsWith('gws-ea-profile/') || file === 'gws-ea-whereabouts/timeline.ts') return true;
  // These two front-page lines explicitly describe home, rather than a dated moment.
  if (file === 'gws-ea-manual/front-page.ts') return name === 'principal_timezone';
  if (file === 'gws-ea-external-email/index.ts') return inSpawnSection(node, 'gws-ea-external-email:principal');
  if (file === 'gws-ea-chat-agents/index.ts') return inSpawnSection(node, 'gws-ea-chat-agents:principal');
  if (file === 'gws-ea-matters/sync.ts' && name === 'resolveGroupTimezone') {
    for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent)
      if (ts.isFunctionDeclaration(parent) && parent.name?.text === 'keepSync') return true;
  }
  return false;
}

it('keeps dated fork readers off the durable home clock', () => {
  const violations: string[] = [];
  const paths = fs
    .readdirSync(modules, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('gws-ea-'))
    .flatMap((entry) => files(path.join(modules, entry.name)));
  for (const file of paths) {
    const relative = path.relative(modules, file);
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      let name: string | undefined;
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'principal_timezone') name = node.name.text;
      if (
        ts.isElementAccessExpression(node) &&
        node.argumentExpression &&
        ts.isStringLiteral(node.argumentExpression) &&
        node.argumentExpression.text === 'principal_timezone'
      )
        name = node.argumentExpression.text;
      if (ts.isBindingElement(node) && (node.propertyName ?? node.name).getText(source) === 'principal_timezone')
        name = 'principal_timezone';
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ['resolveGroupTimezone', 'principalTimezone', 'principalNameAndTimezone'].includes(node.expression.text)
      )
        name = node.expression.text;
      if (name && !allowed(relative, node, name)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push(`${relative}:${line + 1}: ${name}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
});
