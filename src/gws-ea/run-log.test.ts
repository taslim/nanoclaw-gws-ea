import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { REDACTED } from './redact.js';
import { activeStep, startRunLog } from './run-log.js';
import { GwsEaError } from './types.js';

const INSTANCE_ID = '0d8f6f7e-3c2b-4a1d-9e8f-7a6b5c4d3e2f';
const OTHER_INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function controlPlanePaths(): Promise<ControlPlanePaths> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-run-log-'));
  roots.push(root);
  return resolveControlPlanePaths({ configRoot: path.join(root, 'config'), stateRoot: path.join(root, 'state') });
}

async function captures(directory: string): Promise<Array<Record<string, unknown>>> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return Promise.all(
    names
      .sort()
      .map(async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8')) as Record<string, unknown>),
  );
}

describe('GWS-EA run log', () => {
  it('writes a progression log and numbered raw step logs under the instance log root', async () => {
    const paths = await controlPlanePaths();
    const run = await startRunLog({ paths, command: 'create', instanceId: INSTANCE_ID, meta: { track: 'dogfood' } });

    expect(path.dirname(run.directory)).toBe(paths.instanceLogsRoot(INSTANCE_ID));
    expect(paths.instanceLogsRoot(INSTANCE_ID)).toBe(path.join(paths.stateRoot, 'logs', INSTANCE_ID));
    expect(path.relative(paths.instanceRoot(INSTANCE_ID), run.directory).startsWith('..')).toBe(true);
    expect((await stat(run.directory)).mode & 0o777).toBe(0o700);

    const result = await run.step('provision_gcp', async (step) => {
      expect(activeStep()).toBe(step);
      step.fact('project', 'gws-ea-0d8f6f7e3c2b4a1d9e8f');
      step.write('observed project state\n');
      return 'done';
    });
    await run.step('start_onecli', async (step) => {
      step.mark('skipped');
    });
    run.userInput('provider', 'claude');
    run.complete();

    expect(result).toBe('done');
    expect(activeStep()).toBeUndefined();
    const progression = await readFile(run.progressLog, 'utf8');
    expect(progression).toMatch(/^## \S+Z · gws-ea create started\n/u);
    expect(progression).toContain(`  instance: ${INSTANCE_ID}\n`);
    expect(progression).toContain('  track: dogfood\n');
    expect(progression).toMatch(
      /=== \[\S+Z\] provision_gcp \[\d+ms\] → success ===\n {2}project: gws-ea-0d8f6f7e3c2b4a1d9e8f\n {2}raw: steps\/01-provision-gcp\.log\n/u,
    );
    expect(progression).toMatch(
      /=== \[\S+Z\] start_onecli \[\d+ms\] → skipped ===\n {2}raw: steps\/02-start-onecli\.log\n/u,
    );
    expect(progression).toMatch(/=== \[\S+Z\] user-input → provider ===\n {2}value: claude\n/u);
    expect(progression).toMatch(/## \S+Z · completed \(total \d+s\)\n$/u);
    expect(await readFile(path.join(run.directory, 'steps', '01-provision-gcp.log'), 'utf8')).toContain(
      'observed project state\n',
    );
    expect((await stat(run.progressLog)).mode & 0o777).toBe(0o600);
  });

  it('names the failing step and its error in the progression log', async () => {
    const paths = await controlPlanePaths();
    const run = await startRunLog({ paths, command: 'resume', instanceId: INSTANCE_ID });

    const failure = new GwsEaError('command_failed', 'Command failed: gcloud projects describe x (exit code 2)');
    await expect(
      run.step('provision', () =>
        run.step('provision_gcp', async () => {
          throw failure;
        }),
      ),
    ).rejects.toBe(failure);
    run.abort(failure);

    const progression = await readFile(run.progressLog, 'utf8');
    expect(progression).toMatch(/provision_gcp \[\d+ms\] → failed ===\n {2}error: command_failed\n/u);
    expect(progression).toContain('  message: Command failed: gcloud projects describe x (exit code 2)\n');
    expect(progression).toMatch(/## \S+Z · aborted at provision_gcp \(err=command_failed\)\n$/u);
  });

  it('logs pre-reservation runs under logs/runs and moves them when an instance is reserved', async () => {
    const paths = await controlPlanePaths();
    const run = await startRunLog({ paths, command: 'create' });
    const unreserved = run.directory;

    expect(path.dirname(unreserved)).toBe(path.join(paths.stateRoot, 'logs', 'runs'));
    expect(paths.preReservationLogsRoot).toBe(path.join(paths.stateRoot, 'logs', 'runs'));
    await run.step('prerequisites', async () => undefined);
    await run.step('reserve', async (step) => {
      await run.assignInstance(INSTANCE_ID);
      expect(step.rawLog).toBe(path.join(paths.instanceLogsRoot(INSTANCE_ID), run.id, 'steps', '02-reserve.log'));
      step.write('reserved\n');
    });
    run.complete();

    expect(run.directory).toBe(path.join(paths.instanceLogsRoot(INSTANCE_ID), run.id));
    await expect(stat(unreserved)).rejects.toMatchObject({ code: 'ENOENT' });
    const progression = await readFile(run.progressLog, 'utf8');
    expect(progression).toContain('prerequisites');
    expect(progression).toContain(`instance-reserved → ${INSTANCE_ID}`);
    expect(await readFile(path.join(run.directory, 'steps', '02-reserve.log'), 'utf8')).toBe('reserved\n');
  });

  it('treats assigning the instance a run already belongs to as a no-op', async () => {
    const paths = await controlPlanePaths();
    const run = await startRunLog({ paths, command: 'create' });
    await run.assignInstance(INSTANCE_ID);
    const assigned = run.directory;
    const progression = await readFile(run.progressLog, 'utf8');

    await expect(run.assignInstance(INSTANCE_ID)).resolves.toBeUndefined();

    expect(run.directory).toBe(assigned);
    expect(await readdir(paths.instanceLogsRoot(INSTANCE_ID))).toEqual([run.id]);
    expect(await readFile(run.progressLog, 'utf8')).toBe(progression);
  });

  it('refuses to move a run that already belongs to another instance', async () => {
    const paths = await controlPlanePaths();
    const run = await startRunLog({ paths, command: 'resume', instanceId: INSTANCE_ID });
    const assigned = run.directory;

    await expect(run.assignInstance(OTHER_INSTANCE_ID)).rejects.toMatchObject({ code: 'run_log_conflict' });

    expect(run.directory).toBe(assigned);
    expect((await stat(assigned)).isDirectory()).toBe(true);
    await expect(stat(paths.instanceLogsRoot(OTHER_INSTANCE_ID))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never lets concurrent runs share a directory or file', async () => {
    const paths = await controlPlanePaths();
    const fixed = new Date('2026-09-25T10:00:00.000Z');
    const runs = await Promise.all(
      Array.from({ length: 6 }, () =>
        startRunLog({ paths, command: 'create', instanceId: INSTANCE_ID, now: () => fixed }),
      ),
    );

    expect(new Set(runs.map((run) => run.directory)).size).toBe(runs.length);
    await Promise.all(
      runs.map((run, index) => run.step('provision_gcp', async (step) => step.write(`run ${index}\n`))),
    );
    for (const [index, run] of runs.entries()) {
      expect(await readFile(path.join(run.directory, 'steps', '01-provision-gcp.log'), 'utf8')).toBe(`run ${index}\n`);
    }
  });

  it('redacts raw log writes and records .env files as key names only', async () => {
    const paths = await controlPlanePaths();
    const secretDirectory = path.join(paths.stateRoot, 'secret-fixture');
    const secret = `admin-${randomBytes(12).toString('hex')}`;
    await mkdir(secretDirectory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(secretDirectory, 'onecli-admin-api-key'), secret, { mode: 0o600 });
    const run = await startRunLog({ paths, command: 'create', secretDirectories: [secretDirectory] });

    await run.step('start_nanoclaw', async (step) => {
      step.write(`onecli rejected ${secret}\n`);
      step.envFile('/instance/nanoclaw/.env', `ONECLI_URL=http://127.0.0.1:1\nGCHAT_ENDPOINT_URL=${secret}\n`);
      step.fact('credential', secret);
    });

    const raw = await readFile(path.join(run.directory, 'steps', '01-start-nanoclaw.log'), 'utf8');
    const progression = await readFile(run.progressLog, 'utf8');
    expect(raw).toContain(`onecli rejected ${REDACTED}`);
    expect(raw).toContain('.env /instance/nanoclaw/.env: keys ONECLI_URL, GCHAT_ENDPOINT_URL');
    expect(raw).not.toContain('127.0.0.1');
    expect(`${raw}${progression}`).not.toContain(secret);
  });

  it('captures allowlisted reads to the staging directory only when enabled', async () => {
    const paths = await controlPlanePaths();
    const staging = path.join(paths.stateRoot, 'fixture-staging');
    const listing = JSON.stringify([{ projectId: 'gws-ea-0d8f6f7e3c2b4a1d9e8f' }]);
    const exercise = async (captureFixturesTo?: string) => {
      const run = await startRunLog({
        paths,
        command: 'create',
        ...(captureFixturesTo ? { captureFixturesTo } : {}),
      });
      await run.step('provision_gcp', async (step) => {
        step.captureCommand({
          program: 'gcloud',
          args: ['projects', 'list', '--format=json'],
          exitCode: 0,
          stdout: listing,
          stderr: '',
        });
        step.captureCommand({
          program: 'gcloud',
          args: ['auth', 'print-access-token', '--account=a@example.com'],
          exitCode: 0,
          stdout: 'ya29.token',
          stderr: '',
        });
        step.captureCommand({
          program: 'gcloud',
          args: ['iam', 'service-accounts', 'keys', 'create', 'k.json'],
          exitCode: 0,
          stdout: '{}',
          stderr: '',
        });
        step.captureHttp({
          method: 'GET',
          url: 'https://api.cloudflare.com/client/v4/zones?page=1',
          status: 200,
          body: '{"result":[]}',
        });
        step.captureHttp({
          method: 'GET',
          url: 'https://api.cloudflare.com/client/v4/accounts/a/cfd_tunnel/t/token',
          status: 200,
          body: '{"result":"eyJhIjoiYWNjb3VudCJ9"}',
        });
        step.captureHttp({
          method: 'GET',
          url: 'https://api.cloudflare.com/client/v4/user/tokens/verify',
          status: 200,
          body: '{}',
        });
        step.captureHttp({
          method: 'POST',
          url: 'https://api.cloudflare.com/client/v4/zones/z/dns_records',
          status: 200,
          body: '{}',
        });
      });
      return run;
    };

    const disabled = await exercise();
    expect(await captures(staging)).toEqual([]);

    const enabled = await exercise(staging);
    const staged = await captures(staging);
    expect(staged).toEqual([
      expect.objectContaining({
        kind: 'command',
        program: 'gcloud',
        args: ['projects', 'list', '--format=json'],
        stdout: listing,
      }),
      expect.objectContaining({
        kind: 'http',
        method: 'GET',
        url: 'https://api.cloudflare.com/client/v4/zones?page=1',
        body: '{"result":[]}',
      }),
    ]);
    for (const run of [disabled, enabled]) {
      const raw = await readFile(path.join(run.directory, 'steps', '01-provision-gcp.log'), 'utf8').catch(() => '');
      expect(raw).not.toContain('gws-ea-0d8f6f7e3c2b4a1d9e8f');
    }
  });
});
