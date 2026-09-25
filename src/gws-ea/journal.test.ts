import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireInstanceOperation,
  LAUNCHER_CONTRACT_VERSION,
  readProvisionJournal,
  recordChatConfigurationConfirmed,
  recordKeyPolicyLifted,
  recordPrincipalSelection,
  recordStepCompleted,
  recordStepFailure,
  recordStepStarted,
  withInstanceOperation,
} from './journal.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { allocateInstanceId, reserveInstance } from './registry.js';
import { GwsEaError, type InstanceReservationInput } from './types.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function reservation(paths: ControlPlanePaths): InstanceReservationInput {
  const instanceId = allocateInstanceId();
  return {
    instance_id: instanceId,
    checkout_realpath: paths.checkoutRoot(instanceId),
    release_track: 'dogfood',
    source_remote: 'https://example.test/nanoclaw.git',
    deployed_commit: 'a'.repeat(40),
    allocated_ports: { nanoclaw_webhook: 32_001, onecli_app: 32_002, onecli_gateway: 32_003 },
    exclusive_resource_claims: {
      ingress: { mode: 'existing', endpoint_url: 'https://journal.example.test/webhook/gchat' },
      gcp_project_id: 'journal-project',
      gcp_account: 'operator@example.test',
      gchat_service_account: 'gws-ea-chat@journal-project.iam.gserviceaccount.com',
      workspace_email: 'journal@example.test',
      onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
    },
  };
}

async function fixture(): Promise<{ paths: ControlPlanePaths; input: InstanceReservationInput }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-journal-'));
  roots.push(root);
  const paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'config'),
    stateRoot: path.join(root, 'state'),
  });
  const input = reservation(paths);
  await reserveInstance(paths, input);
  return { paths, input };
}

async function rawJournal(paths: ControlPlanePaths, instanceId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(paths.journalFile(instanceId), 'utf8')) as Record<string, unknown>;
}

const PRINCIPAL = {
  messagingGroupId: 'mg-principal',
  platformId: 'gchat:spaces/dm-principal',
  userId: 'gchat:users/principal',
  senderName: 'Principal',
  authenticatedMessageId: 'spaces/dm-principal/messages/first',
  authenticatedMessageAt: '2026-09-19T00:01:00.000Z',
} as const;

describe('provision journal v3', () => {
  it('is created with the reservation, so a crash before the first step leaves a journal with nothing started', async () => {
    const before = Date.now();
    const { paths, input } = await fixture();

    const journal = await readProvisionJournal(paths, input.instance_id);
    expect(journal).toEqual({
      schema_version: 3,
      instance_id: input.instance_id,
      launcher_contract_version: LAUNCHER_CONTRACT_VERSION,
      started_at: expect.any(String),
      steps: {},
      decisions: {},
      key_policy_lifted: false,
    });
    expect(Date.parse(journal.started_at)).toBeGreaterThanOrEqual(before - 1_000);
    expect((await stat(paths.journalFile(input.instance_id))).mode & 0o777).toBe(0o600);
    expect((await stat(paths.stateRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.instancesRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.instanceRoot(input.instance_id))).mode & 0o777).toBe(0o700);
  });

  it('starts no journal for a reservation whose claims conflict', async () => {
    const { paths, input } = await fixture();
    const conflicting = { ...reservation(paths), allocated_ports: input.allocated_ports };

    await expect(reserveInstance(paths, conflicting)).rejects.toMatchObject({ code: 'claim_conflict' });
    await expect(stat(paths.journalFile(conflicting.instance_id))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['a pre-v3 journal', { schema_version: 1, phases: {} }, 'unsupported_journal'],
    [
      'an incompatible launcher contract',
      { launcher_contract_version: LAUNCHER_CONTRACT_VERSION + 1 },
      'incompatible_launcher',
    ],
  ] as const)('refuses %s with remove-and-recreate guidance and leaves it untouched', async (_label, change, code) => {
    const { paths, input } = await fixture();
    const contents = JSON.stringify({ ...(await rawJournal(paths, input.instance_id)), ...change });
    await writeFile(paths.journalFile(input.instance_id), contents, { mode: 0o600 });

    const refusal = await readProvisionJournal(paths, input.instance_id).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code });
    expect((refusal as GwsEaError).message).toContain(`gws-ea remove --id ${input.instance_id}`);
    expect(await readFile(paths.journalFile(input.instance_id), 'utf8')).toBe(contents);
  });

  it('refuses a missing or corrupt journal without rewriting it', async () => {
    const { paths, input } = await fixture();
    await writeFile(paths.journalFile(input.instance_id), '{not-json', { mode: 0o600 });
    await expect(readProvisionJournal(paths, input.instance_id)).rejects.toMatchObject({ code: 'invalid_journal' });
    await withInstanceOperation(paths, input.instance_id, async (operation) => {
      await expect(recordStepStarted(operation, 'materialize_checkout')).rejects.toMatchObject({
        code: 'invalid_journal',
      });
    });
    expect(await readFile(paths.journalFile(input.instance_id), 'utf8')).toBe('{not-json');

    await rm(paths.journalFile(input.instance_id));
    await expect(readProvisionJournal(paths, input.instance_id)).rejects.toMatchObject({ code: 'journal_missing' });
  });

  it('ignores unknown fields at every level', async () => {
    const { paths, input } = await fixture();
    const raw = await rawJournal(paths, input.instance_id);
    await writeFile(
      paths.journalFile(input.instance_id),
      JSON.stringify({
        ...raw,
        future_fact: { anything: true },
        steps: {
          materialize_checkout: { started_at: raw.started_at, completed_at: raw.started_at, attempt: 3 },
          future_step: { started_at: raw.started_at },
        },
        decisions: { principal: { ...PRINCIPAL, avatar: 'https://example.test/a.png' }, future_choice: 'x' },
      }),
      { mode: 0o600 },
    );

    const journal = await readProvisionJournal(paths, input.instance_id);
    expect(journal.steps).toEqual({
      materialize_checkout: { started_at: raw.started_at, completed_at: raw.started_at },
    });
    expect(journal.decisions).toEqual({ principal: PRINCIPAL });
    expect(journal).not.toHaveProperty('future_fact');
  });

  it('records steps, failures, decisions, and facts only under an active operation', async () => {
    const { paths, input } = await fixture();
    const operation = await acquireInstanceOperation(paths, input.instance_id);
    if (!operation) throw new Error('The test instance operation was busy');
    try {
      const started = await recordStepStarted(operation, 'materialize_checkout');
      const firstStart = started.steps.materialize_checkout?.started_at;
      expect((await recordStepStarted(operation, 'materialize_checkout')).steps.materialize_checkout).toEqual({
        started_at: firstStart,
      });

      const failed = await recordStepFailure(
        operation,
        'materialize_checkout',
        new GwsEaError('clone_failed', 'Clone failed:\nremote hung up'),
        '/logs/run/steps/01-materialize-checkout.log',
      );
      expect(failed.last_error).toEqual({
        step: 'materialize_checkout',
        code: 'clone_failed',
        message: 'Clone failed: remote hung up',
        at: expect.any(String),
        log: '/logs/run/steps/01-materialize-checkout.log',
      });
      await recordStepFailure(operation, 'materialize_checkout', new Error('secret-canary'), undefined);
      const unexpected = await readProvisionJournal(paths, input.instance_id);
      expect(unexpected.last_error).toMatchObject({ code: 'unexpected', message: 'Unexpected control-plane failure.' });
      expect(await readFile(paths.journalFile(input.instance_id), 'utf8')).not.toContain('secret-canary');

      const completed = await recordStepCompleted(operation, 'materialize_checkout');
      expect(completed.steps.materialize_checkout).toEqual({
        started_at: firstStart,
        completed_at: expect.any(String),
      });
      expect(completed.last_error).toBeUndefined();

      const confirmed = await recordChatConfigurationConfirmed(operation);
      const confirmedAt = confirmed.decisions.chat_configuration_confirmed_at;
      expect(confirmedAt).toEqual(expect.any(String));
      expect((await recordChatConfigurationConfirmed(operation)).decisions.chat_configuration_confirmed_at).toBe(
        confirmedAt,
      );

      await recordPrincipalSelection(operation, PRINCIPAL);
      await expect(recordPrincipalSelection(operation, PRINCIPAL)).resolves.toMatchObject({
        decisions: { principal: PRINCIPAL },
      });
      await expect(
        recordPrincipalSelection(operation, { ...PRINCIPAL, messagingGroupId: 'mg-other' }),
      ).rejects.toMatchObject({ code: 'principal_selection_mismatch' });

      expect((await recordKeyPolicyLifted(operation, true)).key_policy_lifted).toBe(true);
    } finally {
      operation.release();
    }

    await expect(recordStepStarted(operation, 'provision_gcp')).rejects.toMatchObject({ code: 'operation_inactive' });
    const reopened = await readProvisionJournal(paths, input.instance_id);
    expect(reopened.steps.provision_gcp).toBeUndefined();
    expect(reopened.decisions.principal).toEqual(PRINCIPAL);
    expect(reopened.key_policy_lifted).toBe(true);
  });

  it('gives the instance operation to one process at a time', async () => {
    const { paths, input } = await fixture();
    const holder = await acquireInstanceOperation(paths, input.instance_id);
    if (!holder) throw new Error('The test instance operation was busy');
    try {
      await expect(acquireInstanceOperation(paths, input.instance_id)).resolves.toBeNull();
      const contenderScript = `
        import { resolveControlPlanePaths } from './src/gws-ea/paths.ts';
        import { acquireInstanceOperation } from './src/gws-ea/journal.ts';
        const paths = resolveControlPlanePaths(JSON.parse(process.env.TEST_PATHS));
        const operation = await acquireInstanceOperation(paths, process.env.TEST_INSTANCE_ID);
        process.exit(operation ? 4 : 0);
      `;
      const contender = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', contenderScript], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TEST_PATHS: JSON.stringify({ configRoot: paths.configRoot, stateRoot: paths.stateRoot }),
          TEST_INSTANCE_ID: input.instance_id,
        },
        stdio: 'ignore',
      });
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        contender.once('error', reject);
        contender.once('exit', resolve);
      });
      expect(exitCode).toBe(0);
    } finally {
      holder.release();
    }
    const next = await acquireInstanceOperation(paths, input.instance_id);
    expect(next).not.toBeNull();
    next?.release();
  }, 60_000);
});
