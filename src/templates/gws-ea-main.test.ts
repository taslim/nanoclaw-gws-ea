import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-gws-ea-main-template-test';
const GROUPS_DIR = `${TEST_ROOT}/groups`;

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-gws-ea-main-template-test/groups',
  DATA_DIR: '/tmp/nanoclaw-gws-ea-main-template-test/data',
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
const CONTEXT_ROOT = path.join(TEMPLATE_ROOT, NANOCLAW_EXTENSION_NS, 'context');
const INSTRUCTIONS_FILE = path.join(CONTEXT_ROOT, 'instructions.md');
const DOCTRINE_FILE = path.join(CONTEXT_ROOT, 'additional_context', 'operating-doctrine.md');
const EXPECTED_FILES = [
  'README.md',
  'ai.nanoco.nanoclaw/context/additional_context/operating-doctrine.md',
  'ai.nanoco.nanoclaw/context/instructions.md',
  'plugin.json',
];
const EXPECTED_README = `# GWS-EA main

This Agent Plugins 1.0 template creates the canonical \`main\` executive-assistant agent group.

Its always-loaded instructions establish the generic assistant/principal relationship and point to the detailed operating doctrine in \`ai.nanoco.nanoclaw/context/additional_context/operating-doctrine.md\`. Names and other instance identity come from runtime context; they are intentionally absent here.

Stamp the template through NanoClaw's existing local template path:

\`\`\`bash
ncl groups create --template gws-ea/main
\`\`\`

The template carries no tools, credentials, runtime selection, or deployment configuration.`;
const EXPECTED_INSTRUCTIONS = `# Executive assistant

You are the private executive assistant to the principal identified by runtime context. "Assistant" means you; "principal" means the person whose objectives, time, relationships, and commitments you help carry forward.

Do not invent or infer either party's name or identity. Treat current runtime context as authoritative for who you and the principal are.

Operate as a proactive force multiplier: convert direction into completed outcomes, protect the principal's attention, anticipate what will be needed next, exercise judgment within established authority, and return decisions in a form the principal can act on immediately.

Read and follow \`additional_context/operating-doctrine.md\` as standing operating guidance. Apply it beneath higher-priority instructions and the principal's current direction.`;
const DOCTRINE_SHA256 = '4883b4f87f1b6685d47ccaa69ab0e46ee2204e6f5904868550387db2bd509d76';

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

describe('gws-ea/main template', () => {
  it('parses the real Agent Plugins template without notices', () => {
    const template = parseTemplate(TEMPLATE_ROOT);

    expect(template.name).toBe('gws-ea-main');
    expect(template.agentName).toBe('main');
    expect(template.instructions).toBe(EXPECTED_INSTRUCTIONS);
    expect(template.contextExtras.map(({ name }) => name)).toEqual(['additional_context/operating-doctrine.md']);
    expect(template.mcpServers).toEqual({});
    expect(template.skills).toEqual([]);
    expect(template.tasks).toEqual([]);
    expect(template.report).toEqual([]);
  });

  it('preserves the accepted operating doctrine byte for byte', () => {
    const digest = createHash('sha256').update(fs.readFileSync(DOCTRINE_FILE)).digest('hex');

    expect(digest).toBe(DOCTRINE_SHA256);
  });

  it('stamps the persona and doctrine through the real isolated creation path', async () => {
    const { group, report } = await createAgentFromTemplate('gws-ea/main');
    const groupDir = path.join(GROUPS_DIR, group.folder);
    const config = await getContainerConfig(group.id);

    expect(group.name).toBe('main');
    expect(group.folder).toBe('main');
    expect(group.agent_provider).toBeNull();
    expect(report).toEqual([]);
    expect(fs.readFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), 'utf-8')).toBe(`${EXPECTED_INSTRUCTIONS}\n`);
    expect(fs.readFileSync(path.join(groupDir, 'additional_context', 'operating-doctrine.md'))).toEqual(
      fs.readFileSync(DOCTRINE_FILE),
    );
    expect(fs.existsSync(path.join(groupDir, 'plugins', 'gws-ea-main', 'plugin.json'))).toBe(true);
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

  it('contains no deployment configuration, secrets, endpoints, or personal identity', () => {
    expect(listFiles(TEMPLATE_ROOT)).toEqual(EXPECTED_FILES);

    const manifest = JSON.parse(fs.readFileSync(path.join(TEMPLATE_ROOT, 'plugin.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(manifest).toEqual({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'gws-ea-main',
      version: '1.0.0',
      description: 'Executive-assistant operating posture for the canonical GWS-EA main agent.',
      extensions: { [NANOCLAW_EXTENSION_NS]: { agentName: 'main' } },
    });

    const serializedManifest = JSON.stringify(manifest);
    expect(serializedManifest).not.toMatch(
      /(?:provider|model|package|credential|secret|token|api[_-]?key|endpoint|assistant[_-]?name|principal[_-]?name|email)/i,
    );
    expect(fs.readFileSync(path.join(TEMPLATE_ROOT, 'README.md'), 'utf-8').trimEnd()).toBe(EXPECTED_README);
    expect(fs.readFileSync(INSTRUCTIONS_FILE, 'utf-8').trimEnd()).toBe(EXPECTED_INSTRUCTIONS);
  });
});
