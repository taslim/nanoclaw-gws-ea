import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

const TEST_ROOT = '/tmp/nanoclaw-gws-ea-templates-test';
const GROUPS_DIR = `${TEST_ROOT}/groups`;
const DATA_DIR = `${TEST_ROOT}/data`;

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-gws-ea-templates-test/groups',
  DATA_DIR: '/tmp/nanoclaw-gws-ea-templates-test/data',
  TEMPLATES_DIR: `${process.cwd()}/templates`,
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { getContainerConfig } from '../db/container-configs.js';
import { PERSONA_PREPEND_FILE } from '../group-persona.js';
import { createAgentFromTemplate } from './create-agent.js';
import { NANOCLAW_EXTENSION_NS } from './extension.js';
import { parseTemplate } from './parse.js';

const TEMPLATE_ROOT = path.resolve('templates', 'gws-ea', 'main');
const WELCOME_FILE = path.join(TEMPLATE_ROOT, 'skills', 'welcome', 'SKILL.md');

/**
 * GWS-EA's templates, each stamped once at create and never again: anything
 * that must change with a release ships in the release's guidance, skills, or
 * modules, so a template holds only its plugin and these files.
 */
const TEMPLATES = [
  {
    ref: 'gws-ea/main',
    name: 'gws-ea-main',
    agentName: 'main',
    skills: ['welcome'],
    files: ['README.md', 'plugin.json', 'skills/welcome/SKILL.md'],
  },
  {
    ref: 'gws-ea/external-email',
    name: 'gws-ea-external-email',
    agentName: 'external-email',
    skills: [],
    files: ['README.md', 'plugin.json'],
  },
] as const;

function listFiles(dir: string, relative = ''): string[] {
  return fs
    .readdirSync(path.join(dir, relative), { withFileTypes: true })
    .flatMap((entry) => {
      const name = path.posix.join(relative.split(path.sep).join('/'), entry.name);
      return entry.isDirectory() ? listFiles(dir, name) : [name];
    })
    .sort();
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe.each(TEMPLATES)('$ref template', ({ ref, name, agentName, skills, files }) => {
  const root = path.resolve('templates', ref);

  it('parses without notices and stamps no persona, context, MCP server, or task', () => {
    const template = parseTemplate(root);

    expect(template.name).toBe(name);
    expect(template.agentName).toBe(agentName);
    expect(template.instructions).toBeUndefined();
    expect(template.contextExtras).toEqual([]);
    expect(template.mcpServers).toEqual({});
    expect(template.skills.map((skill) => skill.name)).toEqual(skills);
    expect(template.tasks).toEqual([]);
    expect(template.report).toEqual([]);
  });

  it('holds exactly its plugin, README, and listed skills', () => {
    expect(listFiles(root)).toEqual(files);
  });
});

describe('gws-ea/main template', () => {
  it('stamps main with its welcome and leaves the persona file to the principal', async () => {
    const { group, report } = await createAgentFromTemplate('gws-ea/main');
    const groupDir = path.join(GROUPS_DIR, group.folder);
    const config = await getContainerConfig(group.id);

    expect(group.name).toBe('main');
    expect(group.folder).toBe('main');
    expect(group.agent_provider).toBeNull();
    expect(report).toEqual([]);
    expect(fs.existsSync(path.join(groupDir, PERSONA_PREPEND_FILE))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, 'additional_context'))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, 'plugins', 'gws-ea-main', 'plugin.json'))).toBe(true);
    expect(
      fs.readFileSync(path.join(DATA_DIR, 'v2-sessions', group.id, '.claude-shared', 'skills', 'welcome', 'SKILL.md')),
    ).toEqual(fs.readFileSync(WELCOME_FILE));
    expect(config).toMatchObject({
      provider: null,
      model: null,
      effort: null,
      assistant_name: null,
      mcp_servers: '{}',
      packages_apt: '[]',
      packages_npm: '[]',
    });
  });

  it('names its welcome as the first conversation runs it, /welcome, and its README only files that exist', () => {
    const [, frontmatter = ''] = fs.readFileSync(WELCOME_FILE, 'utf-8').split(/^---$/mu);
    expect(parse(frontmatter)).toMatchObject({ name: 'welcome' });

    const readme = fs.readFileSync(path.join(TEMPLATE_ROOT, 'README.md'), 'utf-8');
    const files = [...readme.matchAll(/`([\w.-]+(?:\/[\w.-]+)+\.\w+)`/gu)].map(([, file]) => file);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(fs.existsSync(path.resolve(file)), file).toBe(true);
  });

  it('contains no deployment configuration, secrets, endpoints, personal identity, or emoji', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(TEMPLATE_ROOT, 'plugin.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(manifest).toEqual({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'gws-ea-main',
      version: '1.0.0',
      description: 'The canonical GWS-EA main agent and its first-conversation welcome.',
      extensions: { [NANOCLAW_EXTENSION_NS]: { agentName: 'main' } },
    });

    const serializedManifest = JSON.stringify(manifest);
    expect(serializedManifest).not.toMatch(
      /(?:provider|model|package|credential|secret|token|api[_-]?key|endpoint|assistant[_-]?name|principal[_-]?name|email)/i,
    );

    const runtimeText = fs.readFileSync(WELCOME_FILE, 'utf-8');
    expect(runtimeText).not.toMatch(/https?:\/\//i);
    expect(runtimeText).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    expect(runtimeText).not.toMatch(/\b(?:provider|model|packages_(?:apt|npm)|mcp_servers)\s*[:=]/i);
    expect(runtimeText).not.toMatch(/\b[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|API_KEY|CREDENTIALS)\s*=/);
    expect(runtimeText).not.toMatch(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/);
    expect(runtimeText).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });
});
