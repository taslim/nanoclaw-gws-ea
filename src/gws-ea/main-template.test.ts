/**
 * Main's template, compared file by file with the plugin stamped into its
 * folder. The comparison mirrors what NanoClaw stamps, so it is checked
 * against NanoClaw's own stamp and restamp of the real `gws-ea/main`
 * template; the readers of main's MCP servers and task series run on real
 * SQLite files.
 */
import { cpSync, mkdirSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-gws-ea-main-template-drift';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-gws-ea-main-template-drift/groups',
  DATA_DIR: '/tmp/nanoclaw-gws-ea-main-template-drift/data',
  TEMPLATES_DIR: '/tmp/nanoclaw-gws-ea-main-template-drift/templates',
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { taskNameSlug as nanoclawTaskNameSlug } from '../modules/scheduling/create.js';
import { createAgentFromTemplate } from '../templates/create-agent.js';
import { restampAgentFromTemplate } from '../templates/restamp.js';
import {
  decideMainFolder,
  inspectMainFolder,
  parseTemplateRestamp,
  taskNameSlug,
  type TemplateRestamp,
} from './main-template.js';
import { GwsEaError } from './types.js';
import { readPluginMcpServers, readTaskSeries } from './verify.js';

const REPOSITORY_TEMPLATE = path.resolve('templates', 'gws-ea', 'main');
const TEMPLATE = path.join(TEST_ROOT, 'templates', 'gws-ea', 'main');
const CONTEXT = path.join(TEMPLATE, 'ai.nanoco.nanoclaw', 'context');
const PROCEDURE = path.join('additional_context', 'operating-procedure.md');

beforeEach(async () => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
  cpSync(REPOSITORY_TEMPLATE, TEMPLATE, { recursive: true });
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

/** Main stamped by NanoClaw's own create, from the test's copy of the real template. */
async function stamped(): Promise<{ readonly id: string; readonly folder: string }> {
  const { group } = await createAgentFromTemplate('gws-ea/main');
  return { id: group.id, folder: path.join(TEST_ROOT, 'groups', group.folder) };
}

describe("main's template against NanoClaw's own stamp", () => {
  it('reads what NanoClaw stamps and restamps from the real template as uncustomized', async () => {
    const main = await stamped();

    expect(await inspectMainFolder(main.folder, TEMPLATE)).toEqual({ kind: 'stamped', customized: [] });
    expect(await decideMainFolder(main.folder, TEMPLATE)).toEqual({ kind: 'unchanged' });

    // A release that changes the persona (trailing blank lines included), the procedure, and adds a context file.
    appendFileSync(path.join(CONTEXT, 'instructions.md'), '\nKeep the principal informed.\n\n\n');
    appendFileSync(path.join(CONTEXT, PROCEDURE), '\nConfirm before sending.\n');
    writeFileSync(path.join(CONTEXT, 'additional_context', 'faq.md'), '# FAQ\n');
    expect(await decideMainFolder(main.folder, TEMPLATE)).toEqual({ kind: 'refresh' });

    await restampAgentFromTemplate('gws-ea/main', main.id, { apply: true });

    expect(await inspectMainFolder(main.folder, TEMPLATE)).toEqual({ kind: 'stamped', customized: [] });
    expect(await decideMainFolder(main.folder, TEMPLATE)).toEqual({ kind: 'unchanged' });
  });

  it("counts every edit, deletion, and addition, where NanoClaw's own plan misses the deletion and the addition", async () => {
    const main = await stamped();
    writeFileSync(path.join(main.folder, 'instructions.prepend.md'), 'My own instructions.\n');
    rmSync(path.join(main.folder, PROCEDURE));
    writeFileSync(path.join(main.folder, 'additional_context', 'notes.md'), 'Notes.\n');
    appendFileSync(path.join(CONTEXT, 'instructions.md'), '\nA new rule.\n');

    const customized = [
      { surface: 'context', name: 'additional_context/notes.md', change: 'added' },
      { surface: 'context', name: 'additional_context/operating-procedure.md', change: 'deleted' },
      { surface: 'persona', name: 'instructions.prepend.md', change: 'changed' },
    ];
    expect(await inspectMainFolder(main.folder, TEMPLATE)).toEqual({ kind: 'stamped', customized });
    expect(await decideMainFolder(main.folder, TEMPLATE)).toEqual({ kind: 'customized', customized });
    const plan = await restampAgentFromTemplate('gws-ea/main', main.id, { apply: false });
    expect(plan.changes.filter((change) => change.customized).map((change) => change.name)).toEqual([
      'instructions.prepend.md',
    ]);
  });

  it('never follows a link the agent planted in its folder, and counts it as customized', async () => {
    const main = await stamped();
    const outside = path.join(TEST_ROOT, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'secret.md'), 'Not main.\n');
    rmSync(path.join(main.folder, 'instructions.prepend.md'));
    symlinkSync(path.join(outside, 'secret.md'), path.join(main.folder, 'instructions.prepend.md'));
    rmSync(path.join(main.folder, 'additional_context'), { recursive: true });
    symlinkSync(outside, path.join(main.folder, 'additional_context'));

    expect(await inspectMainFolder(main.folder, TEMPLATE)).toEqual({
      kind: 'stamped',
      customized: [
        { surface: 'context', name: 'additional_context/operating-procedure.md', change: 'changed' },
        { surface: 'persona', name: 'instructions.prepend.md', change: 'changed' },
      ],
    });
  });

  it('has nothing to compare in a folder the template never stamped, or against a release without it', async () => {
    const main = await stamped();
    const bare = path.join(TEST_ROOT, 'groups', 'bare');
    mkdirSync(bare);

    expect(await decideMainFolder(bare, TEMPLATE)).toMatchObject({ kind: 'not_stamped' });
    expect(await decideMainFolder(main.folder, path.join(TEST_ROOT, 'no-template'))).toEqual({
      kind: 'not_stamped',
      reason: 'the release has no gws-ea/main template',
    });
    // Its own files are still compared with what it was stamped with.
    expect(await inspectMainFolder(main.folder, path.join(TEST_ROOT, 'no-template'))).toEqual({
      kind: 'stamped',
      customized: [],
    });
  });

  it.each(['Weekly review', '  Morning — brief!! ', 'A task name much longer than any series slug keeps', '---'])(
    'names the task series of %j as NanoClaw does',
    (name) => {
      expect(taskNameSlug(name)).toBe(nanoclawTaskNameSlug(name));
    },
  );
});

describe("main's MCP servers and task series", () => {
  const CHECKOUT = path.join(TEST_ROOT, 'checkout');

  function central(servers: string): void {
    mkdirSync(path.join(CHECKOUT, 'data'), { recursive: true });
    const database = new Database(path.join(CHECKOUT, 'data', 'v2.db'));
    try {
      database.exec(`CREATE TABLE container_configs (agent_group_id TEXT PRIMARY KEY, mcp_servers TEXT NOT NULL)`);
      database.prepare("INSERT INTO container_configs VALUES ('ag-main', ?)").run(servers);
    } finally {
      database.close();
    }
  }

  function mailbox(session: string, rows: ReadonlyArray<readonly [string, string, string, number]>): void {
    const directory = path.join(CHECKOUT, 'data', 'v2-sessions', 'ag-main', session);
    mkdirSync(directory, { recursive: true });
    const database = new Database(path.join(directory, 'inbound.db'));
    try {
      database.exec(`CREATE TABLE messages_in (
        id TEXT PRIMARY KEY, kind TEXT, series_id TEXT, status TEXT, recurrence TEXT, content TEXT, seq INTEGER)`);
      for (const [series, status, prompt, seq] of rows) {
        database
          .prepare("INSERT INTO messages_in VALUES (?, 'task', ?, ?, '0 9 * * 1', ?, ?)")
          .run(`${series}-${seq}`, series, status, JSON.stringify({ prompt, script: null }), seq);
      }
    } finally {
      database.close();
    }
  }

  it("reads only the servers main's plugin owns", () => {
    const owned = { type: 'http', url: 'https://example.test/mcp', plugin: 'gws-ea-main' };
    central(JSON.stringify({ calendar: owned, mine: { type: 'http', url: 'https://example.test/own' } }));

    expect(readPluginMcpServers(CHECKOUT, 'ag-main', 'gws-ea-main')).toEqual({ calendar: owned });
    expect(readPluginMcpServers(CHECKOUT, 'ag-other', 'gws-ea-main')).toEqual({});
  });

  it('reads each template series as its next run holds it, ignoring other tasks and mailboxes that hold none', () => {
    central('{}');
    mailbox('tasks-1', [
      ['weekly-review-1a2b', 'completed', 'Review the week (old).', 1],
      ['weekly-review-1a2b', 'paused', 'Review the week.', 2],
      ['reminder-call-mom-3c4d', 'pending', 'Call mom.', 3],
    ]);
    mkdirSync(path.join(CHECKOUT, 'data', 'v2-sessions', 'ag-main', 'chat-1'));
    const chat = new Database(path.join(CHECKOUT, 'data', 'v2-sessions', 'ag-main', 'chat-1', 'inbound.db'));
    chat.exec('CREATE TABLE messages_in (id TEXT PRIMARY KEY, content TEXT)');
    chat.close();

    expect(readTaskSeries(CHECKOUT, 'ag-main', ['weekly-review'])).toEqual([
      { series_id: 'weekly-review-1a2b', recurrence: '0 9 * * 1', prompt: 'Review the week.', script: null },
    ]);
    expect(readTaskSeries(CHECKOUT, 'ag-main', [])).toEqual([]);
    expect(readTaskSeries(CHECKOUT, 'ag-none', ['weekly-review'])).toEqual([]);
  });
});

describe('a recorded restamp', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const valid: TemplateRestamp = {
    agent_group_id: 'ag-main',
    files_before: { 'instructions.prepend.md': digest, 'additional_context/notes.md': null },
    files_after: { 'instructions.prepend.md': `${digest}+x`, 'additional_context/notes.md': null },
    task_slugs: ['weekly-review'],
    settled: { mcp_servers: digest, tasks: digest },
  };
  const invalid = (detail: string): GwsEaError => new GwsEaError('invalid_kept_release', detail);

  it('reads back what was recorded, dropping unknown fields', () => {
    expect(parseTemplateRestamp({ ...valid, later: true }, invalid)).toEqual(valid);
    expect(parseTemplateRestamp({ ...valid, reversing: true }, invalid)).toEqual({ ...valid, reversing: true });
  });

  it.each([
    ['a path out of main folder', { ...valid, files_after: { '../escape.md': digest } }],
    ['an unknown digest', { ...valid, files_before: { 'instructions.prepend.md': 'md5:abc' } }],
    ['an invalid agent group', { ...valid, agent_group_id: 'ag/../main' }],
    ['an invalid task slug', { ...valid, task_slugs: ['Weekly review'] }],
    ['a partial settled state', { ...valid, settled: { mcp_servers: digest } }],
    ['a reversal that is not true', { ...valid, reversing: false }],
  ])('refuses %s', (_label, value) => {
    expect(() => parseTemplateRestamp(value, invalid)).toThrow(GwsEaError);
  });
});
