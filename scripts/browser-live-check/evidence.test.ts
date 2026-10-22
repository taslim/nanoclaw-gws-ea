import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runProbe, writeEvidence } from './evidence.js';

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('browser live-check evidence', () => {
  it('records probe results and platform versions in an owner-only, non-overwriting run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browser-evidence-test-'));
    temporaryRoots.push(root);
    const input = {
      outputRoot: root,
      runId: '2026-10-15-host-browser',
      report: {
        startedAt: '2026-10-15T02:00:00.000Z',
        finishedAt: '2026-10-15T02:00:01.000Z',
        chromeVersion: '155.0.8059.79',
        macosVersion: '27.0.1',
        probes: [
          {
            name: 'owned_loopback_cdp',
            status: 'passed' as const,
            detail: { transport: 'owned loopback CDP', debuggerPort: 49_152 },
          },
        ],
        observations: [],
        decisions: { transport: 'owned loopback CDP' },
      },
    };
    const destination = await writeEvidence(input);
    const recorded: unknown = JSON.parse(await readFile(join(destination, 'results.json'), 'utf8'));
    expect(recorded).toMatchObject(input.report);
    expect((await stat(destination)).mode & 0o777).toBe(0o700);
    expect((await stat(join(destination, 'results.json'))).mode & 0o777).toBe(0o600);
    await expect(writeEvidence(input)).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('records a thrown probe as failed and permits later probes to run', async () => {
    const results = [];
    results.push(
      await runProbe('throws', async () => {
        throw new Error('probe could not connect');
      }),
    );
    results.push(await runProbe('next', async () => ({ status: 'passed', detail: { checked: true } })));
    expect(results).toMatchObject([
      { name: 'throws', status: 'failed', detail: { error: 'probe could not connect' } },
      { name: 'next', status: 'passed' },
    ]);
  });
});
