import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WeekView } from '../../src/modules/gws-ea-meetings/week/view.js';
import type { ScenarioComposition } from './types.js';
import { scenarioRuntime } from './runtime.js';

it('runs the shipped tools, model and effort, and keeps the fixture isolation last', () => {
  const runtime = scenarioRuntime(
    {
      capabilities: ['files-read', 'files-write', 'shell', 'web', 'subagents', 'mcp-servers'],
      moduleEnvironment: { CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT: '1' },
      inference: { model: 'claude-opus-5-5', effort: 'high' },
    },
    { nanoclaw: { command: 'node', args: ['mcp.ts'] } },
    { INHERITED: 'kept', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
    { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' },
  );
  for (const tool of ['WebSearch', 'WebFetch', 'Agent', 'Task', 'Workflow'])
    expect(runtime.tools.disallowedTools).not.toContain(tool);
  expect(runtime.tools.strictMcpConfig).toBe(true);
  expect(Object.keys(runtime.tools.mcpServers)).toEqual(['nanoclaw']);
  expect(runtime.inference).toEqual({ model: 'claude-opus-5-5', effort: 'high' });
  expect(runtime.env).toMatchObject({
    INHERITED: 'kept',
    CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT: '1',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
  });
});

it('keeps the return-flight preview and default reads on the same fresh fixture clock', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'return-flight-preview-'));
  const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const output = path.join(root, 'evidence');
  const startedAt = Date.now();
  try {
    const prepared = spawnSync(
      process.execPath,
      [
        '--import',
        path.join(tree, 'node_modules/tsx/dist/loader.mjs'),
        path.join(tree, 'scripts/scenarios/driver.ts'),
        'prepare',
        '--cases',
        'return-flight-live,merchant-hours-live',
        '--out',
        output,
      ],
      { cwd: tree, encoding: 'utf8', timeout: 30_000 },
    );
    const diagnostics = ['return-flight-live', 'merchant-hours-live'].flatMap((id) =>
      ['prepare.log', 'preflight.log'].map((name) => {
        const file = path.join(output, id, 'run-1', name);
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      }),
    );
    expect(prepared.error).toBeUndefined();
    // The case's preflight checks actual preview dates, fresh native hooks, and default/explicit days reads.
    expect(prepared.status, [prepared.stderr, ...diagnostics].join('\n')).toBe(0);
    for (const name of ['preflight-week-hook.txt', 'preflight-calendar.json'])
      expect(fs.statSync(path.join(output, 'return-flight-live/run-1', name)).size).toBeGreaterThan(0);
    const returnComposition = JSON.parse(
      fs.readFileSync(path.join(output, 'return-flight-live/run-1/composition.json'), 'utf8'),
    ) as ScenarioComposition;
    expect(fs.readdirSync(returnComposition.inboxDirectory)).toEqual([]);
    const directory = path.join(output, 'merchant-hours-live/run-1');
    const composition = JSON.parse(
      fs.readFileSync(path.join(directory, 'composition.json'), 'utf8'),
    ) as ScenarioComposition;
    expect(composition.weekViewReferenceAt).toBeUndefined();
    expect(fs.existsSync(path.join(directory, 'week-view-clock.ts'))).toBe(false);
    if (!composition.weekViewFile) throw new Error('The native host did not publish the other scenario preview.');
    const view = JSON.parse(fs.readFileSync(composition.weekViewFile, 'utf8')) as WeekView;
    expect(Date.parse(view.asOf)).toBeGreaterThanOrEqual(startedAt);
    expect(Date.parse(view.asOf)).toBeLessThanOrEqual(Date.now());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 35_000);
