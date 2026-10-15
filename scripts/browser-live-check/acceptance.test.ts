import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  acceptanceScenarios,
  beginAcceptance,
  calculatePhases,
  readOwnerReceipt,
  scanCanaryFiles,
  summarizeTimedErrands,
  verifyCapturedOutcome,
  verifyWatchSoak,
  type NativeBrowserEvidence,
  type TimedErrand,
} from './acceptance.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'browser-acceptance-'));
  roots.push(root);
  return root;
}
const start = '2026-10-20T10:00:00.000Z';
function at(seconds: number): string {
  return new Date(Date.parse(start) + seconds * 1_000).toISOString();
}
function nativeEvidence(): NativeBrowserEvidence {
  return {
    schemaVersion: 1,
    capturedAt: at(30),
    job: {
      id: 'system:a2a:main:errand',
      browserSessionId: 'browser-session',
      createdAt: at(1),
      cancelled: false,
      cancelRequested: false,
      firstInboundAt: at(1),
      lastDeliveredReportAt: at(20),
    },
    requests: [
      {
        id: 'browser-request',
        requestId: 'request',
        action: 'browser',
        emittedAt: at(4),
        acceptedAt: at(5),
        startedAt: at(6),
        commitStartedAt: null,
        answeredAt: at(14),
        deliveredAt: at(15),
        status: 'completed',
        reason: null,
      },
    ],
    downloads: [{ id: 'download', filename: 'invoice.pdf', bytes: 7, handedOffAt: at(14) }],
    purchase: { openCards: 1, committedAttempts: 0, unresolvedAttempts: 0 },
    watchNextCheckAt: null,
    watchChecks: [],
  };
}
function timed(mode: 'cold' | 'recipe', seconds: number, verifiedSuccess = true): TimedErrand {
  return {
    id: `${mode}-${seconds}`,
    errand: 'invoice',
    mode,
    startedAt: start,
    verifiedAt: at(seconds),
    reportedSuccess: true,
    verifiedSuccess,
    source: { system: 'Invoice service', reference: 'Invoice 123', sha256: 'a'.repeat(64) },
    native: nativeEvidence(),
    phases: {
      transportMs: 4_000,
      browserMs: 8_000,
      modelAndOrchestrationMs: seconds * 1_000 - 14_000,
      verificationMs: 2_000,
      totalMs: seconds * 1_000,
    },
  };
}

describe('post-deployment browser acceptance evidence', () => {
  it('begins with every required scenario unrun in a private non-overwriting directory', async () => {
    const root = await temporaryRoot();
    const run = await beginAcceptance(root, 'owner-run');
    const manifest: unknown = JSON.parse(await readFile(join(run, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      execution: 'post_merge_owner_dogfood',
      scenarios: acceptanceScenarios.map((name) => ({ name, status: 'not-run' })),
    });
    expect((await stat(run)).mode & 0o777).toBe(0o700);
    expect((await stat(join(run, 'manifest.json'))).mode & 0o777).toBe(0o600);
    await expect(beginAcceptance(root, 'owner-run')).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('attributes native request timestamps and labels the remaining time as model and orchestration', () => {
    expect(calculatePhases(start, at(22), nativeEvidence())).toEqual({
      transportMs: 4_000,
      browserMs: 8_000,
      modelAndOrchestrationMs: 8_000,
      verificationMs: 2_000,
      totalMs: 22_000,
    });
    const incomplete = nativeEvidence();
    incomplete.requests[0]!.startedAt = null;
    expect(calculatePhases(start, at(22), incomplete)).toBeNull();
    const future = nativeEvidence();
    future.requests[0]!.answeredAt = at(40);
    expect(calculatePhases(start, at(22), future)).toBeNull();
  });

  it('requires five verified cold and replay samples per errand and reports incorrect success claims', () => {
    const samples = [21, 22, 23, 24, 25].flatMap((seconds) => [timed('cold', seconds), timed('recipe', seconds - 5)]);
    const summary = summarizeTimedErrands(samples);
    expect(summary[0]).toMatchObject({ errand: 'booking', status: 'not-run' });
    expect(summary.find((entry) => entry.errand === 'invoice')).toMatchObject({
      status: 'passed',
      verifiedSuccessRate: 1,
      selfReportedSuccessRate: 1,
      falseSuccessClaims: 0,
      cold: { samples: 5, phases: { totalMs: { p50: 23_000, p90: 25_000 } } },
      recipe: { phases: { totalMs: { p50: 18_000, p90: 20_000 } } },
    });
    samples[0]!.verifiedSuccess = false;
    expect(summarizeTimedErrands(samples).find((entry) => entry.errand === 'invoice')).toMatchObject({
      status: 'failed',
      falseSuccessClaims: 1,
      verifiedSuccessRate: 0.9,
    });
    expect(summarizeTimedErrands(samples.slice(1)).find((entry) => entry.errand === 'invoice')).toMatchObject({
      status: 'not-run',
    });
  });

  it('hashes an independent owner receipt and distinguishes mismatching system-of-record facts', async () => {
    const root = await temporaryRoot();
    const file = join(root, 'receipt.json');
    const receipt = {
      schemaVersion: 1,
      source: { system: 'Restaurant reservations', reference: 'Confirmation ABC' },
      checkedAt: at(22),
      expected: { venue: 'Bistro', party: 4 },
      observed: { venue: 'Bistro', party: 2 },
    };
    const bytes = `${JSON.stringify(receipt)}\n`;
    await writeFile(file, bytes, { mode: 0o600 });
    expect(await readOwnerReceipt(file)).toMatchObject({
      verifiedSuccess: false,
      source: { sha256: createHash('sha256').update(bytes).digest('hex') },
      provenance: 'owner_verified',
    });
    receipt.observed.party = 4;
    await writeFile(file, JSON.stringify(receipt));
    expect(await readOwnerReceipt(file)).toMatchObject({ verifiedSuccess: true });
    await writeFile(file, '{"secret":"do-not-echo"');
    await expect(readOwnerReceipt(file)).rejects.toThrow('Invalid owner receipt JSON');
  });

  it('independently checks an invoice hash and refuses a compare-and-buy run that crossed a commit marker', async () => {
    const root = await temporaryRoot();
    const invoice = join(root, 'invoice.pdf');
    await writeFile(invoice, 'invoice');
    const expectedHash = createHash('sha256').update('invoice').digest('hex');
    expect(
      await verifyCapturedOutcome('invoice', nativeEvidence(), { artifactPath: invoice, expectedSha256: expectedHash }),
    ).toBe(true);
    expect(
      await verifyCapturedOutcome('invoice', nativeEvidence(), {
        artifactPath: invoice,
        expectedSha256: '0'.repeat(64),
      }),
    ).toBe(false);
    expect(await verifyCapturedOutcome('compare-buy', nativeEvidence(), {})).toBe(true);
    const committed = nativeEvidence();
    committed.requests[0]!.commitStartedAt = at(10);
    expect(await verifyCapturedOutcome('compare-buy', committed, {})).toBe(false);
  });

  it('scans encoded and chunk-boundary canaries without returning their values', async () => {
    const root = await temporaryRoot();
    const canaries = join(root, 'canaries.json');
    const output = join(root, 'agent-output.json');
    const secret = 'secret token/+?';
    await writeFile(canaries, JSON.stringify([secret]), { mode: 0o600 });
    await writeFile(output, `${'x'.repeat(65_532)}${encodeURIComponent(secret)}`);
    const result = await scanCanaryFiles(canaries, [output]);
    expect(result).toMatchObject({ status: 'failed', filesScanned: 1, matches: 1 });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(encodeURIComponent(secret));
    await writeFile(output, 'safe native output');
    expect(await scanCanaryFiles(canaries, [output])).toMatchObject({ status: 'passed', matches: 0 });
    await writeFile(join(root, 'broad-canaries.json'), JSON.stringify([secret]), { mode: 0o644 });
    await expect(scanCanaryFiles(join(root, 'broad-canaries.json'), [output])).rejects.toThrow('owner-only');
  });

  it('captures a real native socket response for a separately verified owner errand without copying request payloads', async () => {
    const root = await temporaryRoot();
    const run = await beginAcceptance(root, 'socket-run');
    const execute = promisify(execFile);
    const script = 'scripts/browser-live-check/acceptance.ts';
    const { stdout } = await execute('pnpm', [
      'exec',
      'tsx',
      script,
      'start',
      '--run',
      run,
      '--errand',
      'booking',
      '--mode',
      'cold',
    ]);
    const id = stdout.trim();
    const sample = JSON.parse(await readFile(join(run, 'samples', `${id}.start.json`), 'utf8')) as {
      startedAt: string;
    };
    const native = nativeEvidence();
    const adjust = (value: string | null): string | null =>
      value === null
        ? null
        : new Date(Date.parse(sample.startedAt) + (Date.parse(value) - Date.parse(start)) / 1_000).toISOString();
    native.capturedAt = new Date().toISOString();
    native.job.createdAt = adjust(native.job.createdAt)!;
    native.job.firstInboundAt = adjust(native.job.firstInboundAt);
    native.job.lastDeliveredReportAt = adjust(native.job.lastDeliveredReportAt);
    for (const request of native.requests) {
      request.acceptedAt = adjust(request.acceptedAt)!;
      request.emittedAt = adjust(request.emittedAt);
      request.startedAt = adjust(request.startedAt);
      request.answeredAt = adjust(request.answeredAt);
      request.deliveredAt = adjust(request.deliveredAt);
    }
    const receiptFile = join(root, 'reservation-receipt.json');
    await writeFile(
      receiptFile,
      JSON.stringify({
        schemaVersion: 1,
        source: { system: 'Restaurant record', reference: 'ABC-123' },
        checkedAt: new Date().toISOString(),
        expected: { confirmation: 'ABC-123' },
        observed: { confirmation: 'ABC-123' },
      }),
      { mode: 0o600 },
    );
    const socket = join(root, 'ncl.sock');
    const requests: unknown[] = [];
    const server = createServer((connection) => {
      connection.once('data', (bytes) => {
        const request: unknown = JSON.parse(bytes.toString());
        requests.push(request);
        connection.end(
          `${JSON.stringify({ id: 'capture', ok: true, data: { ...native, payload: 'must-not-be-copied' } })}\n`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, resolve);
    });
    try {
      await execute('pnpm', [
        'exec',
        'tsx',
        script,
        'capture',
        '--run',
        run,
        '--sample',
        id,
        '--socket',
        socket,
        '--job',
        native.job.id,
        '--receipt',
        receiptFile,
        '--reported-success',
        'true',
      ]);
      const bytes = await readFile(join(run, 'samples', `${id}.json`), 'utf8');
      expect(JSON.parse(bytes)).toMatchObject({
        verifiedSuccess: true,
        native: { job: { id: native.job.id } },
        source: { reference: 'ABC-123' },
      });
      expect(bytes).not.toContain('must-not-be-copied');
      expect(requests).toMatchObject([{ command: 'gws-ea-browser-evidence', args: { job: native.job.id } }]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it('never passes a multi-day watch soak on elapsed time alone', () => {
    const finish = new Date(Date.parse(start) + 72 * 3_600_000).toISOString();
    const checks = [
      { id: 'check-1', scheduledAt: start, startedAt: start, finishedAt: at(1), outcome: 'ready', nextCheckAt: at(60) },
      {
        id: 'check-2',
        scheduledAt: finish,
        startedAt: finish,
        finishedAt: finish,
        outcome: 'ready',
        nextCheckAt: null,
      },
    ];
    expect(
      verifyWatchSoak(
        {
          startedAt: start,
          initialNextCheckAt: start,
          scheduleChanges: [],
          finishedAt: finish,
          checks,
          observedAt: [],
        },
        null,
      ),
    ).toMatchObject({
      status: 'not-run',
    });
    const receipt = {
      checkedAt: finish,
      verifiedSuccess: true,
      expected: { noSiteBlock: true, noAccountWarning: true, watchActiveThroughout: true, withinSitePolicy: true },
      observed: { noSiteBlock: true, noAccountWarning: true, watchActiveThroughout: true, withinSitePolicy: true },
    };
    expect(
      verifyWatchSoak(
        {
          startedAt: start,
          initialNextCheckAt: start,
          scheduleChanges: [],
          finishedAt: finish,
          checks,
          observedAt: [],
        },
        receipt,
      ),
    ).toMatchObject({
      status: 'not-run',
      completedChecks: 2,
    });
    expect(
      verifyWatchSoak(
        {
          startedAt: start,
          initialNextCheckAt: start,
          scheduleChanges: [],
          finishedAt: at(10),
          checks: [],
          observedAt: [],
        },
        receipt,
      ),
    ).toMatchObject({
      status: 'not-run',
    });
    const observedAt = Array.from({ length: 4_321 }, (_, index) => at(index * 60));
    const regularChecks = Array.from({ length: 73 }, (_, index) => ({
      id: `regular-${index}`,
      scheduledAt: at(index * 3_600),
      startedAt: at(index * 3_600),
      finishedAt: at(index * 3_600),
      outcome: 'ready',
      nextCheckAt: at((index + 1) * 3_600),
    }));
    expect(
      verifyWatchSoak(
        {
          startedAt: start,
          initialNextCheckAt: start,
          scheduleChanges: [],
          finishedAt: finish,
          checks: regularChecks,
          observedAt,
        },
        receipt,
      ),
    ).toMatchObject({ status: 'passed', completedChecks: 73 });
    expect(
      verifyWatchSoak(
        {
          startedAt: start,
          initialNextCheckAt: null,
          scheduleChanges: [],
          finishedAt: finish,
          checks: regularChecks,
          observedAt,
        },
        receipt,
      ),
    ).toMatchObject({ status: 'not-run' });
    expect(
      verifyWatchSoak(
        {
          startedAt: start,
          initialNextCheckAt: at(6 * 3_600),
          scheduleChanges: [],
          finishedAt: finish,
          checks: regularChecks.slice(6),
          observedAt,
        },
        receipt,
      ),
    ).toMatchObject({ status: 'passed', completedChecks: 67 });
    for (const [observed, status] of [
      [60, 'passed'],
      [6 * 3_600, 'not-run'],
    ] as const)
      expect(
        verifyWatchSoak(
          {
            startedAt: start,
            finishedAt: finish,
            initialNextCheckAt: start,
            scheduleChanges: [{ observedAt: at(observed), nextCheckAt: at(6 * 3_600) }],
            checks: regularChecks.slice(6),
            observedAt,
          },
          receipt,
        ),
      ).toMatchObject({ status });
    expect
      .soft(
        verifyWatchSoak(
          {
            startedAt: start,
            initialNextCheckAt: start,
            scheduleChanges: [],
            finishedAt: finish,
            checks: regularChecks.slice(-2),
            observedAt,
          },
          receipt,
        ),
      )
      .toMatchObject({ status: 'not-run' });
    expect
      .soft(
        verifyWatchSoak(
          {
            startedAt: start,
            initialNextCheckAt: start,
            scheduleChanges: [],
            finishedAt: finish,
            checks: [
              ...regularChecks,
              {
                id: 'boundary-failure',
                scheduledAt: at(-60),
                startedAt: at(-60),
                finishedAt: at(30),
                outcome: 'failed',
                nextCheckAt: at(90),
              },
            ],
            observedAt,
          },
          receipt,
        ),
      )
      .toMatchObject({ status: 'failed' });
    observedAt.splice(30, 10);
    expect(
      verifyWatchSoak(
        {
          startedAt: start,
          initialNextCheckAt: start,
          scheduleChanges: [],
          finishedAt: finish,
          checks: regularChecks,
          observedAt,
        },
        receipt,
      ),
    ).toMatchObject({ status: 'not-run' });
    checks[1]!.outcome = 'blocked';
    expect(
      verifyWatchSoak(
        {
          startedAt: start,
          initialNextCheckAt: start,
          scheduleChanges: [],
          finishedAt: finish,
          checks,
          observedAt: [],
        },
        receipt,
      ),
    ).toMatchObject({
      status: 'failed',
    });
  });

  it('requires uninterrupted monotonic desktop sampling across each measured errand', async () => {
    const root = await temporaryRoot();
    const execute = promisify(execFile);
    const cases = [
      { name: 'gap', seconds: [0, 7_200], quiet: 'not-run', coverage: false },
      { name: 'changed', seconds: [0, 7_200], quiet: 'failed', coverage: false },
      {
        name: 'reversed',
        seconds: [0, 2, 1, ...Array.from({ length: 29 }, (_, index) => index + 3)],
        quiet: 'not-run',
        coverage: false,
      },
      {
        name: 'covered',
        seconds: [-100, -1, ...Array.from({ length: 32 }, (_, index) => index)],
        quiet: 'passed',
        coverage: true,
      },
    ];
    for (const entry of cases) {
      const run = await beginAcceptance(root, entry.name);
      const sample = timed('cold', 30);
      await writeFile(join(run, 'samples', 'sample.json'), JSON.stringify(sample));
      await writeFile(
        join(run, 'desktop.ndjson'),
        entry.seconds
          .map((seconds) =>
            JSON.stringify({
              sampledAt: at(seconds),
              frontmostApp: entry.name === 'changed' && seconds > 0 ? 'com.google.Chrome' : 'com.apple.TextEdit',
              clipboardChangeCount: 7,
              space: null,
              errors: [],
            }),
          )
          .join('\n') + '\n',
      );
      const { stdout } = await execute('pnpm', [
        'exec',
        'tsx',
        'scripts/browser-live-check/acceptance.ts',
        'summarize',
        '--run',
        run,
      ]).catch((error: unknown) => {
        expect(error).toMatchObject({ code: 1 });
        return { stdout: (error as { stdout: string }).stdout };
      });
      const output = JSON.parse(stdout) as { report: string };
      expect.soft(JSON.parse(await readFile(output.report, 'utf8'))).toMatchObject({
        quiet: { status: entry.quiet },
        observationCoverage: entry.coverage,
      });
    }
  }, 15_000);
});
