import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writePrivate } from '../community-portal/private-file.js';
import {
  acquireInstanceOperation,
  assertInstanceCreated,
  LAUNCHER_CONTRACT_VERSION,
  loadCreatedRuntime,
  readProvisionJournal,
  recordChatConfigurationConfirmed,
  recordKeyPolicyLifted,
  recordPrincipalSelection,
  recordStepCompleted,
  recordStepFailure,
  recordStepStarted,
  reserveInstance,
  withInstanceOperation,
} from './journal.js';
import { createOnecliRuntimeLayout } from './onecli-compose.js';
import { beginOperation } from './operation.js';
import { instanceRuntimeFile, resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { getInstanceReservation } from './registry.js';
import { createInstanceRuntimeConfig } from './service.js';
import { GwsEaError, PROVISION_STEPS, releaseOf, type InstanceReservationInput } from './types.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function reservation(): InstanceReservationInput {
  const instanceId = randomUUID();
  return {
    instance_id: instanceId,
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
  const input = reservation();
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
    expect(paths.instanceRoot(input.instance_id)).toBe(path.join(paths.stateRoot, input.instance_id.slice(0, 8)));
    expect((await stat(paths.instanceRoot(input.instance_id))).mode & 0o777).toBe(0o700);
  });

  it('starts no journal for a reservation whose claims conflict', async () => {
    const { paths, input } = await fixture();
    const conflicting = { ...reservation(), allocated_ports: input.allocated_ports };

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
    [
      'a contract 1 journal, from before the Google sign-in step',
      { launcher_contract_version: 1 },
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

  it('refuses provisioning under an unfinished update like a removal receipt, and releases the lock', async () => {
    const { paths, input } = await fixture();
    const target = { ...releaseOf(input), deployed_commit: 'b'.repeat(40) };
    const operation = await acquireInstanceOperation(paths, input.instance_id, { command: 'update', target });
    if (!operation) throw new Error('The test instance operation was busy');
    try {
      await beginOperation(operation, { kind: 'update', from: releaseOf(input), to: target });
    } finally {
      operation.release();
    }

    await expect(acquireInstanceOperation(paths, input.instance_id)).rejects.toMatchObject({
      code: 'operation_in_progress',
    });
    await expect(withInstanceOperation(paths, input.instance_id, async () => 'ran')).rejects.toMatchObject({
      code: 'operation_in_progress',
    });
    const reverting = await acquireInstanceOperation(paths, input.instance_id, { command: 'rollback' });
    expect(reverting).not.toBeNull();
    reverting?.release();

    await writePrivate(paths.removalFile(input.instance_id), { instance_id: input.instance_id });
    const removal = await acquireInstanceOperation(paths, input.instance_id, { command: 'rollback' }).catch(
      (error: unknown) => error,
    );
    expect(removal).toMatchObject({ code: 'removal_in_progress' });
    expect((removal as Error).message).toContain(`gws-ea remove --id ${input.instance_id}`);
  });

  it.each([
    ['a pre-v3 journal', { schema_version: 1, phases: {} }, 'unsupported_journal'],
    [
      'an incompatible launcher contract',
      { launcher_contract_version: LAUNCHER_CONTRACT_VERSION + 1 },
      'incompatible_launcher',
    ],
  ] as const)('refuses to update or roll back after %s, naming remove and recreate', async (_label, change, code) => {
    const { paths, input } = await fixture();
    const contents = JSON.stringify({ ...(await rawJournal(paths, input.instance_id)), ...change });
    await writeFile(paths.journalFile(input.instance_id), contents, { mode: 0o600 });
    const target = { ...releaseOf(input), deployed_commit: 'b'.repeat(40) };

    for (const intent of [{ command: 'update', target }, { command: 'rollback' }] as const) {
      const refusal = await acquireInstanceOperation(paths, input.instance_id, intent).catch((error: unknown) => error);
      expect(refusal).toMatchObject({ code });
      expect((refusal as GwsEaError).message).toContain(
        `gws-ea remove --id ${input.instance_id}, then create it again`,
      );
    }
    // Commands that only operate the running host are not bound to the provisioning contract.
    const start = await acquireInstanceOperation(paths, input.instance_id, { command: 'start' });
    expect(start).not.toBeNull();
    start?.release();
  });

  it('counts an assistant created only once its Google sign-in step is complete', async () => {
    const { paths, input } = await fixture();
    const completedAt = new Date().toISOString();
    const raw = await rawJournal(paths, input.instance_id);
    const steps = Object.fromEntries(
      PROVISION_STEPS.filter((step) => step !== 'connect_google').map((step) => [
        step,
        { started_at: completedAt, completed_at: completedAt },
      ]),
    );
    await writeFile(paths.journalFile(input.instance_id), JSON.stringify({ ...raw, steps }), { mode: 0o600 });

    await expect(assertInstanceCreated(paths, input.instance_id)).rejects.toMatchObject({
      code: 'instance_not_created',
    });
  });

  it('admits update and rollback for an assistant provisioned under this launcher contract', async () => {
    const { paths, input } = await fixture();
    const target = { ...releaseOf(input), deployed_commit: 'b'.repeat(40) };
    for (const intent of [{ command: 'update', target }, { command: 'rollback' }] as const) {
      const operation = await acquireInstanceOperation(paths, input.instance_id, intent);
      expect(operation).not.toBeNull();
      operation?.release();
    }
  });

  it('refuses every command but update, which converts it, for an assistant on the layout before releases', async () => {
    const { paths } = await fixture();
    const legacy = { ...reservation(), checkout_realpath: '/old/layout/instances/nanoclaw' };
    legacy.allocated_ports = { nanoclaw_webhook: 32_101, onecli_app: 32_102, onecli_gateway: 32_103 };
    legacy.exclusive_resource_claims = {
      ...legacy.exclusive_resource_claims,
      ingress: { mode: 'existing', endpoint_url: 'https://legacy.example.test/webhook/gchat' },
      gcp_project_id: 'legacy-project',
      gchat_service_account: 'gws-ea-chat@legacy-project.iam.gserviceaccount.com',
      workspace_email: 'legacy@example.test',
    };
    await reserveInstance(paths, legacy);
    const id = legacy.instance_id;
    await rm(paths.instanceRoot(id), { recursive: true });

    for (const command of ['resume', 'start', 'stop', 'restart', 'ncl', 'rollback', 'connect-google'] as const) {
      const refusal = await acquireInstanceOperation(paths, id, { command }).catch((error: unknown) => error);
      expect(refusal).toMatchObject({
        code: 'legacy_layout',
        message: `Assistant ${id} is on the legacy layout: run gws-ea update --id ${id} to convert it.`,
      });
    }
    // A refused command creates nothing at the short root the conversion will move the assistant to.
    await expect(stat(paths.instanceRoot(id))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it("reads the runtime record from the assistant's physical state, with no release live (R17)", async () => {
    const { paths, input } = await fixture();
    const id = input.instance_id;
    const operation = await acquireInstanceOperation(paths, id);
    if (!operation) throw new Error('The test instance operation was busy');
    try {
      for (const step of PROVISION_STEPS) await recordStepCompleted(operation, step);
    } finally {
      operation.release();
    }
    const reserved = await getInstanceReservation(paths, id);
    const onecli = createOnecliRuntimeLayout({
      instanceId: id,
      instanceRoot: paths.instanceRoot(id),
      project: reserved.exclusive_resource_claims.onecli_project,
      appPort: reserved.allocated_ports.onecli_app,
      gatewayPort: reserved.allocated_ports.onecli_gateway,
      dockerEndpoint: 'unix:///var/run/docker.sock',
    });
    const runtime = createInstanceRuntimeConfig(paths, reserved, onecli, {
      nodePath: process.execPath,
      homeDirectory: paths.stateRoot,
      selectedProvider: 'claude',
      dockerEndpoint: 'unix:///var/run/docker.sock',
    });
    const file = instanceRuntimeFile(paths.instanceLayout(id).state);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writePrivate(file, runtime);
    // No release is live: the live link is absent, as while a switch has fenced the assistant.
    await expect(lstat(paths.checkoutRoot(id))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await loadCreatedRuntime(paths, id)).toEqual(runtime);

    // Another assistant's record, at this assistant's own path: nothing gws-ea runs may act on it for this one.
    await writePrivate(file, { ...runtime, instance_id: randomUUID() });

    await expect(loadCreatedRuntime(paths, id)).rejects.toMatchObject({ code: 'runtime_mismatch' });
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
