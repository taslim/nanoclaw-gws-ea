import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RequestListener } from 'node:http';
import { beforeEach, expect, it, vi } from 'vitest';
import { DENY, defineGuardedAction } from '../../guard/index.js';
import {
  normalizeWebPathname,
  webAdmissionEmails,
  WebMountRegistry,
  type ArtifactReadersMount,
  type PrincipalPageMount,
  type WebMountPath,
} from './mounts.js';

const principals = vi.hoisted(() => ({ reads: 0 }));
vi.mock('../gws-ea-profile/db.js', () => ({
  listPrincipalAddresses: async () => {
    principals.reads++;
    return [{ email: 'morgan@example.com', added_at: '2026-11-01T00:00:00.000Z' }];
  },
}));
beforeEach(() => {
  principals.reads = 0;
});

const handler = (): RequestListener => () => undefined;
const linkGuard = defineGuardedAction({ action: 'test.web-mounts-link', decide: () => DENY('test') });
function page(name: string, mountPath: WebMountPath): PrincipalPageMount {
  return {
    name,
    audience: 'principal',
    path: mountPath,
    methods: ['GET'],
    title: name,
    status: async () => '',
    linkGuard,
    handler,
  };
}
function readers(name: string, mountPath: WebMountPath, emails: readonly string[] = []): ArtifactReadersMount {
  return {
    name,
    audience: 'artifact-readers',
    path: mountPath,
    methods: ['GET'],
    handler,
    admissionEmails: async () => emails,
    authoredContent: () => false,
  };
}

it('refuses overlapping or duplicate registrations and accepts siblings and the root', () => {
  const registry = new WebMountRegistry();
  registry.register(page('home', '/'));
  registry.register(page('logins', '/logins'));
  registry.register(readers('artifacts', '/artifacts'));
  registry.register(page('logins-extra', '/loginsx'));
  expect(() => registry.register(page('nested', '/logins/add'))).toThrow(/overlaps "logins"/u);
  expect(() => registry.register(readers('parent', '/artifacts'))).toThrow(/overlaps "artifacts"/u);
  expect(() => registry.register(page('second-home', '/'))).toThrow(/overlaps "home"/u);
  expect(() => registry.register(page('logins', '/elsewhere'))).toThrow(/already registered/u);
  expect(registry.all().map(({ name }) => name)).toEqual(['home', 'logins', 'artifacts', 'logins-extra']);
  expect(registry.principalPages().map(({ name }) => name)).toEqual(['home', 'logins', 'logins-extra']);
});

it('refuses malformed paths, names, methods and untitled principal pages', () => {
  const registry = new WebMountRegistry();
  for (const bad of ['/Logins', '/logins/', '/a//b', '/a/../b', '/%61', 'logins'] as WebMountPath[])
    expect(() => registry.register(page('bad', bad)), bad).toThrow(/invalid path/u);
  expect(() => registry.register(page('Bad Name', '/x'))).toThrow(/name/u);
  expect(() => registry.register({ ...page('none', '/x'), methods: [] })).toThrow(/methods/u);
  expect(() => registry.register({ ...page('twice', '/x'), methods: ['GET', 'GET'] })).toThrow(/methods/u);
  expect(() => registry.register({ ...page('untitled', '/x'), title: ' ' })).toThrow(/title/u);
  expect(registry.all()).toEqual([]);
});

it('normalizes only paths that spell what they address', () => {
  expect(normalizeWebPathname('/')).toBe('/');
  expect(normalizeWebPathname('/?next=/logins')).toBe('/');
  expect(normalizeWebPathname('/logins/add?x=%2e%2e')).toBe('/logins/add');
  for (const url of [
    undefined,
    '',
    'logins',
    'https://aya.example.com/logins',
    '/logins/%2e%2e/x',
    '/logins%2Fx',
    '/logins%5Cx',
    '/logins\\x',
    '/artifacts/../logins',
    '/artifacts/./x',
    '/artifacts//x',
    '//logins',
    '/logins/',
  ])
    expect(normalizeWebPathname(url), url).toBeUndefined();
});

it('admits the principal for principal pages and each artifact-readers mount its own readers', async () => {
  expect(
    await webAdmissionEmails([
      page('logins', '/logins'),
      page('home', '/'),
      readers('artifacts', '/artifacts', ['remy@example.com', 'morgan@example.com']),
    ]),
  ).toEqual(['morgan@example.com', 'remy@example.com']);
  expect(principals.reads).toBe(1);
  expect(await webAdmissionEmails([readers('artifacts', '/artifacts', ['juno@example.com'])])).toEqual([
    'juno@example.com',
  ]);
  expect(principals.reads).toBe(1);
});

it('keeps the web module free of feature-module imports', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const modules = path.dirname(directory);
  const pending = [path.join(directory, 'index.ts')];
  const seen = new Set<string>();
  const imported: string[] = [];
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const [, specifier] of source.matchAll(/\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/gu)) {
      if (!specifier.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), specifier).replace(/\.js$/u, '.ts');
      imported.push(path.relative(modules, target));
      if (path.dirname(target) === directory) pending.push(target);
    }
  }
  expect(seen.size).toBeGreaterThan(3);
  expect(imported.filter((target) => /^gws-ea-(?:browser|artifacts|connections)\//u.test(target))).toEqual([]);
});
