/** Operator-run, private ASR comparison. This never qualifies assistant behavior. */
import { createHash } from 'node:crypto';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpeechResult } from '../../../channels/inbound-content.js';
import { isRecord } from '../../../gws-ea/validation.js';
import {
  verifyVoiceInstallation,
  type VerifiedVoiceInstallation,
  type VoiceAssetReceipt,
  type VoiceModelId,
} from '../../../gws-ea/voice-assets.js';
import { VoiceProcessError } from '../process.js';
import { readOriginalAudio } from '../staging.js';
import { transcribeAudio, VoiceRecognitionError } from '../transcribe.js';

const MODELS: readonly VoiceModelId[] = ['base', 'small', 'large-v3-turbo-q5_0'];
const CHECKOUT = fileURLToPath(new URL('../../../../', import.meta.url));

interface ComparisonNote {
  id: string;
  audioFile: string;
  /** Human-written before the run; never a prompt to another model. */
  expectedIntent: string;
}

export interface ComparisonManifest {
  schemaVersion: 1;
  repetitions: number;
  installations: Record<VoiceModelId, string>;
  notes: ComparisonNote[];
}

interface ComparisonRun {
  model: VoiceModelId;
  repetition: number;
  wallMs: number;
  result: SpeechResult;
}

export interface ComparisonReport {
  schemaVersion: 1;
  createdAt: string;
  qualification: 'pending';
  measurement: 'decode-and-recognition-wall-time';
  pendingEvidence: string[];
  host: {
    platform: string;
    architecture: string;
    cpu: string;
    logicalCpus: number;
    totalMemoryBytes: number;
    node: string;
  };
  installations: { directory: string; receipt: VoiceAssetReceipt }[];
  notes: {
    id: string;
    audioFile: string;
    inputBytes: number;
    sha256: string;
    expectedIntent: string;
    runs: ComparisonRun[];
  }[];
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Expected a comparison object');
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Comparison ${field} must be nonempty text`);
  return value;
}

function absolute(value: unknown, field: string): string {
  const file = text(value, field);
  if (!path.isAbsolute(file) || /[\0\r\n]/.test(file))
    throw new Error(`Comparison ${field} must be an absolute local path`);
  return file;
}

export function parseComparisonManifest(value: unknown): ComparisonManifest {
  const manifest = record(value);
  if (manifest.schemaVersion !== 1) throw new Error('Unsupported voice comparison manifest');
  if (
    typeof manifest.repetitions !== 'number' ||
    !Number.isSafeInteger(manifest.repetitions) ||
    manifest.repetitions < 1
  )
    throw new Error('Comparison repetitions must be a positive integer');
  const supplied = record(manifest.installations);
  const installations: Record<VoiceModelId, string> = {
    base: absolute(supplied.base, 'base installation'),
    small: absolute(supplied.small, 'small installation'),
    'large-v3-turbo-q5_0': absolute(supplied['large-v3-turbo-q5_0'], 'turbo installation'),
  };
  if (Object.keys(supplied).length !== MODELS.length)
    throw new Error('Comparison requires exactly base, small, and turbo');
  if (!Array.isArray(manifest.notes) || !manifest.notes.length) throw new Error('Comparison needs human audio notes');
  const ids = new Set<string>();
  const notes = manifest.notes.map((value: unknown): ComparisonNote => {
    const note = record(value);
    const id = text(note.id, 'note id');
    if (ids.has(id)) throw new Error('Comparison note ids must be unique');
    ids.add(id);
    return {
      id,
      audioFile: absolute(note.audioFile, 'audio file'),
      expectedIntent: text(note.expectedIntent, 'expected intent'),
    };
  });
  return { schemaVersion: 1, repetitions: manifest.repetitions, installations, notes };
}

/** True if `child` is `parent` itself or below it. */
function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function externalPath(file: string): Promise<string> {
  const canonical = path.join(await realpath(path.dirname(file)), path.basename(file));
  if (isPathInside(await realpath(CHECKOUT), canonical))
    throw new Error('Private comparison files must stay outside the checkout');
  return canonical;
}

/** All candidates receive the same retained bytes; results are faithful source, not scored intent. */
export async function compareVoiceNotes(
  manifest: ComparisonManifest,
  outputDirectory: string,
  signal: AbortSignal,
): Promise<ComparisonReport> {
  const output = await externalPath(absolute(outputDirectory, 'output directory'));
  const installations = new Map<VoiceModelId, VerifiedVoiceInstallation>();
  for (const model of MODELS) {
    const installation = await verifyVoiceInstallation(manifest.installations[model]);
    if (installation.receipt.model !== model)
      throw new Error(`Comparison installation has the wrong model for ${model}`);
    installations.set(model, installation);
  }
  const privatePath = (file: string) => {
    for (const installation of installations.values()) {
      if (isPathInside(installation.installationDir, file))
        throw new Error('Private comparison files cannot use shared voice assets');
    }
  };
  privatePath(output);
  const originals: { note: ComparisonNote; file: string }[] = [];
  for (const note of manifest.notes) {
    const file = await externalPath(note.audioFile);
    privatePath(file);
    originals.push({ note, file });
  }
  // Exclusive creation prevents overwriting prior evidence; the directory protects all transcript files.
  await mkdir(output, { mode: 0o700 });
  const temporary = path.join(output, 'temporary');
  const cpus = os.cpus();
  const report: ComparisonReport = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    qualification: 'pending',
    measurement: 'decode-and-recognition-wall-time',
    pendingEvidence: [
      'Human review of requests, dates, conditions, negations, numbers, recipients, and complete-note coverage',
      'Live Google Chat receiving-agent actions, verified tool results, follow-through, and ordinary replies',
      'Source duration, separate decode/inference/queue time, child peak RSS, and conversational latency budget',
      'Repeated AE1–AE9 acceptance on supported hosts and actual supported receiving provider',
    ],
    host: {
      platform: process.platform,
      architecture: process.arch,
      cpu: cpus[0]?.model ?? 'unknown',
      logicalCpus: cpus.length,
      totalMemoryBytes: os.totalmem(),
      node: process.version,
    },
    installations: [...installations.values()].map(({ installationDir, receipt }) => ({
      directory: installationDir,
      receipt,
    })),
    notes: [],
  };
  try {
    for (const { note, file } of originals) {
      const bytes = await readOriginalAudio({ path: file }, path.dirname(file));
      const evidence = {
        id: note.id,
        audioFile: file,
        inputBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        expectedIntent: note.expectedIntent,
        runs: [] as ComparisonRun[],
      };
      report.notes.push(evidence);
      for (let repetition = 1; repetition <= manifest.repetitions; repetition++) {
        for (const [model, installation] of installations) {
          signal.throwIfAborted();
          const started = performance.now();
          let result: SpeechResult;
          try {
            result = await transcribeAudio(bytes, installation, temporary, signal);
          } catch (error) {
            if (!(error instanceof VoiceRecognitionError || error instanceof VoiceProcessError)) throw error;
            if (signal.aborted) throw error;
            result = { status: 'failed', reason: error.code };
          }
          evidence.runs.push({ model, repetition, wallMs: performance.now() - started, result });
        }
      }
    }
    await writeFile(path.join(output, 'comparison.json'), `${JSON.stringify(report, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    return report;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function runComparisonCli(args: readonly string[], output: (line: string) => void): Promise<number> {
  if (args.length !== 4 || args[0] !== '--manifest' || args[2] !== '--output')
    throw new Error('Usage: compare.ts --manifest /private/notes.json --output /private/new-results');
  const manifestFile = await externalPath(absolute(args[1], 'manifest file'));
  const manifest = parseComparisonManifest(
    JSON.parse(
      (await readOriginalAudio({ path: manifestFile }, path.dirname(manifestFile))).toString('utf8'),
    ) as unknown,
  );
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const report = await compareVoiceNotes(manifest, args[3], controller.signal);
    output(`Private comparison saved: ${path.join(args[3], 'comparison.json')}. Model qualification remains pending.`);
    return report.notes.some((note) => note.runs.some((run) => run.result.status === 'failed')) ? 1 : 0;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void runComparisonCli(process.argv.slice(2), console.log)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'Voice comparison failed');
      process.exitCode = 1;
    });
}
