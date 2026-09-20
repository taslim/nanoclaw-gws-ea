import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireInstanceOperation,
  beginPhase,
  commitPhaseSuccess,
  ensureProvisionJournal,
  firstIncompletePhase,
  journalResourceKey,
  observePhase,
  readProvisionJournal,
} from './journal.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { allocateInstanceId, reserveInstance } from './registry.js';
import type { InstanceReservationInput } from './types.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<{ paths: ControlPlanePaths; input: InstanceReservationInput }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-journal-'));
  roots.push(root);
  const paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'config'),
    stateRoot: path.join(root, 'state'),
  });
  const instanceId = allocateInstanceId();
  const input: InstanceReservationInput = {
    instance_id: instanceId,
    checkout_realpath: paths.checkoutRoot(instanceId),
    release_track: 'dogfood',
    source_remote: 'https://example.test/nanoclaw.git',
    deployed_commit: 'a'.repeat(40),
    allocated_ports: { nanoclaw_webhook: 32_001, onecli_app: 32_002, onecli_gateway: 32_003 },
    exclusive_resource_claims: {
      endpoint_url: 'https://journal.example.test/webhook/gchat',
      gcp_project_id: 'journal-project',
      gcp_account: 'operator@example.test',
      gchat_service_account: 'gws-ea-chat@journal-project.iam.gserviceaccount.com',
      workspace_email: 'journal@example.test',
      onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
    },
  };
  await reserveInstance(paths, input);
  return { paths, input };
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await stat(file);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${file}`);
}

describe('provision journal', () => {
  it('persists intent before a child dies and resumes the same ambiguous attempt', async () => {
    const { paths, input } = await fixture();
    const childScript = `
      import { resolveControlPlanePaths } from './src/gws-ea/paths.ts';
      import { acquireInstanceOperation, ensureProvisionJournal, beginPhase, journalResourceKey } from './src/gws-ea/journal.ts';
      const paths = resolveControlPlanePaths(JSON.parse(process.env.TEST_PATHS));
      const operation = await acquireInstanceOperation(paths, process.env.TEST_INSTANCE_ID);
      if (!operation) process.exit(3);
      await ensureProvisionJournal(operation);
      await beginPhase(operation, 'materialize_checkout', journalResourceKey('checkout', process.env.TEST_RESOURCE));
      process.kill(process.pid, 'SIGKILL');
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childScript], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEST_PATHS: JSON.stringify({ configRoot: paths.configRoot, stateRoot: paths.stateRoot }),
        TEST_INSTANCE_ID: input.instance_id,
        TEST_RESOURCE: input.checkout_realpath,
      },
      stdio: 'ignore',
    });
    expect(await waitForExit(child)).toBeNull();

    const persisted = await readProvisionJournal(paths, input.instance_id);
    const firstAttempt = persisted.phases.materialize_checkout.attempts[0];
    expect(firstAttempt).toMatchObject({ attempt_id: expect.any(String), resource_key: expect.any(String) });
    expect(firstIncompletePhase(persisted)).toBe('materialize_checkout');

    const operation = await acquireInstanceOperation(paths, input.instance_id);
    expect(operation).not.toBeNull();
    try {
      const resumed = await beginPhase(
        operation!,
        'materialize_checkout',
        journalResourceKey('checkout', input.checkout_realpath),
      );
      expect(resumed.requires_reconciliation).toBe(true);
      expect(resumed.attempt.attempt_id).toBe(firstAttempt?.attempt_id);
      expect(resumed.journal.instance_id).toBe(input.instance_id);
    } finally {
      operation!.release();
    }
  }, 20_000);

  it('allows only one separate resume process to own the long operation lock', async () => {
    const { paths, input } = await fixture();
    const acquired = path.join(path.dirname(paths.configRoot), 'acquired');
    const release = path.join(path.dirname(paths.configRoot), 'release');
    const holderScript = `
      import { writeFile, stat } from 'node:fs/promises';
      import { resolveControlPlanePaths } from './src/gws-ea/paths.ts';
      import { acquireInstanceOperation } from './src/gws-ea/journal.ts';
      const paths = resolveControlPlanePaths(JSON.parse(process.env.TEST_PATHS));
      const operation = await acquireInstanceOperation(paths, process.env.TEST_INSTANCE_ID);
      if (!operation) process.exit(2);
      await writeFile(process.env.TEST_ACQUIRED, 'yes');
      while (true) {
        try { await stat(process.env.TEST_RELEASE); break; } catch { await new Promise((r) => setTimeout(r, 5)); }
      }
      operation.release();
    `;
    const contenderScript = `
      import { resolveControlPlanePaths } from './src/gws-ea/paths.ts';
      import { acquireInstanceOperation } from './src/gws-ea/journal.ts';
      const paths = resolveControlPlanePaths(JSON.parse(process.env.TEST_PATHS));
      const operation = await acquireInstanceOperation(paths, process.env.TEST_INSTANCE_ID);
      if (operation) { operation.release(); process.exit(4); }
      process.exit(0);
    `;
    const sharedEnv = {
      ...process.env,
      TEST_PATHS: JSON.stringify({ configRoot: paths.configRoot, stateRoot: paths.stateRoot }),
      TEST_INSTANCE_ID: input.instance_id,
    };
    const holder = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', holderScript], {
      cwd: process.cwd(),
      env: { ...sharedEnv, TEST_ACQUIRED: acquired, TEST_RELEASE: release },
      stdio: 'ignore',
    });
    await waitForFile(acquired);
    const contender = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', contenderScript], {
      cwd: process.cwd(),
      env: sharedEnv,
      stdio: 'ignore',
    });
    expect(await waitForExit(contender)).toBe(0);
    await writeFile(release, 'release');
    expect(await waitForExit(holder)).toBe(0);
  }, 20_000);

  it('requires observation of the intended resource before committing success', async () => {
    const { paths, input } = await fixture();
    const operation = await acquireInstanceOperation(paths, input.instance_id);
    expect(operation).not.toBeNull();
    try {
      const journal = await ensureProvisionJournal(operation!);
      expect(firstIncompletePhase(journal)).toBe('materialize_checkout');
      const key = journalResourceKey('checkout', input.checkout_realpath);
      const begun = await beginPhase(operation!, 'materialize_checkout', key);
      await expect(commitPhaseSuccess(operation!, 'materialize_checkout', begun.attempt.attempt_id)).rejects.toThrow(
        /postcondition/i,
      );
      await expect(
        observePhase(operation!, 'materialize_checkout', begun.attempt.attempt_id, {
          matched: true,
          resource_key: journalResourceKey('checkout', '/different/path'),
        }),
      ).rejects.toThrow(/resource key/i);
      await observePhase(operation!, 'materialize_checkout', begun.attempt.attempt_id, {
        matched: true,
        resource_key: key,
      });
      const committed = await commitPhaseSuccess(operation!, 'materialize_checkout', begun.attempt.attempt_id);
      expect(firstIncompletePhase(committed)).toBe('provision_gcp');
    } finally {
      operation!.release();
    }

    const reopened = await readProvisionJournal(paths, input.instance_id);
    expect(firstIncompletePhase(reopened)).toBe('provision_gcp');
    expect((await stat(paths.journalFile(input.instance_id))).mode & 0o777).toBe(0o600);
    expect((await stat(paths.stateRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.instancesRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.instanceRoot(input.instance_id))).mode & 0o777).toBe(0o700);
  });

  it('requires an exact negative reconciliation before creating a retry attempt', async () => {
    const { paths, input } = await fixture();
    const operation = await acquireInstanceOperation(paths, input.instance_id);
    expect(operation).not.toBeNull();
    try {
      await ensureProvisionJournal(operation!);
      const key = journalResourceKey('checkout', input.checkout_realpath);
      const first = await beginPhase(operation!, 'materialize_checkout', key);
      const ambiguous = await beginPhase(operation!, 'materialize_checkout', key);
      expect(ambiguous.requires_reconciliation).toBe(true);
      expect(ambiguous.attempt.attempt_id).toBe(first.attempt.attempt_id);

      await observePhase(operation!, 'materialize_checkout', first.attempt.attempt_id, { matched: false });
      const retry = await beginPhase(operation!, 'materialize_checkout', key);
      expect(retry.requires_reconciliation).toBe(false);
      expect(retry.attempt.attempt_id).not.toBe(first.attempt.attempt_id);
      expect(retry.journal.phases.materialize_checkout.attempts).toHaveLength(2);
    } finally {
      operation!.release();
    }
  });

  it.each([
    ['corrupt JSON', '{not-json'],
    ['an unknown schema', JSON.stringify({ schema_version: 99, instance_id: allocateInstanceId(), phases: {} })],
  ])('stops mutation for %s', async (_label, contents) => {
    const { paths, input } = await fixture();
    const operation = await acquireInstanceOperation(paths, input.instance_id);
    expect(operation).not.toBeNull();
    await writeFile(paths.journalFile(input.instance_id), contents, { mode: 0o600 });
    try {
      await expect(ensureProvisionJournal(operation!)).rejects.toThrow();
      expect(await readFile(paths.journalFile(input.instance_id), 'utf8')).toBe(contents);
    } finally {
      operation!.release();
    }
  });

  it('does not allow a later phase to begin before its predecessor succeeds', async () => {
    const { paths, input } = await fixture();
    const operation = await acquireInstanceOperation(paths, input.instance_id);
    expect(operation).not.toBeNull();
    try {
      await ensureProvisionJournal(operation!);
      await expect(beginPhase(operation!, 'start_onecli', journalResourceKey('onecli', 'project'))).rejects.toThrow(
        /first incomplete phase/i,
      );
    } finally {
      operation!.release();
    }
  });
});
