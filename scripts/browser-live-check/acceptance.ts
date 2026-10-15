/** Post-merge, owner-operated dogfood acceptance. This script never sends an errand or approves a purchase. */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { SocketTransport } from '../../src/cli/socket-client.js';
import {
  DESKTOP_READ_TIMEOUT_MS,
  DESKTOP_SAMPLE_INTERVAL_MS,
  FocusSampler,
  type DesktopObservation,
} from './focus-sampler.js';
import type { JsonValue, ProbeStatus } from './evidence.js';

type JsonObject = { [key: string]: JsonValue };
export const acceptanceScenarios = [
  'delegation_own_job',
  'different_sites_parallel',
  'same_site_serialized',
  'restart_before_commit',
  'restart_after_commit',
  'email_code_sign_in',
  'vault_secret_confinement',
  'purchase_card_revalidation',
  'unsupported_purchase',
  'standing_guarantee',
  'clipboard_and_external_links',
  'cross_install_isolation',
  'quiet_spaces',
  'public_only_egress',
  'watch_soak',
] as const;
const errands = ['booking', 'form', 'invoice', 'compare-buy'] as const;
type Errand = (typeof errands)[number];
type Mode = 'cold' | 'recipe';
export interface NativeBrowserEvidence {
  schemaVersion: 1;
  capturedAt: string;
  job: {
    id: string;
    browserSessionId: string;
    createdAt: string;
    cancelled: boolean;
    cancelRequested: boolean;
    firstInboundAt: string | null;
    lastDeliveredReportAt: string | null;
  };
  requests: {
    id: string;
    requestId: string;
    action: string;
    emittedAt: string | null;
    acceptedAt: string;
    startedAt: string | null;
    commitStartedAt: string | null;
    answeredAt: string | null;
    deliveredAt: string | null;
    status: string | null;
    reason: string | null;
  }[];
  downloads: { id: string; filename: string; bytes: number; handedOffAt: string | null }[];
  purchase: { openCards: number; committedAttempts: number; unresolvedAttempts: number };
  watchNextCheckAt: string | null;
  watchChecks: WatchCheck[];
}
interface WatchCheck {
  id: string;
  scheduledAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  outcome: string | null;
  nextCheckAt: string | null;
}
interface Phases {
  transportMs: number;
  browserMs: number;
  modelAndOrchestrationMs: number;
  verificationMs: number;
  totalMs: number;
}
interface ReceiptSource {
  system: string;
  reference: string;
  sha256: string;
}
interface OwnerReceipt {
  checkedAt: string;
  source: ReceiptSource;
  expected: JsonObject;
  observed: JsonObject;
  provenance: 'owner_verified';
  verifiedSuccess: boolean;
}
export interface TimedErrand {
  id: string;
  errand: Errand;
  mode: Mode;
  startedAt: string;
  verifiedAt: string;
  reportedSuccess: boolean;
  verifiedSuccess: boolean;
  source: ReceiptSource;
  native: NativeBrowserEvidence;
  phases: Phases | null;
}
interface SampleStart {
  schemaVersion: 1;
  id: string;
  errand: Errand;
  mode: Mode;
  startedAt: string;
  expectedSha256?: string;
}
interface Soak {
  startedAt: string;
  finishedAt: string;
  initialNextCheckAt: string | null;
  scheduleChanges: { observedAt: string; nextCheckAt: string | null }[];
  checks: WatchCheck[];
  observedAt: string[];
}
const phases = ['transportMs', 'browserMs', 'modelAndOrchestrationMs', 'verificationMs', 'totalMs'] as const;

function object(value: unknown, message = 'Expected a JSON object'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Missing required text field');
  return value;
}
function timestamp(value: unknown): string {
  const result = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(result) || !Number.isFinite(Date.parse(result)))
    throw new Error('Invalid UTC timestamp');
  return result;
}
function nullableTime(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}
function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}
function nonnegative(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid metadata count');
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid boolean metadata');
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid metadata array');
  return value;
}
function component(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) throw new Error('Use a single safe evidence name');
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Invalid JSON fact');
  return encoded;
}
async function jsonFile(file: string, message = 'Invalid evidence JSON'): Promise<unknown> {
  const info = await lstat(file);
  if (!info.isFile() || info.size > 4 * 1024 * 1024)
    throw new Error('Evidence must be a regular JSON file smaller than 4 MiB');
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    throw new Error(message);
  }
}
async function privateJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
async function appendPrivate(file: string, value: unknown): Promise<void> {
  await appendFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}
async function hashFile(file: string): Promise<string> {
  const info = await lstat(file);
  if (!info.isFile()) throw new Error('Verification artifact must be a regular file');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function beginAcceptance(outputRoot: string, runId: string, deployment?: string): Promise<string> {
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const run = join(outputRoot, component(runId));
  await mkdir(run, { mode: 0o700 });
  await Promise.all(['samples', 'scenarios'].map((directory) => mkdir(join(run, directory), { mode: 0o700 })));
  await privateJson(join(run, 'manifest.json'), {
    schemaVersion: 1,
    execution: 'post_merge_owner_dogfood',
    createdAt: new Date().toISOString(),
    deployment: deployment ?? null,
    scenarios: acceptanceScenarios.map((name) => ({ name, status: 'not-run' })),
    timedErrands: errands.map((errand) => ({ errand, cold: 'not-run', recipe: 'not-run' })),
    timingAttribution: 'Model-and-orchestration is residual wall time, not measured provider inference time.',
  });
  return run;
}

export async function readOwnerReceipt(file: string): Promise<OwnerReceipt> {
  const info = await lstat(file);
  if (!info.isFile() || info.size > 4 * 1024 * 1024)
    throw new Error('Owner receipt must be a regular JSON file smaller than 4 MiB');
  const bytes = await readFile(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error('Invalid owner receipt JSON');
  }
  const value = object(parsed);
  if (value.schemaVersion !== 1) throw new Error('Unsupported owner receipt schema');
  const source = object(value.source);
  const expected = object(value.expected) as JsonObject;
  const observed = object(value.observed) as JsonObject;
  if (Object.keys(expected).length === 0)
    throw new Error('A receipt needs independent expected system-of-record facts');
  return {
    checkedAt: timestamp(value.checkedAt),
    source: {
      system: text(source.system),
      reference: text(source.reference),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
    expected,
    observed,
    provenance: 'owner_verified',
    verifiedSuccess: canonical(expected) === canonical(observed),
  };
}

/** Strict projection: no message content, request payload, URL or credential is copied into evidence. */
export function parseNativeEvidence(raw: unknown): NativeBrowserEvidence {
  const value = object(raw);
  if (value.schemaVersion !== 1) throw new Error('Unsupported native browser evidence schema');
  const job = object(value.job);
  const purchase = object(value.purchase);
  return {
    schemaVersion: 1,
    capturedAt: timestamp(value.capturedAt),
    job: {
      id: text(job.id),
      browserSessionId: text(job.browserSessionId),
      createdAt: timestamp(job.createdAt),
      cancelled: boolean(job.cancelled),
      cancelRequested: boolean(job.cancelRequested),
      firstInboundAt: nullableTime(job.firstInboundAt),
      lastDeliveredReportAt: nullableTime(job.lastDeliveredReportAt),
    },
    requests: array(value.requests).map((rawRequest) => {
      const request = object(rawRequest);
      return {
        id: text(request.id),
        requestId: text(request.requestId),
        action: text(request.action),
        emittedAt: nullableTime(request.emittedAt),
        acceptedAt: timestamp(request.acceptedAt),
        startedAt: nullableTime(request.startedAt),
        commitStartedAt: nullableTime(request.commitStartedAt),
        answeredAt: nullableTime(request.answeredAt),
        deliveredAt: nullableTime(request.deliveredAt),
        status: nullableText(request.status),
        reason: nullableText(request.reason),
      };
    }),
    downloads: array(value.downloads).map((rawDownload) => {
      const download = object(rawDownload);
      return {
        id: text(download.id),
        filename: text(download.filename),
        bytes: nonnegative(download.bytes),
        handedOffAt: nullableTime(download.handedOffAt),
      };
    }),
    purchase: {
      openCards: nonnegative(purchase.openCards),
      committedAttempts: nonnegative(purchase.committedAttempts),
      unresolvedAttempts: nonnegative(purchase.unresolvedAttempts),
    },
    watchNextCheckAt: nullableTime(value.watchNextCheckAt),
    watchChecks: array(value.watchChecks).map((rawCheck) => {
      const check = object(rawCheck);
      return {
        id: text(check.id),
        scheduledAt: timestamp(check.scheduledAt),
        startedAt: nullableTime(check.startedAt),
        finishedAt: nullableTime(check.finishedAt),
        outcome: nullableText(check.outcome),
        nextCheckAt: nullableTime(check.nextCheckAt),
      };
    }),
  };
}
async function captureNative(socketPath: string, job: string): Promise<NativeBrowserEvidence> {
  if (!isAbsolute(socketPath)) throw new Error('Supply the deployed assistant absolute ncl.sock path');
  const response = await new SocketTransport(socketPath).sendFrame({
    id: randomUUID(),
    command: 'gws-ea-browser-evidence',
    args: { job },
  });
  if (!response.ok)
    throw new Error('The deployed host could not return browser evidence; check its deployment and job id');
  const result = parseNativeEvidence(response.data);
  if (result.job.id !== job) throw new Error('Host returned evidence for a different browser job');
  return result;
}

function unionLength(intervals: [number, number][]): number {
  let total = 0;
  let end = -Infinity;
  for (const [from, to] of intervals.sort(([a], [b]) => a - b)) {
    total += Math.max(0, to - Math.max(from, end));
    end = Math.max(end, to);
  }
  return total;
}
export function calculatePhases(startedAt: string, verifiedAt: string, native: NativeBrowserEvidence): Phases | null {
  const start = Date.parse(startedAt);
  const end = Date.parse(verifiedAt);
  const report = native.job.lastDeliveredReportAt === null ? NaN : Date.parse(native.job.lastDeliveredReportAt);
  const firstInbound = native.job.firstInboundAt === null ? NaN : Date.parse(native.job.firstInboundAt);
  if (
    ![start, end, report, firstInbound].every(Number.isFinite) ||
    start > firstInbound ||
    firstInbound > report ||
    report > end ||
    native.requests.length === 0
  )
    return null;
  const transport: [number, number][] = [[start, firstInbound]];
  const browser: [number, number][] = [];
  for (const request of native.requests) {
    const dates = [request.emittedAt, request.acceptedAt, request.startedAt, request.answeredAt, request.deliveredAt];
    if (dates.some((date) => date === null)) return null;
    const times = dates.map((date) => Date.parse(date!));
    if (
      times.some(
        (time, index) =>
          !Number.isFinite(time) || time < firstInbound || time > report || (index > 0 && time < times[index - 1]!),
      )
    )
      return null;
    transport.push([times[0]!, times[2]!], [times[3]!, times[4]!]);
    browser.push([times[2]!, times[3]!]);
  }
  const transportMs = unionLength(transport);
  const browserMs = unionLength(browser);
  const activeMs = unionLength([...transport, ...browser]);
  // Overlapping phases cannot be independently added (e.g. concurrent requests).
  if (activeMs !== transportMs + browserMs) return null;
  return {
    transportMs,
    browserMs,
    modelAndOrchestrationMs: report - start - activeMs,
    verificationMs: end - report,
    totalMs: end - start,
  };
}
function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!;
}
export function summarizeTimedErrands(samples: TimedErrand[]): {
  errand: Errand;
  status: ProbeStatus;
  verifiedSuccessRate: number | null;
  selfReportedSuccessRate: number | null;
  falseSuccessClaims: number;
  cold: ReturnType<typeof summarizeMode>;
  recipe: ReturnType<typeof summarizeMode>;
}[] {
  return errands.map((errand) => {
    const runs = samples.filter((sample) => sample.errand === errand);
    const cold = summarizeMode(runs.filter((sample) => sample.mode === 'cold'));
    const recipe = summarizeMode(runs.filter((sample) => sample.mode === 'recipe'));
    const falseSuccessClaims = runs.filter((sample) => sample.reportedSuccess && !sample.verifiedSuccess).length;
    const enough =
      cold.samples >= 5 &&
      recipe.samples >= 5 &&
      cold.measuredSamples === cold.samples &&
      recipe.measuredSamples === recipe.samples;
    return {
      errand,
      status: !enough
        ? 'not-run'
        : falseSuccessClaims ||
            runs.some((sample) => !sample.verifiedSuccess) ||
            recipe.phases!.totalMs.p50 >= cold.phases!.totalMs.p50
          ? 'failed'
          : 'passed',
      verifiedSuccessRate: runs.length ? runs.filter((sample) => sample.verifiedSuccess).length / runs.length : null,
      selfReportedSuccessRate: runs.length
        ? runs.filter((sample) => sample.reportedSuccess).length / runs.length
        : null,
      falseSuccessClaims,
      cold,
      recipe,
    };
  });
}
function summarizeMode(samples: TimedErrand[]): {
  samples: number;
  measuredSamples: number;
  phases: Record<(typeof phases)[number], { p50: number; p90: number }> | null;
} {
  const measured = samples.flatMap((sample) => (sample.phases ? [sample.phases] : []));
  return {
    samples: samples.length,
    measuredSamples: measured.length,
    phases: measured.length
      ? (Object.fromEntries(
          phases.map((phase) => [
            phase,
            {
              p50: percentile(
                measured.map((sample) => sample[phase]),
                0.5,
              ),
              p90: percentile(
                measured.map((sample) => sample[phase]),
                0.9,
              ),
            },
          ]),
        ) as Record<(typeof phases)[number], { p50: number; p90: number }>)
      : null,
  };
}

export async function verifyCapturedOutcome(
  errand: Errand,
  native: NativeBrowserEvidence,
  options: { artifactPath?: string; expectedSha256?: string; ownerVerified?: boolean },
): Promise<boolean> {
  if (errand === 'invoice') {
    if (!options.artifactPath || !options.expectedSha256 || !/^[a-f0-9]{64}$/.test(options.expectedSha256))
      throw new Error('Invoice verification requires an artifact and a predeclared SHA256');
    const info = await lstat(options.artifactPath);
    return (
      native.downloads.some(
        (download) =>
          download.handedOffAt !== null &&
          download.filename === basename(options.artifactPath!) &&
          download.bytes === info.size,
      ) && (await hashFile(options.artifactPath)) === options.expectedSha256
    );
  }
  if (errand === 'compare-buy')
    return (
      native.purchase.openCards > 0 &&
      native.purchase.committedAttempts === 0 &&
      native.purchase.unresolvedAttempts === 0 &&
      native.requests.every((request) => request.commitStartedAt === null)
    );
  // The runtime cannot independently establish a real booking/form's system-of-record truth.
  return options.ownerVerified === true;
}

export async function scanCanaryFiles(
  canaryFile: string,
  files: string[],
): Promise<{ status: ProbeStatus; filesScanned: number; matches: number }> {
  const info = await lstat(canaryFile);
  if (
    !info.isFile() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid()) ||
    info.size > 65_536
  )
    throw new Error('Canary file must be an owner-only regular file smaller than 64 KiB');
  const canaries = array(await jsonFile(canaryFile)).map(text);
  if (!canaries.length || canaries.some((canary) => canary.length > 8_192))
    throw new Error('Supply nonempty bounded canary values');
  const needles = [
    ...new Set(
      canaries.flatMap((canary) => [
        canary,
        encodeURIComponent(canary),
        JSON.stringify(canary).slice(1, -1),
        Buffer.from(canary).toString('base64'),
      ]),
    ),
  ].map((needle) => Buffer.from(needle));
  const overlap = Math.max(...needles.map((needle) => needle.length)) - 1;
  let matches = 0;
  for (const file of files) {
    if (!(await lstat(file)).isFile()) throw new Error('Scan only regular agent-output or log files');
    let tail = Buffer.alloc(0);
    let found = false;
    for await (const rawChunk of createReadStream(file, { highWaterMark: 65_536 })) {
      const chunk = Buffer.concat([tail, rawChunk as Buffer]);
      if (needles.some((needle) => chunk.includes(needle))) found = true;
      tail = chunk.subarray(Math.max(0, chunk.length - overlap));
    }
    if (found) matches++;
  }
  return {
    status: files.length === 0 ? 'not-run' : matches ? 'failed' : 'passed',
    filesScanned: files.length,
    matches,
  };
}

export function verifyWatchSoak(
  soak: Soak,
  receipt: Pick<OwnerReceipt, 'checkedAt' | 'verifiedSuccess' | 'expected' | 'observed'> | null,
): { status: ProbeStatus; completedChecks: number; durationHours: number } {
  const durationHours = (Date.parse(soak.finishedAt) - Date.parse(soak.startedAt)) / 3_600_000;
  const completed = soak.checks.filter(
    (check) =>
      check.startedAt !== null &&
      check.finishedAt !== null &&
      Date.parse(check.startedAt) >= Date.parse(soak.startedAt) &&
      Date.parse(check.finishedAt) <= Date.parse(soak.finishedAt),
  );
  const observations = soak.observedAt.map((value) => Date.parse(value));
  const continuousObservation =
    observations.length >= 2 &&
    observations.every(
      (value, index) =>
        Number.isFinite(value) &&
        (index === 0
          ? value <= Date.parse(soak.startedAt) + 120_000
          : value >= observations[index - 1]! && value - observations[index - 1]! <= 120_000),
    ) &&
    observations.at(-1)! >= Date.parse(soak.finishedAt) - 120_000;
  const ordered = [...completed].sort((a, b) => Date.parse(a.startedAt!) - Date.parse(b.startedAt!));
  const changes = soak.scheduleChanges;
  let due = Date.parse(soak.initialNextCheckAt ?? '');
  let changeIndex = 0;
  const scheduleMonotonic = changes.every(
    (change, index) =>
      Number.isFinite(Date.parse(change.observedAt)) &&
      Date.parse(change.observedAt) >= Date.parse(soak.startedAt) &&
      (index === 0 || Date.parse(change.observedAt) > Date.parse(changes[index - 1]!.observedAt)),
  );
  const advanceSchedule = (until: number): boolean => {
    while (changeIndex < changes.length && Date.parse(changes[changeIndex]!.observedAt) <= until) {
      const change = changes[changeIndex++]!;
      // Only an observed, timely native reschedule can extend the current deadline.
      if (Date.parse(change.observedAt) > due + 300_000 || change.nextCheckAt === null) return false;
      due = Date.parse(change.nextCheckAt);
    }
    return Number.isFinite(due) && until <= due + 300_000;
  };
  const scheduleCovered =
    ordered.length >= 2 &&
    Number.isFinite(due) &&
    scheduleMonotonic &&
    ordered.every((check) => {
      if (
        !advanceSchedule(Date.parse(check.startedAt!)) ||
        Date.parse(check.startedAt!) > Date.parse(check.scheduledAt) + 300_000 ||
        check.nextCheckAt === null
      )
        return false;
      due = Date.parse(check.nextCheckAt);
      return Number.isFinite(due);
    }) &&
    advanceSchedule(Date.parse(soak.finishedAt));
  const failed = soak.checks.some(
    (check) =>
      check.startedAt !== null &&
      Date.parse(check.startedAt) <= Date.parse(soak.finishedAt) &&
      (check.finishedAt === null || Date.parse(check.finishedAt) >= Date.parse(soak.startedAt)) &&
      check.outcome !== null &&
      ['blocked', 'failed', 'interrupted'].includes(check.outcome),
  );
  const corroborated =
    receipt?.verifiedSuccess === true &&
    receipt.expected.noSiteBlock === true &&
    receipt.expected.noAccountWarning === true &&
    receipt.observed.noSiteBlock === true &&
    receipt.observed.noAccountWarning === true &&
    receipt.expected.watchActiveThroughout === true &&
    receipt.observed.watchActiveThroughout === true &&
    receipt.expected.withinSitePolicy === true &&
    receipt.observed.withinSitePolicy === true &&
    Date.parse(receipt.checkedAt) >= Date.parse(soak.finishedAt);
  return {
    status:
      failed || (receipt !== null && !receipt.verifiedSuccess)
        ? 'failed'
        : durationHours >= 72 &&
            continuousObservation &&
            scheduleCovered &&
            completed.filter((check) => check.outcome === 'ready').length >= 2 &&
            corroborated
          ? 'passed'
          : 'not-run',
    completedChecks: completed.length,
    durationHours,
  };
}

function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const [command = 'help', ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--') || key.slice(2) in flags)
      throw new Error('Use unique --flag value pairs');
    flags[key.slice(2)] = value;
  }
  return { command, flags };
}
function requireFlag(flags: Record<string, string>, name: string): string {
  return text(flags[name]);
}
function validateFlags(flags: Record<string, string>, names: string[]): void {
  if (Object.keys(flags).some((name) => !names.includes(name)))
    throw new Error('Unknown command flag; see acceptance.ts help');
}
async function readRun(flags: Record<string, string>): Promise<string> {
  const run = resolve(requireFlag(flags, 'run'));
  const manifest = object(await jsonFile(join(run, 'manifest.json')));
  if (manifest.schemaVersion !== 1 || manifest.execution !== 'post_merge_owner_dogfood')
    throw new Error('Not a dogfood acceptance run');
  return run;
}
async function observe(run: string, signal: AbortSignal): Promise<void> {
  const sampler = new FocusSampler();
  await sampler.start();
  try {
    while (!signal.aborted) {
      await delay(1_000, undefined, { signal }).catch(() => undefined);
      for (const observation of sampler.observations.splice(0))
        await appendPrivate(join(run, 'desktop.ndjson'), observation);
    }
  } finally {
    await sampler.stop();
    for (const observation of sampler.observations.splice(0))
      await appendPrivate(join(run, 'desktop.ndjson'), observation);
  }
}
async function quietSummary(
  run: string,
  errands: readonly TimedErrand[],
): Promise<{
  status: ProbeStatus;
  samples: number;
  firstAt: string | null;
  lastAt: string | null;
  frontmostChanged: boolean;
  clipboardChanged: boolean;
  unavailable: boolean;
  observationCoverage: boolean;
}> {
  let samples = 0;
  let first: DesktopObservation | undefined;
  let last: DesktopObservation | undefined;
  let frontmostChanged = false;
  let clipboardChanged = false;
  let unavailable = false;
  let interrupted = false;
  const intervals = errands.map((errand) => [Date.parse(errand.startedAt), Date.parse(errand.verifiedAt)] as const);
  const maxGap = DESKTOP_READ_TIMEOUT_MS + 2 * DESKTOP_SAMPLE_INTERVAL_MS;
  const file = join(run, 'desktop.ndjson');
  try {
    await lstat(file);
  } catch {
    return {
      status: 'not-run',
      samples,
      firstAt: null,
      lastAt: null,
      frontmostChanged,
      clipboardChanged,
      unavailable: true,
      observationCoverage: false,
    };
  }
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    const entry = object(JSON.parse(line) as unknown);
    const observation = entry as unknown as DesktopObservation;
    timestamp(observation.sampledAt);
    if (last) {
      const previousAt = Date.parse(last.sampledAt);
      const currentAt = Date.parse(observation.sampledAt);
      if (
        currentAt <= previousAt ||
        (currentAt - previousAt > maxGap && intervals.some(([start, end]) => previousAt < end && currentAt > start))
      )
        interrupted = true;
    }
    first ??= observation;
    samples++;
    if (
      observation.frontmostApp === null ||
      observation.clipboardChangeCount === null ||
      observation.frontmostApp === 'com.apple.loginwindow'
    )
      unavailable = true;
    frontmostChanged ||= observation.frontmostApp !== first.frontmostApp;
    clipboardChanged ||= observation.clipboardChangeCount !== first.clipboardChangeCount;
    last = observation;
  }
  const observationCoverage =
    intervals.length > 0 &&
    !interrupted &&
    first !== undefined &&
    last !== undefined &&
    intervals.every(
      ([start, end]) =>
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        end >= start &&
        Date.parse(first.sampledAt) <= start &&
        Date.parse(last.sampledAt) >= end,
    );
  return {
    status:
      frontmostChanged || clipboardChanged
        ? 'failed'
        : samples < 2 || unavailable || !observationCoverage
          ? 'not-run'
          : 'passed',
    samples,
    firstAt: first?.sampledAt ?? null,
    lastAt: last?.sampledAt ?? null,
    frontmostChanged,
    clipboardChanged,
    unavailable,
    observationCoverage,
  };
}
async function listJson(directory: string): Promise<unknown[]> {
  const names = (await readdir(directory))
    .filter((name) => name.endsWith('.json') && !name.endsWith('.start.json'))
    .sort();
  return Promise.all(names.map((name) => jsonFile(join(directory, name))));
}
async function summarize(run: string): Promise<void> {
  const samples = (await listJson(join(run, 'samples'))) as TimedErrand[];
  const recordedScenarios = (await listJson(join(run, 'scenarios'))).map((value) => object(value));
  const scenarios = acceptanceScenarios.map((name) => {
    const entry = recordedScenarios.find((scenario) => scenario.name === name);
    return entry ?? { name, status: 'not-run' };
  });
  const quiet = await quietSummary(run, samples);
  const observationCoverage = quiet.observationCoverage;
  const timedErrands = summarizeTimedErrands(samples);
  const scans = (await readdir(run)).filter((name) => name.startsWith('canary-scan-') && name.endsWith('.json'));
  const scanResults = await Promise.all(scans.map(async (name) => object(await jsonFile(join(run, name)))));
  const secretScan: ProbeStatus = scanResults.some((result) => result.status === 'failed')
    ? 'failed'
    : scanResults.some(
          (result) => result.status === 'passed' && typeof result.filesScanned === 'number' && result.filesScanned > 0,
        )
      ? 'passed'
      : 'not-run';
  const report = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    scenarios,
    timedErrands,
    quiet,
    observationCoverage,
    secretScan,
    timingAttribution:
      'Transport includes native mailbox/queue timestamps; browser is host execution wall time. Model-and-orchestration is remaining wall time, not measured provider inference time. Verification starts at the authored timestamp of the latest delivered report.',
    status:
      scenarios.every((scenario) => scenario.status === 'passed') &&
      timedErrands.every((entry) => entry.status === 'passed') &&
      quiet.status === 'passed' &&
      secretScan === 'passed' &&
      observationCoverage
        ? 'passed'
        : scenarios.some((scenario) => scenario.status === 'failed') ||
            timedErrands.some((entry) => entry.status === 'failed') ||
            quiet.status === 'failed' ||
            secretScan === 'failed'
          ? 'failed'
          : 'not-run',
  };
  const id = `summary-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}`;
  await privateJson(join(run, `${id}.json`), report);
  process.stdout.write(
    `${JSON.stringify({ status: report.status, report: join(run, `${id}.json`), timedErrands: timedErrands.map(({ errand, status }) => ({ errand, status })) }, null, 2)}\n`,
  );
  if (report.status !== 'passed') process.exitCode = 1;
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === 'help' || command === '--help') {
    process.stdout.write(
      'Post-merge owner dogfood acceptance. See scripts/browser-live-check/README.md.\nCommands: begin, observe, start, capture, scenario, scan, soak, summarize.\n',
    );
    return;
  }
  if (command === 'begin') {
    validateFlags(flags, ['output-root', 'name', 'deployment']);
    const deployment = requireFlag(flags, 'deployment');
    if (!/^[a-f0-9]{40}$/.test(deployment)) throw new Error('Supply the deployed merged commit SHA');
    process.stdout.write(
      `${await beginAcceptance(resolve(requireFlag(flags, 'output-root')), requireFlag(flags, 'name'), deployment)}\n`,
    );
    return;
  }
  const run = await readRun(flags);
  if (command === 'observe') {
    validateFlags(flags, ['run']);
    if (process.platform !== 'darwin') throw new Error('Desktop observation requires the deployed Mac');
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.once('SIGTERM', () => controller.abort());
    await observe(run, controller.signal);
  } else if (command === 'start') {
    validateFlags(flags, ['run', 'errand', 'mode', 'expected-sha256']);
    const errand = requireFlag(flags, 'errand');
    const mode = requireFlag(flags, 'mode');
    if (!errands.includes(errand as Errand) || !['cold', 'recipe'].includes(mode))
      throw new Error('Invalid errand or mode');
    const expectedSha256 = flags['expected-sha256'];
    if (errand === 'invoice' && (!expectedSha256 || !/^[a-f0-9]{64}$/.test(expectedSha256)))
      throw new Error('Predeclare the independently known invoice SHA256 before starting');
    const id = randomUUID();
    const sample: SampleStart = {
      schemaVersion: 1,
      id,
      errand: errand as Errand,
      mode: mode as Mode,
      startedAt: new Date().toISOString(),
      ...(expectedSha256 ? { expectedSha256 } : {}),
    };
    await privateJson(join(run, 'samples', `${id}.start.json`), sample);
    process.stdout.write(`${id}\n`);
  } else if (command === 'capture') {
    validateFlags(flags, ['run', 'sample', 'socket', 'job', 'receipt', 'reported-success', 'artifact']);
    const id = component(requireFlag(flags, 'sample'));
    const sample = object(await jsonFile(join(run, 'samples', `${id}.start.json`))) as unknown as SampleStart;
    const reportedSuccess = requireFlag(flags, 'reported-success');
    if (!['true', 'false'].includes(reportedSuccess))
      throw new Error('Reported success must be true or false, read from the actual report');
    const native = await captureNative(requireFlag(flags, 'socket'), requireFlag(flags, 'job'));
    const receipt = await readOwnerReceipt(requireFlag(flags, 'receipt'));
    if (Date.parse(receipt.checkedAt) < Date.parse(sample.startedAt) || Date.parse(receipt.checkedAt) > Date.now())
      throw new Error('Receipt verification must occur during this completed run');
    const outcome = await verifyCapturedOutcome(sample.errand, native, {
      artifactPath: flags.artifact,
      expectedSha256: sample.expectedSha256,
      ownerVerified: receipt.verifiedSuccess,
    });
    const record: TimedErrand = {
      id,
      errand: sample.errand,
      mode: sample.mode,
      startedAt: sample.startedAt,
      verifiedAt: receipt.checkedAt,
      reportedSuccess: reportedSuccess === 'true',
      verifiedSuccess:
        receipt.verifiedSuccess &&
        outcome &&
        (sample.mode === 'recipe'
          ? native.requests.some((request) => request.action === 'run_recipe')
          : !native.requests.some((request) => request.action === 'run_recipe')),
      source: receipt.source,
      native,
      phases: calculatePhases(sample.startedAt, receipt.checkedAt, native),
    };
    await privateJson(join(run, 'samples', `${id}.json`), { ...record, ownerVerification: receipt });
    process.stdout.write(
      `${JSON.stringify({ id, verifiedSuccess: record.verifiedSuccess, measured: record.phases !== null })}\n`,
    );
  } else if (command === 'scenario') {
    validateFlags(flags, ['run', 'name', 'receipt']);
    const name = requireFlag(flags, 'name');
    if (!acceptanceScenarios.includes(name as (typeof acceptanceScenarios)[number]))
      throw new Error('Unknown acceptance scenario');
    const receipt = await readOwnerReceipt(requireFlag(flags, 'receipt'));
    let status: ProbeStatus = receipt.verifiedSuccess ? 'passed' : 'failed';
    let soak: ReturnType<typeof verifyWatchSoak> | undefined;
    if (name === 'watch_soak') {
      soak = verifyWatchSoak((await jsonFile(join(run, 'soak.json'))) as Soak, receipt);
      status = soak.status;
    }
    await privateJson(join(run, 'scenarios', `${name}.json`), {
      name,
      status,
      provenance: 'owner_verified',
      receipt,
      ...(soak ? { soak } : {}),
    });
    process.stdout.write(`${JSON.stringify({ name, status })}\n`);
  } else if (command === 'scan') {
    validateFlags(flags, ['run', 'canaries', 'files']);
    const fileList = array(await jsonFile(requireFlag(flags, 'files'))).map(text);
    const result = await scanCanaryFiles(requireFlag(flags, 'canaries'), fileList);
    await privateJson(join(run, `canary-scan-${randomUUID()}.json`), {
      capturedAt: new Date().toISOString(),
      ...result,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== 'passed') process.exitCode = 1;
  } else if (command === 'soak') {
    validateFlags(flags, ['run', 'socket', 'job', 'hours']);
    const hours = Number(flags.hours ?? '72');
    if (!Number.isFinite(hours) || hours < 72) throw new Error('A watch soak must run for at least 72 actual hours');
    const startedAt = new Date().toISOString();
    const until = Date.now() + hours * 3_600_000;
    const checks = new Map<string, WatchCheck>();
    let initialNextCheckAt: string | null = null;
    const scheduleChanges: Soak['scheduleChanges'] = [];
    const observedAt: string[] = [];
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.once('SIGTERM', () => controller.abort());
    while (!controller.signal.aborted) {
      const native = await captureNative(requireFlag(flags, 'socket'), requireFlag(flags, 'job'));
      if (observedAt.length === 0) initialNextCheckAt = native.watchNextCheckAt;
      else if (
        native.watchNextCheckAt !== (scheduleChanges.length ? scheduleChanges.at(-1)!.nextCheckAt : initialNextCheckAt)
      )
        scheduleChanges.push({ observedAt: native.capturedAt, nextCheckAt: native.watchNextCheckAt });
      for (const check of native.watchChecks) checks.set(check.id, check);
      observedAt.push(native.capturedAt);
      await appendPrivate(join(run, 'soak.ndjson'), {
        capturedAt: native.capturedAt,
        jobId: native.job.id,
        watchNextCheckAt: native.watchNextCheckAt,
        watchChecks: native.watchChecks,
      });
      if (Date.now() >= until) break;
      await delay(Math.min(60_000, until - Date.now()), undefined, { signal: controller.signal }).catch(
        () => undefined,
      );
    }
    const soak = {
      startedAt,
      finishedAt: new Date().toISOString(),
      initialNextCheckAt,
      scheduleChanges,
      checks: [...checks.values()],
      observedAt,
    };
    await privateJson(join(run, 'soak.json'), {
      ...soak,
      ...verifyWatchSoak(soak, null),
      interrupted: controller.signal.aborted,
    });
    process.stdout.write(
      'Watch observations saved. No pass is claimed until an independent no-block/no-warning receipt is recorded.\n',
    );
  } else if (command === 'summarize') {
    validateFlags(flags, ['run']);
    await summarize(run);
  } else throw new Error('Unknown command; see acceptance.ts help');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Browser acceptance command failed'}\n`);
    process.exitCode = 1;
  });
}
