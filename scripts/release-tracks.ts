import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import productTracks from '../src/gws-ea/release-tracks.json' with { type: 'json' };
import { resolveReleaseSource } from '../src/gws-ea/release-tracks.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const generateCommand = 'pnpm run release-tracks:generate';
const targets = [
  { file: '.github/workflows/ci.yml', property: 'branches', blocks: 2, escape: escapeGlob },
  { file: '.coderabbit.yaml', property: 'base_branches', blocks: 1, escape: exactPattern },
] as const;

function escapeGlob(branch: string): string {
  return branch.replace(/[\\*?[\]!+]/g, '\\$&');
}

function exactPattern(branch: string): string {
  return `^${branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

async function syncConfiguration(mode: '--check' | '--generate'): Promise<void> {
  const branches = [...new Set(['main', ...Object.values(productTracks).filter((branch) => branch !== null)])];
  const prepared = await Promise.all(
    targets.map(async (target) => {
      const file = path.join(root, target.file);
      const before = await readFile(file, 'utf8');
      const newline = before.includes('\r\n') ? '\r\n' : '\n';
      let blocks = 0;
      const after = before.replace(
        /^([ \t]*)# release-tracks:start\r?\n[\s\S]*?^\1# release-tracks:end(?=\r?$)/gm,
        (_block: string, indent: string) => {
          blocks++;
          return [
            `${indent}# release-tracks:start`,
            `${indent}${target.property}:`,
            ...branches.map((branch) => `${indent}  - '${target.escape(branch).replaceAll("'", "''")}'`),
            `${indent}# release-tracks:end`,
          ].join(newline);
        },
      );
      if (blocks !== target.blocks) {
        throw new Error(`${target.file}: expected ${target.blocks} release-tracks marker blocks, found ${blocks}`);
      }
      return { file, label: target.file, before, after };
    }),
  );
  const changed = prepared.filter(({ before, after }) => before !== after);
  if (mode === '--check' && changed.length > 0) {
    throw new Error(
      `Release track configuration is stale: ${changed.map(({ label }) => label).join(', ')}. Run ${generateCommand}.`,
    );
  }
  if (mode === '--generate') {
    for (const { file, after } of changed) await writeFile(file, after);
  }
}

async function main(args: readonly string[]): Promise<void> {
  if (args.length === 2 && args[0] === '--branch') {
    const source = resolveReleaseSource(args[1]);
    process.stdout.write(`${source.ref.slice('refs/heads/'.length)}\n`);
    return;
  }
  if (args.length === 1 && (args[0] === '--check' || args[0] === '--generate')) {
    await syncConfiguration(args[0]);
    return;
  }
  throw new Error('Usage: release-tracks.ts --branch <track> | --generate | --check');
}

await main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
