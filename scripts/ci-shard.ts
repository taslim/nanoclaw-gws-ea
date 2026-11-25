import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_TIMINGS_PATH = path.join(ROOT, '.github/ci-test-timings.json');
const DEFAULT_WEIGHT_MS = 1_000;

/**
 * Only these host test suites invoke external shells (`zsh`, `fish`) or `lsof`.
 * Shards that contain none of them skip `apt-get install` entirely.
 */
export const SHELL_TEST_FILES = new Set<string>(['src/gws-ea/cli-completion.test.ts', 'src/gws-ea/cutover.test.ts']);

/**
 * Heavy suites that launch real native Chrome processes. Spreading them evenly
 * across shards prevents one 4-core runner from launching 4+ Chrome instances
 * simultaneously and starving Playwright timeouts.
 */
export const CHROME_HEAVY_FILES = new Set<string>([
  'src/modules/gws-ea-browser/open-web-native.test.ts',
  'src/modules/gws-ea-browser/open-web-native.actions.test.ts',
  'src/modules/gws-ea-browser/open-web-native.purchases.test.ts',
  'src/modules/gws-ea-browser/open-web-native.purchases-flow.test.ts',
  'src/modules/gws-ea-browser/purchase.test.ts',
  'src/modules/gws-ea-browser/credential-native.test.ts',
  'src/modules/gws-ea-browser/fill-native.test.ts',
  'src/modules/gws-ea-browser/open-web-watch-native.test.ts',
  'src/modules/gws-ea-browser/logins-page.test.ts',
  'src/modules/gws-ea-artifacts/viewer.test.ts',
  'src/modules/gws-ea-browser/recipes.test.ts',
  'src/modules/gws-ea-connections/page.test.ts',
  'src/modules/gws-ea-browser/index.lifecycle.test.ts',
  'src/modules/gws-ea-browser/reservation-execution.test.ts',
  'src/modules/gws-ea-browser/queue.test.ts',
  'src/modules/gws-ea-browser/document-gate.test.ts',
  'src/modules/gws-ea-browser/resy-signature.test.ts',
]);

export interface ShardPlan {
  readonly shards: readonly (readonly string[])[];
  readonly weightsMs: readonly number[];
}

export function loadTimings(timingsPath: string = DEFAULT_TIMINGS_PATH): Readonly<Record<string, number>> {
  const raw = JSON.parse(readFileSync(timingsPath, 'utf8')) as unknown;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Expected JSON object in ${timingsPath}`);
  }
  const result: Record<string, number> = {};
  for (const [file, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      result[file] = value;
    }
  }
  return result;
}

/**
 * Deterministically assigns every discovered test file to one of `totalShards`
 * shards using Longest-Processing-Time-first (LPT) bin packing.
 *
 * Throws if the resulting partition drops or duplicates any file.
 */
export function buildShardPlan(
  files: readonly string[],
  timings: Readonly<Record<string, number>>,
  totalShards: number,
): ShardPlan {
  if (!Number.isInteger(totalShards) || totalShards < 1) {
    throw new Error(`Invalid shard count: ${totalShards}`);
  }

  const uniqueFiles = [...new Set(files.map((f) => f.trim()).filter(Boolean))];
  if (uniqueFiles.length !== files.filter((f) => f.trim().length > 0).length) {
    throw new Error('Duplicate test file paths passed to buildShardPlan');
  }

  const weighted = uniqueFiles.map((file) => ({
    file,
    weightMs: timings[file] ?? DEFAULT_WEIGHT_MS,
    chromeHeavy: CHROME_HEAVY_FILES.has(file),
  }));

  const chromeItems = weighted
    .filter((item) => item.chromeHeavy)
    .sort((a, b) => b.weightMs - a.weightMs || a.file.localeCompare(b.file));
  const otherItems = weighted
    .filter((item) => !item.chromeHeavy)
    .sort((a, b) => b.weightMs - a.weightMs || a.file.localeCompare(b.file));

  const buckets: string[][] = Array.from({ length: totalShards }, () => []);
  const weightsMs: number[] = Array.from({ length: totalShards }, () => 0);
  const chromeCounts: number[] = Array.from({ length: totalShards }, () => 0);

  // Spread Chrome-heavy files evenly by count first (tie-broken by lightest weight)
  // so no single runner launches 4+ native Chrome suites concurrently.
  for (const item of chromeItems) {
    let target = 0;
    for (let i = 1; i < totalShards; i++) {
      if (
        chromeCounts[i]! < chromeCounts[target]! ||
        (chromeCounts[i]! === chromeCounts[target]! && weightsMs[i]! < weightsMs[target]!)
      ) {
        target = i;
      }
    }
    buckets[target]!.push(item.file);
    weightsMs[target] = weightsMs[target]! + item.weightMs;
    chromeCounts[target] = chromeCounts[target]! + 1;
  }

  // LPT bin-pack remaining files by weight to equalize total shard duration.
  for (const item of otherItems) {
    let lightestIndex = 0;
    for (let i = 1; i < totalShards; i++) {
      if (weightsMs[i]! < weightsMs[lightestIndex]!) {
        lightestIndex = i;
      }
    }
    buckets[lightestIndex]!.push(item.file);
    weightsMs[lightestIndex] = weightsMs[lightestIndex]! + item.weightMs;
  }

  for (const bucket of buckets) {
    bucket.sort();
  }

  // Prove the shards partition the exact discovered set with zero omissions or duplicates.
  const assigned = new Set<string>();
  let totalAssigned = 0;
  for (const bucket of buckets) {
    for (const file of bucket) {
      if (assigned.has(file)) {
        throw new Error(`Shard partition duplicate: ${file}`);
      }
      assigned.add(file);
      totalAssigned++;
    }
  }
  if (totalAssigned !== uniqueFiles.length) {
    throw new Error(`Shard partition mismatch: assigned ${totalAssigned} of ${uniqueFiles.length} files`);
  }

  return { shards: buckets, weightsMs };
}

export function shardNeedsShells(shardFiles: readonly string[]): boolean {
  return shardFiles.some((file) => SHELL_TEST_FILES.has(file));
}

export function parseShardSpec(spec: string): { index: number; total: number } {
  const match = /^(\d+)\/(\d+)$/.exec(spec.trim());
  if (!match) {
    throw new Error(`Expected <index>/<total> shard spec, got: ${spec}`);
  }
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || index > total) {
    throw new Error(`Shard spec out of range: ${spec}`);
  }
  return { index, total };
}

function discoverVitestFiles(): string[] {
  const stdout = execFileSync('pnpm', ['exec', 'vitest', 'list', '--filesOnly'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.endsWith('.test.ts'));
}

function main(args: readonly string[]): void {
  const [command, arg, outFile] = args;
  if (!command || !arg) {
    throw new Error('Usage: ci-shard.ts <plan|files|needs-shells|verify> <index/total | total> [outFile]');
  }

  const files = discoverVitestFiles();
  const timings = loadTimings();

  if (command === 'verify') {
    const total = Number(arg);
    const plan = buildShardPlan(files, timings, total);
    for (let i = 0; i < total; i++) {
      const shardFiles = plan.shards[i]!;
      const weightS = (plan.weightsMs[i]! / 1000).toFixed(1);
      const shells = shardNeedsShells(shardFiles) ? ' [shells]' : '';
      process.stdout.write(`shard ${i + 1}/${total}: ${shardFiles.length} files, est ${weightS}s${shells}\n`);
    }
    return;
  }

  const { index, total } = parseShardSpec(arg);
  const plan = buildShardPlan(files, timings, total);
  const shardFiles = plan.shards[index - 1]!;

  if (command === 'plan') {
    if (!outFile) {
      throw new Error('Usage: ci-shard.ts plan <index/total> <outFile>');
    }
    writeFileSync(outFile, `${shardFiles.join('\n')}\n`, 'utf8');
    process.stdout.write(`needs_shells=${shardNeedsShells(shardFiles) ? 'true' : 'false'}\n`);
    process.stdout.write(`file_count=${shardFiles.length}\n`);
    return;
  }

  if (command === 'files') {
    process.stdout.write(`${shardFiles.join('\n')}\n`);
    return;
  }

  if (command === 'needs-shells') {
    process.stdout.write(`${shardNeedsShells(shardFiles) ? 'true' : 'false'}\n`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main(process.argv.slice(2));
}
