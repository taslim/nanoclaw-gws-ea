import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildSortPrompt,
  resolveFinalToolUpdates,
  sorterVersion,
  type ParsedSortToolEntry,
} from '../../../src/modules/gws-ea-connections/sort-rules.js';
import { APP_TOOL_SORT_CORPUS, type SortEvalCase } from './corpus.js';
import { scoreSortCase, scoreSortSuite, type SortCaseScore } from './score.js';

const SORT_OUTPUT_SCHEMA = JSON.stringify({
  type: 'object',
  additionalProperties: false,
  required: ['tools'],
  properties: {
    tools: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'definition_hash', 'label', 'reason'],
        properties: {
          name: { type: 'string' },
          definition_hash: { type: 'string' },
          label: { type: 'string', enum: ['ask_first', 'just_do'] },
          reason: { type: 'string' },
        },
      },
    },
  },
});

interface RawSortEntry {
  readonly name: string;
  readonly definition_hash: string;
  readonly label: 'ask_first' | 'just_do';
  readonly reason: string;
}

function parseRawSortEntries(rawTools: readonly unknown[]): readonly ParsedSortToolEntry[] {
  const entries: ParsedSortToolEntry[] = [];
  for (const raw of rawTools) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('Sorter CLI returned a non-object tool entry.');
    }
    const record = raw as Record<string, unknown>;
    const { name, definition_hash: definitionHash, label, reason } = record;
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error('Sorter CLI returned a tool entry without a non-empty name.');
    }
    if (typeof definitionHash !== 'string' || !definitionHash.trim()) {
      throw new Error(`Sorter CLI returned a tool entry for "${name}" without a non-empty definition_hash.`);
    }
    if (label !== 'ask_first' && label !== 'just_do') {
      throw new Error(`Sorter CLI returned an invalid label for "${name}": ${String(label)}`);
    }
    if (typeof reason !== 'string' || !reason.trim()) {
      throw new Error(`Sorter CLI returned a tool entry for "${name}" without a non-empty reason.`);
    }
    entries.push({
      name: name.trim(),
      definitionHash: definitionHash.trim(),
      label,
      reason: reason.trim(),
    });
  }
  return entries;
}

interface ClaudeCliJsonResult {
  readonly subtype?: string;
  readonly is_error?: boolean;
  readonly result?: string;
  readonly structured_output?: { readonly tools?: readonly RawSortEntry[] };
  readonly total_cost_usd?: number;
  readonly modelUsage?: Readonly<Record<string, unknown>>;
}

function parseFlags(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('Flags require explicit values.');
    if (flags.has(key)) throw new Error(`Repeated flag: ${key}`);
    flags.set(key, value);
  }
  const allowed = new Set(['--cases', '--model', '--out', '--claude', '--concurrency']);
  for (const key of flags.keys()) if (!allowed.has(key)) throw new Error(`Unknown flag: ${key}`);
  return flags;
}

async function runClaudeSort(
  claudePath: string,
  model: string | undefined,
  prompt: string,
): Promise<{
  readonly entries: readonly ParsedSortToolEntry[];
  readonly resolvedModel: string;
  readonly costUsd: number;
}> {
  const emptyMcp = JSON.stringify({ mcpServers: {} });
  const args = [
    '--print',
    '--output-format',
    'json',
    '--json-schema',
    SORT_OUTPUT_SCHEMA,
    '--tools',
    '',
    '--mcp-config',
    emptyMcp,
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--no-session-persistence',
    ...(model ? ['--model', model] : []),
  ];

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(claudePath, args, {
      cwd: os.tmpdir(),
      env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(`claude exited ${code}: ${err.slice(0, 500)}`));
      else resolve(out);
    });
    child.stdin.end(prompt);
  });

  const parsed = JSON.parse(stdout) as ClaudeCliJsonResult;
  if (parsed.is_error) throw new Error(`claude returned error: ${parsed.result ?? parsed.subtype ?? 'unknown'}`);

  let rawTools: unknown = parsed.structured_output?.tools;
  if (!Array.isArray(rawTools) && typeof parsed.result === 'string' && parsed.result.trim()) {
    const inner = JSON.parse(parsed.result) as { tools?: unknown };
    rawTools = inner.tools;
  }
  if (!Array.isArray(rawTools)) throw new Error('Sorter CLI returned no structured tools array.');

  const modelKeys = Object.keys(parsed.modelUsage ?? {});
  const resolvedModel = model || modelKeys[0] || 'default';
  const entries = parseRawSortEntries(rawTools);
  return { entries, resolvedModel, costUsd: parsed.total_cost_usd ?? 0 };
}

async function evaluateCase(
  sortCase: SortEvalCase,
  claudePath: string,
  model: string | undefined,
): Promise<{
  readonly rawScore: SortCaseScore;
  readonly finalScore: SortCaseScore;
  readonly resolvedModel: string;
  readonly costUsd: number;
}> {
  const prompt = `${buildSortPrompt(
    sortCase.tools.map((item) => ({
      name: item.definition.name,
      definitionHash: item.definitionHash,
      definition: item.definition,
    })),
  )}\n\nReturn the classification as the structured JSON object with key \`tools\`.`;

  const { entries, resolvedModel, costUsd } = await runClaudeSort(claudePath, model, prompt);
  const expected = new Map(
    sortCase.tools.map((item) => [
      item.definition.name,
      { definitionHash: item.definitionHash, definition: item.definition },
    ]),
  );
  const { updates } = resolveFinalToolUpdates(expected, entries);
  const rawUpdates = entries.map((entry) => ({
    name: entry.name,
    definitionHash: entry.definitionHash,
    label: entry.label,
    source: 'sorter' as const,
    reason: entry.reason,
  }));

  return {
    rawScore: scoreSortCase(sortCase, rawUpdates),
    finalScore: scoreSortCase(sortCase, updates),
    resolvedModel,
    costUsd,
  };
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const claudePath = path.resolve(flags.get('--claude') ?? path.join(os.homedir(), '.local', 'bin', 'claude'));
  if (!fs.existsSync(claudePath)) {
    throw new Error(`Authenticated claude CLI not found at ${claudePath}. Pass --claude <path>.`);
  }
  const requestedModel = flags.get('--model') || process.env.NANOCLAW_DEFAULT_MODEL || undefined;
  const concurrency = Number(flags.get('--concurrency') ?? '4');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('--concurrency must be a positive integer.');

  const filter = new Set(
    (flags.get('--cases') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const selected =
    filter.size === 0 ? APP_TOOL_SORT_CORPUS : APP_TOOL_SORT_CORPUS.filter((item) => filter.has(item.id));
  if (selected.length === 0) throw new Error('No matching cases selected.');

  const outDir = path.resolve(
    flags.get('--out') ?? path.join(os.tmpdir(), `app-tool-sort-${new Date().toISOString().replace(/[:.]/g, '-')}`),
  );
  fs.mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, 'results.json');
  fs.rmSync(reportPath, { force: true });

  const results = new Array<Awaited<ReturnType<typeof evaluateCase>>>(selected.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
    while (cursor < selected.length) {
      const idx = cursor++;
      const sortCase = selected[idx]!;
      const outcome = await evaluateCase(sortCase, claudePath, requestedModel);
      results[idx] = outcome;
      const status = outcome.finalScore.passed ? 'PASS' : 'FAIL';
      console.log(
        `${status}\t${sortCase.id}\tmust_ask=${outcome.finalScore.mustAskTotal - outcome.finalScore.missedMustAsk.length}/${outcome.finalScore.mustAskTotal}\tmissed=${outcome.finalScore.missedMustAsk.length}\tunnecessary_asks=${outcome.finalScore.unnecessaryAsks.length}/${outcome.finalScore.allowJustDoTotal}\t(raw_missed=${outcome.rawScore.missedMustAsk.length})`,
      );
    }
  });
  await Promise.all(workers);

  const actualModel = results[0]?.resolvedModel ?? requestedModel ?? 'default';
  const version = sorterVersion(actualModel);
  const finalSuite = scoreSortSuite({
    model: actualModel,
    sorterVersion: version,
    cases: results.map((r) => r.finalScore),
  });
  const rawSuite = scoreSortSuite({
    model: actualModel,
    sorterVersion: version,
    cases: results.map((r) => r.rawScore),
  });
  const totalCostUsd = results.reduce((sum, r) => sum + r.costUsd, 0);
  const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tree, encoding: 'utf8' }).trim();

  const report = {
    recordedAt: new Date().toISOString(),
    commit,
    model: actualModel,
    sorterVersion: version,
    totalCostUsd: Number(totalCostUsd.toFixed(6)),
    final: finalSuite,
    rawModelBeforeFloors: {
      passed: rawSuite.passed,
      missedMustAskCount: rawSuite.missedMustAskCount,
      unnecessaryAskCount: rawSuite.unnecessaryAskCount,
      missingCount: rawSuite.missingCount,
    },
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log('');
  console.log(
    `SUMMARY: ${finalSuite.passed ? 'PASSED' : 'FAILED'} | sorterVersion=${version} | must_ask_missed=${finalSuite.missedMustAskCount}/${finalSuite.mustAskTotal} (raw=${rawSuite.missedMustAskCount}) | unnecessary_asks=${finalSuite.unnecessaryAskCount}/${finalSuite.allowJustDoTotal} | cost=$${totalCostUsd.toFixed(4)} | report=${reportPath}`,
  );
  if (!finalSuite.passed) {
    for (const item of finalSuite.cases) {
      for (const miss of item.missedMustAsk) {
        console.error(`MISS [${item.id}] ${miss.name}: assigned=${miss.assigned} (${miss.reason})`);
      }
    }
    process.exitCode = 1;
  }
}

void main();
