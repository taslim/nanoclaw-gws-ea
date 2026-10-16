import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DesktopObservation } from './focus-sampler.js';

export type ProbeStatus = 'passed' | 'failed' | 'not-run';
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface ProbeResult {
  name: string;
  status: ProbeStatus;
  detail: { [key: string]: JsonValue };
}

export interface LiveCheckReport {
  startedAt: string;
  finishedAt: string;
  chromeVersion: string;
  macosVersion: string;
  probes: ProbeResult[];
  observations: DesktopObservation[];
  decisions: { [key: string]: JsonValue };
}

export async function runProbe(name: string, execute: () => Promise<Omit<ProbeResult, 'name'>>): Promise<ProbeResult> {
  try {
    return { name, ...(await execute()) };
  } catch (error: unknown) {
    return {
      name,
      status: 'failed',
      detail: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export async function writeEvidence(input: {
  outputRoot: string;
  runId: string;
  report: LiveCheckReport;
}): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(input.runId)) {
    throw new Error('Evidence run id must be a single safe path component');
  }
  await mkdir(input.outputRoot, { recursive: true, mode: 0o700 });
  const destination = join(input.outputRoot, input.runId);
  // Intentionally not recursive: EEXIST preserves the original evidence.
  await mkdir(destination, { mode: 0o700 });
  await writeFile(join(destination, 'results.json'), `${JSON.stringify(input.report, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  const lines = [
    '# Host browser live check',
    '',
    `Started: ${input.report.startedAt}`,
    `Finished: ${input.report.finishedAt}`,
    `Chrome: ${input.report.chromeVersion}`,
    `macOS: ${input.report.macosVersion}`,
    '',
    ...input.report.probes.map((probe) => `- **${probe.status}**: ${probe.name}`),
    '',
    'See results.json for observations, exact scope and unrun checks. A not-run check is not acceptance evidence.',
    '',
  ];
  await writeFile(join(destination, 'README.md'), lines.join('\n'), { flag: 'wx', mode: 0o600 });
  return destination;
}
